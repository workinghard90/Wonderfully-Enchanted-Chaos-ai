"""Opt-in local ComfyUI artwork jobs. Preserve originals; never install models."""
import hashlib
import io
import json
import math
import time
import uuid
import warnings
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import requests
from PIL import Image

from .animation import bind_workflow
from .readiness import audit_workflow

MAX_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 24_000_000


def _json(path):
    path = Path(path)
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('Job and workflow JSON files must be at most 1 MiB')
    return json.loads(path.read_text(encoding='utf-8'))


def local_worker_url(url):
    """Loopback only; SSH forwarding can keep a separate GPU worker private."""
    parsed = urlsplit(url)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', '::1')
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ('', '/') or not parsed.port):
        raise ValueError('Use a loopback worker URL such as http://127.0.0.1:8188; keep remote workers behind a private tunnel')
    return url.rstrip('/')


def image_dimensions(raw):
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError('Artwork must be 1 byte to 10 MiB')
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(raw)) as image:
            width, height, fmt = image.width, image.height, image.format
            if fmt not in ('PNG', 'JPEG', 'WEBP') or width * height > MAX_PIXELS:
                raise ValueError('Artwork must be PNG/JPEG/WebP with at most 24 megapixels')
            image.verify()
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
    return width, height, fmt


def _positive(value, label):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError(f'{label} must be a positive finite number')
    return value


def resolution(width, height, box, target):
    ppi = max(width / box[0], height / box[1])
    return {'width_pixels': width, 'height_pixels': height, 'effective_ppi': ppi,
            'fitted_inches': [width / ppi, height / ppi], 'meets_ppi_target': ppi >= target}


def prepare_artwork_job(job_path):
    """Offline validation only. No directories, downloads or requests."""
    source = Path(job_path).resolve()
    job = _json(source)
    if not isinstance(job, dict) or type(job.get('schema_version')) is not int or job['schema_version'] != 1:
        raise ValueError('Expected an artwork job with schema_version 1')
    method = job.get('source_method')
    if method not in ('generation', 'reference_edit', 'upscale'):
        raise ValueError('Declare source_method as generation, reference_edit or upscale')
    workflow_name = job.get('workflow')
    if not isinstance(workflow_name, str) or not workflow_name:
        raise ValueError('A reviewed ComfyUI API workflow file is required')
    workflow_path = (source.parent / workflow_name).resolve()
    audit_workflow(workflow_path)
    workflow = _json(workflow_path)
    bindings = job.get('bindings', {})
    if not isinstance(bindings, dict):
        raise ValueError('bindings must map existing node_id.input_name fields to values')
    workflow = bind_workflow(workflow, bindings)
    node = job.get('save_image_node')
    if not isinstance(node, str) or workflow.get(node, {}).get('class_type') != 'SaveImage':
        raise ValueError('save_image_node must identify an existing standard SaveImage node')
    expected = job.get('expected_pixels')
    if (not isinstance(expected, list) or len(expected) != 2
            or any(type(v) is not int or v < 64 or v > 8192 for v in expected)
            or expected[0] * expected[1] > MAX_PIXELS):
        raise ValueError('expected_pixels needs two integer dimensions between 64 and 8192, at most 24 megapixels')
    box = job.get('artwork_box_inches', [7.5, 10])
    if not isinstance(box, list) or len(box) != 2:
        raise ValueError('artwork_box_inches needs width and height')
    box = [_positive(v, 'Artwork box size') for v in box]
    target = _positive(job.get('target_ppi', 300), 'target_ppi')
    reference = job.get('reference')
    reference_data = None
    if reference is not None:
        if not isinstance(reference, dict) or not isinstance(reference.get('file'), str):
            raise ValueError('reference needs file and an explicit LoadImage input_binding')
        binding = reference.get('input_binding')
        if not isinstance(binding, str) or '.' not in binding:
            raise ValueError('reference.input_binding must be node_id.image')
        nid, key = binding.split('.', 1)
        if key != 'image' or workflow.get(nid, {}).get('class_type') != 'LoadImage' or key not in workflow[nid]['inputs']:
            raise ValueError('Reference binding must identify an existing standard LoadImage image input')
        path = (source.parent / reference['file']).resolve()
        if path.stat().st_size > MAX_BYTES:
            raise ValueError('Reference exceeds 10 MiB')
        raw = path.read_bytes()
        _, _, fmt = image_dimensions(raw)
        reference_data = (binding, raw, {'PNG': 'png', 'JPEG': 'jpg', 'WEBP': 'webp'}[fmt])
    if method == 'reference_edit' and reference_data is None:
        raise ValueError('reference_edit requires an explicit reference upload/binding')
    report = {'schema_version': 1, 'state': 'validated_offline', 'worker_execution_completed': False, 'model_quality_reviewed': False,
              'source_method_declared_by_operator': method, 'native_generation_verified': False,
              'save_image_node': node, 'expected_pixels': expected, 'artwork_box_inches': box,
              'target_ppi': target, 'planned_resolution': resolution(*expected, box, target),
              'reference_supplied': reference_data is not None, 'publishing_review_required': True,
              'notice': 'Pixel checks do not certify detail, character consistency, line quality or KDP acceptance.'}
    return workflow, reference_data, report


