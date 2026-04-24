"""Detect the hardware / OS / toolchain of the current machine.

Produces the `machine` and `toolchain` sub-objects of a run record. Also
computes a stable-across-runs fingerprint hash so the site can group runs by
machine.
"""

from __future__ import annotations

import hashlib
import platform
import re
import subprocess
from typing import Any


def auto_label() -> str:
    """Pick a sensible default --label for this host.

    Hostname first (it's what humans already call the machine) — stripped of
    mDNS/LAN suffixes. Falls back to a slug of the CPU model if the hostname
    looks generic (cloud metadata-style `ip-…`, `ec2-…`, etc.).
    """
    host = (platform.node() or "").strip()
    if host:
        bare = host.split(".")[0]
        generic = (
            bare.startswith(("ip-", "ec2-", "host-"))
            or bare in {"localhost", ""}
        )
        if not generic:
            return bare

    model = _cpu_info()["model"]
    slug = re.sub(r"[^a-z0-9]+", "-", model.lower()).strip("-")
    return slug or "unknown"


def capture() -> dict[str, Any]:
    cpu = _cpu_info()
    mem = _memory_gb()
    os_info = _os_info()
    fp = _fingerprint(cpu["model"], cpu["physical_cores"], mem, os_info["system"])

    return {
        "fingerprint": fp,
        "cpu_model": cpu["model"],
        "cpu_arch": platform.machine(),
        "physical_cores": cpu["physical_cores"],
        "logical_cores": cpu["logical_cores"],
        "memory_gb": mem,
        "os": f"{os_info['system']} {os_info['release']}",
        "kernel": os_info["kernel"],
    }


def toolchain() -> dict[str, Any]:
    rustc = _run(["rustc", "--version"]) or "unknown"
    return {"rustc": rustc}


# ---------------------------------------------------------------------------


def _cpu_info() -> dict[str, Any]:
    system = platform.system()
    model = "unknown"
    physical = 0
    logical = 0

    try:
        import psutil  # type: ignore

        logical = psutil.cpu_count(logical=True) or 0
        physical = psutil.cpu_count(logical=False) or 0
    except Exception:
        pass

    if system == "Darwin":
        model = _run(["sysctl", "-n", "machdep.cpu.brand_string"]) or model
        if not physical:
            physical = int(_run(["sysctl", "-n", "hw.physicalcpu"]) or 0)
        if not logical:
            logical = int(_run(["sysctl", "-n", "hw.logicalcpu"]) or 0)
    elif system == "Linux":
        # /proc/cpuinfo "model name" — first matching line.
        try:
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if line.lower().startswith("model name"):
                        model = line.split(":", 1)[1].strip()
                        break
        except OSError:
            pass
    else:
        model = platform.processor() or model

    return {"model": model, "physical_cores": physical, "logical_cores": logical}


def _memory_gb() -> float:
    try:
        import psutil  # type: ignore

        return round(psutil.virtual_memory().total / (1024**3), 1)
    except Exception:
        return 0.0


def _os_info() -> dict[str, Any]:
    return {
        "system": platform.system(),
        "release": platform.release(),
        "kernel": platform.version(),
    }


def _run(cmd: list[str]) -> str | None:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            return r.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


def _fingerprint(cpu_model: str, physical_cores: int, memory_gb: float, os_system: str) -> str:
    """Short hash of stable machine identity. Deliberately excludes kernel
    version, OS release, and rustc — those change without the machine changing.
    """
    normalized = re.sub(r"\s+", " ", cpu_model).strip()
    s = f"{normalized}|{physical_cores}|{round(memory_gb)}|{os_system}"
    return hashlib.sha256(s.encode()).hexdigest()[:10]
