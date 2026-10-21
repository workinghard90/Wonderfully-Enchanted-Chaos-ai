"""Read-only hardware and dependency diagnostics. No models downloaded or installed."""
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse

import requests


def _binary_version(name, args=("-version",)):
    executable = shutil.which(name)
    if not executable:
        return {"available": False}
    try:
        run = subprocess.run([executable, *args], capture_output=True, text=True, timeout=8, check=False)
        output = (run.stdout or run.stderr).splitlines()
        return {"available": run.returncode == 0, "path": executable, "version": output[0][:240] if output else "unknown"}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "error": type(exc).__name__}


def detect_gpus():
    executable = shutil.which("nvidia-smi")
    if not executable:
        return {"nvidia": [], "status": "nvidia-smi unavailable; GPU capability unknown"}
    try:
        run = subprocess.run([executable, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=8, check=False)
        if run.returncode:
            return {"nvidia": [], "status": "nvidia-smi query failed"}
        devices = []
        for line in run.stdout.splitlines():
            parts = [x.strip() for x in line.split(",")]
            if len(parts) == 2:
                try:
                    devices.append({"name": parts[0], "vram_mib": int(parts[1])})
                except ValueError:
                    continue
        return {"nvidia": devices, "status": "detected" if devices else "no NVIDIA devices reported"}
    except (OSError, subprocess.TimeoutExpired):
        return {"nvidia": [], "status": "nvidia-smi unavailable or timed out"}


def validate_comfy_url(url):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("ComfyUI URL must be an http(s) URL without credentials or fragments")
    return url.rstrip("/")


def diagnose(comfy_url="http://127.0.0.1:8188", check_network=False, disk_path="."):
    url = validate_comfy_url(comfy_url)
    disk = shutil.disk_usage(Path(disk_path).resolve())
    report = {
        "schema_version": 1,
        "system": {"os": platform.system(), "architecture": platform.machine(), "python": platform.python_version()},
        "disk": {"free_gib": round(disk.free / 1024**3, 2)},
        "gpu": detect_gpus(),
        "tools": {"ffmpeg": _binary_version("ffmpeg"), "ffprobe": _binary_version("ffprobe"), "piper": _binary_version("piper", ("--help",))},
        "comfyui": {"url": url, "status": "not checked"},
    }
    if check_network:
        try:
            response = requests.get(f"{url}/system_stats", timeout=4)
            report["comfyui"]["status"] = "reachable" if response.ok else f"http {response.status_code}"
        except requests.RequestException:
            report["comfyui"]["status"] = "unreachable"
    devices = report["gpu"]["nvidia"]
    report["recommendation"] = (
        "GPU detected: benchmark a compatible ComfyUI workflow before selecting a model"
        if devices else "No NVIDIA GPU confirmed: use CPU-safe validation and consider a remote/cloud generation worker"
    )
    return report


def save_diagnostics(path, **kwargs):
    result = diagnose(**kwargs)
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_suffix(dest.suffix + ".tmp")
    temp.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, dest)
    return result
