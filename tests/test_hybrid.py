import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer
from wec_engine.studio import create_handler

class HybridTests(unittest.TestCase):
    def test_reject_insecure_origin(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ValueError):
                create_handler(Path(td)/'db', td, allowed_origin='http://example.com')
    def test_backup_auth_and_cors(self):
        with tempfile.TemporaryDirectory() as td:
            server=ThreadingHTTPServer(('127.0.0.1',0),create_handler(Path(td)/'db',td,token='secret',allowed_origin='https://studio.example'))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{server.server_port}'
            try:
                with self.assertRaises(HTTPError) as error: urlopen(base+'/api/backup')
                self.assertEqual(error.exception.code,401)
                req=Request(base+'/api/backup',headers={'X-WEC-Token':'secret','Origin':'https://studio.example'})
                with urlopen(req) as r:
                    self.assertEqual(r.headers['Access-Control-Allow-Origin'],'https://studio.example')
                    self.assertEqual(json.load(r)['projects'],[])
                req=Request(base+'/api/backup',headers={'X-WEC-Token':'secret','Origin':'https://evil.example'})
                with urlopen(req) as r: self.assertIsNone(r.headers.get('Access-Control-Allow-Origin'))
                req=Request(base+'/api/projects',method='OPTIONS',headers={'Origin':'https://studio.example','Access-Control-Request-Method':'POST'})
                with urlopen(req) as r: self.assertEqual(r.status,204)
            finally:
                server.shutdown();server.server_close();thread.join()
if __name__=='__main__':unittest.main()
