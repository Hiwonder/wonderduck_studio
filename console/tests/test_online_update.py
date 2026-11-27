import io
import unittest
from contextlib import nullcontext
from unittest.mock import Mock, patch

from app.models.online_update import OnlineModelUpdater


class OnlineModelUpdateTests(unittest.TestCase):
    def setUp(self):
        self.manager = Mock()
        self.control = Mock()
        self.updater = OnlineModelUpdater(self.manager, lambda: nullcontext(self.control),
                                          opener=lambda *_args, **_kwargs: MockResponse(b"model"))
        self.phase = "idle"
        self.enabled = True
        self.rest_succeeds = False
        self.disable_takes_effect = True
        self.control.query.side_effect = self.command
        self.manager.query.side_effect = self.status

    def command(self, calls, timeout):
        (method, params), = calls
        if method == "robot.rest":
            self.phase = "rested" if self.rest_succeeds else "failed"
            self.enabled = not self.rest_succeeds
        elif method == "robot.enable":
            if params["on"] or self.disable_takes_effect:
                self.enabled = params["on"]
        elif method != "robot.init":
            raise AssertionError(method)
        return {method: {"accepted": True}}

    def status(self, calls, timeout):
        return {"robot.policies": {"rest_phase": self.phase, "motion_enabled": self.enabled,
                                   "enabled": True, "homed": True}}

    def test_manual_update_after_rest_failure_keeps_policy_disabled(self):
        with self.updater.manual_operation() as (before_apply, policy_restarted):
            before_apply()
            self.assertFalse(policy_restarted)
            self.assertFalse(self.enabled)
        self.assertFalse(self.enabled)

    def test_manual_update_rechecks_policy_at_submission(self):
        with self.assertRaisesRegex(ValueError, "策略仍在运行"):
            with self.updater.manual_operation() as (before_apply, _):
                self.enabled = True
                before_apply()

    def test_manual_update_resumes_after_successful_rest(self):
        self.rest_succeeds = True
        with self.updater.manual_operation() as (before_apply, policy_restarted):
            before_apply()
            self.assertTrue(policy_restarted)
            self.assertFalse(self.enabled)
        self.assertTrue(self.enabled)

    def test_batch_updates_after_rest_failure(self):
        def apply(slot, source, size, filename, *, before_apply):
            before_apply()
            self.assertEqual(source.read(), b"model")
            return {"status": "applied", "model": {"id": slot}}

        self.manager.apply.side_effect = apply
        job = self.run_batch()
        self.assertEqual(job["rest"]["state"], "policy_disabled")
        self.assertEqual(job["resume"]["state"], "skipped")
        self.assertTrue(all(item["state"] == "applied" for item in job["items"]))
        self.assertFalse(self.enabled)

    def test_batch_blocks_when_strategy_disable_is_unconfirmed(self):
        self.disable_takes_effect = False
        job = self.run_batch()
        self.manager.apply.assert_not_called()
        self.assertEqual(job["rest"]["state"], "failed")
        self.assertTrue(all(item["state"] == "not_started" for item in job["items"]))

    def run_batch(self):
        with patch.object(self.updater, "check", return_value={"status": "compatible"}):
            self.updater.start()
        self.assertTrue(self.updater.operation_lock.acquire(timeout=5))
        self.updater.operation_lock.release()
        return self.updater.status()["job"]


class MockResponse(io.BytesIO):
    headers = {}
