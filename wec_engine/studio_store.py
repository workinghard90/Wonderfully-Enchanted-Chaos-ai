"""Transactional studio projects, normalized scene images and portable backups.

Images live in SQLite so project restore is atomic and needs no user-controlled
filesystem paths. All limits also apply to imported backups.
"""
import base64
from datetime import datetime, timezone
import binascii
from contextlib import closing, contextmanager
import io
import re
import sqlite3
import uuid
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError
from .story import plan_story

MAX_GENERATIONS_PER_DAY = 20
MAX_PROJECTS = 100
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_PIXELS = 32_000_000
MAX_IMAGE_EDGE = 2048
MAX_STUDIO_IMAGE_BYTES = 16 * 1024 * 1024
MAX_BACKUP_BYTES = 40 * 1024 * 1024


class StorageLimitError(ValueError):
    pass


class ProjectConflictError(ValueError):
    pass


class GenerationLimitError(ValueError):
    pass


@contextmanager
def _database(path):
    with closing(sqlite3.connect(path, timeout=15)) as db:
        db.execute('PRAGMA foreign_keys=ON')
        with db:
            yield db


def init_db(path):
    from pathlib import Path
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _database(path) as db:
        db.execute('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, story TEXT NOT NULL, duration REAL NOT NULL, scenes INTEGER NOT NULL, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
        db.execute('CREATE TABLE IF NOT EXISTS scene_images (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, scene_id TEXT NOT NULL, image BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (project_id,scene_id))')
        db.execute('CREATE TABLE IF NOT EXISTS image_generation_usage (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL)')
    return path


def _validated_project(payload):
    if not isinstance(payload, dict):
        raise ValueError('Expected a project object')
    title, story = payload.get('title', ''), payload.get('story', '')
    duration, scenes = payload.get('duration', 35), payload.get('scenes', 7)
    if not isinstance(title, str) or not title.strip() or len(title) > 150:
        raise ValueError('Title must be 1–150 characters')
    if not isinstance(story, str) or not story.strip() or len(story) > 30000:
        raise ValueError('Story must be 1–30000 characters')
    try:
        title.encode('utf-8')
        story.encode('utf-8')
    except UnicodeEncodeError as exc:
        raise ValueError('Project text contains invalid characters') from exc
    plan_story(story, total_duration=duration, scene_count=scenes)
    return {'title': title.strip(), 'story': story.strip(), 'duration': float(duration), 'scenes': scenes}


def _image_metadata(row):
    return dict(row)


def list_projects(path):
    with _database(path) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute('SELECT p.id,p.title,p.duration,p.scenes,p.updated,(SELECT COUNT(*) FROM scene_images WHERE project_id=p.id) AS image_count FROM projects p ORDER BY updated DESC,id')]


