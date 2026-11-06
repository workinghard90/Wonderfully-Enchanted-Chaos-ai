"""Server-side owner login contract: public pages, protected APIs and no leaks."""
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from wec_engine.studio import create_handler

TOKEN = "test-owner-master-login-token-32-characters"


class OwnerLoginTests(unittest.TestCase):
    def test_owner_status_requires_exact_token_and_public_pages_stay_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = ThreadingHTTPServer(("127.0.0.1", 0),
                create_handler(root/"studio.sqlite3", root, token=TOKEN))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                def get(path, secret=None):
                    headers = {"X-WEC-Token": secret} if secret is not None else {}
                    with urlopen(Request(base+path, headers=headers), timeout=10) as res:
                        return res.status, dict(res.headers), res.read()
                for path in ("/", "/studio", "/owner-login.js", "/api/health"):
                    with self.subTest(path=path):
                        status, headers, body = get(path)
                        self.assertEqual(status, 200)
                        self.assertNotIn(TOKEN.encode(), body)
                for secret in (None, "", "wrong-owner-master-login-token-32-chars"):
                    with self.subTest(secret=secret), self.assertRaises(HTTPError) as error:
                        get("/api/auth/status", secret)
                    self.assertEqual(error.exception.code, 401)
                status, headers, raw = get("/api/auth/status", TOKEN)
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(raw),
                    {"authenticated": True, "role": "owner",
                     "ai_requires_provider": True})
                self.assertEqual(headers.get("Cache-Control"), "no-store")
                self.assertNotIn(TOKEN.encode(), raw)
                with self.assertRaises(HTTPError) as error:
                    get("/api/automation/jobs")
                self.assertEqual(error.exception.code, 401)
                self.assertEqual(get("/api/automation/jobs", TOKEN)[0], 200)
            finally:
                server.shutdown()
                server.server_close()
                server.RequestHandlerClass.video_jobs.close()
                thread.join(timeout=5)
