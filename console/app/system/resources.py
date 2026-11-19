"""Read storage and memory usage without querying robot hardware."""

from pathlib import Path
import math
import shutil


def cpu_temperature(thermal_root=Path("/sys/class/thermal")):
    """Read CPU thermal zones, using the SoC zone when a CPU zone is unavailable."""
    cpu_readings, soc_readings = [], []
    try:
        zones = thermal_root.glob("thermal_zone*")
        for zone in zones:
            try:
                kind = (zone / "type").read_text(encoding="ascii").strip().lower()
                celsius = float((zone / "temp").read_text(encoding="ascii").strip()) / 1000
            except (OSError, ValueError, UnicodeError):
                continue
            if not math.isfinite(celsius) or celsius <= 0:
                continue
            if 'cpu' in kind or 'package' in kind or 'x86_pkg' in kind:
                cpu_readings.append(celsius)
            elif 'soc' in kind:
                soc_readings.append(celsius)
    except OSError:
        return None
    return max(cpu_readings or soc_readings, default=None)


def snapshot():
    storage = shutil.disk_usage("/")
    memory = {}
    for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
        name, _, value = line.partition(":")
        if name in ("MemTotal", "MemAvailable"):
            fields = value.split()
            if len(fields) != 2 or fields[1] != "kB":
                raise ValueError("内存信息格式无效")
            memory[name] = int(fields[0]) * 1024
    total = memory.get("MemTotal")
    available = memory.get("MemAvailable")
    if total is None or available is None or not 0 <= available <= total:
        raise ValueError("无法读取完整的内存信息")
    return {
        "storage": {"used_bytes": storage.used, "total_bytes": storage.total},
        "memory": {"used_bytes": total - available, "total_bytes": total},
        "cpu_temp_c": cpu_temperature(),
    }
