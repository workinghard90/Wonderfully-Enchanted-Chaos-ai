"""Immutable owner snapshots; one server process per storage directory.

Atomic directory rename publishes a self-contained package only after both
files are flushed. No mutable asset references or database are required.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
import time

MAX_PACKAGE = 90 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
MAX_SNAPSHOTS = 50
HEADROOM = 256 * 1024 * 1024


class SnapshotError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def sync_directory(path):
    # Windows does not expose directory fsync; Render runs Linux.
    if os.name != 'nt':
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def validate_package(raw):
    if not raw or len(raw) > MAX_PACKAGE:
        raise SnapshotError('Recovery package exceeds the 90 MiB limit.', 413)
    try:
        envelope = json.loads(raw)
        if (envelope['app'] != 'wec-recovery-package' or envelope['package_version'] != 1
                or not isinstance(envelope['payload'], str)
                or hashlib.sha256(envelope['payload'].encode()).hexdigest() != envelope['sha256']):
            raise ValueError()
        content = json.loads(envelope['payload'])
        project = content['project']
        versions = [project]
        cp = content['checkpoint']
        if cp is not None:
            if (type(cp['createdAt']) is not int or cp['createdAt'] < 0
                    or cp['project']['id'] != project['id'] or cp['project']['kind'] != project['kind']):
                raise ValueError()
            versions.append(cp['project'])
        for value in versions:
            if (value['app'] != 'wec-creative-studio' or value['schema_version'] != 1
                    or value['backup_version'] != 2
                    or value['kind'] not in ('art', 'video', 'coloring', 'storybook')
                    or not isinstance(value['id'], str) or len(value['id']) > 100
                    or not isinstance(value['title'], str) or len(value['title']) > 150
                    or not isinstance(value['pages'], list)
                    or len(value['pages']) > (7 if value['kind'] == 'video' else 80)):
                raise ValueError()
            total = 0
            for asset in [value.get('reference'), value.get('cover')] + [p.get('asset') for p in value['pages']]:
                if asset is None:
                    continue
                encoded = asset['image_base64']
                if not isinstance(encoded, str) or len(encoded) > 14 * 1024 * 1024:
                    raise ValueError()
                image = base64.b64decode(encoded, validate=True)
                total += len(image)
                if (not image or len(image) > 10 * 1024 * 1024 or total > 30 * 1024 * 1024
                        or hashlib.sha256(image).hexdigest() != asset['sha256']):
                    raise ValueError()
        return {'title': project['title'], 'kind': project['kind'], 'project_id': project['id'],
                'checkpoint': cp is not None}
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        raise SnapshotError('Invalid recovery package or picture checksum. Existing snapshots were kept.') from None


class OnlineStore:
    def __init__(self, directory):
        self.root = Path(directory)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        # Only uncommitted/deleted directories are cleaned. Single process only.
        for prefix in ('.upload-', '.deleted-'):
            for path in self.root.glob(prefix + '*'):
                if path.is_dir():
                    shutil.rmtree(path)

    def _path(self, key):
        if not isinstance(key, str) or not re.fullmatch('[a-f0-9]{64}', key):
            raise SnapshotError('Invalid snapshot identifier.')
        return self.root / key

    def _items(self):
        items = []
        for path in self.root.iterdir():
            if re.fullmatch('[a-f0-9]{64}', path.name) and path.is_dir():
                metadata = json.loads((path / 'metadata.json').read_text(encoding='utf-8'))
                if metadata.get('id') != path.name or (path / 'package.json').stat().st_size != metadata.get('bytes'):
                    raise SnapshotError('Online storage needs inspection: a snapshot is damaged.', 503)
                items.append(metadata)
        return sorted(items, key=lambda x: (x['created_at'], x['id']), reverse=True)

    def list(self):
        with self.lock:
            items = self._items()
            return {'enabled': True, 'snapshots': items, 'used_bytes': sum(x['bytes'] for x in items),
                    'max_bytes': MAX_TOTAL, 'max_snapshots': MAX_SNAPSHOTS, 'max_package_bytes': MAX_PACKAGE}

    def save(self, raw):
        with self.lock:
            metadata = validate_package(raw)
            key = hashlib.sha256(raw).hexdigest()
            target = self._path(key)
            if target.exists():
                with self.open(key):
                    pass  # Verify bytes before acknowledging an idempotent retry.
                return json.loads((target / 'metadata.json').read_text(encoding='utf-8'))
            items = self._items()
            if len(items) >= MAX_SNAPSHOTS or sum(x['bytes'] for x in items) + len(raw) > MAX_TOTAL:
                raise SnapshotError('Online storage is full. Download and remove an older snapshot before saving.', 413)
            if shutil.disk_usage(self.root).free < HEADROOM + len(raw):
                raise SnapshotError('The storage disk is low on space. Previous snapshots were kept.', 507)
            metadata.update(id=key, bytes=len(raw), created_at=int(time.time() * 1000))
            temporary = Path(tempfile.mkdtemp(prefix='.upload-', dir=self.root))
            try:
                for name, data in [('package.json', raw), ('metadata.json', json.dumps(metadata).encode())]:
                    with (temporary / name).open('xb') as output:
                        output.write(data)
                        output.flush()
                        os.fsync(output.fileno())
                sync_directory(temporary)
                os.rename(temporary, target)
                sync_directory(self.root)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
            return metadata

    def open(self, key):
        with self.lock:
            path = self._path(key) / 'package.json'
            try:
                source = path.open('rb')
            except FileNotFoundError:
                raise SnapshotError('Snapshot not found. Refresh the online library.', 404) from None
            digest = hashlib.sha256()
            try:
                for chunk in iter(lambda: source.read(65536), b''):
                    digest.update(chunk)
                if digest.hexdigest() != key:
                    raise SnapshotError('Snapshot checksum failed. Restore your independent downloaded backup.', 503)
                source.seek(0)
                return source
            except Exception:
                source.close()
                raise

    def remove(self, key):
        with self.lock:
            path = self._path(key)
            if not path.exists():
                return
            target = self.root / ('.deleted-' + key)
            os.rename(path, target)
            sync_directory(self.root)
            shutil.rmtree(target)
