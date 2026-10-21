"""Offline, narrated vertical movies from a studio backup. No network calls.

Piper is an optional dependency. The operator supplies a voice model and its
JSON configuration; neither the studio nor this module downloads a model.
"""
import array
import hashlib
import json
import math
import shutil
import subprocess
import tempfile
import textwrap
import wave
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from .production import _timecode, verify_delivery
from .studio_store import get_project, get_scene_image, init_db, restore_backup
from .story import plan_story

SAMPLE_RATE = 22050
MAX_DURATION = 300
MAX_SCENES = 30
MAX_BACKUP_BYTES = 40 * 1024 * 1024


def _run(args, *, cwd=None):
    try:
        subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True, timeout=600)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError('FFmpeg failed: ' + (exc.stderr or '')[-1500:]) from None


def _selected_project(backup, project_index):
    if not isinstance(backup, dict) or backup.get('schema_version') != 2:
        raise ValueError('Choose a version 2 studio backup with attached scene images')
    projects = backup.get('projects')
    if not isinstance(projects, list) or not projects:
        raise ValueError('The backup contains no projects')
    if project_index is None:
        if len(projects) != 1:
            raise ValueError('Multiple projects: choose one with --project-index (starting at 0)')
        project_index = 0
    if isinstance(project_index, bool) or not isinstance(project_index, int) or not 0 <= project_index < len(projects):
        raise ValueError('Project index is outside this backup')
    return projects[project_index]


