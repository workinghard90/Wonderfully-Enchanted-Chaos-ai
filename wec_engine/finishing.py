"""Add an existing audio mix to a silent video without modifying the source."""
import shutil
import uuid
import subprocess
from pathlib import Path


def attach_audio(video, audio, output, *, shortest=True):
    if not shutil.which('ffmpeg'):
        raise RuntimeError('ffmpeg not found')
    for item in (video, audio):
        if not Path(item).is_file():
            raise FileNotFoundError(item)
    target = Path(output)
    if target.resolve() in (Path(video).resolve(), Path(audio).resolve()):
        raise ValueError('Output must differ from input files')
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.stem + '.partial.' + uuid.uuid4().hex + target.suffix)
    cmd = ['ffmpeg', '-y', '-i', str(video), '-i', str(audio),
           '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
           '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
    if shortest:
        cmd.append('-shortest')
    cmd.append(str(temp))
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)
    return target
