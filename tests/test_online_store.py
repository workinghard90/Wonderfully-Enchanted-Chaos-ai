"""Real filesystem recovery, failed commits, bounds and authenticated HTTP."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from wec_engine.online_store import OnlineStore, SnapshotError, validate_package
from wec_engine.studio import create_handler


def package(title='Original', image=b'exact original bytes'):
    asset = {'image_base64': base64.b64encode(image).decode(), 'sha256': hashlib.sha256(image).hexdigest()}
    project = {'app': 'wec-creative-studio', 'schema_version': 1, 'backup_version': 2,
               'id': 'original-project', 'title': title, 'kind': 'art', 'pages': [{'asset': asset, 'review': 'approved'}]}
    payload = json.dumps({'project': project, 'checkpoint': {'createdAt': 123, 'project': project}})
    return json.dumps({'app': 'wec-recovery-package', 'package_version': 1,
                       'payload': payload, 'sha256': hashlib.sha256(payload.encode()).hexdigest()}).encode()


class OnlineStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = OnlineStore(self.root/'online')

    def test_restart_and_clean_store_restore_exact_bytes(self):
        raw = package()
        item = self.store.save(raw)
        restarted = OnlineStore(self.store.root)
        self.assertEqual(restarted.list()['snapshots'], [item])
        with restarted.open(item['id']) as source:
            independent_backup = source.read()
        self.assertEqual(raw, independent_backup)
        fresh = OnlineStore(self.root/'clean')
        self.assertEqual(fresh.save(independent_backup)['id'], item['id'])
        with fresh.open(item['id']) as source:
            self.assertEqual(source.read(), raw)

    def test_failed_commit_keeps_previous_and_cleans_staging(self):
        first = self.store.save(package())
        with patch('wec_engine.online_store.os.rename', side_effect=OSError('disk failed')):
            with self.assertRaises(OSError):
                self.store.save(package('New'))
        self.assertEqual(self.store.list()['snapshots'], [first])
        self.assertFalse(list(self.store.root.glob('.upload-*')))
        abandoned = self.store.root/'.upload-interrupted'
        abandoned.mkdir()
        (abandoned/'partial').write_bytes(b'partial')
        self.assertEqual(OnlineStore(self.store.root).list()['snapshots'], [first])
        self.assertFalse(abandoned.exists())

    def test_concurrent_retries_are_idempotent_and_edits_keep_history(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(self.store.save, [package()] * 8))
        self.assertEqual(len({x['id'] for x in results}), 1)
        self.store.save(package('Changed'))
        self.assertEqual(len(self.store.list()['snapshots']), 2)
        self.store.remove(results[0]['id'])
        self.store.remove(results[0]['id'])
        self.assertEqual(len(self.store.list()['snapshots']), 1)

    def test_integrity_and_path_rejection(self):
        raw = package()
        bad = json.loads(raw); bad['sha256'] = '0' * 64
        with self.assertRaises(SnapshotError):
            self.store.save(json.dumps(bad).encode())
        bad = json.loads(raw); content = json.loads(bad['payload'])
        content['project']['pages'][0]['asset']['sha256'] = '0' * 64
        bad['payload'] = json.dumps(content); bad['sha256'] = hashlib.sha256(bad['payload'].encode()).hexdigest()
        with self.assertRaises(SnapshotError):
            validate_package(json.dumps(bad).encode())
        for value in ('../other', 'x', '/etc/passwd'):
            with self.assertRaises(SnapshotError):
                self.store.remove(value)
        item = self.store.save(raw)
        (self.store.root/item['id']/'package.json').write_bytes(raw.replace(b'Original', b'Corrupt!'))
        with self.assertRaises(SnapshotError):
            self.store.open(item['id'])

    def test_limits_preserve_saved_snapshots(self):
        first = self.store.save(package())
        for target, value in [('MAX_TOTAL', 1), ('MAX_SNAPSHOTS', 1), ('HEADROOM', 10**30)]:
            with patch('wec_engine.online_store.' + target, value):
                with self.assertRaises(SnapshotError):
                    self.store.save(package('New'))
        self.assertEqual(self.store.list()['snapshots'], [first])

    def serve(self, enabled=True, token='test-owner-secret-at-least-32-characters', render=False):
        with patch.dict('os.environ', {'WEC_ENABLE_ONLINE_STORAGE': '1' if enabled else '0', 'RENDER': 'true' if render else ''}):
            handler = create_handler(self.root/'studio.db', self.root, token=token)
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def close():
            server.shutdown(); thread.join(); server.server_close(); handler.video_jobs.close()
        self.addCleanup(close)
        return 'http://127.0.0.1:' + str(server.server_port)

    def test_http_auth_download_remove_and_restart(self):
        base = self.serve()
        route = base + '/api/creative/snapshots'
        headers = {'X-WEC-Token': 'test-owner-secret-at-least-32-characters', 'Content-Type': 'application/json'}
        with self.assertRaises(HTTPError) as caught:
            urlopen(route)
        self.assertEqual(caught.exception.code, 401)
        with urlopen(Request(route, data=package(), headers=headers)) as response:
            self.assertEqual(response.status, 201); item = json.load(response)
        with urlopen(Request(route + '/' + item['id'], headers=headers)) as response:
            self.assertEqual(response.read(), package())
        with patch('wec_engine.studio_video.VideoJobs.status', return_value={'jobs': [{'status': 'queued'}]}):
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(route, data=package('Wait for video'), headers=headers))
            self.assertEqual(caught.exception.code, 429)
        with self.assertRaises(HTTPError) as caught:
            urlopen(Request(route + '/' + item['id'] + '/remove', data=b'{}', headers=headers))
        self.assertEqual(caught.exception.code, 400)
        with urlopen(Request(route + '/' + item['id'] + '/remove', data=json.dumps({'confirm': item['id']}).encode(), headers=headers)) as response:
            self.assertEqual(response.status, 200)

    def test_disabled_and_missing_mount_fail_closed(self):
        for enabled, token, render in [(False, None, False), (True, None, False), (True, 'a'*32, True)]:
            base = self.serve(enabled, token, render)
            headers = {'X-WEC-Token': token or ''}
            with urlopen(Request(base+'/api/creative/snapshots', headers=headers)) as response:
                self.assertFalse(json.load(response)['enabled'])
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(base+'/api/creative/snapshots', data=package(), headers=headers))
            self.assertEqual(caught.exception.code, 503)
