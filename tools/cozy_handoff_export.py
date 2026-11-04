"""Create a reviewed WEC -> Cozy handoff ZIP from an owner-prepared manifest.

Usage:
  python -m tools.cozy_handoff_export manifest.json assets-root output.zip

The manifest uses the v1 handoff schema; referenced paths are relative to
assets-root. This is an offline, explicit owner action, not website publishing.
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

from tools.cozy_handoff_validate import validate, MAX_ENTRY, MAX_ARCHIVE


def export(manifest_path, asset_root, output_path):
    manifest_path, asset_root, output_path = map(Path, (manifest_path, asset_root, output_path))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("Manifest must be an object")
    assets = manifest.get("assets", {})
    kdp = manifest.get("kdp", {})
    if not isinstance(assets, dict) or not isinstance(kdp, dict):
        raise ValueError("Invalid assets or KDP section")
    previews = assets.get("previews", [])
    if not isinstance(previews, list):
        raise ValueError("Invalid preview list")
    paths = [assets.get("cover"), *previews, kdp.get("interior"), kdp.get("cover")]
    paths = list(dict.fromkeys(p for p in paths if p is not None))
    checksums = {}
    total = 0
    payloads = {}
    root = asset_root.resolve(strict=True)
    for name in paths:
        if not isinstance(name, str) or not name or "\\" in name or ".." in PurePosixPath(name).parts or name.startswith("/"):
            raise ValueError("Unsafe asset path")
        source = (root / name).resolve(strict=True)
        if not source.is_file() or not source.is_relative_to(root):
            raise ValueError("Asset outside root or not a file: " + name)
        data = source.read_bytes()
        total += len(data)
        if len(data) > MAX_ENTRY or total > MAX_ARCHIVE:
            raise ValueError("Package size limit exceeded")
        payloads[name] = data
        checksums[name] = hashlib.sha256(data).hexdigest()
    manifest["sha256"] = checksums
    raw = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    if len(raw) > 64 * 1024:
        raise ValueError("Manifest too large")
    if output_path.exists():
        raise FileExistsError("Refusing to overwrite existing output")
    # Validate before returning the ZIP. Delete an invalid partial artifact.
    try:
        with zipfile.ZipFile(output_path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", raw)
            for name, data in payloads.items():
                archive.writestr(name, data)
        problems = validate(output_path)
        if problems:
            raise ValueError("; ".join(problems))
    except Exception:
        output_path.unlink(missing_ok=True)
        raise
    return output_path


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("Usage: python -m tools.cozy_handoff_export manifest.json assets-root output.zip")
    try:
        result = export(*sys.argv[1:])
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        sys.exit("Export failed: " + str(exc))
    print("Validated private handoff created:", result)
