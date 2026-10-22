"""The local artwork app is packaged and served without opening private APIs."""
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from wec_engine.studio import create_handler


class ColoringAssetsTests(unittest.TestCase):
    def test_assets_security_and_api_isolation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            handler = create_handler(root / 'studio.sqlite', root, token='private-story-token')
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                for route, mime in [('/coloring', 'text/html'), ('/coloring/', 'text/html'),
                                    ('/coloring/app.js', 'application/javascript'),
                                    ('/coloring/zip.js', 'application/javascript'),
                                    ('/coloring/project-store.js', 'application/javascript'),
                                    ('/coloring/print-check.js', 'application/javascript'),
                                    ('/coloring/style.css', 'text/css')]:
                    with self.subTest(route=route), urlopen(base + route) as response:
                        self.assertEqual(response.status, 200)
                        self.assertTrue(response.headers['Content-Type'].startswith(mime))
                        self.assertIn("script-src 'self'", response.headers['Content-Security-Policy'])
                        self.assertNotIn("'unsafe-inline'", response.headers['Content-Security-Policy'])
                        self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
                        self.assertTrue(response.read())
                with urlopen(base + '/') as response:
                    self.assertIn(b'href="/coloring/"', response.read())
                for route in ['/api/projects', '/api/backup', '/api/video']:
                    with self.subTest(route=route), self.assertRaises(HTTPError) as error:
                        urlopen(base + route)
                    self.assertEqual(error.exception.code, 401)
                for route in ['/coloring/../studio.py', '/coloring/%2e%2e/studio.py', '/coloring/index.html']:
                    with self.subTest(route=route), self.assertRaises(HTTPError) as error:
                        urlopen(Request(base + route, headers={'X-WEC-Token': 'private-story-token'}))
                    self.assertEqual(error.exception.code, 404)
            finally:
                server.shutdown(); server.server_close(); thread.join()
