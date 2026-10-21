"""Offline coverage of image safety, old database migration and atomic recovery."""
import base64
from contextlib import closing
import io
import json
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from PIL import Image
from wec_engine import studio_store as store
from wec_engine.studio import create_handler

PROJECT = {'title': 'Lantern', 'story': 'A lantern helps a fox. They cross a bridge.', 'duration': 10, 'scenes': 2}


def picture(mode='RGB', size=(40, 30), color='red', format='PNG', **kwargs):
    output = io.BytesIO()
    Image.new(mode, size, color).save(output, format=format, **kwargs)
    return output.getvalue()


class ImageStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = store.init_db(Path(self.temp.name) / 'studio.sqlite3')
        self.project = store.save_project(self.db, PROJECT)
        self.pid = self.project['id']

    def test_migrate_original_database_without_losing_project(self):
        old = Path(self.temp.name) / 'old.sqlite3'
        with closing(sqlite3.connect(old)) as db, db:
            db.execute('CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, story TEXT NOT NULL, duration REAL NOT NULL, scenes INTEGER NOT NULL, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
            db.execute('INSERT INTO projects(id,title,story,duration,scenes) VALUES (?,?,?,?,?)', (self.pid, PROJECT['title'], PROJECT['story'], 10, 2))
        store.init_db(old)
        self.assertEqual(store.get_project(old, self.pid)['story'], PROJECT['story'])
        store.save_scene_image(old, self.pid, 'scene-001', picture())
        self.assertEqual(store.get_project(old, self.pid)['image_count'], 1)

    def test_upload_formats_normalize_and_plan_has_metadata_only(self):
        for format in ('PNG', 'JPEG', 'WEBP'):
            with self.subTest(format=format):
                store.save_scene_image(self.db, self.pid, 'scene-001', picture(format=format))
                raw = store.get_scene_image(self.db, self.pid, 'scene-001')
                with Image.open(io.BytesIO(raw)) as image:
                    self.assertEqual(image.format, 'JPEG')
                    self.assertEqual(image.size, (40, 30))
        project = store.get_project(self.db, self.pid)
        self.assertEqual(project['image_count'], 1)
        self.assertEqual(store.list_projects(self.db)[0]['image_count'], 1)
        scene = store.project_plan(project)['scenes'][0]
        self.assertEqual(scene['image_asset']['width'], 40)
        self.assertIsNone(scene['image'])  # No fabricated CLI media path or generation result.

    def test_orientation_metadata_resize_and_alpha(self):
        exif = Image.Exif(); exif[274] = 6; exif[315] = 'private author'
        store.save_scene_image(self.db, self.pid, 'scene-001', picture(size=(60, 30), format='JPEG', exif=exif))
        with Image.open(io.BytesIO(store.get_scene_image(self.db, self.pid, 'scene-001'))) as image:
            self.assertEqual(image.size, (30, 60))
            self.assertFalse(image.getexif())
        store.save_scene_image(self.db, self.pid, 'scene-001', picture('RGBA', (2200, 1100), (0, 0, 0, 0)))
        with Image.open(io.BytesIO(store.get_scene_image(self.db, self.pid, 'scene-001'))) as image:
            self.assertEqual(image.size, (2048, 1024))
            self.assertEqual(image.getpixel((10, 10)), (255, 255, 255))

    def test_invalid_images_do_not_replace_existing_image(self):
        store.save_scene_image(self.db, self.pid, 'scene-001', picture())
        original = store.get_scene_image(self.db, self.pid, 'scene-001')
        for raw in (b'<svg onload="alert(1)"></svg>', b'not an image', picture(format='GIF'), picture()[:25]):
            with self.subTest(raw=raw[:15]), self.assertRaises(ValueError):
                store.save_scene_image(self.db, self.pid, 'scene-001', raw)
        with patch.object(store, 'MAX_IMAGE_PIXELS', 100), self.assertRaises(ValueError):
            store.save_scene_image(self.db, self.pid, 'scene-001', picture())
        self.assertEqual(store.get_scene_image(self.db, self.pid, 'scene-001'), original)

    def test_invalid_scene_ids_never_create_assets(self):
        for sid in ('scene-000', 'scene-003', '../secret', 'scene-1'):
            with self.subTest(sid=sid), self.assertRaises(LookupError):
                store.save_scene_image(self.db, self.pid, sid, picture())
        with self.assertRaises(LookupError):
            store.save_scene_image(self.db, 'f' * 32, 'scene-001', picture())
        self.assertEqual(store.get_project(self.db, self.pid)['image_count'], 0)

    def test_story_changes_need_explicit_image_reset(self):
        store.save_scene_image(self.db, self.pid, 'scene-001', picture())
        edited = dict(PROJECT, title='Renamed', duration=12)
        store.save_project(self.db, edited, self.pid)
        self.assertEqual(store.get_project(self.db, self.pid)['image_count'], 1)
        for changed in (dict(edited, story='Another story'), dict(edited, scenes=1)):
            with self.assertRaises(store.ProjectConflictError):
                store.save_project(self.db, changed, self.pid)
        self.assertEqual(store.get_project(self.db, self.pid)['story'], PROJECT['story'])
        store.save_project(self.db, dict(edited, story='Another story', reset_images=True), self.pid)
        self.assertEqual(store.get_project(self.db, self.pid)['image_count'], 0)

    def test_v1_restore_creates_copies_and_keeps_existing(self):
        backup = {'schema_version': 1, 'projects': [dict(PROJECT, id=self.pid)]}
        first = store.restore_backup(self.db, backup)['projects'][0]['id']
        second = store.restore_backup(self.db, backup)['projects'][0]['id']
        self.assertEqual(len({self.pid, first, second}), 3)
        self.assertEqual(len(store.list_projects(self.db)), 3)
        self.assertEqual(store.get_project(self.db, first)['story'], PROJECT['story'])

    def test_v2_round_trip_preserves_image_bytes(self):
        store.save_scene_image(self.db, self.pid, 'scene-001', picture())
        original = store.get_scene_image(self.db, self.pid, 'scene-001')
        backup = store.export_backup(self.db)
        self.assertEqual(backup['schema_version'], 2)
        self.assertEqual(base64.b64decode(backup['projects'][0]['scene_images'][0]['image_base64']), original)
        other = store.init_db(Path(self.temp.name) / 'restored.sqlite3')
        pid = store.restore_backup(other, json.loads(json.dumps(backup)))['projects'][0]['id']
        self.assertNotEqual(pid, self.pid)
        self.assertEqual(store.get_scene_image(other, pid, 'scene-001'), original)
        self.assertEqual(store.get_project(other, pid)['story'], PROJECT['story'])

    def test_device_recovery_requires_an_empty_database_atomically(self):
        backup = store.export_backup(self.db)
        with self.assertRaises(store.ProjectConflictError):
            store.restore_backup(self.db, backup, only_if_empty=True)
        self.assertEqual(len(store.list_projects(self.db)), 1)
        other = store.init_db(Path(self.temp.name) / 'device-recovery.sqlite3')
        barrier = threading.Barrier(2)
        results = []
        def recover():
            barrier.wait()
            try:
                store.restore_backup(other, backup, only_if_empty=True)
                results.append('restored')
            except store.ProjectConflictError:
                results.append('conflict')
        workers = [threading.Thread(target=recover) for _ in range(2)]
        for worker in workers: worker.start()
        for worker in workers: worker.join(timeout=20)
        self.assertCountEqual(results, ['restored', 'conflict'])
        self.assertEqual(len(store.list_projects(other)), 1)
        with self.assertRaises(ValueError):
            store.restore_backup(other, backup, only_if_empty='true')

    def test_restore_is_all_or_nothing(self):
        backup = {'schema_version': 2, 'projects': [PROJECT, dict(PROJECT, story='')]}
        with self.assertRaises(ValueError): store.restore_backup(self.db, backup)
        self.assertEqual(len(store.list_projects(self.db)), 1)
        store.save_scene_image(self.db, self.pid, 'scene-001', picture())
        valid = store.export_backup(self.db)['projects'][0]
        for invalid in (
            dict(valid, scene_images=[dict(valid['scene_images'][0], image_base64='%%%')]),
            dict(valid, scene_images=valid['scene_images'] * 2),
            dict(valid, scene_images=[dict(valid['scene_images'][0], scene_id='../bad')]),
            dict(valid, scene_images=[dict(valid['scene_images'][0], mime='image/svg+xml')]),
            dict(valid, scene_images=[dict(valid['scene_images'][0], image_base64=base64.b64encode(b'bad jpeg').decode())]),
            dict(valid, scene_images=[dict(valid['scene_images'][0], image_base64=base64.b64encode(picture()).decode())]),
        ):
            with self.subTest(invalid=invalid['scene_images'][0].get('mime')), self.assertRaises(ValueError):
                store.restore_backup(self.db, {'schema_version': 2, 'projects': [valid, invalid]})
        self.assertEqual(len(store.list_projects(self.db)), 1)

    def test_invalid_backup_and_text_validation(self):
        for backup in (None, [], {}, {'schema_version': True, 'projects': [PROJECT]}, {'schema_version': 3, 'projects': [PROJECT]}, {'schema_version': 1, 'projects': []}, {'schema_version': 1, 'projects': [None]}):
            with self.subTest(backup=backup), self.assertRaises(ValueError): store.restore_backup(self.db, backup)
        for field, value in (('story', '\ud800'), ('duration', float('nan')), ('scenes', True)):
            with self.assertRaises(ValueError): store.save_project(self.db, dict(PROJECT, **{field: value}))

    def test_quotas_replacement_and_removal(self):
        with patch.object(store, 'MAX_PROJECTS', 1):
            with self.assertRaises(store.StorageLimitError): store.save_project(self.db, PROJECT)
            with self.assertRaises(store.StorageLimitError): store.restore_backup(self.db, {'schema_version': 1, 'projects': [PROJECT]})
        store.save_scene_image(self.db, self.pid, 'scene-001', picture())
        raw = store.get_scene_image(self.db, self.pid, 'scene-001')
        with patch.object(store, 'MAX_STUDIO_IMAGE_BYTES', len(raw)):
            store.save_scene_image(self.db, self.pid, 'scene-001', picture())  # Replacement credits old bytes.
            with self.assertRaises(store.StorageLimitError): store.save_scene_image(self.db, self.pid, 'scene-002', picture())
            with self.assertRaises(store.StorageLimitError): store.restore_backup(self.db, store.export_backup(self.db))
            self.assertEqual(len(store.list_projects(self.db)), 1)
            store.remove_scene_image(self.db, self.pid, 'scene-001')
            store.save_scene_image(self.db, self.pid, 'scene-002', picture())
        with self.assertRaises(LookupError): store.get_scene_image(self.db, self.pid, 'scene-001')


class ImageApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / 'db.sqlite3'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), create_handler(self.db, self.root, token='test-secret'))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.project = store.save_project(self.db, PROJECT)
        self.route = '/api/projects/' + self.project['id'] + '/scenes/scene-001/image'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()

    def request(self, route, body=None, method=None, token='test-secret', **headers):
        req = Request(self.base + route, data=body, method=method, headers={'X-WEC-Token': token, **headers})
        try: response = urlopen(req, timeout=10)
        except HTTPError as exc: response = exc
        with response: return response.status, response.headers, response.read()

    def test_authentication_covers_all_new_routes(self):
        for route, method, body in ((self.route, 'GET', None), (self.route, 'POST', picture()), (self.route + '/remove', 'POST', b''), ('/api/backup', 'GET', None), ('/api/restore', 'POST', b'{}')):
            for token in ('', 'wrong'):
                with self.subTest(route=route, method=method, token=token):
                    self.assertEqual(self.request(route, body, method, token)[0], 401)

    def test_upload_preview_backup_restore_and_remove(self):
        self.assertEqual(self.request(self.route, picture(), 'POST')[0], 200)
        status, headers, raw = self.request(self.route)
        self.assertEqual(status, 200); self.assertEqual(headers['Content-Type'], 'image/jpeg')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertIn("img-src 'self' blob:", headers['Content-Security-Policy'])
        backup = self.request('/api/backup')[2]
        status, _, restored = self.request('/api/restore', backup, 'POST')
        self.assertEqual(status, 200)
        new_id = json.loads(restored)['projects'][0]['id']
        self.assertEqual(self.request(self.route.replace(self.project['id'], new_id))[2], raw)
        self.assertEqual(self.request(self.route + '/remove', b'', 'POST')[0], 200)
        self.assertEqual(self.request(self.route)[0], 404)
        self.assertEqual(self.request(self.route.replace(self.project['id'], new_id))[0], 200)

    def test_http_conflict_and_validation(self):
        self.request(self.route, picture(), 'POST')
        route = '/api/projects/' + self.project['id']
        edited = dict(PROJECT, story='Changed story')
        self.assertEqual(self.request(route, json.dumps(edited).encode(), 'POST')[0], 409)
        self.assertEqual(self.request(self.route, b'not an image', 'POST')[0], 400)
        self.assertEqual(self.request(self.route.replace('scene-001', 'scene-003'), picture(), 'POST')[0], 404)
        self.assertEqual(self.request('/api/restore', b'{', 'POST')[0], 400)
        edited['reset_images'] = True
        self.assertEqual(self.request(route, json.dumps(edited).encode(), 'POST')[0], 200)
        self.assertEqual(self.request(self.route)[0], 404)

    def test_device_recovery_http_guard_and_asset(self):
        backup = json.loads(self.request('/api/backup')[2])
        backup['only_if_empty'] = True
        self.assertEqual(self.request('/api/restore', json.dumps(backup).encode(), 'POST')[0], 409)
        self.assertEqual(len(store.list_projects(self.db)), 1)
        backup['only_if_empty'] = 'false'
        self.assertEqual(self.request('/api/restore', json.dumps(backup).encode(), 'POST')[0], 400)
        status, headers, content = self.request('/device-backup.js', token='')
        self.assertEqual(status, 200)
        self.assertIn('javascript', headers['Content-Type'])
        self.assertIn(b'WECDeviceBackups', content)

    def test_declared_body_limits_reject_before_reading(self):
        for route, size in ((self.route, store.MAX_UPLOAD_BYTES + 1), ('/api/restore', store.MAX_BACKUP_BYTES + 1)):
            with self.subTest(route=route):
                self.assertEqual(self.request(route, b'x', 'POST', **{'Content-Length': str(size)})[0], 413)
        self.assertEqual(len(store.list_projects(self.db)), 1)
        self.assertEqual(store.get_project(self.db, self.project['id'])['image_count'], 0)
