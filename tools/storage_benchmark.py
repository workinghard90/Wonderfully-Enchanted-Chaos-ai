"""Offline WEC snapshot throughput and recovery correctness benchmark.

Creates synthetic assets in an isolated temporary directory. Never uses the
production data path, Render service, paid models, or user projects. Reported
timings describe the CI/local machine, not live Render storage.
"""
import argparse
import base64
import hashlib
import json
import tempfile
import time
from pathlib import Path

from wec_engine.online_store import MAX_PACKAGE, MAX_SNAPSHOTS, OnlineStore


def build_package(index, image_bytes):
    encoded = base64.b64encode(image_bytes).decode('ascii')
    project = {
        'app': 'wec-creative-studio', 'schema_version': 1,
        'backup_version': 2, 'id': f'benchmark-{index}',
        'kind': 'art', 'title': f'Synthetic test {index}',
        'pages': [{'asset': {'image_base64': encoded,
                             'sha256': hashlib.sha256(image_bytes).hexdigest()}}],
    }
    payload = json.dumps({'project': project, 'checkpoint': None}, separators=(',', ':'))
    return json.dumps({
        'app': 'wec-recovery-package', 'package_version': 1, 'payload': payload,
        'sha256': hashlib.sha256(payload.encode('utf-8')).hexdigest(),
    }, separators=(',', ':')).encode('utf-8')


def benchmark(count=12, image_kib=128):
    if not 1 <= count <= min(MAX_SNAPSHOTS, 50) or not 1 <= image_kib <= 1024:
        raise ValueError('Use 1–50 samples and 1–1024 KiB per synthetic asset')
    with tempfile.TemporaryDirectory(prefix='wec-storage-benchmark-') as temporary:
        root = Path(temporary) / 'snapshots'
        store = OnlineStore(root)
        packages = {}
        start = time.perf_counter()
        for i in range(count):
            # Stable, non-private synthetic bytes; no AI or personal assets.
            seed = hashlib.sha256(f'wec-benchmark-{i}'.encode()).digest()
            raw_image = (seed * ((image_kib * 1024 + len(seed) - 1) // len(seed)))[:image_kib * 1024]
            payload = build_package(i, raw_image)
            if len(payload) > MAX_PACKAGE:
                raise ValueError('Synthetic recovery package exceeds limits')
            saved = store.save(payload)
            packages[saved['id']] = payload
        save_seconds = time.perf_counter() - start

        start = time.perf_counter()
        listing = store.list()
        list_seconds = time.perf_counter() - start
        if len(listing['snapshots']) != count or len(packages) != count:
            raise AssertionError('Saved snapshot count changed unexpectedly')
        if listing['used_bytes'] != sum(map(len, packages.values())):
            raise AssertionError('Snapshot accounting does not match stored bytes')

        start = time.perf_counter()
        reopened = OnlineStore(root)
        for key, original in packages.items():
            with reopened.open(key) as snapshot:
                recovered = snapshot.read()
            if recovered != original or hashlib.sha256(recovered).hexdigest() != key:
                raise AssertionError('Recovery bytes or checksum changed')
        recovery_seconds = time.perf_counter() - start

        return {
            'benchmark': 'synthetic snapshot storage, local temporary filesystem',
            'samples': count,
            'synthetic_image_kib': image_kib,
            'stored_bytes': listing['used_bytes'],
            'save_seconds': round(save_seconds, 4),
            'list_seconds': round(list_seconds, 4),
            'readback_seconds': round(recovery_seconds, 4),
            'checksum_roundtrip': 'pass',
            'note': 'No live Render disk, external provider, or user data accessed; no timing SLA inferred.',
        }


def main():
    parser = argparse.ArgumentParser(description='Benchmark synthetic WEC snapshot storage safely')
    parser.add_argument('--count', type=int, default=12)
    parser.add_argument('--image-kib', type=int, default=128)
    args = parser.parse_args()
    result = benchmark(args.count, args.image_kib)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
