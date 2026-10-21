"""Phase 7: offline workflow audit and opt-in ComfyUI preflight; never downloads weights."""
import json
from pathlib import Path

import requests

from .animation import bind_workflow
from .deployment import diagnose, validate_comfy_url


def audit_workflow(path, kind='image', bindings=None):
    if kind not in ('image', 'video'):
        raise ValueError('kind must be image or video')
    workflow = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(workflow, dict) or not workflow:
        raise ValueError('Expected a nonempty ComfyUI API-format workflow object')
    for node_id, node in workflow.items():
        if not isinstance(node, dict) or not isinstance(node.get('class_type'), str) or not isinstance(node.get('inputs'), dict):
            raise ValueError(f'Invalid API node {node_id}; export API-format JSON, not UI workflow JSON')
    bound = bind_workflow(workflow, bindings or {})
    classes = sorted({node['class_type'] for node in bound.values()})
    names = ' '.join(classes).lower()
    if kind == 'image':
        export_candidates = [nid for nid, n in bound.items() if 'saveimage' in n['class_type'].lower()]
    else:
        export_candidates = [nid for nid, n in bound.items() if any(x in n['class_type'].lower() for x in ('videosave', 'savevideo', 'videocombine', 'vhs_video', 'createvideo'))]
    models = sorted({str(v) for n in bound.values() for k, v in n['inputs'].items()
                     if isinstance(v, str) and any(t in k.lower() for t in ('ckpt_name', 'unet_name', 'lora_name', 'vae_name', 'model_name'))})
    warnings = []
    if not export_candidates:
        warnings.append(f'No recognizable {kind} export node; inspect workflow output and adapter compatibility')
    if kind == 'video' and not any(x in names for x in ('video', 'wan', 'ltx', 'animate')):
        warnings.append('No recognizable video node class; verify this is a video workflow')
    return {'valid_api_format': True, 'kind': kind, 'nodes': len(bound), 'classes': classes,
            'model_filenames_referenced': models, 'export_node_candidates': export_candidates,
            'warnings': warnings, 'ready_for_execution': bool(export_candidates) and not warnings}


def preflight(workflow_path=None, kind='image', bindings=None, comfy_url='http://127.0.0.1:8188', check_network=False):
    url = validate_comfy_url(comfy_url)
    result = {'schema_version': 1, 'diagnostics': diagnose(comfy_url=url, check_network=check_network)}
    if workflow_path:
        result['workflow'] = audit_workflow(workflow_path, kind=kind, bindings=bindings)
    if check_network:
        try:
            resp = requests.get(f'{url}/object_info', timeout=8)
            resp.raise_for_status()
            available = resp.json()
            if not isinstance(available, dict):
                raise ValueError('ComfyUI object_info was not an object')
            if workflow_path:
                missing = sorted(set(result['workflow']['classes']) - set(available))
                result['workflow']['missing_node_classes'] = missing
                result['workflow']['ready_for_execution'] &= not missing
            result['comfy_node_registry'] = 'reachable'
        except (requests.RequestException, ValueError) as exc:
            result['comfy_node_registry'] = f'unavailable: {type(exc).__name__}'
            if workflow_path:
                result['workflow']['ready_for_execution'] = False
    return result
