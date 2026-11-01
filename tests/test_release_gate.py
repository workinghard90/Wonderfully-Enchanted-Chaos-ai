"""Offline tests for the release gate; no Render calls, writes, or AI requests."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from tools import release_gate


class Reply:
    def __init__(self, status, body):
        self.status = status
        self.body = io.BytesIO(body)

    def read(self, size=-1):
        return self.body.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.body.close()


class FakeOpener:
    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        route = request.full_url.split(".test", 1)[1]
        status, payload = self.routes[route]
        if status >= 300:
            raise HTTPError(request.full_url, status, "blocked", {}, None)
        return Reply(status, payload)


class ReleaseGateTests(unittest.TestCase):
    def test_requires_safe_origin(self):
        for target in (
            "http://example.com", "https://example.com/path",
            "https://user:password@example.com",
            "https://example.com/?token=secret",
            "https://example.com/#fragment",
            "file:///tmp/file", "https://example.com:invalid",
            "https://example.com:0",
        ):
            with self.subTest(target=target), self.assertRaises(ValueError):
                release_gate.validate_target(target)
        self.assertEqual(release_gate.validate_target("http://127.0.0.1:8765/"),
                         "http://127.0.0.1:8765")
        self.assertEqual(release_gate.validate_target("https://wec.test/"), "https://wec.test")

    def fixture(self, folder, *, tamper=False, auth=401, video=True, storage=True):
        paths = {"/api/health": (200, b'{"ok":true}'),
                 "/api/projects": (auth, b''),
                 "/api/video": (200, json.dumps({"ready": video, "jobs": [{"title": "Private"}]}).encode()),
                 "/api/creative/snapshots": (200, json.dumps({"enabled": storage, "snapshots": []}).encode())}
        for name, route in release_gate.ASSETS:
            original = ("fixture " + name).encode()
            (folder / name).write_bytes(original)
            paths[route] = (200, original + (b"x" if tamper and name == "app.js" else b""))
        return FakeOpener(paths)

    def test_all_checks_pass_without_writing_or_reporting_private_data(self):
        with tempfile.TemporaryDirectory() as directory:
            opener = self.fixture(Path(directory))
            with patch.object(release_gate, "build_opener", return_value=opener):
                result = release_gate.run_gate("https://wec.test", directory, token="private-secret")
            self.assertTrue(result["passed"], result["checks"])
            self.assertEqual(len(result["checks"]), 10)
            self.assertTrue(all(request.get_method() == "GET" for request in opener.requests))
            self.assertTrue(all(not request.full_url.endswith("private-secret") for request in opener.requests))
            protected = [req for req in opener.requests if "/api/video" in req.full_url or
                         "/api/creative/snapshots" in req.full_url]
            self.assertEqual(len(protected), 2)
            self.assertTrue(all(req.get_header("X-wec-token") == "private-secret" for req in protected))
            self.assertTrue(all(req.get_header("X-wec-token") is None for req in opener.requests if req not in protected))
            self.assertNotIn("private-secret", json.dumps(result))
            self.assertNotIn("Private", json.dumps(result))

    def test_wrong_build_is_not_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            opener = self.fixture(Path(directory), tamper=True)
            with patch.object(release_gate, "build_opener", return_value=opener):
                result = release_gate.run_gate("https://wec.test", directory, public_only=True)
            self.assertFalse(result["passed"])
            self.assertFalse(next(c for c in result["checks"] if c["name"] == "asset:app.js")["pass"])
            self.assertEqual(result["scope"], "public-only")

    def test_unsecured_api_is_a_blocker(self):
        with tempfile.TemporaryDirectory() as directory:
            opener = self.fixture(Path(directory), auth=200)
            with patch.object(release_gate, "build_opener", return_value=opener):
                result = release_gate.run_gate("https://wec.test", directory, public_only=True)
            self.assertFalse(result["passed"])
            self.assertFalse(next(c for c in result["checks"] if c["name"] == "authentication")["pass"])

    def test_missing_credential_and_unready_services_are_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            opener = self.fixture(Path(directory), video=False, storage=False)
            with patch.object(release_gate, "build_opener", return_value=opener):
                without = release_gate.run_gate("https://wec.test", directory)
            self.assertFalse(without["passed"])
            self.assertIn("owner credential", [c["name"] for c in without["checks"]])
            self.assertFalse(any("/api/video" in req.full_url for req in opener.requests))
            opener.requests.clear()
            with patch.object(release_gate, "build_opener", return_value=opener):
                not_ready = release_gate.run_gate("https://wec.test", directory, token="private-secret")
            self.assertFalse(not_ready["passed"])
            self.assertFalse(next(c for c in not_ready["checks"] if c["name"] == "video")["pass"])
            self.assertFalse(next(c for c in not_ready["checks"] if c["name"] == "storage")["pass"])

    def test_redirect_is_not_followed_and_does_not_leak_token(self):
        with tempfile.TemporaryDirectory() as directory:
            opener = self.fixture(Path(directory))
            opener.routes["/api/video"] = (302, b"redirect")
            with patch.object(release_gate, "build_opener", return_value=opener):
                result = release_gate.run_gate("https://wec.test", directory, token="private-secret")
            self.assertFalse(result["passed"])
            self.assertFalse(next(c for c in result["checks"] if c["name"] == "video")["pass"])


if __name__ == "__main__":
    unittest.main()
