"""Full-scale and register settings for the auxiliary QMI8658."""

ACCEL_FULL_SCALE_G = 8
GYRO_FULL_SCALE_DPS = 1024
ACTIVE_CONFIG = bytes.fromhex("40 23 63 00 11 00 83")
LEGACY_ACTIVE_CONFIG = bytes.fromhex("40 03 43 00 11 00 83")
LEGACY_ASYNC_CONFIG = LEGACY_ACTIVE_CONFIG[:-1] + b"\x03"
