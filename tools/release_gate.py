"""Read-only release gate for the WEC owner-operated studio.

Compares deployed static bytes against THIS checkout and checks authentication,
video readiness, and persistent snapshot availability. Never writes to WEC,
starts a render, or contacts an inference provider.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

SOURCE = Path(__file__).resolve().parents[1] / "wec_engine" / "studio_web" / "creative"
ASSETS = (
    ("index.html", "/studio/"),
    ("app.js", "/studio/app.js"),
    ("video.js", "/studio/video.js"),
    ("store.js", "/studio/store.js"),
    ("artwork-picker.js", "/studio/artwork-picker.js"),
    ("style.css", "/studio/style.css"),
)
MAX_RESPONSE = 2 * 1024 * 1024


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_target(value):
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("Invalid target port") from None
    local = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or (parsed.scheme == "http" and not local) or parsed.username
            or parsed.password or parsed.path not in ("", "/") or parsed.query
            or parsed.fragment or port == 0):
        raise ValueError("Use a bare HTTPS origin (HTTP allowed for loopback only), without credentials or URL parameters")
    return value.rstrip("/")


def _get(opener, origin, route, token=None, timeout=10):
    headers = {"Accept": "application/json" if route.startswith("/api/") else "*/*"}
    if token is not None:
        headers["X-WEC-Token"] = token
    request = Request(origin + route, headers=headers, method="GET")
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                raise ValueError("Response exceeded safe read limit")
            return response.status, body
    except HTTPError as error:
        # No redirected request is followed. Never send the owner token elsewhere.
        return error.code, b""


def run_gate(url, source=SOURCE, *, token=None, public_only=False, timeout=10):
    origin = validate_target(url)
    source = Path(source)
    checks = []
    opener = build_opener(_NoRedirect)

    def record(name, ok, detail):
        checks.append({"name": name, "pass": bool(ok), "detail": detail})

    def probe(route, *, credential=None):
        try:
            return _get(opener, origin, route, token=credential, timeout=timeout)
        except (URLError, OSError, TimeoutError, ValueError) as exc:
            record("network:" + route, False, "Network or response error: " + type(exc).__name__)
            return None, b""

    status, raw = probe("/api/health")
    try:
        health = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        health = None
    record("health", status == 200 and isinstance(health, dict) and health.get("ok") is True,
           "Health endpoint returned expected OK" if status == 200 and health == {"ok": True} else "Health endpoint did not report OK")

    for filename, route in ASSETS:
        path = source / filename
        try:
            expected = path.read_bytes()
        except OSError:
            record("asset:" + filename, False, "Expected source file unavailable")
            continue
        status, deployed = probe(route)
        exact = status == 200 and hashlib.sha256(deployed).digest() == hashlib.sha256(expected).digest()
        record("asset:" + filename, exact,
               "Exact deployed bytes match source" if exact else "Deployment differs from the selected checkout (or file unavailable)")

    status, _ = probe("/api/projects")
    record("authentication", status == 401,
           "Unauthenticated project request rejected" if status == 401 else "Owner API not securely rejected; do not release")

    if not public_only:
        if not token:
            record("owner credential", False, "Set WEC_STUDIO_TOKEN in the shell; never put it in a URL or command argument")
        else:
            for route, name in (("/api/video", "video"), ("/api/creative/snapshots", "storage")):
                status, data = probe(route, credential=token)
                try:
                    payload = json.loads(data)
                except (ValueError, UnicodeDecodeError):
                    payload = None
                ready = status == 200 and isinstance(payload, dict) and payload.get("ready" if name == "video" else "enabled") is True
                record(name, ready,
                       name.title() + " reports ready" if ready else name.title() + " unavailable, unauthorized, or disabled")
    return {"schema_version": 1, "scope": "public-only" if public_only else "owner-read-only",
            "target": origin, "checks": checks,
            "passed": all(item["pass"] for item in checks),
            "note": "A passing gate is not proof of disk persistence across restart, video quality, or billing configuration."}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check WEC production without writes or paid inference")
    parser.add_argument("--url", required=True, help="Bare HTTPS origin, e.g. https://your-service.onrender.com")
    parser.add_argument("--source", default=str(SOURCE), help="Creative studio source directory in the intended Git checkout")
    parser.add_argument("--public-only", action="store_true", help="Skip authenticated readiness; not a full release gate")
    parser.add_argument("--timeout", type=float, default=10)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 60:
        parser.error("Timeout must be between 0 and 60 seconds")
    try:
        result = run_gate(args.url, args.source, token=os.getenv("WEC_STUDIO_TOKEN"),
                          public_only=args.public_only, timeout=args.timeout)
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