def get_project(path, pid):
    with _database(path) as db:
        db.row_factory = sqlite3.Row
        row = db.execute('SELECT * FROM projects WHERE id=?', (pid,)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result['images'] = {row['scene_id']: _image_metadata(row) for row in db.execute('SELECT scene_id,width,height,length(image) AS bytes,updated FROM scene_images WHERE project_id=?', (pid,))}
        result['image_count'] = len(result['images'])
        return result


def _check_project_limit(db, extra=1):
    if db.execute('SELECT COUNT(*) FROM projects').fetchone()[0] + extra > MAX_PROJECTS:
        raise StorageLimitError(f'This studio can hold {MAX_PROJECTS} projects. Restore fewer projects into a separate studio.')


def _check_image_limit(db, extra, replaced=0):
    current = db.execute('SELECT COALESCE(SUM(length(image)),0) FROM scene_images').fetchone()[0]
    if current + extra - replaced > MAX_STUDIO_IMAGE_BYTES:
        raise StorageLimitError('Scene image storage is full (16 MB). Download a backup, then remove unused scene images.')


def save_project(path, payload, pid=None):
    value = _validated_project(payload)
    if pid is not None and not re.fullmatch(r'[a-f0-9]{32}', pid):
        raise ValueError('Invalid project ID')
    pid = pid or uuid.uuid4().hex
    with _database(path) as db:
        db.execute('BEGIN IMMEDIATE')
        old = db.execute('SELECT story,scenes FROM projects WHERE id=?', (pid,)).fetchone()
        if old:
            changed = old != (value['story'], value['scenes'])
            has_images = db.execute('SELECT 1 FROM scene_images WHERE project_id=? LIMIT 1', (pid,)).fetchone()
            if changed and has_images:
                if payload.get('reset_images') is not True:
                    raise ProjectConflictError('Changing the story or scene count clears its scene images. Download a backup, then confirm the change.')
                db.execute('DELETE FROM scene_images WHERE project_id=?', (pid,))
            db.execute('UPDATE projects SET title=?,story=?,duration=?,scenes=?,updated=CURRENT_TIMESTAMP WHERE id=?', (*value.values(), pid))
        else:
            _check_project_limit(db)
            db.execute('INSERT INTO projects(id,title,story,duration,scenes) VALUES (?,?,?,?,?)', (pid, *value.values()))
    return get_project(path, pid)


def project_plan(project):
    plan = plan_story(project['story'], total_duration=project['duration'], scene_count=project['scenes'])
    plan['title'] = project['title']
    for scene in plan['scenes']:
        scene['image_asset'] = project.get('images', {}).get(scene['id'])
    return plan


def _read_image(raw, *, backup=False):
    limit = MAX_IMAGE_BYTES if backup else MAX_UPLOAD_BYTES
    if not raw or len(raw) > limit:
        raise StorageLimitError(f'Image exceeds the {limit // (1024 * 1024)} MB limit')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in ('JPEG', 'PNG', 'WEBP'):
                    raise ValueError('Choose a JPEG, PNG or WebP image')
                if image.width * image.height > MAX_IMAGE_PIXELS:
                    raise ValueError('Choose an image with no more than 32 million pixels')
                if backup:
                    if image.format != 'JPEG' or max(image.size) > MAX_IMAGE_EDGE:
                        raise ValueError('Backup contains an unsupported scene image; use a WEC image backup')
                    image.load()
                    return raw, image.width, image.height
                image = ImageOps.exif_transpose(image)
                image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
                if image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info):
                    rgba = image.convert('RGBA')
                    normalized = Image.new('RGB', rgba.size, 'white')
                    normalized.paste(rgba, mask=rgba.getchannel('A'))
                else:
                    normalized = image.convert('RGB')
                output = io.BytesIO()
                normalized.save(output, format='JPEG', quality=90)
                value = output.getvalue()
                if len(value) > MAX_IMAGE_BYTES:
                    raise StorageLimitError('Image is too detailed to store. Choose a smaller image.')
                return value, normalized.width, normalized.height
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError('The image could not be opened. Choose a valid JPEG, PNG or WebP image.') from exc


def _check_scene(db, pid, sid):
    row = db.execute('SELECT scenes FROM projects WHERE id=?', (pid,)).fetchone()
    if not row:
        raise LookupError('Project not found')
    valid = {f'scene-{index:03d}' for index in range(1, row[0] + 1)}
    if sid not in valid:
        raise LookupError('Scene not found')


def save_scene_image(path, pid, sid, raw, *, expected_project=None):
    value, width, height = _read_image(raw)
    with _database(path) as db:
        db.execute('BEGIN IMMEDIATE')
        _check_scene(db, pid, sid)
        if expected_project is not None:
            _check_generation_target(db, pid, sid, expected_project)
        old = db.execute('SELECT length(image) FROM scene_images WHERE project_id=? AND scene_id=?', (pid, sid)).fetchone()
        _check_image_limit(db, len(value), old[0] if old else 0)
        db.execute('INSERT INTO scene_images(project_id,scene_id,image,width,height) VALUES (?,?,?,?,?) ON CONFLICT(project_id,scene_id) DO UPDATE SET image=excluded.image,width=excluded.width,height=excluded.height,updated=CURRENT_TIMESTAMP', (pid, sid, value, width, height))
        db.execute('UPDATE projects SET updated=CURRENT_TIMESTAMP WHERE id=?', (pid,))
    return {'scene_id': sid, 'width': width, 'height': height, 'bytes': len(value)}


def get_scene_image(path, pid, sid):
    with _database(path) as db:
        _check_scene(db, pid, sid)
        row = db.execute('SELECT image FROM scene_images WHERE project_id=? AND scene_id=?', (pid, sid)).fetchone()
        if not row:
            raise LookupError('Scene image not found')
        return row[0]


def remove_scene_image(path, pid, sid):
    with _database(path) as db:
        db.execute('BEGIN IMMEDIATE')
        _check_scene(db, pid, sid)
        db.execute('DELETE FROM scene_images WHERE project_id=? AND scene_id=?', (pid, sid))
        db.execute('UPDATE projects SET updated=CURRENT_TIMESTAMP WHERE id=?', (pid,))
    return {'removed': True, 'scene_id': sid}


def export_backup(path, project_id=None):
    with _database(path) as db:
        db.execute('BEGIN')
        db.row_factory = sqlite3.Row
        projects = []
        rows = db.execute('SELECT * FROM projects WHERE id=?', (project_id,)) if project_id else db.execute('SELECT * FROM projects ORDER BY updated DESC,id')
        for row in rows:
            project = dict(row)
            project['scene_images'] = [
                {'scene_id': image['scene_id'], 'mime': 'image/jpeg',
                 'image_base64': base64.b64encode(image['image']).decode('ascii')}
                for image in db.execute('SELECT scene_id,image FROM scene_images WHERE project_id=? ORDER BY scene_id', (project['id'],))]
            projects.append(project)
        if project_id and not projects:
            raise LookupError('Project not found')
    return {'schema_version': 2, 'projects': projects}


