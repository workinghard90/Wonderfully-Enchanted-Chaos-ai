import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer
from wec_engine.studio import init_db, save_project, list_projects, project_plan, create_handler

class StudioTests(unittest.TestCase):
    def test_store_and_plan(self):
        with tempfile.TemporaryDirectory() as td:
            db = init_db(Path(td)/'db.sqlite')
            p = save_project(db, {'title':'Lantern','story':'A lantern flew across the sky.','duration':35,'scenes':7})
            self.assertEqual(len(list_projects(db)), 1)
            self.assertEqual(len(project_plan(p)['scenes']), 7)
            p['title'] = 'New title'
            save_project(db, p, p['id'])
            self.assertEqual(len(list_projects(db)), 1)
    def test_validation(self):
        with tempfile.TemporaryDirectory() as td:
            db = init_db(Path(td)/'db.sqlite')
            with self.assertRaises(ValueError):
                save_project(db, {'title':'','story':'abc','duration':35,'scenes':7})
            with self.assertRaises(ValueError):
                save_project(db, {'title':'Valid','story':'abc','duration':35,'scenes':0})
    def test_http_auth_and_dry_run(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            server = ThreadingHTTPServer(('127.0.0.1',0),create_handler(root/'db.sqlite',root,token='secret'))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{server.server_port}'
            try:
                with self.assertRaises(HTTPError) as ctx:
                    urlopen(base+'/api/projects')
                self.assertEqual(ctx.exception.code,401)
                data=json.dumps({'title':'Lantern','story':'The lantern rose into the sky.','duration':35,'scenes':7}).encode()
                req=Request(base+'/api/projects',data=data,headers={'X-WEC-Token':'secret'},method='POST')
                with urlopen(req) as r: p=json.load(r)
                req=Request(base+'/api/projects/'+p['id']+'/dry-run',headers={'X-WEC-Token':'secret'})
                with urlopen(req) as r: result=json.load(r)
                self.assertTrue(result['dry_run'])
                self.assertTrue(result['tasks'])
            finally:
                server.shutdown();server.server_close();thread.join()
if __name__=='__main__':unittest.main()
