import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

from PIL import Image
import requests

from wec_engine.studio import create_handler
from wec_engine.studio_store import init_db, save_project, save_scene_image, export_backup, get_project
from wec_engine.studio_video import VideoJobs, VideoJobError


@unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required for synthetic movie fixture')
class StudioVideoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.db = init_db(self.root/'studio.sqlite3')
        self.project = save_project(self.db, {'title': 'A test movie', 'story': 'The lantern glows. The fox smiles.', 'scenes': 2, 'duration': 2})
        image = io.BytesIO(); Image.new('RGB', (256, 256), 'gold').save(image, format='JPEG')
        for sid in ('scene-001', 'scene-002'):
            save_scene_image(self.db, self.project['id'], sid, image.getvalue())
        save_project(self.db, {'title': 'Other private project', 'story': 'Keep separate.', 'scenes': 1, 'duration': 2})
        self.jobs = VideoJobs(self.root/'video-jobs', enabled=True, worker_command=[sys.executable, str(Path(__file__).with_name('video_fixture_worker.py'))])
        self.ready = patch.object(self.jobs, 'ready', return_value=True); self.ready.start()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), create_handler(self.db, self.root, token='test-studio-video-secret-32-characters', video_jobs=self.jobs))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.session = requests.Session(); self.session.headers['X-WEC-Token'] = 'test-studio-video-secret-32-characters'

    def tearDown(self):
        self.jobs.close()
        for _ in range(50):
            if not self.jobs.processes: break
            time.sleep(.05)
        self.server.shutdown(); self.server.server_close(); self.session.close(); self.ready.stop(); self.temp.cleanup()

    def start(self):
        return self.session.post(self.base+f'/api/projects/{self.project["id"]}/video', json={'ambience': True}, timeout=5)

    def finish(self, jid):
        for _ in range(100):
            value = self.jobs.get(jid)
            if value['status'] in ('ready', 'failed', 'cancelled', 'interrupted') and jid not in self.jobs.processes:
                return value
            time.sleep(.05)
        self.fail('Synthetic job did not finish')

    def test_authentication_covers_every_video_route(self):
        jid = 'a'*32
        for route in ('/api/video', f'/api/video-jobs/{jid}', f'/api/video-jobs/{jid}/file'):
            self.assertEqual(requests.get(self.base+route, timeout=5).status_code, 401)
        for route in (f'/api/projects/{self.project["id"]}/video', f'/api/video-jobs/{jid}/cancel', f'/api/video-jobs/{jid}/remove'):
            self.assertEqual(requests.post(self.base+route, json={}, timeout=5).status_code, 401)
        status = self.session.get(self.base+'/api/video', timeout=5)
        self.assertNotIn('test-studio-video-secret', status.text)
        self.assertNotIn(str(self.root), status.text)
        self.assertEqual(self.session.get(self.base+'/api/video-jobs/'+jid, timeout=5).status_code, 404)

    def test_video_requires_strong_token_even_on_loopback(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), create_handler(self.db, self.root, video_jobs=self.jobs))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            status = requests.get(base+'/api/video', timeout=5).json()
            self.assertFalse(status['ready']); self.assertEqual(status['jobs'], [])
            result = requests.post(base+f'/api/projects/{self.project["id"]}/video', json={}, timeout=5)
            self.assertEqual(result.status_code, 503)
            self.assertEqual(self.jobs.status()['attempts_today'], 0)
        finally:
            server.shutdown(); server.server_close()

    def test_snapshot_is_immutable_and_single_job_can_be_cancelled(self):
        save_project(self.db, {'title': 'SLOW movie', 'story': self.project['story'], 'duration': 2, 'scenes': 2}, self.project['id'])
        response = self.start(); self.assertEqual(response.status_code, 202)
        jid = response.json()['id']
        self.assertEqual(self.start().status_code, 409)
        snapshot = json.loads((self.jobs.root/jid/'backup.json').read_text())
        self.assertEqual(len(snapshot['projects']), 1)
        self.assertNotIn('Other private project', json.dumps(snapshot))
        save_project(self.db, {'title': 'Edited later', 'story': self.project['story'], 'duration': 2, 'scenes': 2}, self.project['id'])
        self.assertEqual(snapshot['projects'][0]['title'], 'SLOW movie')
        self.session.post(self.base+f'/api/video-jobs/{jid}/cancel', timeout=5)
        self.assertEqual(self.finish(jid)['status'], 'cancelled')
        self.assertEqual(get_project(self.db, self.project['id'])['image_count'], 2)

    def test_ready_movie_range_download_and_explicit_removal(self):
        response = self.start(); self.assertEqual(response.status_code, 202)
        jid = response.json()['id']; self.assertEqual(self.finish(jid)['status'], 'ready')
        url = self.base+f'/api/video-jobs/{jid}/file'
        whole = self.session.get(url, timeout=5); self.assertEqual(whole.status_code, 200)
        self.assertEqual(whole.headers['Content-Type'], 'video/mp4')
        part = self.session.get(url, headers={'Range': 'bytes=0-31'}, timeout=5)
        self.assertEqual(part.status_code, 206); self.assertEqual(part.content, whole.content[:32])
        self.assertEqual(part.headers['Content-Range'], f'bytes 0-31/{len(whole.content)}')
        tail = self.session.get(url, headers={'Range': 'bytes=-12'}, timeout=5)
        self.assertEqual(tail.content, whole.content[-12:])
        for value in ('bytes=9-2', 'bytes=-0', 'bytes=9999999-', 'bytes=0-1,5-6', 'bad'):
            self.assertEqual(self.session.get(url, headers={'Range': value}, timeout=5).status_code, 416)
        result = self.session.post(self.base+f'/api/video-jobs/{jid}/remove', timeout=5)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.session.get(url, timeout=5).status_code, 404)
        self.assertEqual(get_project(self.db, self.project['id'])['image_count'], 2)

    def test_failed_jobs_do_not_leak_logs_and_quota_survives_reopen(self):
        save_project(self.db, {'title': 'FAIL movie', 'story': self.project['story'], 'duration': 2, 'scenes': 2}, self.project['id'])
        for _ in range(2):
            response = self.start(); self.assertEqual(response.status_code, 202)
            value = self.finish(response.json()['id']); self.assertEqual(value['status'], 'failed')
            self.assertNotIn('synthetic-private-worker-error', json.dumps(value))
        self.assertEqual(self.start().status_code, 429)
        reopened = VideoJobs(self.jobs.root, enabled=False)
        self.assertEqual(reopened.status()['attempts_today'], 2)
        reopened.close()

    def test_incomplete_or_oversized_projects_do_not_reserve_attempts(self):
        snapshot = export_backup(self.db, self.project['id'])
        snapshot['projects'][0]['story'] = 'lantern '*101
        with self.assertRaisesRegex(VideoJobError, '100 words'):
            self.jobs.start(snapshot, self.project['id'])
        snapshot['projects'][0]['story'] = 'lantern '*60
        with self.assertRaisesRegex(VideoJobError, 'long scene narration'):
            self.jobs.start(snapshot, self.project['id'])
        self.assertEqual(self.jobs.status()['attempts_today'], 0)
        from wec_engine.studio_store import remove_scene_image
        remove_scene_image(self.db, self.project['id'], 'scene-002')
        response = self.start(); self.assertEqual(response.status_code, 400)
        self.assertIn('every scene', response.text)
        self.assertEqual(self.jobs.status()['attempts_today'], 0)
        response = self.session.post(self.base+f'/api/projects/{self.project["id"]}/video', json={'model': 'untrusted'}, timeout=5)
        self.assertEqual(response.status_code, 400)

    def test_interrupted_jobs_are_not_automatically_rerun(self):
        jid = 'b'*32; folder = self.jobs.root/jid; folder.mkdir()
        (folder/'status.json').write_text(json.dumps({'id': jid, 'status': 'running', 'created_at': '2026-01-01', 'owner_pid': 99999999}))
        recovered = VideoJobs(self.jobs.root, enabled=False)
        self.assertEqual(recovered.get(jid)['status'], 'interrupted')
        self.assertEqual(recovered.status()['attempts_today'], 0)
        recovered.close()


if __name__ == '__main__':
    unittest.main()
