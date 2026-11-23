"""Coordinate robotd and the existing maintenance controller."""

import json
import logging
import math
import secrets
import select
import socket
import threading
import time

from app.robot.robotd_state import MAX_LINE_BYTES, RobotdController
from app.robot.manual_page_guard import ManualPageGuard
from app.robot.protocol import IDS
from app.robot.workspace_rest import ensure_rest


MAINTENANCE_WORKSPACES = frozenset(("action", "debug", "calibration"))
AUTOMATIC_WORKSPACES = frozenset(("target", "pickup", "line", "person", "maze"))
WORKSPACES = MAINTENANCE_WORKSPACES | AUTOMATIC_WORKSPACES | frozenset(("status", "control", "system", "network", "models"))
MANUAL_DISABLED_WORKSPACES = MAINTENANCE_WORKSPACES | AUTOMATIC_WORKSPACES | frozenset(("status",))
REST_WORKSPACES = MAINTENANCE_WORKSPACES | frozenset(("status",))
OBSERVATION_WORKSPACES = REST_WORKSPACES
SETTINGS_WORKSPACES = frozenset(("system", "network"))
CLIENT_TIMEOUT = 30
UNCONFIRMED_RELEASE_WARNING = "卸力未确认，运动控制不可用；设备状态为只读"
REST_INVALIDATING_ACTIONS = frozenset(("move", "move_direct", "write_register", "offset_direct",
                                       "center_all", "home_all", "run_targets"))


class MaintenanceLease:
    def __init__(self, path):
        self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.connection.settimeout(6)
        self.connection.connect(path)
        self.stream = self.connection.makefile("rwb")
        self.next_id = 0

    def request(self, action, **params):
        self.next_id += 1
        message = dict(jsonrpc="2.0", id=self.next_id, method="robot.maintenance", params=dict(action=action, **params))
        try:
            self.stream.write((json.dumps(message) + "\n").encode())
            self.stream.flush()
            line = self.stream.readline(MAX_LINE_BYTES + 1)
        except OSError as error:
            self.close()
            raise ConnectionError("robotd 维护会话通信失败") from error
        if not line or len(line) > MAX_LINE_BYTES:
            raise ConnectionError("robotd 维护会话已断开")
        reply = json.loads(line)
        if reply.get("id") != self.next_id or reply.get("error") is not None or not isinstance(reply.get("result"), dict):
            raise RuntimeError(f"robotd 维护请求失败：{reply.get('error')}")
        result = reply["result"]
        if action == "release" and not result.get("accepted") and result.get("reason") == "no_maintenance":
            return self.request("status")
        if not result.get("accepted"):
            raise RuntimeError(f"robotd 维护请求被拒绝：{result.get('reason') or result.get('phase')}")
        expected = "active" if action in ("acquire", "acquire_partial", "acquire_status", "status_read_begin", "status_read_complete", "status_read_timeout", "invalidate_rest") else "idle"
        if result.get("phase") != expected:
            raise RuntimeError(f"robotd 维护交接未完成：{result.get('phase')}")
        return result

    def alive(self):
        if self.connection.fileno() < 0:
            return False
        readable, _, _ = select.select([self.connection], [], [], 0)
        if not readable:
            return True
        try:
            return bool(self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT))
        except BlockingIOError:
            return True
        except OSError:
            return False

    def close(self):
        try:
            self.stream.close()
        finally:
            self.connection.close()


