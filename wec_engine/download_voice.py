"""Explicit build/setup command for one checksum-pinned public Piper voice.

Never imported by studio startup or a render. No credentials are required.
"""
import hashlib
from pathlib import Path
import sys

import requests

REVISION = '5041a7a49ae5b3a0f30e6837769eb03fdbb231bd'
BASE = f'https://huggingface.co/rhasspy/piper-voices/resolve/{REVISION}/en/en_US/ljspeech/high/'
FILES = {
    'en_US-ljspeech-high.onnx': (114199011, '5d4f08ba6a2a48c44592eed3ce56bf85e9de3dd4e20df90541ae68a8310c029a'),
    'en_US-ljspeech-high.onnx.json': (4970, '7e1f4634af596d83cca997fb7a931ba80b70f8a316a2655ee69c55365e0ace14'),
}


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024*1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def download(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for name, (size, checksum) in FILES.items():
        target = directory/name
        if target.exists():
            if target.stat().st_size == size and digest(target) == checksum:
                continue
            raise FileExistsError(f'{name} already exists with different contents. Choose a new voice directory.')
        partial = directory/(name+'.partial')
        for attempt in range(3):
            offset = partial.stat().st_size if partial.exists() else 0
            if offset >= size:
                break
            try:
                with requests.get(BASE+name, headers={'Range': f'bytes={offset}-'},
                                  stream=True, timeout=(15, 120)) as response:
                    response.raise_for_status()
                    if response.status_code == 206:
                        if not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                            raise RuntimeError('Voice download returned an unexpected range')
                        mode = 'ab'
                    elif response.status_code == 200:
                        mode, offset = 'wb', 0
                    else:
                        raise RuntimeError('Voice download did not return file bytes')
                    with partial.open(mode) as output:
                        for chunk in response.iter_content(1024*1024):
                            offset += len(chunk)
                            if offset > size:
                                raise RuntimeError('Voice download exceeds its pinned size')
                            output.write(chunk)
            except requests.RequestException:
                if attempt == 2:
                    raise RuntimeError('Voice download could not finish; rerun this explicit setup command to resume.') from None
        if not partial.is_file() or partial.stat().st_size != size or digest(partial) != checksum:
            raise RuntimeError('Voice download checksum failed; the model was not installed')
        partial.replace(target)
    (directory/'VOICE_NOTICE.txt').write_text(
        'Piper en_US-ljspeech-high\nDataset: LJ Speech, public domain per model card.\n'
        'https://huggingface.co/rhasspy/piper-voices/blob/'+REVISION+'/en/en_US/ljspeech/high/MODEL_CARD\n'
        'Piper software: GPLv3, https://github.com/OHF-Voice/piper1-gpl\n', encoding='utf-8')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python -m wec_engine.download_voice VOICE_DIRECTORY')
    download(sys.argv[1])