def _request(session, method, url, *, limit=1024 * 1024, **kwargs):
    try:
        with session.request(method, url, timeout=(5, 20), allow_redirects=False, stream=True, **kwargs) as response:
            if response.status_code != 200:
                raise RuntimeError(f'Local worker returned HTTP {response.status_code}; no request was retried')
            chunks, size = [], 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > limit:
                    raise ValueError('Worker response exceeded the size limit')
                chunks.append(chunk)
        return b''.join(chunks)
    except requests.RequestException:
        raise RuntimeError('Local worker connection failed; inspect its queue before submitting another job') from None


def _safe_part(value):
    if not isinstance(value, str) or '\\' in value or '\x00' in value:
        raise ValueError('Invalid worker image path')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Invalid worker image path')
    return value


def run_artwork_job(job_path, output_dir, *, execute=False,
                    comfy_url='http://127.0.0.1:8188', wait_seconds=600):
    workflow, reference, report = prepare_artwork_job(job_path)
    url = local_worker_url(comfy_url)
    if not execute:
        return report
    if type(wait_seconds) is not int or not 1 <= wait_seconds <= 3600:
        raise ValueError('wait_seconds must be an integer from 1 to 3600')
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=False)  # A fresh folder prevents accidental resubmission/overwrite.
    report_path = destination / 'artwork-report.json'
    def checkpoint():
        partial = report_path.with_suffix('.json.tmp')
        partial.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        partial.replace(report_path)
    report['state'] = 'checking_worker'
    checkpoint()
    session = requests.Session()
    session.trust_env = False  # Never send a local job/reference through an environment proxy.
    try:
        registry = json.loads(_request(session, 'GET', url + '/object_info', limit=8 * 1024 * 1024))
        if not isinstance(registry, dict) or set(n['class_type'] for n in workflow.values()) - set(registry):
            raise ValueError('Required workflow nodes are missing from the local worker')
        if reference:
            binding, raw, ext = reference
            uploaded = json.loads(_request(session, 'POST', url + '/upload/image',
                files={'image': (f'wec-reference-{uuid.uuid4().hex}.{ext}', raw)}, data={'overwrite': 'false'}))
            name, folder = _safe_part(uploaded['name']), _safe_part(uploaded.get('subfolder', ''))
            if not name or '/' in name or uploaded.get('type', 'input') != 'input':
                raise ValueError('Invalid uploaded reference metadata')
            workflow = bind_workflow(workflow, {binding: f'{folder}/{name}' if folder else name})
        report['workflow_sha256'] = hashlib.sha256(json.dumps(workflow, sort_keys=True).encode()).hexdigest()
        report['state'] = 'submission_unconfirmed'
        checkpoint()
        queued = json.loads(_request(session, 'POST', url + '/prompt',
                         json={'prompt': workflow, 'client_id': str(uuid.uuid4())}))
        pid = queued.get('prompt_id')
        if not isinstance(pid, str) or not pid or len(pid) > 128 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in pid):
            raise ValueError('Worker did not return a valid prompt ID; inspect its queue before resubmitting')
        report.update(prompt_id=pid, state='submitted')
        checkpoint()
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            history = json.loads(_request(session, 'GET', url + '/history/' + pid))
            item = history.get(pid)
            if item:
                status = item.get('status', {})
                if status.get('status_str') == 'error':
                    raise RuntimeError('ComfyUI execution failed; inspect the local worker for details')
                # Only a completed, explicitly selected final output is acceptable.
                if status.get('completed'):
                    images = item.get('outputs', {}).get(report['save_image_node'], {}).get('images', [])
                    if len(images) != 1 or images[0].get('type') != 'output':
                        raise ValueError('Selected SaveImage must return exactly one final output image')
                    image = images[0]
                    params = {'filename': _safe_part(image['filename']),
                              'subfolder': _safe_part(image.get('subfolder', '')), 'type': 'output'}
                    if not params['filename'] or '/' in params['filename']:
                        raise ValueError('Invalid output filename')
                    raw = _request(session, 'GET', url + '/view', params=params, limit=MAX_BYTES)
                    width, height, fmt = image_dimensions(raw)
                    if fmt != 'PNG':
                        raise ValueError('SaveImage output must be PNG; no format conversion was performed')
                    target = destination / 'artwork.png'
                    partial = destination / 'artwork.png.tmp'
                    partial.write_bytes(raw)
                    partial.replace(target)
                    report.update(state='completed', worker_execution_completed=True, output_file='artwork.png', bytes=len(raw),
                                  sha256=hashlib.sha256(raw).hexdigest(),
                                  actual_resolution=resolution(width, height, report['artwork_box_inches'], report['target_ppi']),
                                  expected_pixels_match=[width, height] == report['expected_pixels'])
                    report['pixel_checks_pass'] = report['actual_resolution']['meets_ppi_target'] and report['expected_pixels_match']
                    checkpoint()
                    return report
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        report['state'] = 'timed_out'
        checkpoint()
        raise TimeoutError('Stopped waiting; the worker may still be running. Inspect its queue/history using the saved prompt ID. No resubmission occurred.')
    except Exception as exc:
        if report['state'] != 'timed_out':
            report['state_before_failure'] = report['state']
            report['state'] = 'failed'
        report['error_type'] = type(exc).__name__
        checkpoint()
        raise
    finally:
        session.close()
