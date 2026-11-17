"""Read storage and memory usage without querying robot hardware."""

from pathlib import Path
import shutil


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
    }
