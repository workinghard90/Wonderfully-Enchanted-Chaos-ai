"""Integration regressions found while reconciling the phase archives."""
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from PIL import Image
from wec_engine.cli import main as cli
from wec_engine.integration import prepare_video_reference
from wec_engine.orchestrator import run_production
from wec_engine.router import HybridRouter
from wec_engine.studio import create_handler, main as studio_main
from wec_engine.story import plan_story


class RegressionTests(unittest.TestCase):
    def test_plan_validation(self):
        for duration in (True, None, [], float('inf'), float('nan')):
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                plan_story('A lantern', total_duration=duration)
        for scenes in (True, 0, 101):
            with self.assertRaises(ValueError):
                plan_story('A lantern', scene_count=scenes)
        with self.assertRaises(ValueError):
            plan_story('A lantern', total_duration=.01)

    def test_new_output_directory_and_nonfinite_budget(self):
        class Local:
            def available(self): return True
            def generate(self, _, target): Image.new('RGB', (512, 512)).save(target)
        with tempfile.TemporaryDirectory() as td:
            result = HybridRouter(comfy=Local()).generate({'id':'a','prompt':'a','comfy_workflow':'x'}, Path(td)/'new')
            self.assertTrue(Path(result['image_path']).is_file())
            for estimate, budget in ((float('nan'), 1), (1, float('nan')), (float('inf'), 2)):
                with self.assertRaises(ValueError):
                    HybridRouter().generate({'id':'b','prompt':'b'}, td, allow_cloud=True, cloud_estimate_usd=estimate, cloud_budget_usd=budget)

    def test_render_options_change_rejects_resume(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); plan = root/'plan.json'
            plan.write_text(json.dumps({'duration':1,'scenes':[{'id':'a','duration':1}]}))
            with self.assertRaises(FileNotFoundError):
                run_production(plan,root/'job',allow_silent=True)
            with self.assertRaisesRegex(ValueError,'options changed'):
                run_production(plan,root/'job',allow_silent=True,captions=False)

    def test_cli_relative_workflow_and_explicit_worker(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); scene=root/'scene.json'
            scene.write_text(json.dumps({'id':'a','prompt':'test','comfy_workflow':'workflow.json'}))
            with patch('wec_engine.cli.HybridRouter') as router:
                router.return_value.generate.return_value={}
                cli(['generate',str(scene),'--comfy-url','http://127.0.0.1:9191'])
                self.assertEqual(router.return_value.generate.call_args.args[0]['comfy_workflow'],str(root/'workflow.json'))

    def test_delivery_failure_exit_code(self):
        with patch('wec_engine.cli.verify_delivery', return_value={'ok':False}):
            self.assertEqual(cli(['verify-delivery','bad.mp4']),1)

    def test_worker_environment(self):
        from wec_engine.animation import ComfyAnimation
        from wec_engine.providers.comfy import ComfyProvider
        with patch.dict('os.environ', {'WEC_COMFY_URL':'http://127.0.0.1:9191/'}):
            for provider in (ComfyAnimation, ComfyProvider):
                self.assertEqual(provider().base_url,'http://127.0.0.1:9191')
                self.assertEqual(provider('http://localhost:8188').base_url,'http://localhost:8188')

    def test_remote_studio_requires_strong_token(self):
        with patch.dict('os.environ', {'WEC_STUDIO_TOKEN':'weak'}):
            with self.assertRaises(SystemExit): studio_main(['--host','0.0.0.0'])

    def test_origin_validation(self):
        with tempfile.TemporaryDirectory() as td:
            for origin in ('https://example.com?x=1','https://example.com#frag','https://a:b@example.com','https://example.com/','https://example.com:bad'):
                with self.subTest(origin=origin), self.assertRaises(ValueError):
                    create_handler(Path(td)/'db',td,allowed_origin=origin)

    def test_reference_subfolder(self):
        with tempfile.TemporaryDirectory() as td:
            workflow=Path(td)/'w.json'
            workflow.write_text(json.dumps({'1':{'class_type':'LoadImage','inputs':{'image':'old'}}, '2':{'class_type':'SaveVideo','inputs':{}}}))
            with patch('wec_engine.integration.upload_reference',return_value={'name':'new.png','subfolder':'refs'}):
                self.assertEqual(prepare_video_reference(workflow,'image.png','1.image'),{'1.image':'refs/new.png'})


class ApiRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),create_handler(self.root/'db',self.root,token='secret',allowed_origin='https://studio.example'))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def request(self,path,payload=None,method=None,origin=None):
        headers={'X-WEC-Token':'secret'}
        if origin: headers['Origin']=origin
        if payload is not None: headers['Content-Type']='application/json'
        request=Request(self.base+path,data=json.dumps(payload).encode() if payload is not None else None,headers=headers,method=method)
        with urlopen(request) as response: return response.status,response.read(),response.headers
    def test_crud_plan_backup_and_side_effect_free_dry_run(self):
        payload={'title':'<script>Safe text</script>','story':'A lantern flew through the sky.','duration':35,'scenes':7}
        _,body,_=self.request('/api/projects',payload);project=json.loads(body);path='/api/projects/'+project['id']
        _,body,_=self.request(path);self.assertEqual(json.loads(body)['story'],payload['story'])
        payload['title']='Updated';self.request(path,payload)
        _,body,_=self.request(path+'/plan');self.assertEqual(json.loads(body)['title'],'Updated')
        self.request(path+'/dry-run');self.assertFalse((self.root/'projects').exists())
        _,body,_=self.request('/api/backup');self.assertEqual(len(json.loads(body)['projects']),1)
        for asset in ('/','/app.js','/style.css','/config.js','/api/health'):
            self.assertEqual(self.request(asset)[0],200)
    def test_bad_payloads_are_client_errors(self):
        for value in ([],{'title':'a','story':'hello','duration':[],'scenes':1},{'title':'a','story':'hello','duration':True,'scenes':1},{'title':'a','story':'hello','duration':35,'scenes':True}):
            with self.assertRaises(HTTPError) as error: self.request('/api/projects',value)
            self.assertEqual(error.exception.code,400)
    def test_missing_project_and_denied_preflight(self):
        with self.assertRaises(HTTPError) as error:self.request('/api/projects/'+'a'*32)
        self.assertEqual(error.exception.code,404)
        with self.assertRaises(HTTPError) as error:self.request('/api/projects',method='OPTIONS',origin='https://other.example')
        self.assertEqual(error.exception.code,403)
