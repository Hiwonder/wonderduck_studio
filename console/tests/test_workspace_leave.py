import http.client
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

from app.robot.studio import StudioController
from app.sensors.qmi_imu import AuxiliaryImu
from server import Handler


class WorkspaceLeaveTests(unittest.TestCase):
    def setUp(self):
        studio = StudioController.__new__(StudioController)
        studio.lock = threading.RLock()
        studio.token = "test-token"
        studio.path = "test-robotd"
        studio.owner = studio.controller = studio.lease = None
        studio.status_viewers = {}
        studio.client_workspaces = {}
        studio.rest_transition_client = None
        studio.rest_unconfirmed = set()
        studio.unconfirmed_warnings = {}
        studio.manual_page_guard = Mock()
        studio.manual_page_guard.leases = {}
        studio._set_status_viewer = Mock()
        studio.controller_factory = Mock(side_effect=AssertionError("unexpected maintenance acquisition"))
        self.studio = studio
        self.auxiliary = AuxiliaryImu(20, demo=True)
        self.addCleanup(self.auxiliary.close)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.controller = studio
        server.auxiliary_imu = self.auxiliary
        server.daemon_threads = True
        self.server = server
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()

    def request(self, revision, data):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request("POST", "/api/workspace", json.dumps(data), {
                "X-Console-Token": "test-token",
                "X-Console-Client": "test-client",
                "X-Head-Subscription-Revision": str(revision),
            })
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_leave_during_rest_prevents_maintenance_acquisition(self):
        entered, finish_rest = threading.Event(), threading.Event()

        def rest(_path):
            entered.set()
            if not finish_rest.wait(2):
                raise RuntimeError("test did not release rest")

        with patch("app.robot.studio.ensure_rest", side_effect=rest), ThreadPoolExecutor() as pool:
            request = pool.submit(self.request, 1, {"workspace": "action", "rest_before": True})
            try:
                self.assertTrue(entered.wait(1))
                status, result = self.request(2, {"operation": "leave"})
                self.assertEqual(status, 200)
                self.assertTrue(result["pending"])
                self.studio.manual_page_guard.release.assert_not_called()
            finally:
                finish_rest.set()
            status, result = request.result(2)
        self.assertEqual(status, 200)
        self.assertEqual(result["workspace"], "system")
        self.assertEqual(self.studio.client_workspaces["test-client"][0], "system")
        self.assertIsNone(self.studio.rest_transition_client)
        self.studio.manual_page_guard.release.assert_called_once_with("test-client")
        self.studio.controller_factory.assert_not_called()
        self.assertTrue(self.auxiliary.current_workspace_request("test-client", 2, "system"))

    def test_late_enter_is_rejected_after_leave(self):
        self.assertEqual(self.request(2, {"operation": "leave"})[0], 200)
        with patch("app.robot.studio.ensure_rest") as rest:
            self.assertEqual(self.request(1, {"workspace": "action", "rest_before": True})[0], 400)
            rest.assert_not_called()
        self.assertEqual(self.studio.client_workspaces["test-client"][0], "system")

    def test_departure_survives_revision_expiry_and_unconfirmed_release(self):
        entered, finish_rest = threading.Event(), threading.Event()

        def rest(_path):
            entered.set()
            if not finish_rest.wait(2):
                raise AssertionError("test did not release rest")
            raise RuntimeError("rest failed")

        self.studio._robotd_emergency_release = Mock(side_effect=RuntimeError("release failed"))
        with patch("app.robot.studio.ensure_rest", side_effect=rest), ThreadPoolExecutor() as pool:
            request = pool.submit(self.request, 1, {"workspace": "action", "rest_before": True})
            try:
                self.assertTrue(entered.wait(1))
                self.assertEqual(self.request(2, {"operation": "leave"})[0], 200)
                # Rest can outlast the auxiliary IMU's inactivity window.
                with self.auxiliary.lock:
                    self.auxiliary.workspace_requests.clear()
                    self.auxiliary.subscription_versions.clear()
            finally:
                finish_rest.set()
            status, result = request.result(2)
        self.assertEqual(status, 200)
        self.assertEqual(result["workspace"], "system")
        self.assertIn("test-client", self.studio.rest_unconfirmed)
        self.studio.manual_page_guard.release.assert_not_called()
        self.studio.controller_factory.assert_not_called()
