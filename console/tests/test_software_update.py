import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app.system import software_update
from app.system.runtime_config import software_build


class SoftwareUpdateTests(unittest.TestCase):
    def test_matching_version_is_compared_by_digest(self):
        installed = "a" * 64
        for current_digest, expected_version in ((installed, None), ("b" * 64, "0.1.5"), (None, "0.1.5")):
            with self.subTest(current_digest=current_digest), \
                    patch.object(software_update, "software_build", return_value=("0.1.5", current_digest)), \
                    patch.object(software_update, "run_updater",
                                 return_value=json.dumps({"version": "0.1.5", "sha256": installed})):
                result = software_update.handle(Path("/robot"), "/run/robotd.sock",
                                                {"action": "check", "language": "zh"}, 8090)
            self.assertEqual(result["version"], expected_version)
            if expected_version:
                self.assertEqual(result["sha256"], installed)

    def test_reinstall_is_bound_to_the_confirmed_build(self):
        requested = "b" * 64
        with patch.object(software_update, "software_build", return_value=("0.1.5", "a" * 64)), \
                patch.object(software_update, "active", return_value=False), \
                patch.object(software_update, "run_updater"), patch.object(software_update, "_run") as run:
            software_update.handle(Path("/robot"), "/run/robotd.sock",
                                   {"action": "install", "language": "en", "version": "0.1.5",
                                    "sha256": requested}, 8090)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--expected-sha256") + 1], requested)

    def test_local_build_does_not_inherit_a_stale_release_digest(self):
        digest = "a" * 64
        revision = "1" * 40
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".runtime-release.json").write_text(json.dumps({
                "install_status": "installed", "tag": "v0.1.5", "version": "0.1.5",
                "source_revision": revision, "sha256": digest,
            }))
            identity = root / "identity.json"
            identity.write_text(json.dumps({"version": "0.1.5", "revision": revision}))
            self.assertEqual(software_build(root, identity), ("0.1.5", digest))
            identity.write_text(json.dumps({"version": "0.1.5", "revision": "2" * 40}))
            self.assertEqual(software_build(root, identity), ("0.1.5", None))
