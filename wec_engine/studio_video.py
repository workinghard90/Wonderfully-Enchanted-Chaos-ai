"""Authenticated studio video-job controller. One CPU job, no image inference."""
from datetime import datetime, timezone
from contextlib import closing, contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

from .studio_video_worker import write_json

MAX_SECONDS = 35
MAX_SCENES = 7
MAX_STORY_WORDS = 100
DAILY_LIMIT = 2
MAX_JOBS = 3
MAX_MOVIE_BYTES = 20_000_000
JOB_TIMEOUT = 1200
TERMINAL = {'ready', 'failed', 'cancelled', 'interrupted'}
PUBLIC_FIELDS = {'id', 'project_id', 'title', 'status', 'progress', 'message', 'created_at',
                 'finished_at', 'duration', 'bytes'}


class VideoJobError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(timezone.utc).isoformat()


class VideoJobs:
    def __init__(self, directory, *, enabled=None, model=None, worker_command=None):
        self.root = Path(directory).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.enabled = os.getenv('WEC_ENABLE_VIDEO_RENDER') == '1' if enabled is None else enabled
        self.model = Path(model or os.getenv('WEC_PIPER_MODEL', '')).resolve()
        self.worker_command = worker_command
        self.lock = threading.RLock()
        self.processes = {}
        self.cancelled = set()
        self.closed = False
        with self._db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL)')
        self._recover()

    @contextmanager
    def _db(self):
        with closing(sqlite3.connect(self.root/'usage.sqlite3', timeout=10)) as db:
            with db:
                yield db

    def _folder(self, jid):
        if not isinstance(jid, str) or not re.fullmatch(r'[a-f0-9]{32}', jid):
            raise VideoJobError('Video not found', 404)
        return self.root/jid

    def _record(self, jid):
        try:
            return json.loads((self._folder(jid)/'status.json').read_text(encoding='utf-8'))
        except (FileNotFoundError, ValueError):
            raise VideoJobError('Video not found', 404) from None

    def get(self, jid):
        with self.lock:
            value = self._record(jid)
            return {key: value[key] for key in PUBLIC_FIELDS if key in value}

    def _save(self, value):
        write_json(self._folder(value['id'])/'status.json', value)

    def _recover(self):
        # A restart never silently re-runs a render or consumes another attempt.
        for path in self.root.glob('*/status.json'):
            try:
                value = json.loads(path.read_text(encoding='utf-8'))
                owner = value.get('owner_pid')
                alive = False
                if owner:
                    try:
                        os.kill(owner, 0)
                        alive = True
                    except (ProcessLookupError, OSError):
                        pass
                if value.get('status') not in TERMINAL and not alive:
                    value.update(status='interrupted', message='The server restarted. Start a new render when ready.', finished_at=now())
                    self._save(value)
            except (ValueError, OSError, VideoJobError):
                continue

    def ready(self):
        return bool(self.enabled and self.model.is_file() and Path(str(self.model)+'.json').is_file()
                    and shutil.which('ffmpeg') and shutil.which('ffprobe')
                    and importlib.util.find_spec('piper'))

    def _usage(self):
        with self._db() as db:
            row = db.execute('SELECT attempts FROM usage WHERE day=?', (datetime.now(timezone.utc).date().isoformat(),)).fetchone()
        return row[0] if row else 0

    def status(self):
        with self.lock:
            jobs = []
            for path in self.root.glob('*/status.json'):
                try:
                    jobs.append(self.get(path.parent.name))
                except VideoJobError:
                    continue
            jobs.sort(key=lambda job: job['created_at'], reverse=True)
            ready = self.ready()
            return {'ready': ready, 'message': 'Render a saved story using its attached pictures. No image AI calls are made.' if ready else 'Video rendering needs owner setup.',
                    'max_duration': MAX_SECONDS, 'max_scenes': MAX_SCENES,
                    'attempts_today': self._usage(), 'daily_limit': DAILY_LIMIT,
                    'max_saved_videos': MAX_JOBS, 'jobs': jobs}

    def start(self, snapshot, project_id, *, ambience=True):
        with self.lock:
            if self.closed or not self.ready():
                raise VideoJobError('Video rendering needs owner setup.', 503)
            project = snapshot['projects'][0]
            if project['duration'] > MAX_SECONDS or project['scenes'] > MAX_SCENES:
                raise VideoJobError('This video test supports up to 35 seconds and 7 scenes.')
            if len(project['story']) > 1000 or len(project['story'].split()) > MAX_STORY_WORDS:
                raise VideoJobError('Keep this short-video test to 100 words and 1000 characters. Shorten the story before rendering.')
            expected = {f'scene-{i:03d}' for i in range(1, project['scenes']+1)}
            if {image['scene_id'] for image in project.get('scene_images', [])} != expected:
                raise VideoJobError('Attach a picture to every scene before rendering.')
            if len(project['story'].split()) < project['scenes']:
                raise VideoJobError('Every scene needs narration. Reduce the scene count.')
            if type(ambience) is not bool:
                raise VideoJobError('Ambience must be true or false.')
            if len(self.status()['jobs']) >= MAX_JOBS:
                raise VideoJobError('Download and remove an older video before making another.', 429)
            active = self.root/'active.lock'
            try:
                with active.open('x') as lock:
                    lock.write(str(os.getpid()))
            except FileExistsError:
                try:
                    os.kill(int(active.read_text()), 0)
                except (ProcessLookupError, ValueError):
                    active.unlink(missing_ok=True)
                    return self.start(snapshot, project_id, ambience=ambience)
                raise VideoJobError('A video is already rendering. Wait or cancel it first.', 409) from None
            try:
                with self._db() as db:
                    db.execute('BEGIN IMMEDIATE')
                    day = datetime.now(timezone.utc).date().isoformat()
                    row = db.execute('SELECT attempts FROM usage WHERE day=?', (day,)).fetchone()
                    if row and row[0] >= DAILY_LIMIT:
                        raise VideoJobError('The two-render daily test limit has been reached. Try tomorrow (UTC).', 429)
                    db.execute('INSERT INTO usage VALUES (?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1', (day,))
                jid = uuid.uuid4().hex
                folder = self._folder(jid)
                folder.mkdir()
                raw = json.dumps(snapshot, ensure_ascii=False).encode('utf-8')
                (folder/'backup.json').write_bytes(raw)
                write_json(folder/'request.json', {'ambience': ambience})
                value = {'id': jid, 'project_id': project_id, 'title': project['title'], 'status': 'queued',
                         'progress': 0, 'message': 'Your saved scenes are queued for rendering.',
                         'created_at': now(), 'owner_pid': os.getpid(), 'snapshot_sha256': hashlib.sha256(raw).hexdigest()}
                self._save(value)
                thread = threading.Thread(target=self._run, args=(jid,), daemon=True)
                thread.start()
                return self.get(jid)
            except Exception:
                active.unlink(missing_ok=True)
                raise

    @staticmethod
    def _stop(process):
        if process.poll() is not None:
            return
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def _run(self, jid):
        folder = self._folder(jid)
        process = None
        try:
            with self.lock:
                if jid in self.cancelled:
                    return
                command = self.worker_command or [sys.executable, '-m', 'wec_engine.studio_video_worker', 'render']
                with (folder/'worker.log').open('wb') as log:
                    environment = {key: value for key, value in os.environ.items()
                                   if not re.search(r'TOKEN|SECRET|PASSWORD|API_KEY', key.upper())}
                    environment['OMP_NUM_THREADS'] = '1'
                    process = subprocess.Popen(command + [str(folder), str(self.model)], stdout=log, stderr=subprocess.STDOUT,
                                               start_new_session=os.name != 'nt', env=environment)
                self.processes[jid] = process
                value = self._record(jid)
                value.update(status='running', message='Starting your movie')
                self._save(value)
            deadline = time.monotonic() + JOB_TIMEOUT
            while process.poll() is None:
                if time.monotonic() > deadline or (folder/'worker.log').stat().st_size > 1_000_000:
                    self._stop(process)
                    raise RuntimeError('Render limit reached')
                with self.lock:
                    if jid in self.cancelled:
                        self._stop(process)
                        return
                    try:
                        progress = json.loads((folder/'progress.json').read_text(encoding='utf-8'))
                        value = self._record(jid)
                        value.update(progress=max(0, min(99, int(progress['progress']))), message=str(progress['message'])[:150])
                        self._save(value)
                    except (OSError, ValueError, KeyError):
                        pass
                time.sleep(0.5)
            with self.lock:
                if jid in self.cancelled:
                    return
                result = json.loads((folder/'result.json').read_text(encoding='utf-8')) if process.returncode == 0 else {}
                movie = folder/'movie.mp4'
                if not result.get('ok') or not movie.is_file() or not 0 < movie.stat().st_size <= MAX_MOVIE_BYTES:
                    raise RuntimeError('Render did not finish')
                value = self._record(jid)
                value.update(status='ready', progress=100, message='Your movie is ready. Download it to keep it.',
                             duration=result['duration'], bytes=movie.stat().st_size, finished_at=now())
                self._save(value)
                shutil.rmtree(folder/'work', ignore_errors=True)
        except Exception:
            with self.lock:
                value = self._record(jid)
                if value['status'] not in TERMINAL:
                    value.update(status='failed', message='Rendering stopped. Your story and pictures are safe. The owner can inspect the render log.', finished_at=now())
                    self._save(value)
        finally:
            with self.lock:
                if process is not None:
                    self._stop(process)
                    process.wait(timeout=5)
                self.processes.pop(jid, None)
                (self.root/'active.lock').unlink(missing_ok=True)

    def cancel(self, jid):
        with self.lock:
            value = self._record(jid)
            if value['status'] not in TERMINAL:
                self.cancelled.add(jid)
                if jid in self.processes:
                    self._stop(self.processes[jid])
                value.update(status='cancelled', message='Render cancelled. Your project is unchanged.', finished_at=now())
                self._save(value)
            return self.get(jid)

    def remove(self, jid):
        with self.lock:
            value = self._record(jid)
            if value['status'] not in TERMINAL or jid in self.processes:
                raise VideoJobError('Wait for the render to stop before removing it.', 409)
            shutil.rmtree(self._folder(jid))
            return {'removed': True}

    def movie(self, jid):
        with self.lock:
            if self._record(jid)['status'] != 'ready':
                raise VideoJobError('This movie is not ready yet.', 409)
            path = self._folder(jid)/'movie.mp4'
            if not path.is_file():
                raise VideoJobError('The server copy is unavailable. Render again from your project.', 404)
            return path

    def close(self):
        with self.lock:
            self.closed = True
            for job in self.status()['jobs']:
                if job['status'] not in TERMINAL:
                    self.cancel(job['id'])
