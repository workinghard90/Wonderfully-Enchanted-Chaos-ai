"""Resumable, local production orchestration. No implicit cloud spending."""
import hashlib
import json
import math
import os
from pathlib import Path
from .animation import ComfyAnimation
from .integration import prepare_video_reference
from .router import HybridRouter
from .motion import render_clips
from .video import render_stills
from .production import captions_from_plan, finalize_video, verify_delivery


def _save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, path)


def _fingerprint(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()


def run_production(plan_path, workdir, *, audio=None, dry_run=False, generate_images=False,
                   animate=False, captions=True, allow_silent=False, comfy_url=None, _plan=None):
    """Run existing tools with checkpointed scene stages. Explicit input assets required.

    Video assembly is all-clips or all-stills; mixed scenes aren't silently substituted.
    Cloud generation is intentionally disabled until cumulative accounting exists.
    """
    comfy_url = comfy_url or os.environ.get('WEC_COMFY_URL') or 'http://127.0.0.1:8188'
    plan_path = Path(plan_path).resolve()
    plan = _plan if _plan is not None else json.loads(plan_path.read_text(encoding='utf-8'))
    scenes = plan.get('scenes', [])
    if not isinstance(scenes, list) or not scenes or any(not isinstance(scene, dict) for scene in scenes):
        raise ValueError('Plan needs a nonempty scene list')
    durations = [scene.get('duration') for scene in scenes]
    total = plan.get('duration')
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 1 / 30 for value in durations):
        raise ValueError('Each scene needs a finite duration of at least one frame')
    if isinstance(total, bool) or not isinstance(total, (int, float)) or not math.isfinite(total) or total <= 0:
        raise ValueError('Plan needs a positive finite total duration')
    if abs(sum(durations) - total) > max(.05, len(scenes) / 30):
        raise ValueError('Scene durations must add up to plan duration')
    ids = [scene.get('id') for scene in scenes]
    if any(not isinstance(sid, str) or not sid.replace('-', '').replace('_', '').isalnum() for sid in ids) or len(ids) != len(set(ids)):
        raise ValueError('Scene IDs must be unique and filename-safe')
    if animate and not generate_images and not all(s.get('image') for s in scenes):
        raise ValueError('Animation requires scene images or --generate-images')
    workdir = Path(workdir).resolve()
    if _plan is not None and not dry_run:
        raise ValueError('In-memory plans are only supported for dry-runs')
    options = {'audio': str(Path(audio).resolve()) if audio else None,
               'captions': captions, 'allow_silent': allow_silent,
               'generate_images': generate_images, 'animate': animate, 'comfy_url': comfy_url}
    fingerprint = _fingerprint({'plan': plan, 'options': options})
    state_path = workdir / 'production-state.json'
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding='utf-8'))
        if state['plan_sha256'] != fingerprint:
            raise ValueError('Plan changed or rendering options changed: use a new workdir to avoid mixing assets')
    else:
        state = {'plan_sha256': fingerprint, 'scenes': {}, 'stages': {}, 'final': None}
    tasks = []
    for scene in scenes:
        sid = scene['id']
        image = scene.get('image')
        clip = scene.get('video')
        if image and not Path(image).is_absolute():
            image = str((plan_path.parent / image).resolve())
        if clip and not Path(clip).is_absolute():
            clip = str((plan_path.parent / clip).resolve())
        if not image and generate_images:
            image = str(workdir / 'images' / (sid + '.png'))
            tasks.append('generate image: ' + sid)
        if not clip and animate:
            clip = str(workdir / 'clips' / (sid + '.mp4'))
            tasks.append('animate clip: ' + sid)
        state['scenes'][sid] = {'image': image, 'video': clip}
    tasks += ['assemble scenes', 'generate estimated captions' if captions else 'skip captions', 'finalize video', 'verify delivery']
    if dry_run:
        return {'dry_run': True, 'tasks': tasks, 'workdir': str(workdir), 'state_exists': state_path.exists()}
    workdir.mkdir(parents=True, exist_ok=True)
    _save(state_path, state)
    for scene in scenes:
        sid = scene['id']
        entry = state['scenes'][sid]
        image, clip = entry['image'], entry['video']
        if image and not Path(image).is_file() and generate_images:
            spec = dict(scene)
            if spec.get('comfy_workflow') and not Path(spec['comfy_workflow']).is_absolute():
                spec['comfy_workflow'] = str((plan_path.parent / spec['comfy_workflow']).resolve())
            spec['width'], spec['height'] = 1024, 1792
            if comfy_url:
                from .providers.comfy import ComfyProvider
                provider = ComfyProvider(base_url=comfy_url)
                router = HybridRouter(comfy=provider)
            else:
                router = HybridRouter()
            generated = router.generate(spec, workdir / 'images', allow_cloud=False)
            if Path(generated['image_path']).resolve() != Path(image).resolve():
                import shutil
                destination = Path(image)
                destination.parent.mkdir(parents=True, exist_ok=True)
                partial = destination.with_suffix(destination.suffix + '.tmp')
                shutil.copyfile(generated['image_path'], partial)
                partial.replace(destination)
        if clip and not Path(clip).is_file() and animate:
            workflow = scene.get('animation_workflow')
            if not workflow:
                raise ValueError(f'{sid} missing animation_workflow (API JSON)')
            if not Path(workflow).is_absolute():
                workflow = str((plan_path.parent / workflow).resolve())
            bindings = dict(scene.get('animation_bindings') or {})
            if scene.get('animation_image_binding'):
                if not image or not Path(image).is_file():
                    raise FileNotFoundError(f'{sid}: image needed for animation reference upload')
                reference_bindings = prepare_video_reference(
                    workflow, image, scene['animation_image_binding'],
                    comfy_url=comfy_url or 'http://127.0.0.1:8188')
                if set(reference_bindings) & set(bindings):
                    raise ValueError(f'{sid}: duplicate reference image binding')
                bindings.update(reference_bindings)
            runner = ComfyAnimation(base_url=comfy_url) if comfy_url else ComfyAnimation()
            runner.animate(workflow, clip, bindings=bindings)
        _save(state_path, state)
    entries = [dict(scene, **state['scenes'][scene['id']]) for scene in scenes]
    has_clips = all(x['video'] and Path(x['video']).is_file() for x in entries)
    has_images = all(x['image'] and Path(x['image']).is_file() for x in entries)
    if not (has_clips or has_images):
        raise FileNotFoundError('Each scene needs an existing video clip or image; no complete media set found')
    manifest = workdir / 'resolved-manifest.json'
    _save(manifest, {'scenes': entries})
    silent = workdir / 'silent.mp4'
    mode = 'clips' if has_clips else 'stills'
    if not silent.is_file() or state['stages'].get('assembly_mode') != mode:
        if has_clips:
            render_clips(manifest, silent)
        else:
            render_stills(manifest, silent)
        state['stages']['assembly_mode'] = mode
        _save(state_path, state)
    srt = workdir / 'captions.srt'
    if captions and not srt.is_file():
        captions_from_plan(plan_path, srt)
    if audio:
        audio = Path(audio).resolve()
        if not audio.is_file():
            raise FileNotFoundError(audio)
    elif not allow_silent:
        raise ValueError('Provide --audio or explicitly allow silent output with --allow-silent')
    final = workdir / 'final.mp4'
    if not final.is_file():
        finalize_video(silent, final, audio=audio, captions=srt if captions else None)
    report = verify_delivery(final, expected_duration=plan['duration'], require_audio=bool(audio))
    state['final'] = str(final) if report['ok'] else None
    state['stages']['verification'] = report
    _save(state_path, state)
    return {'ok': report['ok'], 'video': str(final), 'report': report, 'state': str(state_path), 'mode': mode}
