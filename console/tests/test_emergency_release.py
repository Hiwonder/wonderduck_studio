import http.client
import json
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import Mock

from app.robot.controller import Controller, DemoHardware, SerialOperationCancelled
from app.robot.hardware import Hardware
from app.robot.protocol import IDS
from app.robot.studio import StudioController
from server import Handler


class WaitingHardware(DemoHardware):
    def __init__(self):
        super().__init__()
        self.entered = threading.Event()
        self.proceed = threading.Event()
        self.actions = []

    def wait_for_bus(self):
        self.entered.set()
        if not self.proceed.wait(3):
            raise RuntimeError("Test did not release the bus")

    def execute(self, command):
        action = command["action"]
        self.actions.append(action)
        if action == "registers":
            self.wait_for_bus()
        return super().execute(command)

    def prepare_action_playback(self, ids):
        self.actions.append("prepare")
        self.wait_for_bus()
        self.check_interrupted()
        return super().prepare_action_playback(ids)

    def move_action_frame(self, targets, duration_ms):
        self.actions.append("frame")
        return super().move_action_frame(targets, duration_ms)


class EmergencyReleaseTests(unittest.TestCase):
    @staticmethod
    def action_document():
        return {"action_id": 1, "layout": [[20, 0, 0]], "frames": [
            {"duration_ms": 10, "positions": {"20": 2048}},
        ]}

    def setUp(self):
        self.hardware = WaitingHardware()
        self.controller = Controller(self.hardware, 20, demo=True)
        self.addCleanup(self.controller.close)
        self.addCleanup(self.hardware.proceed.set)
        deadline = time.monotonic() + 2
        while self.controller.unavailable_servo_ids():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.002)
        self.controller.arm("test", True)
        self.studio = StudioController.__new__(StudioController)
        self.studio.lock = threading.RLock()
        self.studio.controller = self.controller
        self.studio._action_position_limits = {}
        self.studio.owner = "test"
        self.studio.workspace = "action"
        self.studio.lease = SimpleNamespace(alive=lambda: True)
        self.studio.token = "test-token"
        self.studio.hz = 20
        self.studio.demo = True
        self.studio.rest_invalidated = True
        self.studio.rest_unconfirmed = set()
        self.studio.status_viewers = {}
        self.studio.error = None
        self.studio.library_active = False
        self.studio.rest_transition_client = None
        self.studio.client_workspaces = {"test": ("action", time.monotonic())}
        self.studio.observer = SimpleNamespace(
            snapshot=lambda *_args, **_kwargs: {}, set_devices_enabled=lambda _enabled: None)
        self.studio._sync_status = lambda: None
        self.pool = ThreadPoolExecutor(max_workers=3)
        self.addCleanup(self.pool.shutdown)

    def test_action_card_limits_survive_missing_health_response(self):
        bounds = {str(device_id): [1000, 3000] for device_id in IDS}
        bounds["13"] = [1252, 2889]
        bounds["23"] = [1207, 2844]
        self.studio.action_position_limits({"action_position_limits": bounds})
        self.assertEqual(self.studio.action_position_limits({})[13], (1252, 2889))
        joints = {joint["id"]: joint for joint in self.studio.snapshot("test")["joints"]}
        self.assertEqual(joints[13]["encoder_limits"], (1252, 2889))
        self.assertEqual(joints[23]["encoder_limits"], (1207, 2844))

    def test_http_release_and_status_can_enter_during_serial_read(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        server.controller = self.studio
        server.studio = True
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        release_enqueued = threading.Event()
        original_enqueue = self.controller.enqueue_emergency_release

        def observe_release():
            future = original_enqueue()
            release_enqueued.set()
            return future

        self.controller.enqueue_emergency_release = observe_release

        def request(path, data=None):
            connection = http.client.HTTPConnection(*server.server_address, timeout=2)
            try:
                headers = {"X-Console-Token": "test-token", "X-Console-Client": "test",
                           "X-Studio-Workspace": "action"}
                connection.request("GET" if data is None else "POST", path,
                                   None if data is None else json.dumps(data), headers)
                reply = connection.getresponse()
                return reply.status, json.loads(reply.read())
            finally:
                connection.close()

        read = self.pool.submit(request, "/api/command", {"action": "registers", "id": 20})
        try:
            self.assertTrue(self.hardware.entered.wait(1))
            old_write = self.controller.enqueue_command(
                {"action": "move_direct", "id": 20, "degrees": 0}, "test")
            release = self.pool.submit(request, "/api/emergency-release", {})
            self.assertTrue(release_enqueued.wait(1))
            status, snapshot = request("/api/state")
            self.assertEqual(status, 200)
            self.assertFalse(snapshot["armed"])
            self.assertFalse(release.done())
        finally:
            self.hardware.proceed.set()
        self.assertEqual(read.result(1)[0], 200)
        self.assertTrue(release.result(1)[1]["verified"])
        with self.assertRaises(PermissionError):
            old_write.result(1)
        self.assertEqual(self.hardware.actions, ["registers", "release_all"])

    def test_emergency_cancels_motion_between_preparation_and_dispatch(self):
        future = self.controller.enqueue_action({
            "operation": "send_frame", "document": self.action_document()}, "test")
        try:
            self.assertTrue(self.hardware.entered.wait(1))
            release = self.controller.enqueue_emergency_release()
            self.assertFalse(release.done())
        finally:
            self.hardware.proceed.set()
        with self.assertRaises(SerialOperationCancelled):
            future.result(1)
        self.assertTrue(release.result(1)["verified"])
        self.assertEqual(self.hardware.actions, ["prepare", "release_all"])

    def test_stopping_playback_cancels_frame_before_dispatch(self):
        start = self.controller.enqueue_action({
            "operation": "start", "document": self.action_document(), "loop": True}, "test")
        self.assertEqual(start.result(1)["state"], "playing")
        try:
            self.assertTrue(self.hardware.entered.wait(1))
            stop = self.pool.submit(self.studio.action_task, {"operation": "stop"}, "test")
            self.assertEqual(stop.result(1)["state"], "stopped")
        finally:
            self.hardware.proceed.set()
        self.controller.close()
        self.assertEqual(self.hardware.actions, ["prepare"])

    def test_close_drains_pending_release_and_cancels_waiting_write(self):
        read = self.controller.enqueue_command({"action": "registers", "id": 20}, "test")
        try:
            self.assertTrue(self.hardware.entered.wait(1))
            old_write = self.controller.enqueue_command(
                {"action": "move_direct", "id": 20, "degrees": 0}, "test")
            release = self.controller.enqueue_emergency_release()
            closing = self.pool.submit(self.controller.close)
            self.assertTrue(self.controller.stop.wait(1))
        finally:
            self.hardware.proceed.set()
        read.result(1)
        self.assertTrue(release.result(1)["verified"])
        closing.result(1)
        with self.assertRaisesRegex(RuntimeError, "维护控制器已关闭"):
            old_write.result(1)
        self.assertEqual(self.hardware.actions, ["registers", "release_all"])

    def test_robotd_release_reserves_the_bus_route_without_blocking_state(self):
        entered, proceed = threading.Event(), threading.Event()
        self.studio.controller = None
        self.studio.lease = None
        self.studio.owner = None
        self.studio.robotd_releases = 0
        self.studio.observer.set_stream_suspended = lambda _suspended: None

        def robotd_release():
            entered.set()
            if not proceed.wait(3):
                raise RuntimeError("Test did not complete robotd's release")
            return {"verified": True}

        self.studio._robotd_emergency_release = robotd_release
        release = self.pool.submit(self.studio.emergency_release, "test")
        try:
            self.assertTrue(entered.wait(1))
            with self.assertRaisesRegex(RuntimeError, "卸力尚未完成"):
                self.studio._switch_workspace("test", "debug")
            self.assertFalse(self.studio.snapshot("test")["maintenance_active"])
        finally:
            proceed.set()
        self.assertTrue(release.result(1)["verified"])

    def test_stale_workspace_is_rejected_before_admission(self):
        with self.assertRaises(PermissionError):
            self.studio.submit({"action": "registers", "id": 20}, "test", workspace="debug")
        self.assertFalse(self.hardware.entered.is_set())

    def test_individual_scan_checks_release_before_the_next_servo(self):
        hardware = Hardware.__new__(Hardware)
        hardware.baud_codes = {}
        hardware.select_baud = Mock()
        hardware.live = SimpleNamespace(make_read=lambda device_id, *_args: device_id)
        hardware.exchange = Mock(return_value=({}, {}, {}))
        hardware.check_interrupted = Mock(side_effect=[None, SerialOperationCancelled()])
        with self.assertRaises(SerialOperationCancelled):
            hardware.individual_read([20, 21], 56, 12)
        hardware.exchange.assert_called_once_with(20, (20,), 12)


if __name__ == "__main__":
    unittest.main()