def restore_backup(path, backup, *, only_if_empty=False):
    if type(only_if_empty) is not bool:
        raise ValueError('The empty-server recovery option must be true or false')
    if not isinstance(backup, dict) or type(backup.get('schema_version')) is not int or backup['schema_version'] not in (1, 2):
        raise ValueError('Choose a WEC backup with schema version 1 or 2')
    projects = backup.get('projects')
    if not isinstance(projects, list) or not 1 <= len(projects) <= MAX_PROJECTS:
        raise ValueError(f'Backup must contain between 1 and {MAX_PROJECTS} projects')
    prepared = []
    total_bytes = 0
    for source in projects:
        value = _validated_project(source)
        images = source.get('scene_images', [])
        if not isinstance(images, list) or len(images) > value['scenes']:
            raise ValueError('Invalid scene images in backup')
        if backup['schema_version'] == 1 and images:
            raise ValueError('Version 1 backups cannot contain scene images')
        scene_ids = {f'scene-{i:03d}' for i in range(1, value['scenes'] + 1)}
        seen = set()
        normalized = []
        for image in images:
            if not isinstance(image, dict) or not isinstance(image.get('scene_id'), str):
                raise ValueError('Invalid scene image in backup')
            sid, encoded = image['scene_id'], image.get('image_base64')
            if sid not in scene_ids or sid in seen:
                raise ValueError('Invalid or duplicate scene ID in backup')
            seen.add(sid)
            if image.get('mime') != 'image/jpeg' or not isinstance(encoded, str):
                raise ValueError('Invalid backup image format')
            if len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
                raise StorageLimitError('Backup scene image exceeds 2 MB')
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValueError('Invalid backup image encoding') from exc
            raw, width, height = _read_image(raw, backup=True)
            total_bytes += len(raw)
            if total_bytes > MAX_STUDIO_IMAGE_BYTES:
                raise StorageLimitError('Backup scene images exceed the 16 MB studio limit')
            normalized.append((sid, raw, width, height))
        prepared.append((uuid.uuid4().hex, value, normalized))
    with _database(path) as db:
        db.execute('BEGIN IMMEDIATE')
        if only_if_empty and db.execute('SELECT 1 FROM projects LIMIT 1').fetchone():
            raise ProjectConflictError('Server projects already exist. Nothing was recovered. Download the device backup to review it separately.')
        _check_project_limit(db, len(prepared))
        _check_image_limit(db, total_bytes)
        for pid, value, images in prepared:
            db.execute('INSERT INTO projects(id,title,story,duration,scenes) VALUES (?,?,?,?,?)', (pid, *value.values()))
            db.executemany('INSERT INTO scene_images(project_id,scene_id,image,width,height) VALUES (?,?,?,?,?)', [(pid, *image) for image in images])
    return {'restored': len(prepared), 'projects': [{'id': pid, 'title': value['title']} for pid, value, _ in prepared]}


def _generation_day():
    return datetime.now(timezone.utc).date().isoformat()


def generation_usage(path):
    with _database(path) as db:
        row = db.execute('SELECT attempts FROM image_generation_usage WHERE day=?', (_generation_day(),)).fetchone()
        return row[0] if row else 0


def _check_generation_target(db, pid, sid, expected_project):
    _check_scene(db, pid, sid)
    current = db.execute('SELECT story,scenes FROM projects WHERE id=?', (pid,)).fetchone()
    if current != (expected_project['story'], expected_project['scenes']):
        raise ProjectConflictError('The story or scenes changed while generating. Reopen the project and try again.')
    if db.execute('SELECT 1 FROM scene_images WHERE project_id=? AND scene_id=?', (pid, sid)).fetchone():
        raise ProjectConflictError('This scene already has an image. Keep a backup and remove it before generating another.')


def reserve_generation(path, pid, sid, expected_project):
    """Count every attempted call, including provider failures. No billing promise."""
    with _database(path) as db:
        db.execute('BEGIN IMMEDIATE')
        _check_generation_target(db, pid, sid, expected_project)
        # Leave room for the largest normalized image before using the allowance.
        _check_image_limit(db, MAX_IMAGE_BYTES)
        day = _generation_day()
        row = db.execute('SELECT attempts FROM image_generation_usage WHERE day=?', (day,)).fetchone()
        if row and row[0] >= MAX_GENERATIONS_PER_DAY:
            raise GenerationLimitError('This studio has used its 20 image attempts for today. Try after midnight UTC.')
        db.execute('INSERT INTO image_generation_usage(day,attempts) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1', (day,))
