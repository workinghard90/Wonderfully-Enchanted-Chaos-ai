"""Validate a private WEC -> Cozy publishing handoff ZIP (stdlib only).

Usage: python -m tools.cozy_handoff_validate path/to/handoff.zip
Validation never publishes or modifies source files.
"""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import PurePosixPath

SCHEMA = "wec-cozy-handoff-v1"
MAX_ARCHIVE = 90 * 1024 * 1024
MAX_ENTRY = 42 * 1024 * 1024
MAX_ENTRIES = 100
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
PDF_EXT = {".pdf"}
FORBIDDEN = ("token", "secret", "password", "api_key", "private_key", "authorization")


def validate(path):
    errors = []
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES:
            errors.append("Too many ZIP entries")
        names = set()
        total = 0
        for entry in entries:
            name = entry.filename
            pure = PurePosixPath(name)
            if (name.startswith("/") or "\\" in name or ".." in pure.parts
                    or pure.is_absolute() or not name or name in names
                    or (entry.external_attr >> 16) & 0o170000 == 0o120000):
                errors.append("Unsafe or duplicate ZIP entry")
            names.add(name)
            total += entry.file_size
            if entry.file_size > MAX_ENTRY:
                errors.append("Oversized ZIP entry")
        if total > MAX_ARCHIVE:
            errors.append("Uncompressed package exceeds limit")
        if "manifest.json" not in names:
            errors.append("Missing manifest.json")
        if errors:
            return errors
        if archive.getinfo("manifest.json").file_size > 64 * 1024:
            return ["Manifest too large"]
        try:
            manifest = json.loads(archive.read("manifest.json"))
        except (ValueError, UnicodeError):
            return ["Invalid manifest JSON"]
        if not isinstance(manifest, dict):
            return ["Manifest must be an object"]
        if any(word in str(key).lower() for key in manifest for word in FORBIDDEN):
            errors.append("Manifest contains forbidden credential-like field")
        if manifest.get("schemaVersion") != SCHEMA:
            errors.append("Unsupported schema version")
        if not SLUG.fullmatch(str(manifest.get("productSlug", ""))):
            errors.append("Invalid product slug")
        for field in ("sourceProjectId", "title", "creator", "productType", "description"):
            value = manifest.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 4000:
                errors.append("Invalid or missing " + field)
        if manifest.get("publicationStatus") not in ("draft", "approved"):
            errors.append("Invalid publication status")
        if manifest.get("purchaseUrl") is not None:
            errors.append("Purchase URL must remain unset in owner handoff")
        assets = manifest.get("assets")
        kdp = manifest.get("kdp")
        if not isinstance(assets, dict) or not isinstance(kdp, dict):
            return errors + ["Invalid assets or KDP section"]
        referenced = []
        cover = assets.get("cover")
        if cover is not None:
            referenced.append((cover, IMAGE_EXT, "assets/"))
        previews = assets.get("previews", [])
        if not isinstance(previews, list) or len(previews) > 40:
            errors.append("Invalid preview list")
        else:
            referenced.extend((p, IMAGE_EXT, "assets/") for p in previews)
        for key in ("interior", "cover"):
            item = kdp.get(key)
            if item is not None:
                referenced.append((item, PDF_EXT, "kdp/"))
        for item, extensions, prefix in referenced:
            if not isinstance(item, str) or item not in names or not item.startswith(prefix) or PurePosixPath(item).suffix.lower() not in extensions:
                errors.append("Missing or invalid referenced asset")
        for name in names:
            if name != "manifest.json" and not name.endswith("/") and not (name.startswith("assets/") or name.startswith("kdp/")):
                errors.append("Unexpected package file")
        # Optional SHA-256 checksums are mandatory for each referenced file.
        checksums = manifest.get("sha256")
        if not isinstance(checksums, dict):
            errors.append("Missing sha256 checksums")
        else:
            for item, _, _ in referenced:
                if isinstance(item, str) and item in names:
                    expected = checksums.get(item)
                    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                        errors.append("Missing checksum: " + item)
                    elif hashlib.sha256(archive.read(item)).hexdigest() != expected:
                        errors.append("Checksum mismatch: " + item)
    return errors


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python -m tools.cozy_handoff_validate handoff.zip")
    try:
        issues = validate(sys.argv[1])
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        sys.exit("Invalid package: " + str(exc))
    if issues:
        sys.exit("Invalid package:\\n- " + "\\n- ".join(issues))
    print("Handoff package validated; no publication performed.")
