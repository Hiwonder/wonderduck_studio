"""Shared paths for the robot runtime used by Studio services."""

import os
from pathlib import Path


def robot_root(value=None):
    """Resolve the configured robot directory independently of the Studio checkout."""
    if value is None:
        value = os.environ.get("ROBOT_ROOT", str(Path.home() / "wonderduck"))
    return Path(value).expanduser().resolve()
