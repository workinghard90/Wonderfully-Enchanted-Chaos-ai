"""Private CPU worker for the studio; never invokes image-generation services."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import signal

from .backup_video import render_backup_video


def write_json(path, value):
    target = Path(path)
    partial = target.with_suffix('.new')
    partial.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    partial.replace(target)


def narrate(root, model):
    # Bound ONNX's CPU pool and disable its retained memory arena on small hosts.
    # This subprocess exits before FFmpeg starts so model memory is released.
    import wave
    import onnxruntime as ort
    from piper import PiperVoice, SynthesisConfig
    from piper.config import PiperConfig
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    voice = PiperVoice(
        config=PiperConfig.from_dict(json.loads(Path(str(model)+'.json').read_text(encoding='utf-8'))),
        session=ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider']),
        download_dir=root,
    )
    plan = json.loads((root/'plan.json').read_text(encoding='utf-8'))
    for scene in plan['scenes']:
        with wave.open(str(root/(scene['id']+'-raw.wav')), 'wb') as wav:
            voice.synthesize_wav(scene['narration'], wav, syn_config=SynthesisConfig(length_scale=1.08))


def main(argv=None):
    args = list(argv or sys.argv[1:])
    if len(args) != 3 or args[0] not in ('render', 'narrate'):
        raise SystemExit('Use render|narrate JOB_DIRECTORY VOICE_MODEL')
    mode, root, model = args[0], Path(args[1]).resolve(), Path(args[2]).resolve()
    if mode == 'narrate':
        narrate(root, model)
        return
    parent = os.getppid()
    def watch_parent():
        while True:
            time.sleep(2)
            if os.name != 'nt' and os.getppid() != parent:
                if os.getpgrp() == os.getpid():
                    os.killpg(os.getpid(), signal.SIGKILL)
                os._exit(1)
    threading.Thread(target=watch_parent, daemon=True).start()
    request = json.loads((root/'request.json').read_text(encoding='utf-8'))
    def progress(value):
        write_json(root/'progress.json', value)
    def isolated_voice(plan, voice_model, work):
        subprocess.run([sys.executable, '-m', 'wec_engine.studio_video_worker', 'narrate', str(work), str(voice_model)],
                       check=True, timeout=240)
    report = render_backup_video(root/'backup.json', root/'movie.mp4', voice_model=model,
                                 workdir=root/'work', ambience=request['ambience'],
                                 progress=progress, narrator=isolated_voice)
    write_json(root/'result.json', {'duration': report['duration'], 'bytes': report['bytes'], 'ok': report['ok']})


if __name__ == '__main__':
    main()