def prepare_backup(backup_path, workdir, *, project_index=None):
    """Validate through the studio importer and extract only the selected project.

    Paths from JSON are never used. A fresh workdir is required, and a missing
    image is an error rather than an invented or reused scene.
    """
    source, root = Path(backup_path).resolve(), Path(workdir).resolve()
    if source.stat().st_size > MAX_BACKUP_BYTES:
        raise ValueError('Choose a backup smaller than 40 MB')
    backup = json.loads(source.read_text(encoding='utf-8'))
    selected = _selected_project(backup, project_index)
    # Validate all fields, image formats, limits and scene IDs before writing.
    with tempfile.TemporaryDirectory(prefix='wec-backup-validate-') as temp:
        db = init_db(Path(temp) / 'studio.sqlite3')
        restored = restore_backup(db, {'schema_version': 2, 'projects': [selected]})
        pid = restored['projects'][0]['id']
        project = get_project(db, pid)
        if project['duration'] > MAX_DURATION or project['scenes'] > MAX_SCENES:
            raise ValueError('Video export supports at most 300 seconds and 30 scenes')
        plan = plan_story(project['story'], total_duration=project['duration'], scene_count=project['scenes'])
        plan['title'] = project['title']
        missing = [scene['id'] for scene in plan['scenes'] if scene['id'] not in project['images']]
        if missing:
            raise ValueError('Attach an image to every scene first. Missing: ' + ', '.join(missing))
        if any(not scene['narration'].strip() for scene in plan['scenes']):
            raise ValueError('Every scene needs narration; reduce the scene count')
        if root.exists():
            raise FileExistsError('Choose a new workdir; existing files are preserved')
        root.mkdir(parents=True)
        for scene in plan['scenes']:
            name = scene['id'] + '.jpg'
            (root / name).write_bytes(get_scene_image(db, pid, scene['id']))
            scene['image'] = name
    (root / 'plan.json').write_text(json.dumps(plan, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    return plan


def _synthesize_scenes(plan, model, root):
    try:
        from piper import PiperVoice, SynthesisConfig
    except ImportError:
        raise RuntimeError('Install narration support with: python -m pip install ".[narration]"') from None
    voice = PiperVoice.load(str(model), use_cuda=False)
    config = SynthesisConfig(length_scale=1.08)
    for scene in plan['scenes']:
        with wave.open(str(root / (scene['id'] + '-raw.wav')), 'wb') as wav:
            voice.synthesize_wav(scene['narration'], wav, syn_config=config)


def _read_pcm(path):
    with wave.open(str(path), 'rb') as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, SAMPLE_RATE):
            raise ValueError('Expected mono 16-bit 22050 Hz narration')
        raw = wav.readframes(wav.getnframes())
    values = array.array('h')
    values.frombytes(raw)
    import sys
    if sys.byteorder != 'little':
        values.byteswap()
    return values


def _write_pcm(path, values):
    import sys
    samples = array.array('h', values)
    if sys.byteorder != 'little':
        samples.byteswap()
    with wave.open(str(path), 'wb') as wav:
        wav.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
        wav.writeframes(samples.tobytes())


def _caption_line(text):
    # Block ASS/HTML control markup from story text; preserve visible wording.
    text = ' '.join(text.split()).replace('\\', '＼').replace('{', '｛').replace('}', '｝')
    text = text.replace('<', '‹').replace('>', '›')
    return '\n'.join(textwrap.wrap(text, width=26, break_long_words=False, break_on_hyphens=False))


def _ass_time(value):
    cs = round(value * 100)
    hours, cs = divmod(cs, 360000)
    minutes, cs = divmod(cs, 6000)
    seconds, cs = divmod(cs, 100)
    return f'{hours}:{minutes:02d}:{seconds:02d}.{cs:02d}'


def make_narration(plan, root, *, ambience=False):
    """Place separate recordings on the scene timeline without cutting words.

    Captions follow the measured utterance interval, not word-level alignment.
    A recording may be sped up by at most 35%; longer text requires a longer
    project duration. This avoids silently truncating narration at scene cuts.
    """
    root = Path(root)
    total_samples = round(plan['duration'] * SAMPLE_RATE)
    mix = [0.0] * total_samples
    timings, srt = [], []
    ass = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920',
           'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '[V4+ Styles]',
           'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
           'Style: Default,DejaVu Sans,62,&H00FFFFFF,&H00FFFFFF,&H00201913,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,85,85,150,1',
           '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    for scene in plan['scenes']:
        sid = scene['id']
        clean = root / (sid + '-voice.wav')
        _run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(root / (sid + '-raw.wav')),
              '-af', 'silenceremove=start_periods=1:start_duration=0.01:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_duration=0.01:start_threshold=-45dB,areverse',
              '-ar', str(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', str(clean)])
        samples = _read_pcm(clean)
        if not samples or max(abs(value) for value in samples) < 32:
            raise ValueError('Narrator returned empty or silent audio for ' + sid)
        lead = min(0.35, scene['duration'] * 0.15)
        available = scene['duration'] - lead - min(0.25, scene['duration'] * 0.1)
        duration = len(samples) / SAMPLE_RATE
        speed = max(1.0, duration / available)
        if speed > 1.35:
            raise ValueError(f'{sid} narration is too long. Increase the project duration or shorten this scene.')
        if speed > 1.0:
            fitted = root / (sid + '-fitted.wav')
            # Slightly conservative speed avoids losing the final phoneme to rounding.
            speed = min(1.35, speed * 1.005)
            _run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(clean),
                  '-af', f'atempo={speed:.6f}', '-ar', str(SAMPLE_RATE), '-ac', '1',
                  '-c:a', 'pcm_s16le', str(fitted)])
            samples = _read_pcm(fitted)
        start_sample = round((scene['start'] + lead) * SAMPLE_RATE)
        scene_end = round((scene['start'] + scene['duration']) * SAMPLE_RATE)
        if start_sample + len(samples) > min(scene_end, total_samples):
            raise ValueError('Narration would overlap the next scene: ' + sid)
        peak = max(abs(value) for value in samples)
        gain = 0.76 * 32767 / peak
        fade = max(1, round(0.008 * SAMPLE_RATE))
        for index, sample in enumerate(samples):
            envelope = min(1.0, index / fade, (len(samples) - 1 - index) / fade)
            mix[start_sample + index] += sample * gain * envelope
        start, end = start_sample / SAMPLE_RATE, (start_sample + len(samples)) / SAMPLE_RATE
        line = _caption_line(scene['narration'])
        srt.append(f'{len(srt)+1}\n{_timecode(start)} --> {_timecode(end)}\n{line}\n')
        ass.append(f'Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{line.replace(chr(10), chr(92)+"N")}')
        timings.append({'scene_id': sid, 'start': start, 'end': end, 'speed': speed,
                        'caption': line, 'alignment': 'measured utterance, not individual words'})
    if ambience:
        # Original procedural pad/chimes, no samples, downloads, or external music.
        for i in range(total_samples):
            t = i / SAMPLE_RATE
            envelope = min(1.0, t / 1.5, (plan['duration'] - t) / 2.0)
            chord = sum(math.sin(2 * math.pi * frequency * t) for frequency in (130.813, 164.814, 195.998, 261.626)) / 4
            mix[i] += 32767 * 0.025 * envelope * chord
        for scene in plan['scenes'][1:]:
            offset = round(scene['start'] * SAMPLE_RATE)
            for j in range(min(round(0.8 * SAMPLE_RATE), total_samples - offset)):
                t = j / SAMPLE_RATE
                mix[offset + j] += 32767 * 0.035 * math.exp(-7 * t) * math.sin(2 * math.pi * 1046.502 * t)
    _write_pcm(root / 'narration-mix.wav', (max(-32767, min(32767, round(value))) for value in mix))
    (root / 'captions.srt').write_text('\n'.join(srt) + '\n', encoding='utf-8')
    (root / 'captions.ass').write_text('\n'.join(ass) + '\n', encoding='utf-8')
    (root / 'narration-timing.json').write_text(json.dumps(timings, indent=2) + '\n', encoding='utf-8')
    return timings


