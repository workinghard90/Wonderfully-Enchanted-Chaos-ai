"""Phase 4: deterministic subtitle timing, optional Piper TTS, and final MP4 finishing.

No cloud charges or automatic downloads. FFmpeg must be installed locally.
"""
import json
import os
import tempfile
import math
import shutil
import uuid
import subprocess
from pathlib import Path


def _timecode(seconds):
    ms = round(float(seconds) * 1000)
    if ms < 0:
        raise ValueError('Negative subtitle timestamp')
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def captions_from_plan(plan_path, output_path):
    plan = json.loads(Path(plan_path).read_text(encoding='utf-8'))
    scenes = plan.get('scenes', [])
    if not scenes:
        raise ValueError('Plan has no scenes')
    cues = []
    last_end = 0.0
    for scene in scenes:
        start = float(scene['start'])
        duration = float(scene['duration'])
        end = start + duration
        if not math.isfinite(start) or not math.isfinite(duration) or start < last_end - 0.001 or duration <= 0:
            raise ValueError('Scenes overlap, are out of order, or have invalid durations')
        last_end = end
        line = ' '.join(str(scene.get('narration', '')).split())
        if line:
            cues.append(f'{len(cues)+1}\n{_timecode(start)} --> {_timecode(end)}\n{line}\n')
    if not cues:
        raise ValueError('No narration to caption')
    dest = Path(output_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text('\n'.join(cues) + '\n', encoding='utf-8')
    return dest


def synthesize_piper(text_path, model_path, output_path, *, piper='piper'):
    """Piper binary and voice model must already be installed by the operator."""
    if not shutil.which(piper):
        raise RuntimeError('Piper executable unavailable; install it separately')
    source, model, target = Path(text_path), Path(model_path), Path(output_path)
    if not source.is_file() or not model.is_file():
        raise FileNotFoundError('Narration text and Piper voice model are required')
    if target.resolve() in (source.resolve(), model.resolve()):
        raise ValueError('Output must not overwrite an input')
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.stem + '.partial.' + uuid.uuid4().hex + target.suffix)
    try:
        subprocess.run([piper, '--model', str(model), '--output_file', str(partial)],
                       input=source.read_text(encoding='utf-8'), text=True,
                       capture_output=True, check=True)
        if not partial.is_file() or partial.stat().st_size == 0:
            raise RuntimeError('Piper produced no audio')
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def finalize_video(video, output, *, audio=None, captions=None, fps=30, width=1080, height=1920):
    """Burn SRT subtitles, optionally attach an existing audio mix, and export H.264/AAC.

    SRT cues from story planning are estimated timings, not speech-aligned captions.
    """
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise RuntimeError('FFmpeg and FFprobe are required')
    video, target = Path(video).resolve(), Path(output).resolve()
    audio = Path(audio).resolve() if audio is not None else None
    captions = Path(captions).resolve() if captions is not None else None
    if not video.is_file():
        raise FileNotFoundError(video)
    if captions is not None and target == captions:
        raise ValueError('Output must differ from caption input')
    if target.resolve() == video.resolve():
        raise ValueError('Output must differ from video input')
    if audio is not None and not Path(audio).is_file():
        raise FileNotFoundError(audio)
    if captions is not None and not Path(captions).is_file():
        raise FileNotFoundError(captions)
    if audio is not None and target.resolve() == Path(audio).resolve():
        raise ValueError('Output must differ from audio input')
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.stem + '.partial.' + uuid.uuid4().hex + target.suffix)
    # A fixed relative caption filename avoids FFmpeg filter escaping problems on
    # Windows drive letters and paths containing apostrophes, commas or brackets.
    vf = f'scale={int(width)}:{int(height)}:force_original_aspect_ratio=increase,crop={int(width)}:{int(height)},setsar=1,fps={int(fps)}'
    if captions is not None:
        vf += ',subtitles=filename=captions.srt'
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(video)]
    if audio is not None:
        cmd += ['-i', str(audio)]
    cmd += ['-map', '0:v:0']
    if audio is not None:
        cmd += ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest']
    else:
        # Preserve any existing audio stream if the input video has one.
        cmd += ['-map', '0:a?', '-c:a', 'aac', '-b:a', '192k']
    cmd += ['-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium',
            '-crf', '23', '-threads', os.environ.get('WEC_FFMPEG_THREADS', '2'), '-movflags', '+faststart', str(partial)]
    try:
        with tempfile.TemporaryDirectory(prefix='wec-captions-') as temp:
            if captions is not None:
                shutil.copyfile(captions, Path(temp) / 'captions.srt')
            subprocess.run(cmd, check=True, capture_output=True, text=True, cwd=temp)
        if not partial.is_file() or partial.stat().st_size == 0:
            raise RuntimeError('FFmpeg produced no video')
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def verify_delivery(path, *, expected_duration=None, tolerance=1.0, require_audio=True, max_bytes=20_000_000):
    if not shutil.which('ffprobe'):
        raise RuntimeError('ffprobe is required')
    file = Path(path)
    if not file.is_file():
        raise FileNotFoundError(file)
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(file)],
                            check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    streams = data.get('streams', [])
    videos = [s for s in streams if s.get('codec_type') == 'video']
    audios = [s for s in streams if s.get('codec_type') == 'audio']
    duration = float(data.get('format', {}).get('duration', 0))
    checks = {'h264': len(videos) == 1 and videos[0].get('codec_name') == 'h264',
              'vertical_1080p': len(videos) == 1 and videos[0].get('width') == 1080 and videos[0].get('height') == 1920,
              'yuv420p': len(videos) == 1 and videos[0].get('pix_fmt') == 'yuv420p',
              'aac_audio': bool(audios) and audios[0].get('codec_name') == 'aac' if require_audio else True,
              'size_limit': file.stat().st_size <= max_bytes}
    if expected_duration is not None:
        checks['duration'] = abs(duration - float(expected_duration)) <= tolerance
    # MP4 faststart requires atom inspection beyond ffprobe's normal stream fields.
    with file.open('rb') as f:
        header = f.read(min(file.stat().st_size, 2_000_000))
    checks['faststart'] = b'moov' in header and (b'mdat' not in header or header.find(b'moov') < header.find(b'mdat'))
    return {'ok': all(checks.values()), 'checks': checks, 'duration': duration,
            'bytes': file.stat().st_size, 'path': str(file)}
