"""Keep manual-movement inhibition bound to each active browser connection."""

import json
import logging
import select
import socket


class _PageLease:
    def __init__(self, path):
        self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.connection.settimeout(2)
        self.stream = None
        self.next_id = 0
        self.status_enabled = False
        self.transition_enabled = False
        try:
            self.connection.connect(str(path))
            self.stream = self.connection.makefile("rwb")
            self._request("register")
            self._request("block_manual")
        except BaseException:
            self.close()
            raise

    def _request(self, action):
        self.next_id += 1
        message = dict(jsonrpc="2.0", id=self.next_id, method="robot.humanControl",
                       params=dict(action=action, source="web"))
        self.stream.write((json.dumps(message) + "\n").encode())
        self.stream.flush()
        line = self.stream.readline(65537)
        if not line or len(line) > 65536:
            raise ConnectionError("机器人手动控制限制连接已断开")
        reply = json.loads(line)
        if not isinstance(reply, dict):
            raise RuntimeError("机器人未确认手动控制限制")
        result = reply.get("result")
        if reply.get("id") != self.next_id or reply.get("error") is not None or not isinstance(result, dict):
            raise RuntimeError("机器人未确认手动控制限制")
        if result.get("accepted") is not True:
            raise RuntimeError(f"机器人拒绝手动控制限制：{result.get('reason') or '未确认'}")

    def alive(self):
        if self.connection.fileno() < 0:
            return False
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            if not readable:
                return True
            return bool(self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT))
        except (OSError, ValueError):
            return False

    def set_status(self, enabled):
        if self.status_enabled != enabled:
            try:
                self._request("block_status" if enabled else "unblock_status")
            except BaseException:
                # The request may have reached robotd even if its reply was
                # lost.  Reassert the desired state rather than trusting the
                # last acknowledged value on a later retry.
                self.status_enabled = None
                raise
            self.status_enabled = enabled

    def set_transition(self, enabled):
        if self.transition_enabled != enabled:
            self._request("block_maintenance_transition" if enabled else "unblock_maintenance_transition")
            self.transition_enabled = enabled

    def close(self):
        if self.stream is not None:
            self.stream.close()
            self.stream = None
        self.connection.close()

    def release(self):
        try:
            if self.alive():
                self._request("unblock_manual")
        finally:
            self.close()


class ManualPageGuard:
    def __init__(self, path):
        self.path = path
        self.leases = {}

    def contains(self, client):
        return client in self.leases

    def status_enabled(self, client):
        lease = self.leases.get(client)
        return lease is not None and lease.status_enabled and lease.alive()

    def set_transition(self, client, enabled):
        # Reuse the status guard's connection.  Creating a fresh lease here
        # could lose protection between the two guards if that connection died.
        lease = self.leases.get(client)
        if lease is None or not lease.alive():
            raise ConnectionError("机器人维护交接保护连接已断开")
        lease.set_transition(enabled)

    def ensure(self, client, status=None):
        previous = self.leases.get(client)
        if previous is not None and previous.alive():
            lease = previous
        else:
            if previous is not None:
                previous.close()
                del self.leases[client]
            lease = self.leases[client] = _PageLease(self.path)
        if status is not None:
            try:
                lease.set_status(status)
            except BaseException:
                if lease.transition_enabled and lease.alive():
                    if status is True:
                        # The old stream may be unusable after a timeout. Keep
                        # its transition block until a fresh connection has
                        # confirmed a replacement status block.
                        replacement = None
                        try:
                            replacement = _PageLease(self.path)
                            replacement.set_status(True)
                        except (OSError, RuntimeError, ValueError):
                            if replacement is not None:
                                replacement.close()
                        else:
                            self.leases[client] = replacement
                            lease.close()
                            return
                else:
                    self.leases.pop(client, None)
                    lease.close()
                raise

    def release(self, client):
        lease = self.leases.pop(client, None)
        if lease is not None:
            try:
                lease.release()
            except (OSError, ValueError, RuntimeError) as error:
                # Closing the connection also drops its guard in robotd.
                logging.warning("Cannot confirm manual control restriction release: %s", error)

    def close(self):
        for client in list(self.leases):
            try:
                self.release(client)
            except (OSError, ValueError, RuntimeError):
                # A disconnected session is removed by robotd when its socket closes.
                pass
