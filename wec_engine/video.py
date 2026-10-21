"""Assemble manifest-relative stills into silent H.264 video atomically."""
import json
import math
import os
import shutil
import uuid
import subprocess
from pathlib import Path


def _render(manifest_path, output_path, *, clips=False, fps=30, width=1080, height=1920):
    if not shutil.which('ffmpeg'):
        raise RuntimeError('ffmpeg executable not found')
    manifest_path = Path(manifest_path).resolve()
    scenes = json.loads(manifest_path.read_text(encoding='utf-8'))['scenes']
    if not scenes:
        raise ValueError('No scenes')
    output = Path(output_path).resolve()
    inputs = []
    durations = []
    for scene in scenes:
        path = Path(scene['video' if clips else 'image'])
        if not path.is_absolute():
            path = manifest_path.parent / path
        path = path.resolve()
        if not path.is_file():
            raise FileNotFoundError(path)
        if output == path or output == manifest_path:
            raise ValueError('Output must differ from every input')
        duration = float(scene['duration'])
        if not math.isfinite(duration) or duration < 1 / fps:
            raise ValueError('Scene duration must be finite and at least one frame')
        inputs.append(path)
        durations.append(duration)
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.stem + '.partial.' + uuid.uuid4().hex + output.suffix)
    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1']
    for path, duration in zip(inputs, durations):
        if not clips:
            args += ['-loop', '1', '-framerate', str(fps), '-t', str(duration)]
        args += ['-i', str(path)]
    filters = []
    for i, duration in enumerate(durations):
        frames = max(1, round(duration * fps))
        pad = f'tpad=stop_mode=clone:stop_duration={duration},' if clips else ''
        filters.append(f'[{i}:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps={fps},{pad}trim=end_frame={frames},setpts=PTS-STARTPTS,format=yuv420p[v{i}]')
    filters.append(''.join(f'[v{i}]' for i in range(len(scenes))) + f'concat=n={len(scenes)}:v=1:a=0[outv]')
    args += ['-filter_complex', ';'.join(filters), '-map', '[outv]', '-an', '-c:v', 'libx264',
             '-threads', os.environ.get('WEC_FFMPEG_THREADS', '2'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(partial)]
    try:
        subprocess.run(args, check=True, capture_output=True, text=True)
        if not partial.is_file() or not partial.stat().st_size:
            raise RuntimeError('FFmpeg produced no video')
        partial.replace(output)
    finally:
        partial.unlink(missing_ok=True)
    return output


def render_stills(manifest_path, output_path, *, fps=30):
    return _render(manifest_path, output_path, fps=fps)


def probe(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)
