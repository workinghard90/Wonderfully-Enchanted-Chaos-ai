"""Creative exports and provider limits, without live AI calls."""
import base64
import io
import json
from pathlib import Path
import re
import tempfile
import threading
import unittest
from unittest.mock import patch, MagicMock
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer

from PIL import Image
from wec_engine import creative
from wec_engine import studio_store as store
from wec_engine.studio import create_handler
from wec_engine.providers.cloudflare_text import CloudflareText, draft_settings, validate_draft
from wec_engine.providers.cloudflare_images import GenerationError


def picture():
    output = io.BytesIO()
    Image.new('RGBA', (200, 300), (120, 30, 210, 125)).save(output, format='PNG')
    return base64.b64encode(output.getvalue()).decode('ascii')


def project(kind='coloring', count=2):
    return {'kind': kind, 'title': 'Pip’s cozy world', 'author': 'Melody Autumn Hall',
            'duration': 10, 'pages': [{'text': 'A cloud found a little star.', 'image_base64': picture()} for _ in range(count)]}


class CreativeTests(unittest.TestCase):
    def test_coloring_pdf_front_matter_and_blank_backs(self):
        pdf = creative.book_pdf(project())
        self.assertTrue(pdf.startswith(b'%PDF-'))
        self.assertEqual(len(re.findall(rb'/Type /Page\b', pdf)), 6)
        self.assertIn(b'/MediaBox [ 0 0 612 792 ]', pdf)
        self.assertIn(b'/DeviceGray', pdf)
        self.assertIn(b'/FontFile2', pdf)

    def test_storybook_double_sided_even_count(self):
        for count, expected in [(1, 4), (2, 4), (3, 6)]:
            self.assertEqual(len(re.findall(rb'/Type /Page\b', creative.book_pdf(project('storybook', count)))), expected)

    def test_cover_spine_tracks_exported_pages_and_paper(self):
        for kind, count, factor in [('coloring', 40, .002252), ('storybook', 22, .002347)]:
            value = project(kind,count);value['back_text']='A cozy little world to enjoy together.'
            pdf=creative.cover_pdf(value)
            self.assertEqual(len(re.findall(rb'/Type /Page\b',pdf)),1)
            pages=2+count*2 if kind=='coloring' else 2+count+(count%2)
            box=re.search(rb'/MediaBox \[ 0 0 ([0-9.]+) 810 \]',pdf)
            self.assertIsNotNone(box)
            self.assertAlmostEqual(float(box[1]),1242+pages*factor*72,places=3)
            self.assertNotIn(b'/SMask',pdf)

    def test_bad_images_missing_text_and_overflow_rejected(self):
        value = project('storybook')
        for invalid in ['bad', base64.b64encode(b'<svg/>').decode('ascii'), '']:
            value['pages'][0]['image_base64'] = invalid
            with self.assertRaises(ValueError):
                creative.book_pdf(value)
        value = project('storybook'); value['pages'][0]['text'] = ''
        with self.assertRaises(ValueError):
            creative.book_pdf(value)
        value['pages'][0]['text'] = 'very long words ' * 90
        with self.assertRaisesRegex(ValueError, 'too much text'):
            creative.book_pdf(value)
        value['pages'][0]['text'] = 'X' * 200
        with self.assertRaisesRegex(ValueError, 'word is too long'):
            creative.book_pdf(value)
        with patch.object(creative, 'MAX_PIXELS', 100):
            with self.assertRaises(store.StorageLimitError):
                creative.prepare(project())

    def test_video_handoff_is_atomic_and_preserves_scene_assignment(self):
        with tempfile.TemporaryDirectory() as temp:
            db = store.init_db(Path(temp)/'studio.sqlite3')
            value = project('video'); value['pages'][0]['text'] = 'A cloud found a little star.'
            value['pages'][1]['text'] = 'The star shone bright at home.'
            pid = creative.video_project(db, value)['projects'][0]['id']
            saved = store.get_project(db, pid)
            self.assertEqual(saved['image_count'], 2)
            planned = store.project_plan(saved)
            self.assertEqual(planned['scenes'][0]['narration'], value['pages'][0]['text'])
            value['pages'][0]['text'] = 'Short.'
            with self.assertRaisesRegex(ValueError, 'Scene text changed'):
                creative.video_project(db, value)
            self.assertEqual(len(store.list_projects(db)), 1)

    def test_shared_image_budget_and_separate_text_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            db = store.init_db(Path(temp)/'studio.sqlite3')
            for _ in range(20):
                store.reserve_creative_generation(db)
            p = store.save_project(db, {'title': 'A', 'story': 'A star.', 'duration': 10, 'scenes': 1})
            with self.assertRaises(store.GenerationLimitError):
                store.reserve_generation(db, p['id'], 'scene-001', p)
            for _ in range(5):
                store.reserve_text_generation(db)
            with self.assertRaises(store.GenerationLimitError):
                store.reserve_text_generation(db)

    def test_video_planning_rejects_renderer_limits(self):
        for story, count, message in [
            ('word ' * 101, 7, '100 words'),
            ('word ' * 26, 1, '25 words'),
            ('abcdefghij ' * 20, 1, '200 characters'),
            (('x' * 100 + ' ') * 10, 7, '1000 characters'),
            ('Hi', 2, 'Every scene needs narration'),
        ]:
            with self.subTest(count=count, message=message):
                with self.assertRaisesRegex(ValueError, message):
                    creative.plan({'story': story, 'scenes': count, 'duration': 35})
        accepted = creative.plan({'story': 'word ' * 100, 'scenes': 4, 'duration': 35})
        self.assertEqual(len(accepted['scenes']), 4)

    def test_video_handoff_checks_current_narration_before_decoding_or_saving(self):
        with tempfile.TemporaryDirectory() as temp:
            db = store.init_db(Path(temp)/'studio.sqlite3')
            value = project('video')
            value['narration'] = 'An edited script with different words.'
            value['sceneCount'] = 2
            with patch.object(creative, 'prepare') as decode:
                with self.assertRaisesRegex(ValueError, 'Narration changed'):
                    creative.video_project(db, value)
                decode.assert_not_called()
            value['narration'] = '  ' + '\n'.join(p['text'] for p in value['pages']) + ' '
            for count in (1, True, 2.0):
                value['sceneCount'] = count
                with self.assertRaisesRegex(ValueError, 'Scene count changed'):
                    creative.video_project(db, value)
            self.assertEqual(store.list_projects(db), [])
            value['sceneCount'] = 2
            creative.video_project(db, value)
            self.assertEqual(len(store.list_projects(db)), 1)

    def test_overlong_handoff_and_ai_draft_rejected_before_use(self):
        with tempfile.TemporaryDirectory() as temp:
            db = store.init_db(Path(temp)/'studio.sqlite3')
            value = project('video', 1)
            value['pages'][0]['text'] = 'word ' * 26
            with self.assertRaisesRegex(ValueError, '25 words'):
                creative.video_project(db, value)
            self.assertEqual(store.list_projects(db), [])
            settings = draft_settings({'kind': 'video', 'idea': 'A cloud', 'count': 1})
            with self.assertRaisesRegex(ValueError, '25 words'):
                validate_draft({'title': 'Cloud', 'narration': 'word ' * 26}, settings)
            self.assertEqual(validate_draft({'title': 'Cloud', 'narration': 'A cloud smiled.'}, settings)['narration'], 'A cloud smiled.')

    def test_draft_schema_and_invalid_responses_never_retry(self):
        settings = draft_settings({'kind': 'storybook', 'idea': 'A cloud', 'count': 1})
        self.assertEqual(validate_draft({'title': 'A', 'pages': [{'text': 'A cloud smiled.', 'prompt': 'Cloud at sunrise'}]}, settings)['title'], 'A')
        for bad in ({'title':'A','pages':[]}, {'title':'A','pages':[{'prompt':'Cloud'}]}, '```json {} ```'):
            with self.assertRaises(ValueError):
                validate_draft(bad, settings)
        with patch.dict('os.environ', {'WEC_ENABLE_TEXT_GENERATION':'1','WEC_CLOUDFLARE_ACCOUNT_ID':'a'*32,'WEC_CLOUDFLARE_API_TOKEN':'test-only'}):
            response = MagicMock(); response.status_code=200
            response.iter_content.return_value = [b'{"success":true,"result":{"response":"invalid-json"}}']
            response.__enter__.return_value=response
            with patch('wec_engine.providers.cloudflare_text.requests.post', return_value=response) as call:
                with self.assertRaises(GenerationError):
                    CloudflareText().generate(settings)
                self.assertEqual(call.call_count, 1)
                self.assertFalse(call.call_args.kwargs['allow_redirects'])


class CreativeHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.token = 'test-only-creative-token-32-characters'
        self.db = Path(self.temp.name)/'studio.sqlite3'
        self.server = ThreadingHTTPServer(('127.0.0.1',0), create_handler(self.db, self.temp.name, self.token))
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        self.addCleanup(self.close)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def close(self):
        self.server.shutdown(); self.thread.join(); self.server.RequestHandlerClass.video_jobs.close(); self.server.server_close()

    def request(self,path,body=None,token=True):
        req = Request(self.base+path, data=json.dumps(body).encode() if body is not None else None,
                      headers={'X-WEC-Token':self.token if token else '', 'Content-Type':'application/json'})
        try:
            with urlopen(req) as r:return r.status, r.read(), r.headers
        except HTTPError as e:return e.code,e.read(),e.headers

    def test_static_routes_and_authentication(self):
        for path in ['/','/studio/','/studio/app.js','/studio/store.js','/studio/video.js','/studio/style.css', '/video', '/video/', '/?project=old-id']:
            self.assertEqual(self.request(path,token=False)[0],200)
        home = self.request('/', token=False)[1]
        self.assertEqual(home, self.request('/studio/', token=False)[1])
        self.assertIn(b'Artwork Studio', home)
        video = self.request('/video/', token=False)[1]
        self.assertEqual(video, self.request('/?project=old-id', token=False)[1])
        self.assertIn(b'id="story"', video)
        self.assertIn(b'src="/app.js"', video)
        self.assertEqual(self.request('/api/creative/pdf',project(),False)[0],401)
        self.assertEqual(self.request('/studio/../../studio.py',token=False)[0],401)

    def test_plan_pdf_and_invalid_payload_routes(self):
        status, data, _ = self.request('/api/creative/plan',{'story':'The little cloud smiled. Then it flew home.','scenes':2,'duration':10})
        self.assertEqual(status,200); self.assertEqual(len(json.loads(data)['scenes']),2)
        status, data, headers = self.request('/api/creative/pdf',project())
        self.assertEqual(status,200); self.assertTrue(data.startswith(b'%PDF-'));self.assertEqual(headers['Content-Type'],'application/pdf')
        self.assertEqual(self.request('/api/creative/pdf',[])[0],400)
        self.assertEqual(self.request('/api/creative/plan',{'story':'A','scenes':True})[0],400)

    def test_disabled_generation_never_calls_upstream(self):
        with patch('wec_engine.providers.cloudflare_images.requests.post') as call:
            status,_,_=self.request('/api/creative/image',{'prompt':'A friendly cloud'})
            self.assertEqual(status,503);call.assert_not_called()
        self.assertEqual(store.generation_usage(self.db),0)

    def test_invalid_video_handoff_is_a_client_error_without_side_effects(self):
        value = project('video')
        value['narration'] = 'New script that has not been split.'
        code, body, _ = self.request('/api/creative/video', value)
        self.assertEqual(code, 400)
        self.assertIn('Narration changed', json.loads(body)['error'])
        self.assertEqual(store.list_projects(self.db), [])
        code, _, _ = self.request('/api/creative/plan', {'story': 'word '*26, 'scenes': 1, 'duration': 35})
        self.assertEqual(code, 400)
        self.assertEqual(store.generation_usage(self.db), 0)


if __name__ == '__main__':
    unittest.main()
