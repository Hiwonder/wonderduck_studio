"""Paths shared by console modules and sensor subprocesses."""

from pathlib import Path

CONSOLE_ROOT = Path(__file__).resolve().parents[1]
CALIBRATION_DEFAULTS = Path("/etc/robot/calibration-defaults")
