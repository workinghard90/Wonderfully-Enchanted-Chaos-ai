"""Mocked provider protocol and HTTP generation; never calls a live AI service."""
import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from PIL import Image
import requests
from wec_engine.providers.cloudflare_images import CloudflareImages, GenerationError, MODEL, REFERENCE_MODEL, prepare_reference
from wec_engine import studio_store as store
from wec_engine.studio import create_handler

ACCOUNT = 'a' * 32
TOKEN = 'provider-test-token-do-not-use'
PROJECT = {'title': 'Lantern', 'story': 'A tiny lantern helps a fox.', 'duration': 10, 'scenes': 2}


def image_bytes():
    output = io.BytesIO(); Image.new('RGB', (512, 512), 'gold').save(output, format='JPEG')
    return output.getvalue()


def response(body=None, status=200, chunks=None):
    value = Mock(); value.status_code = status
    value.__enter__ = Mock(return_value=value); value.__exit__ = Mock(return_value=False)
    value.iter_content.return_value = chunks if chunks is not None else [json.dumps(body).encode()]
    return value


def image_response(raw=None):
    return response({'success': True, 'result': {'image': base64.b64encode(image_bytes() if raw is None else raw).decode()}})


class ProviderTests(unittest.TestCase):
    def provider(self, **kwargs):
        return CloudflareImages(ACCOUNT, TOKEN, enabled=True, **kwargs)

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_explicit_enable_and_valid_config_required(self, post):
        for account, token, enabled in ((ACCOUNT, TOKEN, False), ('bad', TOKEN, True), (ACCOUNT, '', True), (ACCOUNT, 'bad\nheader', True)):
            with self.subTest(account=account, enabled=enabled), self.assertRaises(GenerationError):
                CloudflareImages(account, token, enabled).generate('A lantern')
        post.assert_not_called()

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_official_rest_protocol_and_fixed_model(self, post):
        post.return_value = image_response()
        raw = self.provider().generate(' A lantern ')
        self.assertEqual(raw, image_bytes())
        args, kwargs = post.call_args
        self.assertEqual(args[0], f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run/{MODEL}')
        self.assertEqual(kwargs['json'], {'prompt': 'A lantern', 'steps': 4})
        self.assertEqual(kwargs['headers']['Authorization'], 'Bearer ' + TOKEN)
        self.assertEqual(kwargs['timeout'], (5, 45))
        self.assertFalse(kwargs['allow_redirects']); self.assertTrue(kwargs['stream'])
        self.assertEqual(post.call_count, 1)

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_invalid_prompts_make_no_call(self, post):
        for prompt in (None, {}, '', ' ', 'x' * 2049, '\ud800'):
            with self.subTest(prompt=str(prompt)[:20]), self.assertRaises(ValueError): self.provider().generate(prompt)
        post.assert_not_called()

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_safe_provider_errors_and_no_retry(self, post):
        for upstream, expected in ((401, 503), (403, 503), (429, 429), (302, 502), (500, 502)):
            post.reset_mock(); post.return_value = response({'secret': TOKEN}, upstream)
            with self.subTest(upstream=upstream), self.assertRaises(GenerationError) as caught:
                self.provider().generate('A lantern')
            self.assertEqual(caught.exception.status, expected)
            self.assertNotIn(TOKEN, str(caught.exception)); self.assertNotIn(ACCOUNT, str(caught.exception))
            self.assertEqual(post.call_count, 1)
        for error, status in ((requests.Timeout(TOKEN), 504), (requests.ConnectionError(TOKEN), 502)):
            post.side_effect = error
            with self.assertRaises(GenerationError) as caught: self.provider().generate('A lantern')
            self.assertEqual(caught.exception.status, status); self.assertNotIn(TOKEN, str(caught.exception))

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_malformed_oversized_and_invalid_image_responses(self, post):
        for body in ({'success': False, 'errors': [TOKEN]}, [], {'success': True, 'result': {'image': '%%%'}}, {'success': True, 'result': {}}):
            post.return_value = response(body)
            with self.assertRaises(GenerationError): self.provider().generate('A lantern')
        for raw in (b'<svg/>', b'not an image'):
            post.return_value = image_response(raw)
            with self.assertRaises(GenerationError): self.provider().generate('A lantern')
        post.return_value = image_response()
        with patch('wec_engine.providers.cloudflare_images.MAX_RESPONSE', 1), self.assertRaises(GenerationError):
            self.provider().generate('A lantern')


class ReferenceProviderTests(unittest.TestCase):
    def test_normalization_preserves_source_and_bounds_upload(self):
        source = io.BytesIO()
        Image.new('RGBA', (1400, 700), (80, 40, 130, 128)).save(source, format='PNG')
        original = source.getvalue()
        normalized = prepare_reference(base64.b64encode(original).decode())
        with Image.open(io.BytesIO(normalized)) as image:
            self.assertEqual(image.size, (512, 256))
            self.assertEqual(image.mode, 'RGB')
            self.assertEqual(image.format, 'PNG')
            self.assertFalse(image.info)
        self.assertEqual(source.getvalue(), original)

    def test_invalid_references_fail_locally(self):
        for encoded in (None, '', '%%%', base64.b64encode(b'<svg/>').decode()):
            with self.subTest(encoded=encoded), self.assertRaises(ValueError):
                prepare_reference(encoded)
        with patch('wec_engine.providers.cloudflare_images.MAX_REFERENCE', 1), self.assertRaises(ValueError):
            prepare_reference(base64.b64encode(image_bytes()).decode())
        source = io.BytesIO(); Image.new('RGB', (4000, 3001)).save(source, format='PNG')
        with self.assertRaises(ValueError): prepare_reference(base64.b64encode(source.getvalue()).decode())

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_multipart_reference_protocol_no_fallback(self, post):
        ref = prepare_reference(base64.b64encode(image_bytes()).decode())
        provider = CloudflareImages(ACCOUNT, TOKEN, enabled=True)
        post.return_value = image_response()
        self.assertEqual(provider.generate('Keep image 0 character', reference=ref), image_bytes())
        args, kwargs = post.call_args
        self.assertTrue(args[0].endswith(REFERENCE_MODEL))
        self.assertEqual(kwargs['data'], {'prompt':'Keep image 0 character', 'width':'1024', 'height':'1024'})
        self.assertEqual(kwargs['files']['input_image_0'], ('reference.png', ref, 'image/png'))
        self.assertNotIn('json', kwargs)
        self.assertNotIn('Content-Type', kwargs['headers'])
        self.assertFalse(kwargs['allow_redirects'])
        for status in (429, 500):
            post.reset_mock(); post.return_value = response(status=status)
            with self.assertRaises(GenerationError): provider.generate('Keep character', reference=ref)
            self.assertEqual(post.call_count, 1)
            self.assertTrue(post.call_args.args[0].endswith(REFERENCE_MODEL))


class GenerationApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name); self.db = self.root/'db'
        self.env = patch.dict('os.environ', {'WEC_ENABLE_IMAGE_GENERATION': '1', 'WEC_CLOUDFLARE_ACCOUNT_ID': ACCOUNT, 'WEC_CLOUDFLARE_API_TOKEN': TOKEN})
        self.env.start(); self.addCleanup(self.env.stop)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), create_handler(self.db, self.root, token='studio-test'))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.project = store.save_project(self.db, PROJECT); self.pid = self.project['id']
        self.route = '/api/projects/'+self.pid+'/scenes/scene-001/generate'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()

    def request(self, path, payload=None, token='studio-test'):
        req = Request(self.base+path, data=json.dumps(payload).encode() if payload is not None else None, headers={'X-WEC-Token': token})
        try: result = urlopen(req, timeout=10)
        except HTTPError as error: result = error
        with result: return result.status, json.load(result)

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_authentication_and_status_never_expose_secrets(self, post):
        for path, payload in (('/api/generation', None), (self.route, {'prompt': 'A lantern'})):
            self.assertEqual(self.request(path, payload, token='wrong')[0], 401)
        code, value = self.request('/api/generation')
        self.assertEqual(code, 200); self.assertTrue(value['ready']); self.assertEqual(value['attempts_today'], 0)
        self.assertNotIn(TOKEN, json.dumps(value)); self.assertNotIn(ACCOUNT, json.dumps(value))
        post.assert_not_called()

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_disabled_provider_cannot_be_called_through_api(self, post):
        with patch('wec_engine.providers.cloudflare_images.CloudflareImages.ready', return_value=False):
            self.assertFalse(self.request('/api/generation')[1]['ready'])
            self.assertEqual(self.request(self.route, {'prompt': 'A lantern'})[0], 503)
        self.assertEqual(store.generation_usage(self.db), 0); post.assert_not_called()

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_generated_image_is_stored_backed_up_and_not_overwritten(self, post):
        post.return_value = image_response()
        code, value = self.request(self.route, {'prompt': 'A tiny lantern'})
        self.assertEqual(code, 200); self.assertEqual(value['width'], 512)
        self.assertEqual(store.get_project(self.db, self.pid)['image_count'], 1)
        self.assertEqual(len(store.export_backup(self.db)['projects'][0]['scene_images']), 1)
        self.assertEqual(self.request('/api/generation')[1]['attempts_today'], 1)
        before = store.get_scene_image(self.db, self.pid, 'scene-001')
        self.assertEqual(self.request(self.route, {'prompt': 'A different lantern'})[0], 409)
        self.assertEqual(post.call_count, 1); self.assertEqual(store.get_scene_image(self.db, self.pid, 'scene-001'), before)

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_invalid_input_missing_scene_and_storage_make_no_call(self, post):
        self.assertEqual(self.request(self.route, {'prompt': ''})[0], 400)
        self.assertEqual(self.request(self.route.replace('scene-001', 'scene-999'), {'prompt': 'A lantern'})[0], 404)
        self.assertEqual(self.request(self.route.replace(self.pid, 'f'*32), {'prompt': 'A lantern'})[0], 404)
        with patch.object(store, 'MAX_STUDIO_IMAGE_BYTES', 1):
            self.assertEqual(self.request(self.route, {'prompt': 'A lantern'})[0], 413)
        self.assertEqual(store.generation_usage(self.db), 0); post.assert_not_called()

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_failures_consume_attempts_and_daily_quota_stops_calls(self, post):
        post.return_value = response(status=429)
        with patch.object(store, 'MAX_GENERATIONS_PER_DAY', 1):
            self.assertEqual(self.request(self.route, {'prompt': 'A lantern'})[0], 429)
            self.assertEqual(self.request(self.route, {'prompt': 'A lantern'})[0], 429)
        self.assertEqual(post.call_count, 1); self.assertEqual(store.generation_usage(self.db), 1)
        self.assertEqual(store.get_project(self.db, self.pid)['image_count'], 0)
        with patch.object(store, '_generation_day', return_value='2099-01-01'):
            self.assertEqual(store.generation_usage(self.db), 0)

    @patch('wec_engine.providers.cloudflare_images.requests.post')
    def test_concurrent_operations_and_story_change_discard_stale_result(self, post):
        started, finish = threading.Event(), threading.Event()
        def generate(*args, **kwargs):
            started.set(); self.assertTrue(finish.wait(8)); return image_response()
        post.side_effect = generate
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.request, self.route, {'prompt': 'A lantern'})
            try:
                self.assertTrue(started.wait(5))
                self.assertEqual(self.request(self.route, {'prompt': 'Another lantern'})[0], 429)
                store.save_project(self.db, dict(PROJECT, story='Changed story'), self.pid)
            finally: finish.set()
            self.assertEqual(future.result()[0], 409)
        self.assertEqual(post.call_count, 1); self.assertEqual(store.get_project(self.db, self.pid)['image_count'], 0)

    def test_generated_save_also_preserves_a_picture_added_in_the_meantime(self):
        store.reserve_generation(self.db, self.pid, 'scene-001', self.project)
        store.save_scene_image(self.db, self.pid, 'scene-001', image_bytes())
        with self.assertRaises(store.ProjectConflictError):
            store.save_scene_image(self.db, self.pid, 'scene-001', image_bytes(), expected_project=self.project)
