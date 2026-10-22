"""Local HTTP protocol fixtures only: no models, GPU, inference or external API."""
import contextlib
import hashlib
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from wec_engine.artwork import local_worker_url, prepare_artwork_job, run_artwork_job
from wec_engine.cli import main


def png(size):
    stream = io.BytesIO()
    Image.new('RGB', size, 'white').save(stream, format='PNG')
    return stream.getvalue()


class ArtworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workflow = {'6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'old'}},
                         '7': {'class_type': 'LoadImage', 'inputs': {'image': 'old.png'}},
                         '9': {'class_type': 'SaveImage', 'inputs': {}},
                         '10': {'class_type': 'SaveImage', 'inputs': {}}}
        (self.root / 'workflow.json').write_text(json.dumps(self.workflow))
        self.job = {'schema_version': 1, 'workflow': 'workflow.json', 'source_method': 'generation',
                    'save_image_node': '9', 'bindings': {'6.text': 'A cloud coloring illustration'},
                    'expected_pixels': [2304, 3072]}
        self.path = self.root / 'job.json'
        self.write_job()
        self.raw = png((2304, 3072))
        self.calls = []
        self.history = {'job-123': {'status': {'completed': True}, 'outputs': {
            '10': {'images': [{'filename': 'unselected.png', 'type': 'output'}]},
            '9': {'images': [{'filename': 'final.png', 'subfolder': 'books', 'type': 'output'}]}}}}
        self.queue_status = 200
        self.registry = {n['class_type']: {} for n in self.workflow.values()}

    def write_job(self):
        self.path.write_text(json.dumps(self.job))

    @contextlib.contextmanager
    def worker(self):
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.respond()
            def do_POST(self):
                self.respond()
            def respond(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                owner.calls.append((self.command, self.path, body))
                code = 200
                if self.path == '/object_info':
                    result = json.dumps(owner.registry).encode()
                elif self.path == '/prompt':
                    code = owner.queue_status
                    result = json.dumps({'prompt_id': 'job-123'}).encode()
                elif self.path == '/upload/image':
                    result = json.dumps({'name': 'uploaded.png', 'subfolder': 'references', 'type': 'input'}).encode()
                elif self.path.startswith('/history/'):
                    result = json.dumps(owner.history).encode()
                elif self.path.startswith('/view?'):
                    result = owner.raw
                else:
                    code, result = 404, b''
                self.send_response(code)
                if code == 302:
                    self.send_header('Location', '/must-not-follow')
                self.send_header('Content-Length', str(len(result)))
                self.end_headers()
                self.wfile.write(result)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f'http://127.0.0.1:{server.server_port}'
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_offline_validation_never_contacts_worker_or_creates_output(self):
        with patch('wec_engine.artwork.requests.Session', side_effect=AssertionError('network')):
            report = run_artwork_job(self.path, self.root / 'out')
        self.assertEqual(report['state'], 'validated_offline')
        self.assertTrue(report['planned_resolution']['meets_ppi_target'])
        self.assertFalse((self.root / 'out').exists())

    def test_full_resolution_selected_output_is_byte_identical(self):
        with self.worker() as url:
            report = run_artwork_job(self.path, self.root / 'out', execute=True, comfy_url=url)
        self.assertTrue(report['pixel_checks_pass'])
        self.assertEqual(report['actual_resolution']['effective_ppi'], 307.2)
        self.assertEqual((self.root / 'out/artwork.png').read_bytes(), self.raw)
        self.assertEqual(report['sha256'], hashlib.sha256(self.raw).hexdigest())
        self.assertFalse(report['native_generation_verified'])
        self.assertEqual(sum(path == '/prompt' for _, path, _ in self.calls), 1)
        queued = json.loads(next(body for _, path, body in self.calls if path == '/prompt'))
        self.assertEqual(queued['prompt']['6']['inputs']['text'], 'A cloud coloring illustration')
        self.assertIn('filename=final.png', self.calls[-1][1])
        self.assertNotIn('unselected.png', self.calls[-1][1])

    def test_reference_upload_and_explicit_binding_preserve_bytes(self):
        original = png((1102, 1427))
        ref = self.root / 'Pip reference.png'
        ref.write_bytes(original)
        self.job.update(source_method='reference_edit', reference={'file': ref.name, 'input_binding': '7.image'})
        self.write_job()
        with self.worker() as url:
            report = run_artwork_job(self.path, self.root / 'out', execute=True, comfy_url=url)
        upload = next(body for _, path, body in self.calls if path == '/upload/image')
        self.assertIn(original, upload)
        queued = json.loads(next(body for _, path, body in self.calls if path == '/prompt'))
        self.assertEqual(queued['prompt']['7']['inputs']['image'], 'references/uploaded.png')
        self.assertEqual(ref.read_bytes(), original)
        self.assertTrue(report['reference_supplied'])
        self.assertEqual(self.workflow['7']['inputs']['image'], 'old.png')
        self.assertEqual(json.loads((self.root / 'workflow.json').read_text()), self.workflow)

    def test_undersized_image_is_kept_with_failed_checks_and_cli_exit(self):
        self.raw = png((1102, 1427))
        with self.worker() as url, contextlib.redirect_stdout(io.StringIO()):
            code = main(['artwork', str(self.path), str(self.root / 'out'), '--execute', '--comfy-url', url])
        report = json.loads((self.root / 'out/artwork-report.json').read_text())
        self.assertEqual(code, 1)
        self.assertFalse(report['pixel_checks_pass'])
        self.assertAlmostEqual(report['actual_resolution']['effective_ppi'], 146.933333, places=5)
        self.assertEqual((self.root / 'out/artwork.png').read_bytes(), self.raw)

    def test_existing_output_folder_prevents_resubmission(self):
        (self.root / 'out').mkdir()
        (self.root / 'out/keep.txt').write_text('saved work')
        with patch('wec_engine.artwork.requests.Session', side_effect=AssertionError('network')):
            with self.assertRaises(FileExistsError):
                run_artwork_job(self.path, self.root / 'out', execute=True)
        self.assertEqual((self.root / 'out/keep.txt').read_text(), 'saved work')

    def test_bad_bindings_and_reference_fail_before_any_request(self):
        for update in [{'bindings': {'missing.text': 'bad'}}, {'save_image_node': '6'},
                       {'source_method': 'reference_edit'}, {'schema_version': True},
                       {'expected_pixels': [True, 3072]}, {'artwork_box_inches': [0, 10]},
                       {'target_ppi': float('nan')}, {'bindings': []},
                       {'reference': {'file': 'missing.png', 'input_binding': '9.image'}}]:
            with self.subTest(update=update):
                saved = self.job.copy()
                self.job.update(update)
                self.write_job()
                with patch('wec_engine.artwork.requests.Session', side_effect=AssertionError('network')):
                    with self.assertRaises(ValueError):
                        run_artwork_job(self.path, self.root / 'out', execute=True)
                self.job = saved
        self.assertFalse((self.root / 'out').exists())

    def test_missing_node_registry_blocks_queue(self):
        self.registry.pop('LoadImage')
        with self.worker() as url:
            with self.assertRaisesRegex(ValueError, 'missing'):
                run_artwork_job(self.path, self.root / 'out', execute=True, comfy_url=url)
        self.assertEqual([path for _, path, _ in self.calls], ['/object_info'])

    def test_worker_execution_failure_has_no_download_or_retry(self):
        self.history = {'job-123': {'status': {'status_str': 'error'}}}
        with self.worker() as url:
            with self.assertRaisesRegex(RuntimeError, 'execution failed'):
                run_artwork_job(self.path, self.root / 'out', execute=True, comfy_url=url)
        self.assertFalse((self.root / 'out/artwork.png').exists())
        report = json.loads((self.root / 'out/artwork-report.json').read_text())
        self.assertEqual(report['prompt_id'], 'job-123')
        self.assertEqual(report['state'], 'failed')

    def test_missing_multiple_preview_or_traversal_output_is_rejected(self):
        for entry in [[], [{'filename': 'a.png', 'type': 'temp'}],
                      [{'filename': '../secret.png', 'type': 'output'}],
                      [{'filename': 'a.png', 'subfolder': '../', 'type': 'output'}],
                      [{'filename': 'a.png', 'type': 'output'}] * 2]:
            with self.subTest(entry=entry):
                self.history['job-123']['outputs']['9']['images'] = entry
                with tempfile.TemporaryDirectory() as directory, self.worker() as url:
                    out = Path(directory) / 'out'
                    with self.assertRaises(ValueError):
                        run_artwork_job(self.path, out, execute=True, comfy_url=url)
                    self.assertFalse((out / 'artwork.png').exists())

    def test_corrupt_output_is_not_saved_as_artwork(self):
        self.raw = b'not a PNG'
        with self.worker() as url:
            with self.assertRaises(OSError):
                run_artwork_job(self.path, self.root / 'out', execute=True, comfy_url=url)
        self.assertFalse((self.root / 'out/artwork.png').exists())

    def test_timeout_keeps_prompt_id_and_never_requeues(self):
        self.history = {}
        with self.worker() as url:
            with self.assertRaises(TimeoutError):
                run_artwork_job(self.path, self.root / 'out', execute=True, comfy_url=url, wait_seconds=1)
        self.assertEqual(sum(path == '/prompt' for _, path, _ in self.calls), 1)
        report = json.loads((self.root / 'out/artwork-report.json').read_text())
        self.assertEqual(report['state'], 'timed_out')
        self.assertEqual(report['prompt_id'], 'job-123')

    def test_redirects_and_submission_errors_are_not_retried(self):
        for code in (302, 500):
            with self.subTest(code=code):
                self.calls = []
                self.queue_status = code
                with tempfile.TemporaryDirectory() as directory, self.worker() as url:
                    with self.assertRaises(RuntimeError):
                        run_artwork_job(self.path, Path(directory) / 'out', execute=True, comfy_url=url)
                self.assertEqual([path for _, path, _ in self.calls], ['/object_info', '/prompt'])

    def test_only_explicit_loopback_worker_urls_are_accepted(self):
        for url in ['https://example.com', 'http://192.168.1.2:8188', 'http://localhost:8188',
                    'http://127.0.0.1:8188/?token=secret', 'http://user:pass@127.0.0.1:8188',
                    'http://127.0.0.1:8188/path', 'http://127.0.0.1']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                local_worker_url(url)
        self.assertEqual(local_worker_url('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188')
        self.assertEqual(local_worker_url('http://[::1]:8188'), 'http://[::1]:8188')
