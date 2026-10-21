"""Explicit ComfyUI reference-image upload and live smoke checks.

No model installation, cloud billing, or remote host discovery is performed.
"""
import json
from pathlib import Path
import requests
from .deployment import validate_comfy_url
from .readiness import audit_workflow


def upload_reference(image_path, *, comfy_url='http://127.0.0.1:8188', overwrite=False, timeout=60):
    """Upload an operator-approved local image to ComfyUI's input directory."""
    url = validate_comfy_url(comfy_url)
    image = Path(image_path)
    if not image.is_file() or image.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp'):
        raise ValueError('Reference must be an existing PNG, JPEG, or WebP file')
    if image.stat().st_size > 30_000_000:
        raise ValueError('Reference exceeds 30 MB upload limit')
    with image.open('rb') as handle:
        response = requests.post(f'{url}/upload/image', files={'image': (image.name, handle)},
                                 data={'overwrite': 'true' if overwrite else 'false'}, timeout=timeout)
    response.raise_for_status()
    result = response.json()
    if not isinstance(result, dict) or not isinstance(result.get('name'), str) or not result['name']:
        raise RuntimeError('ComfyUI did not return an uploaded image name')
    return {'name': result['name'], 'subfolder': result.get('subfolder', ''), 'type': result.get('type', 'input')}


def prepare_video_reference(workflow_path, image_path, input_binding, *, comfy_url='http://127.0.0.1:8188'):
    """Validate explicit LoadImage binding BEFORE uploading; never guess a node ID."""
    if not isinstance(input_binding, str) or '.' not in input_binding:
        raise ValueError('input_binding must be node_id.input_name')
    node_id, key = input_binding.split('.', 1)
    workflow = json.loads(Path(workflow_path).read_text(encoding='utf-8'))
    audit_workflow(workflow_path, kind='video')
    node = workflow.get(node_id, {})
    if key != 'image' or 'loadimage' not in node.get('class_type', '').lower() or key not in node.get('inputs', {}):
        raise ValueError('Binding must target the image input of an existing LoadImage node')
    uploaded = upload_reference(image_path, comfy_url=comfy_url)
    subfolder = uploaded.get('subfolder', '').strip('/')
    return {input_binding: f"{subfolder}/{uploaded['name']}" if subfolder else uploaded['name']}


def live_check(comfy_url='http://127.0.0.1:8188', timeout=8):
    """Read-only live connectivity and node registry check; no job submitted."""
    url = validate_comfy_url(comfy_url)
    report = {'url': url, 'reachable': False, 'node_count': 0, 'can_upload_reference': False}
    try:
        response = requests.get(f'{url}/object_info', timeout=timeout)
        response.raise_for_status()
        registry = response.json()
        if not isinstance(registry, dict):
            raise ValueError('Invalid ComfyUI node registry')
        report.update(reachable=True, node_count=len(registry), can_upload_reference='LoadImage' in registry)
    except (requests.RequestException, ValueError) as exc:
        report['error'] = f'{type(exc).__name__}: {exc}'
    return report