def _scene_plate(source, output):
    with Image.open(source) as original:
        image = ImageOps.exif_transpose(original).convert('RGB')
        background = ImageOps.fit(image, (1080, 1920)).filter(ImageFilter.GaussianBlur(38))
        background = ImageEnhance.Brightness(background).enhance(0.38)
        foreground = ImageOps.contain(image, (1020, 1500))
        # Reserve space below the art for captions and preserve the full picture.
        background.paste(foreground, ((1080 - foreground.width) // 2, 100 + (1500 - foreground.height) // 2))
        background.save(output, quality=95)


def render_backup_video(backup_path, output_path, *, voice_model, workdir=None,
                        project_index=None, ambience=False, progress=None, narrator=None):
    def notify(stage, percent, message):
        if progress:
            progress({'stage': stage, 'progress': percent, 'message': message})
    source, output, model = (Path(value).resolve() for value in (backup_path, output_path, voice_model))
    if output.suffix.lower() != '.mp4':
        raise ValueError('Output must use the .mp4 extension')
    if output.exists():
        raise FileExistsError('Output already exists; choose a new filename')
    if not model.is_file() or not Path(str(model) + '.json').is_file():
        raise FileNotFoundError('A Piper .onnx voice and its matching .onnx.json are required')
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise RuntimeError('Install FFmpeg and FFprobe before exporting video')
    if output in (source, model, Path(str(model) + '.json')):
        raise ValueError('Output must differ from inputs')
    root = Path(workdir).resolve() if workdir else output.with_name(output.stem + '-work')
    notify('snapshot', 5, 'Preparing your saved scenes')
    plan = prepare_backup(source, root, project_index=project_index)
    notify('narration', 12, 'Recording the narration')
    (narrator or _synthesize_scenes)(plan, model, root)
    notify('audio', 25, 'Timing captions and mixing audio')
    timings = make_narration(plan, root, ambience=ambience)
    concat = []
    for scene in plan['scenes']:
        notify('scenes', 30 + round(45 * len(concat) / len(plan['scenes'])),
               f'Building scene {len(concat)+1} of {len(plan["scenes"])}')
        plate = root / (scene['id'] + '-plate.jpg')
        _scene_plate(root / scene['image'], plate)
        frames = max(1, round(scene['duration'] * 30))
        clip = scene['id'] + '.mp4'
        zoom = f"zoompan=z='min(zoom+0.00012,1.018)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d={frames}:s=1080x1920:fps=30"
        _run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(plate),
              '-vf', zoom, '-frames:v', str(frames), '-an', '-c:v', 'libx264', '-preset', 'fast',
              '-crf', '22', '-threads', '2', '-pix_fmt', 'yuv420p', str(root / clip)])
        concat.append(f"file '{clip}'")
    (root / 'clips.txt').write_text('\n'.join(concat) + '\n', encoding='utf-8')
    final = root / 'final.mp4'
    notify('finishing', 82, 'Adding captions and finishing the movie')
    _run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1',
          '-f', 'concat', '-safe', '1', '-i', 'clips.txt', '-i', 'narration-mix.wav',
          '-vf', 'subtitles=filename=captions.ass', '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-threads', '2',
          '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
          '-t', str(plan['duration']), '-movflags', '+faststart', 'final.mp4'], cwd=root)
    notify('verification', 96, 'Checking your finished movie')
    report = verify_delivery(final, expected_duration=plan['duration'], tolerance=0.1)
    report.update({'title': plan['title'], 'narration': 'Piper local neural TTS',
                   'voice_model': model.name, 'ambience': ambience,
                   'backup_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                   'caption_timing': 'Measured utterance intervals; not word-level forced alignment',
                   'scenes': timings})
    if not report['ok']:
        (root / 'verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        raise RuntimeError('Video failed delivery verification; inspect verification.json in the workdir')
    if output.exists():
        raise FileExistsError('Output appeared during rendering; existing file is preserved')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Copy to the destination filesystem before the final atomic replacement.
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.wec-video-', suffix='.mp4', delete=False) as temp:
        partial = Path(temp.name)
    try:
        shutil.copyfile(final, partial)
        partial.replace(output)
    finally:
        partial.unlink(missing_ok=True)
    report['path'] = str(output)
    (root / 'verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    notify('complete', 100, 'Your movie is ready')
    return report
