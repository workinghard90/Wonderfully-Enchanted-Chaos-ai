"""Mocked adapter protocols; these are not live model generation tests."""
import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from wec_engine.animation import ComfyAnimation
from wec_engine.providers.comfy import ComfyProvider
from wec_engine.providers.cloud import CloudProvider
from wec_engine.orchestrator import run_production

class Response:
    def __init__(self,payload=None,content=b''):
        self.payload=payload;self.content=content
    def json(self):return self.payload
    def raise_for_status(self):pass

class ProviderTests(unittest.TestCase):
    def test_image_prompt_history_download(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);workflow=root/'image.json'
            workflow.write_text(json.dumps({'1':{'class_type':'SaveImage','inputs':{}}}))
            raw=io.BytesIO();Image.new('RGB',(512,512)).save(raw,format='PNG')
            history={'job':{'status':{'completed':True},'outputs':{'1':{'images':[{'filename':'result.png','subfolder':'images'}]}}}}
            with patch('wec_engine.providers.comfy.requests.post',return_value=Response({'prompt_id':'job'})) as post, patch('wec_engine.providers.comfy.requests.get',side_effect=[Response(history),Response(content=raw.getvalue())]) as get:
                output=ComfyProvider().generate(workflow,root/'out.png')
            with Image.open(output) as image:self.assertEqual(image.size,(512,512))
            self.assertIn('prompt',post.call_args.kwargs['json'])
            self.assertEqual(get.call_args.kwargs['params']['subfolder'],'images')
    def test_video_binding_history_download(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);workflow=root/'video.json'
            workflow.write_text(json.dumps({'1':{'class_type':'LoadImage','inputs':{'image':'old.png'}}}))
            history={'job':{'status':{'completed':True},'outputs':{'2':{'videos':[{'filename':'result.mp4'}]}}}}
            with patch('wec_engine.animation.requests.post',return_value=Response({'prompt_id':'job'})) as post, patch('wec_engine.animation.requests.get',side_effect=[Response(history),Response(content=b'mocked-video')]):
                output=ComfyAnimation().animate(workflow,root/'out.mp4',bindings={'1.image':'new.png'})
            self.assertEqual(output.read_bytes(),b'mocked-video')
            self.assertEqual(post.call_args.kwargs['json']['prompt']['1']['inputs']['image'],'new.png')
    def test_completed_video_without_supported_output_fails(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);workflow=root/'video.json';workflow.write_text('{}')
            with patch('wec_engine.animation.requests.post',return_value=Response({'prompt_id':'job'})), patch('wec_engine.animation.requests.get',return_value=Response({'job':{'status':{'completed':True},'outputs':{}}})):
                with self.assertRaisesRegex(RuntimeError,'without a supported video'):ComfyAnimation().animate(workflow,root/'out.mp4')
    def test_custom_cloud_gateway_contract(self):
        with tempfile.TemporaryDirectory() as td:
            provider=CloudProvider('https://gateway.example/image','test-key-only')
            with patch('wec_engine.providers.cloud.requests.post',return_value=Response({'image_base64':base64.b64encode(b'mocked-image').decode()})) as post:
                output=provider.generate('lantern',Path(td)/'out.png',references=['ref.png'])
            self.assertEqual(output.read_bytes(),b'mocked-image')
            self.assertEqual(post.call_args.kwargs['json']['references'],['ref.png'])
            self.assertEqual(post.call_args.kwargs['headers']['Authorization'],'Bearer test-key-only')
    def test_production_resolves_workflow_relative_to_plan(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);plan=root/'plan.json'
            plan.write_text(json.dumps({'duration':1,'scenes':[{'id':'scene-001','start':0,'duration':1,'prompt':'x','comfy_workflow':'image-api.json','narration':'x'}]}))
            def generate(scene,directory,**kwargs):
                self.assertEqual(scene['comfy_workflow'],str(root/'image-api.json'))
                output=Path(directory)/'scene-001.png';output.parent.mkdir(parents=True,exist_ok=True)
                Image.new('RGB',(512,512)).save(output)
                return {'image_path':str(output)}
            with patch('wec_engine.orchestrator.HybridRouter') as router, patch('wec_engine.orchestrator.render_stills'), patch('wec_engine.orchestrator.finalize_video'), patch('wec_engine.orchestrator.verify_delivery',return_value={'ok':True}):
                router.return_value.generate.side_effect=generate
                report=run_production(plan,root/'job',generate_images=True,allow_silent=True)
            self.assertTrue(report['ok'])
