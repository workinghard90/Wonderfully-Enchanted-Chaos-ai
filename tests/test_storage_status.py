"""Read-only capacity report tests; no server data deletion or AI requests."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from wec_engine.online_store import HEADROOM, MAX_TOTAL, MAX_PACKAGE, MAX_SNAPSHOTS
from wec_engine.storage_status import capacity_report
from wec_engine.studio import create_handler


class DummyVideos:
    def __init__(self, saved=0, daily=0, active=0):
        self.saved, self.daily, self.active = saved, daily, active

    def status(self):
        jobs = [{'status': 'queued' if i < self.active else 'ready',
                 'title': 'CONFIDENTIAL', 'id': 'secret-id'} for i in range(self.saved)]
        return {'ready': True, 'jobs': jobs, 'max_saved_videos': 3,
                'attempts_today': self.daily, 'daily_limit': 2}

    def close(self):
        pass


class DummyOnline:
    def __init__(self, saved=0, used=0):
        self.saved, self.used = saved, used

    def list(self):
        return {'enabled': True, 'snapshots': [{'title': 'PRIVATE', 'id': 'secret'}] * self.saved,
                'used_bytes': self.used, 'max_bytes': MAX_TOTAL,
                'max_snapshots': MAX_SNAPSHOTS, 'max_package_bytes': MAX_PACKAGE}


class StorageCapacityTests(unittest.TestCase):
    def test_limits_are_separate_and_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            before = sorted(Path(tmp).iterdir())
            with patch('wec_engine.storage_status.os.path.ismount', return_value=True):
                value = capacity_report(tmp, DummyOnline(2, 1200), DummyVideos(3, 2))
            self.assertTrue(value['storage']['mount_confirmed'] is None or value['storage']['mount_confirmed'])
            self.assertEqual(value['videos']['remaining_slots'], 0)
            self.assertEqual(value['videos']['remaining_attempts_today'], 0)
            self.assertEqual(value['snapshots']['remaining_slots'], MAX_SNAPSHOTS - 2)
            self.assertEqual(value['snapshots']['remaining_quota_bytes'], MAX_TOTAL - 1200)
            codes = {w['code'] for w in value['warnings']}
            self.assertIn('video_slots_full', codes)
            self.assertIn('daily_render_limit', codes)
            self.assertNotIn('snapshot_quota_full', codes)
            payload = json.dumps(value)
            for private in ('CONFIDENTIAL', 'PRIVATE', 'secret-id', 'secret', tmp):
                self.assertNotIn(private, payload)
            self.assertEqual(before, sorted(Path(tmp).iterdir()))

    def test_full_snapshot_quotas_distinct_from_filesystem(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = capacity_report(tmp, DummyOnline(MAX_SNAPSHOTS, MAX_TOTAL), DummyVideos())
            codes = {w['code'] for w in result['warnings']}
            self.assertIn('snapshot_quota_full', codes)
            self.assertIn('snapshot_count_full', codes)
            self.assertNotIn('video_slots_full', codes)
            self.assertGreater(result['storage']['free_bytes'], 0)

    def test_disk_pressure_and_missing_mount_warn_without_deleting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = root/'keep-forever.json'
            original.write_bytes(b'important')
            usage = __import__('shutil')._ntuple_diskusage(5 * 1024**3, 5 * 1024**3 - 100, 100)
            with patch.dict('os.environ', {'RENDER': 'true'}), \
                 patch('wec_engine.storage_status.shutil.disk_usage', return_value=usage), \
                 patch('wec_engine.storage_status.os.path.ismount', return_value=False):
                state = capacity_report(tmp, None, DummyVideos())
            self.assertFalse(state['storage']['mount_confirmed'])
            self.assertFalse(state['snapshots']['enabled'])
            self.assertEqual(state['storage']['free_bytes'], 100)
            self.assertEqual(state['storage']['max_snapshot_bytes_possible'], 0)
            codes = {w['code'] for w in state['warnings']}
            self.assertIn('persistent_mount_missing', codes)
            self.assertIn('snapshot_headroom_low', codes)
            self.assertIn('video_package_headroom_low', codes)
            self.assertEqual(original.read_bytes(), b'important')

    def test_authenticated_read_only_route(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            token = 'studio-storage-test-token-at-least-32-characters'
            with patch.dict('os.environ', {'WEC_ENABLE_ONLINE_STORAGE': '1', 'RENDER': ''}):
                handler = create_handler(root/'studio.sqlite3', root, token=token,
                                         video_jobs=DummyVideos(3, 2))
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f'http://127.0.0.1:{server.server_port}/api/storage/capacity'
            try:
                with self.assertRaises(HTTPError) as e:
                    urlopen(url, timeout=5)
                self.assertEqual(e.exception.code, 401)
                req = Request(url, headers={'X-WEC-Token': token})
                with urlopen(req, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    text = response.read().decode()
                    value = json.loads(text)
                self.assertNotIn(token, text)
                self.assertNotIn(tmp, text)
                self.assertEqual(value['videos']['remaining_slots'], 0)
                self.assertEqual(value['snapshots']['saved'], 0)
                with self.assertRaises(HTTPError) as e:
                    urlopen(Request(url, headers={'X-WEC-Token': 'bad'}), timeout=5)
                self.assertEqual(e.exception.code, 401)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
