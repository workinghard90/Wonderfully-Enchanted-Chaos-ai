"""A tiny synthetic movie for HTTP/browser tests. Never loads AI models."""
from pathlib import Path
import json
import subprocess
import sys
import time

root = Path(sys.argv[1])
project = json.loads((root/'backup.json').read_text())['projects'][0]
retry_fixture = project['title'].startswith('RETRY') and not json.loads((root/'status.json').read_text()).get('retry_of')
if project['title'].startswith('FAIL') or retry_fixture:
    print('synthetic-private-worker-error-must-not-leak', flush=True)
    raise SystemExit(1)
if project['title'].startswith('SLOW'):
    time.sleep(20)
progress = root/'progress.json'
progress.write_text(json.dumps({'progress': 60, 'message': 'Building synthetic test movie'}))
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
                '-i', 'color=c=teal:s=64x96:r=10', '-f', 'lavfi', '-i', 'sine=frequency=220',
                '-t', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-movflags', '+faststart', str(root/'movie.mp4')], check=True)
(root/'result.json').write_text(json.dumps({'ok': True, 'duration': 1}))