class StudioController:
    readonly = False
    demo = False
    full_servo_range = False

    def __init__(self, path, hz, controller_factory, lease_factory=MaintenanceLease, demo=False,
                 status_hardware_factory=None):
        self.path, self.hz = str(path), hz
        self.controller_factory, self.lease_factory = controller_factory, lease_factory
        self.demo = demo
        self.observer = RobotdController(path, hz, include_details=True)
        self.status_viewers = {}
        self.status_hardware_factory = status_hardware_factory
        self.status_lease = None
        self.status_error = None
        self.status_retry_at = 0.0
        self.client_workspaces = {}
        self.manual_page_guard = ManualPageGuard(path)
        self.manual_guard_error = None
        self.rest_transition_client = None
        self.rest_unconfirmed = set()
        self.unconfirmed_warnings = {}
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.owner = None
        self.workspace = None
        self.controller = None
        self.lease = None
        self.partial_maintenance = False
        self.partial_unavailable_ids = set()
        self.rest_invalidated = False
        self.last_seen = 0
        self.error = None
        self.library_owner = None
        self.library_id = None
        self.library_active = False
        self.library_cancelled = set()
        self.library_result = dict(state="idle", frame=None, count=0, error=None)
        self.stop = threading.Event()
        self.watchdog = threading.Thread(target=self._watch, name="studio-session", daemon=True)
        self.watchdog.start()

    @property
    def joints(self):
        return self.controller.joints if self.controller else self.observer.joints

    @property
    def imu_source(self):
        return self.controller.imu_source if self.controller else "robotd"

    @property
    def calibration(self):
        if self.controller is None:
            raise RuntimeError("没有活动的标定工作区")
        return self.controller.calibration

    def _require(self, client, workspaces):
        if client in self.rest_unconfirmed:
            raise PermissionError("维护接管未确认，设备操作不可用")
        if not client or self.owner != client or self.workspace not in workspaces or self.controller is None:
            raise PermissionError("当前浏览器没有此工作区的维护控制权")
        if self.lease is None or not self.lease.alive():
            raise PermissionError("robotd 维护会话已断开")
        self.last_seen = time.monotonic()
        return self.controller

    def authorize(self, client, path, workspace):
        with self.lock:
            if workspace != self.workspace:
                raise PermissionError("工作区已切换，请重新操作")
            if path in ("/api/action-document", "/api/action-playback"):
                self._require(client, {"action"})
            elif path in ("/api/parameter-batch", "/api/export-targets", "/api/list-targets", "/api/load-targets"):
                self._require(client, {"debug"})
            elif path == "/api/head-imu/calibration":
                self._require(client, {"calibration"})

    def _switch_unconfirmed_workspace(self, client, workspace):
        """Allow guarded observation without treating an unconfirmed release as safe."""
        warning = self.unconfirmed_warnings.get(client, UNCONFIRMED_RELEASE_WARNING)
        try:
            # Keep the full movement block even on a different page. The
            # release request may have failed before robotd could latch it.
            self.manual_page_guard.ensure(client, status=True)
        except (OSError, RuntimeError, ValueError):
            if client in self.status_viewers:
                self._set_status_viewer(client, False)
            raise
        self.client_workspaces[client] = (workspace, time.monotonic())
        if (workspace in OBSERVATION_WORKSPACES and self.owner is None
                and self.controller is None and self.lease is None):
            self._set_status_viewer(client, True)
            return dict(workspace=workspace, maintenance=False, ready=True,
                        readonly=True, release_unconfirmed=True, warning=warning)
        if client in self.status_viewers:
            self._set_status_viewer(client, False)
        message = warning + ("；维护占用，设备状态采集暂停" if workspace == "status" else
                             "；请重新点击页面重试")
        return dict(workspace=workspace, maintenance=False, ready=False, error=message)

    def _unconfirmed_fallback(self, client, workspace, warning):
        self.rest_unconfirmed.add(client)
        self.unconfirmed_warnings[client] = warning
        try:
            return self._switch_unconfirmed_workspace(client, workspace)
        except (OSError, RuntimeError, ValueError) as error:
            self.client_workspaces[client] = (workspace, time.monotonic())
            return dict(workspace=workspace, maintenance=False, ready=False,
                        error=f"{warning}；手动控制限制未确认：{error}")

    def _partial_observation(self, client, timeouts):
        """Wait for every servo's own read, including an explicit missing reply."""
        if not hasattr(self.observer, "snapshot"):
            return None
        try:
            state = self.observer.snapshot(client, include_devices=True)
        except (OSError, RuntimeError, ValueError, TypeError):
            return None
        rows = state.get("servos")
        if state.get("online") is not True or state.get("bus_waiting") or not isinstance(rows, list):
            return None
        if (len(rows) != len(IDS) or any(not isinstance(row, dict) for row in rows)
                or {row.get("id") for row in rows} != set(IDS)):
            return None
        now, missing, available = time.monotonic(), [], 0
        for row in rows:
            observed = row.get("observed_monotonic")
            if type(observed) not in (int, float) or not 0 <= now - observed <= 10:
                return None
            if row.get("valid") is True and row.get("torque") == 0 and row.get("error") is None:
                timeouts.pop(row["id"], None)
                available += 1
            elif row.get("valid") is False and row.get("error") == "未连接":
                missing.append(row["id"])
            elif row.get("valid") is False and row.get("error") == "读取超时":
                # Older robotd builds publish each clean timeout under the same label.
                previous, count = timeouts.get(row["id"], (None, 0))
                if observed != previous:
                    count += 1
                    timeouts[row["id"]] = observed, count
                if count >= 2:
                    missing.append(row["id"])
            else:
                timeouts.pop(row["id"], None)
                return None
        return missing if available and missing and available + len(missing) == len(IDS) else None

    def _try_partial_maintenance(self, client, workspace, fallback):
        if workspace not in MAINTENANCE_WORKSPACES or not fallback.get("ready"):
            return fallback
        if not hasattr(self.observer, "snapshot"):
            with self.lock:
                if self.rest_transition_client == client:
                    self.rest_transition_client = None
            return fallback
        deadline = time.monotonic() + 12
        timeouts = {}
        while time.monotonic() < deadline:
            with self.lock:
                if (self.rest_transition_client != client or client not in self.rest_unconfirmed
                        or self.client_workspaces.get(client, (None,))[0] != workspace):
                    if self.rest_transition_client == client:
                        self.rest_transition_client = None
                    return fallback
            missing = self._partial_observation(client, timeouts)
            if missing:
                break
            time.sleep(.05)
        else:
            with self.lock:
                if self.rest_transition_client == client:
                    self.rest_transition_client = None
            return fallback
        with self.lock:
            if self.rest_transition_client != client or self.owner is not None:
                if self.rest_transition_client == client:
                    self.rest_transition_client = None
                return fallback
            try:
                self.manual_page_guard.set_transition(client, True)
                self.manual_page_guard.ensure(client, status=False)
                self.rest_unconfirmed.discard(client)
                result = self._switch_workspace(client, workspace, partial=True, unavailable_ids=missing)
                self.manual_page_guard.set_transition(client, False)
                self.unconfirmed_warnings.pop(client, None)
                result.update(ready=True, partial=True, unavailable_ids=missing)
                return result
            except (OSError, RuntimeError, ValueError, PermissionError) as error:
                logging.warning("部分舵机维护接管未完成：%s", error)
                self.rest_unconfirmed.add(client)
                try:
                    self.manual_page_guard.ensure(client, status=True)
                    if self.owner == client and (self.controller is not None or self.lease is not None):
                        self._leave()
                    self.manual_page_guard.set_transition(client, False)
                    return self._switch_unconfirmed_workspace(client, workspace)
                except (OSError, RuntimeError, ValueError) as guard_error:
                    logging.error("无法恢复维护保护：%s", guard_error)
                    return dict(workspace=workspace, maintenance=False, ready=False,
                                error="维护保护未确认，请重新点击页面重试")
            finally:
                self.rest_transition_client = None

    def switch(self, client, workspace):
        if not client or workspace not in WORKSPACES:
            raise ValueError("工作区无效")
        with self.lock:
            if workspace in SETTINGS_WORKSPACES:
                try:
                    result = self._switch_workspace(client, workspace)
                except (OSError, RuntimeError, ValueError) as error:
                    # Settings remain usable while robotd completes a serial handoff.
                    logging.warning("进入设置时维护串口未确认：%s", error)
                    self.rest_unconfirmed.add(client)
                    self.client_workspaces[client] = (workspace, time.monotonic())
                    return dict(workspace=workspace, maintenance=False, ready=True)
                if client not in self.rest_unconfirmed:
                    self.manual_page_guard.release(client)
                return result
            if self.rest_transition_client is not None:
                raise RuntimeError("机器人正在休息，请等待页面切换完成")
            if client in self.rest_unconfirmed:
                # Permit navigation while keeping the manual guard. The daemon's
                # emergency gate remains closed until a release is verified.
                return self._switch_unconfirmed_workspace(client, workspace)
            previous = self.client_workspaces.get(client)
            previous_status_seen = self.status_viewers.get(client)
            previously_disabled = bool(previous and previous[0] in MANUAL_DISABLED_WORKSPACES)
            disabled = workspace in MANUAL_DISABLED_WORKSPACES
            try:
                if disabled:
                    self.manual_page_guard.ensure(client)
                    if workspace == "status":
                        self.manual_page_guard.ensure(client, status=True)
                    elif workspace != "status":
                        self.manual_page_guard.ensure(client, status=False)
                result = self._switch_workspace(client, workspace)
            except BaseException:
                if previous is None:
                    self.client_workspaces.pop(client, None)
                else:
                    self.client_workspaces[client] = previous
                if previous_status_seen is None:
                    self.status_viewers.pop(client, None)
                else:
                    self.status_viewers[client] = previous_status_seen
                if workspace in REST_WORKSPACES:
                    # A failed handoff must not restore a motion-capable page
                    # while the user is seeing the unavailable maintenance page.
                    self.rest_unconfirmed.add(client)
                    self.manual_page_guard.ensure(client, status=True)
                elif previously_disabled:
                    self.manual_page_guard.ensure(client, status=previous[0] == "status")
                else:
                    self.manual_page_guard.release(client)
                raise
            if not disabled:
                self.manual_page_guard.release(client)
            elif workspace != "status":
                self.manual_page_guard.ensure(client, status=False)
            return result

    def switch_after_rest(self, client, workspace):
        """Rest once before a user-initiated servo workspace transition."""
        if not client or workspace not in REST_WORKSPACES:
            raise ValueError("工作区无效")
        with self.lock:
            if self.rest_transition_client is not None:
                raise RuntimeError("机器人正在休息，请等待页面切换完成")
            previous = self.client_workspaces.get(client)
            if previous is not None and previous[0] == workspace and client not in self.rest_unconfirmed:
                return self.switch(client, workspace)
            if self.owner not in (None, client):
                return self._unconfirmed_fallback(client, workspace, "另一浏览器正在使用维护工作区；设备操作不可用")
            other_status_viewer = any(other != client and self.manual_page_guard.status_enabled(other)
                                      for other in self.manual_page_guard.leases)
            if other_status_viewer and workspace == "status" and self.owner is None:
                return self._unconfirmed_fallback(client, workspace, "其他页面正在采集设备状态；维护接管暂不可用")
            previous_status_seen = self.status_viewers.get(client)
            retry_unconfirmed = client in self.rest_unconfirmed
            self.rest_transition_client = client
            try:
                if self.owner == client and (self.controller is not None or self.lease is not None):
                    self._leave()
                if previous_status_seen is not None:
                    self._set_status_viewer(client, False)
                # Once release is unconfirmed, do not open a movement window
                # while retrying it. Emergency release is a priority request
                # and remains available with the status guard held.
                self.manual_page_guard.ensure(client, status=retry_unconfirmed or other_status_viewer)
            except (OSError, RuntimeError, PermissionError, ValueError) as error:
                self.rest_transition_client = None
                return self._unconfirmed_fallback(client, workspace, f"维护串口未安全交回：{error}；设备操作不可用")
            except BaseException:
                self.rest_transition_client = None
                if previous and previous[0] in MANUAL_DISABLED_WORKSPACES:
                    self.manual_page_guard.ensure(client, status=previous[0] == "status")
                else:
                    self.manual_page_guard.release(client)
                if previous_status_seen is not None:
                    self._set_status_viewer(client, True)
                raise
        try:
            # Do not hold the Studio lock while the robot is sitting: state
            # snapshots and unrelated status requests must remain responsive.
            fallback = False
            try:
                if retry_unconfirmed or other_status_viewer:
                    raise RuntimeError("卸力尚未确认")
                ensure_rest(self.path)
            except Exception as error:
                logging.warning("休息未完成，准备关闭策略并卸力：%s", error)
                try:
                    self._robotd_emergency_release()
                except Exception as release_error:
                    message = f"休息未完成，关闭策略和卸力未确认：{release_error}"
                    logging.error("%s", message)
                    with self.lock:
                        self.rest_transition_client = None
                        fallback = self._unconfirmed_fallback(client, workspace, message)
                        if workspace in MAINTENANCE_WORKSPACES and fallback.get("ready"):
                            self.rest_transition_client = client
                    return self._try_partial_maintenance(client, workspace, fallback)
                fallback = True
            with self.lock:
                self.rest_transition_client = None
                # An unconfirmed release keeps the status guard active.  The
                # maintenance lease needs that guard removed to acquire the
                # bus, so overlap it with a separate movement block until the
                # exclusive lease has actually taken over.
                transition_guard = (retry_unconfirmed or other_status_viewer) and workspace in MAINTENANCE_WORKSPACES
                try:
                    if transition_guard:
                        self.manual_page_guard.set_transition(client, True)
                    self.rest_unconfirmed.discard(client)
                    result = self.switch(client, workspace)
                    if transition_guard:
                        self.manual_page_guard.set_transition(client, False)
                except Exception as error:
                    warning = f"维护接管未完成：{error}；设备操作不可用"
                    result = self._unconfirmed_fallback(client, workspace, warning)
                    # If the final transition-unblock failed after acquiring
                    # maintenance, restore a status guard before releasing the
                    # lease.  Otherwise the failed cleanup would open a gap.
                    if self.owner == client and (self.controller is not None or self.lease is not None):
                        if self.manual_page_guard.status_enabled(client):
                            try:
                                self._leave()
                            except (OSError, RuntimeError, PermissionError, ValueError) as leave_error:
                                warning += f"；维护串口未安全交回：{leave_error}"
                            result = self._unconfirmed_fallback(client, workspace, warning)
                    # If the status guard cannot be restored, retain the
                    # connection-bound transition guard for the next retry.
                    if transition_guard and self.manual_page_guard.status_enabled(client):
                        try:
                            self.manual_page_guard.set_transition(client, False)
                        except (OSError, RuntimeError, ValueError) as guard_error:
                            logging.warning("Cannot release maintenance transition guard: %s", guard_error)
                    return result
                self.unconfirmed_warnings.pop(client, None)
                if fallback:
                    result["rest_fallback"] = True
                return result
        except BaseException:
            with self.lock:
                self.rest_transition_client = None
                if retry_unconfirmed:
                    # Interruption must never release the last movement block
                    # while the maintenance handoff is still in progress.
                    self.rest_unconfirmed.add(client)
                    self.client_workspaces[client] = (workspace, time.monotonic())
                    try:
                        self.manual_page_guard.ensure(client, status=True)
                        if workspace in MAINTENANCE_WORKSPACES:
                            self.manual_page_guard.set_transition(client, False)
                    except (OSError, RuntimeError, ValueError) as guard_error:
                        logging.error("Cannot restore interrupted maintenance guard: %s", guard_error)
                elif previous and previous[0] in MANUAL_DISABLED_WORKSPACES:
                    self.manual_page_guard.ensure(client, status=previous[0] == "status")
                else:
                    self.manual_page_guard.release(client)
                if previous_status_seen is not None and not retry_unconfirmed:
                    self._set_status_viewer(client, True)
            raise

    def _switch_workspace(self, client, workspace, partial=False, unavailable_ids=()):
        if not client or workspace not in WORKSPACES:
            raise ValueError("工作区无效")
        with self.lock:
            if workspace not in MAINTENANCE_WORKSPACES:
                previous_workspace = self.client_workspaces.get(client)
                was_viewing_status = client in self.status_viewers
                if self.owner == client:
                    self._leave()
                self.client_workspaces[client] = (workspace, time.monotonic())
                self._set_status_viewer(client, workspace == "status")
                result = dict(workspace=workspace, maintenance=False)
                if workspace == "status":
                    paused = self.controller is not None or self.lease is not None
                    result.update(ready=not paused, error="维护占用，采集暂停" if paused else None)
                return result
            if self.lease is not None and not self.lease.alive():
                # A disconnected lease cannot protect an active serial worker.
                # Stop that worker before discarding the connection or trying to
                # acquire a new lease. If it cannot stop, leave ownership intact.
                if self.controller is not None:
                    self.controller.close()
                    self.controller = None
                self._discard_lease("robotd 维护会话已断开")
            if self.owner not in (None, client):
                raise PermissionError("另一浏览器正在使用维护工作区")
            if self.owner == client and self.workspace == workspace and self.controller:
                # A close which timed out may have already stopped accepting work.
                # Finish closing it before the user retries the same workspace.
                stop = getattr(self.controller, "stop", None)
                if stop is None or not stop.is_set():
                    self._require(client, {workspace})
                    return dict(workspace=workspace, maintenance=True)
                self.controller.close()
                self.controller = None
            was_viewing_status = client in self.status_viewers
            previous_workspace = self.client_workspaces.get(client)
            self.client_workspaces[client] = (workspace, time.monotonic())
            self._set_status_viewer(client, False)
            # Maintenance pauses the shared status subscription until it leaves.
            self._stop_status()
            if self.controller is not None:
                self.controller.close()
                self.controller = None
            if self.lease is None:
                lease = self.lease_factory(self.path)
                self.observer.set_stream_suspended(True)
                try:
                    self._acquire_maintenance(client, lease, partial)
                except BaseException:
                    self.observer.set_stream_suspended(False)
                    lease.close()
                    if previous_workspace is not None:
                        self.client_workspaces[client] = previous_workspace
                    if was_viewing_status:
                        self._set_status_viewer(client, True)
                    raise
                self.lease = lease
                self.partial_maintenance = partial
                self.partial_unavailable_ids = set(unavailable_ids) if partial else set()
                self.rest_invalidated = False
                self.owner = client
            self.workspace = workspace
            self.last_seen = time.monotonic()
            try:
                self.controller = self.controller_factory(workspace)
                # A lease can be reused across maintenance workspaces. Keep its
                # partial-release semantics on every replacement controller.
                self.controller.partial_maintenance = self.partial_maintenance
                self.controller.partial_unavailable_ids = set(self.partial_unavailable_ids)
            except Exception:
                self._leave()
                if previous_workspace is not None:
                    self.client_workspaces[client] = previous_workspace
                if was_viewing_status:
                    self._set_status_viewer(client, True)
                raise
            self.error = None
            return dict(workspace=workspace, maintenance=True)

    def _acquire_maintenance(self, client, lease, partial):
        # Pause passive status reads during exclusive handoff. Their manual
        # movement blocks stay held, and the status stream is already stopped.
        paused = []
        if self.manual_page_guard.transition_enabled(client):
            peers = [other for other in self.manual_page_guard.leases
                     if other != client and self.manual_page_guard.status_enabled(other)]
        else:
            peers = []
        try:
            for other in peers:
                self.manual_page_guard.ensure(other, status=False)
                paused.append(other)
            lease.request("acquire_partial" if partial else "acquire")
        finally:
            for other in paused:
                try:
                    self.manual_page_guard.ensure(other, status=True)
                except (OSError, RuntimeError, ValueError) as error:
                    logging.warning("恢复设备状态采集限制失败：%s", error)

    def _set_status_viewer(self, client, active):
        previous = self.status_viewers.get(client)
        if active:
            self.status_viewers[client] = time.monotonic()
        else:
            self.status_viewers.pop(client, None)
        try:
            self._sync_status()
        except BaseException:
            if previous is None:
                self.status_viewers.pop(client, None)
            else:
                self.status_viewers[client] = previous
            raise

    def _stop_status(self):
        self.observer.set_devices_enabled(False)
        if self.lease is None:
            self.observer.set_stream_suspended(False)

    def _sync_status(self):
        # Never keep a device subscription after its connection-bound status
        # guard has disappeared; the daemon may otherwise resume normal reads.
        enabled = (self.lease is None and self.controller is None
                   and any(self.manual_page_guard.status_enabled(client) for client in self.status_viewers))
        self.observer.set_devices_enabled(enabled)
        if enabled:
            self.observer.set_stream_suspended(False)

    def set_status_visible(self, client, visible):
        with self.lock:
            if client == self.rest_transition_client:
                return
            entry = self.client_workspaces.get(client)
            if entry is None:
                return
            workspace, _ = entry
            self.client_workspaces[client] = (workspace, time.monotonic())
            if client in self.rest_unconfirmed:
                if workspace in OBSERVATION_WORKSPACES:
                    # Re-establish the connection-bound guard before subscribing
                    # after a disconnect; a status view never owns maintenance.
                    try:
                        self.manual_page_guard.ensure(client, status=True)
                    except (OSError, RuntimeError, ValueError):
                        if client in self.status_viewers:
                            self._set_status_viewer(client, False)
                        raise
                    self._set_status_viewer(client, visible)
                return
            self._set_status_viewer(client, visible and workspace == "status")

    def readonly_for(self, client):
        with self.lock:
            entry = self.client_workspaces.get(client)
            return bool(client in self.rest_unconfirmed and entry and entry[0] in OBSERVATION_WORKSPACES)

    def heartbeat(self, client):
        with self.lock:
            self._require(client, MAINTENANCE_WORKSPACES)
            return dict(workspace=self.workspace, maintenance=True)

    def _discard_lease(self, reason):
        """Drop a lease only after its serial controller has stopped."""
        if self.controller is not None:
            raise RuntimeError("维护任务尚未结束，串口不能交回")
        lease, self.lease = self.lease, None
        self.partial_maintenance = False
        self.partial_unavailable_ids = set()
        try:
            if lease is not None:
                lease.close()
        except (OSError, ValueError) as error:
            logging.warning("关闭维护会话失败：%s", error)
        finally:
            if self.library_active and self.library_owner == self.owner:
                self.library_active = False
                self.library_result = dict(state="error", frame=None, count=0, error=reason)
            self.owner = self.workspace = None
            self.rest_invalidated = False
            self.last_seen = 0
            self.error = reason
            self.observer.set_stream_suspended(False)

    def _leave(self):
        library = self.library_active and self.library_owner == self.owner
        if library and self.controller is not None:
            self.library_result = self.controller.action_task(dict(operation="stop"), self.library_owner)
        if self.controller is not None:
            self.controller.close()
            self.controller = None
        if self.lease is not None:
            try:
                self.lease.request("release")
            except (OSError, RuntimeError, ValueError) as error:
                # The serial worker is stopped, but the release result may be
                # unknown. Closing the connection asks robotd to reclaim its
                # bus; never keep an owner whose controller no longer exists.
                self._discard_lease(f"维护串口交接未确认：{error}")
                raise RuntimeError(self.error) from error
            try:
                self.lease.close()
            except (OSError, ValueError) as error:
                logging.warning("关闭维护会话失败：%s", error)
            self.lease = None
            self.partial_maintenance = False
            self.partial_unavailable_ids = set()
            self.rest_invalidated = False
            self.observer.set_stream_suspended(False)
        self.owner = None
        self.workspace = None
        self.last_seen = 0
        if library:
            self.library_active = False
            self.client_workspaces[self.library_owner] = ("control", time.monotonic())
            self.manual_page_guard.release(self.library_owner)
        self._sync_status()

    def start_library_action(self, client, document, run_id):
        with self.lock:
            if not client or not isinstance(run_id, str) or not run_id:
                raise ValueError("动作请求标识无效")
            key = (client, run_id)
            if key in self.library_cancelled:
                self.library_cancelled.remove(key)
                raise RuntimeError("动作请求已取消")
            if self.owner is not None or self.lease is not None:
                raise RuntimeError("维护工作区正在使用，请先结束当前操作")
            self.library_owner = client
            self.library_id = run_id
            self.library_active = True
            try:
                self.switch(client, "action")
                self.controller.arm(client, True)
                self._invalidate_rest_for_maintenance()
                self.library_result = self.controller.action_task(
                    dict(operation="start", document=document, loop=False, locked_ids=[]), client)
                return dict(self.library_result, active=True)
            except Exception as error:
                try:
                    if self.owner == client and self.lease is not None:
                        self._leave()
                except Exception as cleanup_error:
                    raise RuntimeError(f"动作启动失败：{error}；维护资源释放失败：{cleanup_error}") from error
                self.library_active = False
                self.library_result = dict(state="error", frame=None, count=0, error=str(error))
                raise

    def library_action(self, client, operation, run_id):
        with self.lock:
            if not client or not isinstance(run_id, str) or not run_id:
                raise ValueError("动作请求标识无效")
            if operation == "stop" and (self.library_owner != client or self.library_id != run_id):
                self.library_cancelled.add((client, run_id))
                return dict(state="stopped", frame=None, count=0, error=None, active=False)
            if self.library_owner != client or self.library_id != run_id:
                raise PermissionError("当前浏览器没有动作控制权")
            if operation == "stop":
                if self.library_active:
                    self._leave()
            elif operation == "status":
                if self.library_active:
                    controller = self._require(client, {"action"})
                    controller.arm(client, True)
                    self.library_result = controller.action_task(dict(operation="status"), client)
                    if self.library_result["state"] in ("completed", "stopped", "error"):
                        self._leave()
            else:
                raise ValueError("未知动作播放操作")
            return dict(self.library_result, active=self.library_active)

    def emergency_release(self, client, run_id=None):
        if not client:
            raise PermissionError("会话无效，请刷新页面")
        if run_id is not None and (not isinstance(run_id, str) or not run_id):
            raise ValueError("动作请求标识无效")
        with self.lock:
            self._stop_status()
            if run_id is not None and (self.library_owner != client or self.library_id != run_id):
                self.library_cancelled.add((client, run_id))
            if self.controller is not None:
                if self.lease is None or not self.lease.alive():
                    raise RuntimeError("维护会话已断开，卸力结果未确认")
                library_active = self.library_active
                try:
                    return self.controller.emergency_release()
                finally:
                    if library_active:
                        self._leave()
            return self._robotd_emergency_release()

    def _robotd_emergency_release(self):
        try:
            response = self.observer.query((("robot.emergencyRelax", {}),), timeout=30)
            result = response["robot.emergencyRelax"]
        except (OSError, TimeoutError, KeyError, TypeError, ValueError) as error:
            raise RuntimeError(f"卸力请求连接中断或超时，结果未确认：{error}") from error
        if not isinstance(result, dict) or type(result.get("accepted")) is not bool:
            raise RuntimeError("卸力结果格式无效，结果未确认")
        if not result["accepted"]:
            raise RuntimeError(result.get("reason") or "设备未确认卸力")
        return dict(verified=True, source="robotd")

    def shutdown(self, client):
        if not client:
            raise PermissionError("会话无效，请刷新页面")
        with self.lock:
            self.status_viewers.clear()
            self._stop_status()
            if self.controller is not None or self.lease is not None:
                self._leave()
            try:
                result = self.observer.query((("robot.shutdown", {}),), timeout=3)["robot.shutdown"]
            except (OSError, TimeoutError, KeyError, TypeError, ValueError) as error:
                raise RuntimeError(f"关机请求未确认：{error}") from error
            if not isinstance(result, dict) or type(result.get("accepted")) is not bool:
                raise RuntimeError("关机请求结果无效")
            if not result["accepted"]:
                raise RuntimeError(result.get("reason") or "机器人拒绝关机")
            return dict(accepted=True)

    def arm(self, client, on):
        with self.lock:
            if not on and self.owner != client:
                return dict(armed=False)
            return self._require(client, {"action", "debug"}).arm(client, on)

    def submit(self, command, client):
        action = command.get("action")
        if action == "servo_debug":
            allowed = {"action"}
        elif action in ("imu_sample", "calibration_start", "calibration_restore", "calibration_next", "calibration_cancel"):
            allowed = {"calibration"}
        else:
            allowed = {"action", "debug"}
        with self.lock:
            controller = self._require(client, allowed)
            if (action in REST_INVALIDATING_ACTIONS or action == "torque" and command.get("on") is True
                    or action == "servo_debug" and command.get("enabled") is True):
                self._invalidate_rest_for_maintenance()
            return controller.submit(command, client)

    def _invalidate_rest_for_maintenance(self):
        # Maintenance writes bypass robotd, so it must forget its old rest result
        # before any operation that could enable torque or move a joint. Notify
        # once per lease; if the request fails, no servo command is issued.
        if not self.rest_invalidated:
            self.lease.request("invalidate_rest")
            self.rest_invalidated = True

    def parameter_task(self, command, client):
        with self.lock:
            controller = self._require(client, {"debug"})
            if command.get("operation") == "start":
                self._invalidate_rest_for_maintenance()
            return controller.parameter_task(command, client)

    def action_task(self, command, client):
        with self.lock:
            controller = self._require(client, {"action"})
            if command.get("operation") in ("start", "send_frame"):
                self._invalidate_rest_for_maintenance()
            if command.get("operation") != "send_frame":
                return controller.action_task(command, client)
            future = controller.action_task(command, client, defer_frame=True)
        # Waiting for the serial write must not block state snapshots or the rest of Studio.
        return controller.finish_action_frame(future)

    def maintenance_voltage_snapshot(self):
        """Expose only an already sampled, complete maintenance voltage snapshot."""
        def finite_number(value):
            if type(value) not in (int, float):
                return False
            try:
                return math.isfinite(value)
            except OverflowError:
                return False

        unavailable = dict(available=False)
        if not self.lock.acquire(blocking=False):
            return unavailable
        try:
            if (self.demo or self.owner is None or self.workspace not in ("action", "debug")
                    or self.controller is None or self.lease is None or not self.lease.alive()):
                return unavailable
            state = self.controller.snapshot(None)
            calibration = state.get("calibration")
            playback = state.get("action_playback")
            if (state.get("demo") is not False or state.get("online") is not True
                    or state.get("maintenance_voltage_ready") is not True
                    or state.get("parameter_batch_active") is not False
                    or not isinstance(calibration, dict) or calibration.get("active") is not False
                    or not isinstance(playback, dict)
                    or playback.get("state") not in ("idle", "completed", "stopped", "error")):
                return unavailable
            now = time.monotonic()
            sampled = state.get("sampled_monotonic")
            sequence = state.get("sequence")
            rows = state.get("servos")
            if (type(sequence) is not int or sequence <= 0 or not isinstance(rows, list)
                    or not finite_number(sampled)
                    or not 0 <= now - sampled <= .25):
                return unavailable
            expected = set(IDS)
            selected = {}
            for row in rows:
                if not isinstance(row, dict) or type(row.get("id")) is not int:
                    return unavailable
                device_id = row["id"]
                if device_id not in expected:
                    continue
                voltage, observed = row.get("voltage"), row.get("sampled_monotonic")
                if (device_id in selected or row.get("online") is not True or row.get("valid") is not True
                        or row.get("error") is not None
                        or not finite_number(voltage) or not 0 < voltage <= 25.5
                        or not finite_number(observed)
                        or not 0 <= now - observed <= .25):
                    return unavailable
                selected[device_id] = dict(id=device_id, voltage=voltage, sampled_monotonic=observed)
            if set(selected) != expected:
                return unavailable
            return dict(available=True, sequence=sequence, servos=[selected[device_id] for device_id in IDS])
        finally:
            self.lock.release()

    def snapshot(self, client):
        with self.lock:
            observed = self.observer.snapshot(client, include_devices=client in self.status_viewers)
            if client in self.status_viewers:
                state = observed
                paused = self.controller is not None or self.lease is not None
                state.update(device_paused=paused)
                if paused:
                    message = "维护占用，独立采集暂停"
                    state.update(imu=dict(valid=False, error=message),
                                 servos=[dict(joint, online=False, valid=False, error=message)
                                         for joint in self.joints])
                elif client in self.rest_unconfirmed and self.client_workspaces.get(client, (None,))[0] in OBSERVATION_WORKSPACES:
                    # These pages render the independently sampled stream while
                    # movement and maintenance writes remain blocked.
                    age = state.get("device_report_age_ms")
                    if type(age) in (int, float) and age >= 0:
                        state["sampled_monotonic"] = time.monotonic() - age / 1000
            else:
                state = self.controller.snapshot(client) if self.controller else observed
            state.update(robot=observed.get("robot", {}), tof=observed.get("tof"),
                         workspace=self.workspace, maintenance_owner=self.owner == client,
                         maintenance_active=self.owner is not None, maintenance_error=self.error)
            return state

    def _watch(self):
        while not self.stop.wait(1):
            with self.lock:
                now = time.monotonic()
                expired_viewers = [client for client, seen in self.status_viewers.items()
                                   if client != self.rest_transition_client and now - seen > CLIENT_TIMEOUT]
                for client in expired_viewers:
                    try:
                        self._set_status_viewer(client, False)
                    except (OSError, RuntimeError, TimeoutError, ValueError) as error:
                        self.status_error = str(error)
                        logging.error("设备状态采集停止失败：%s", error)
                try:
                    self._sync_status()
                except (OSError, RuntimeError, TimeoutError, ValueError) as error:
                    self.status_error = str(error)
                    logging.error("设备状态串口交接失败：%s", error)
                self.client_workspaces = {client: entry for client, entry in self.client_workspaces.items()
                                          if client == self.rest_transition_client or now - entry[1] <= CLIENT_TIMEOUT}
                self.rest_unconfirmed.intersection_update(self.client_workspaces)
                self.unconfirmed_warnings = {client: warning for client, warning in self.unconfirmed_warnings.items()
                                             if client in self.rest_unconfirmed}
                for client in list(self.manual_page_guard.leases):
                    if client == self.rest_transition_client:
                        continue
                    entry = self.client_workspaces.get(client)
                    if entry is None or (entry[0] not in MANUAL_DISABLED_WORKSPACES
                                         and client not in self.rest_unconfirmed):
                        try:
                            self.manual_page_guard.release(client)
                        except (OSError, ValueError, RuntimeError) as error:
                            logging.warning("Cannot release manual control restriction: %s", error)
                for client, (workspace, _) in self.client_workspaces.items():
                    if client == self.rest_transition_client:
                        continue
                    if workspace not in MANUAL_DISABLED_WORKSPACES and client not in self.rest_unconfirmed:
                        continue
                    try:
                        self.manual_page_guard.ensure(client, status=workspace == "status" or client in self.rest_unconfirmed)
                        self.manual_guard_error = None
                    except (OSError, ValueError, RuntimeError) as error:
                        message = str(error)
                        if self.manual_guard_error != message:
                            logging.warning("Cannot restore manual control restriction: %s", error)
                            self.manual_guard_error = message
                        if workspace in OBSERVATION_WORKSPACES and client in self.status_viewers:
                            try:
                                self._set_status_viewer(client, False)
                            except (OSError, ValueError, RuntimeError) as status_error:
                                logging.error("Cannot stop unguarded status subscription: %s", status_error)
                if self.lease is None:
                    continue
                lost = not self.lease.alive()
                expired = time.monotonic() - self.last_seen > CLIENT_TIMEOUT
                if not lost and not expired:
                    if self.library_active and self.controller is not None:
                        self.library_result = self.controller.action_task(
                            dict(operation="status"), self.library_owner)
                        if self.library_result["state"] in ("completed", "stopped", "error"):
                            try:
                                self._leave()
                            except (OSError, RuntimeError) as error:
                                self.error = f"动作完成后串口交接失败：{error}"
                                logging.error("%s", self.error)
                    continue
                reason = "robotd 维护会话断开" if lost else "浏览器维护会话已过期"
                try:
                    if self.library_active:
                        self.library_result = dict(state="error", frame=None, count=0, error=reason)
                        self.library_active = False
                    if lost:
                        if self.controller is not None:
                            self.controller.close()
                            self.controller = None
                        self._discard_lease(reason)
                        self._sync_status()
                    else:
                        self._leave()
                    self.error = reason
                    logging.warning("%s；维护已停止", reason)
                except (OSError, RuntimeError) as error:
                    self.error = f"{reason}；串口交接失败：{error}"
                    logging.error("%s", self.error)

    def close(self):
        self.stop.set()
        self.watchdog.join(timeout=3)
        with self.lock:
            try:
                self.status_viewers.clear()
                self._stop_status()
                if self.lease is not None:
                    self._leave()
            finally:
                self.manual_page_guard.close()
                self.observer.close()
