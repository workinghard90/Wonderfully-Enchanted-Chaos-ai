"""Phase 9 responsive, single-server studio. Standard-library HTTP and SQLite.

Bind to loopback by default. Remote access requires TLS termination and authentication.
"""
import argparse
import hmac
import json
import os
import re
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, urlsplit
from .studio_store import (
    init_db, list_projects, get_project, save_project, project_plan,
    save_scene_image, get_scene_image, remove_scene_image,
    export_backup, restore_backup, StorageLimitError, ProjectConflictError,
    MAX_UPLOAD_BYTES, MAX_BACKUP_BYTES,
    generation_usage, reserve_generation, MAX_GENERATIONS_PER_DAY, GenerationLimitError,
)
from .orchestrator import run_production
from .providers.cloudflare_images import CloudflareImages, GenerationError, validate_prompt
from .studio_video import VideoJobs, VideoJobError

ROOT = Path(__file__).parent / 'studio_web'
MAX_BODY = 128 * 1024

def create_handler(db_path, data_dir, token=None, allowed_origin=None, video_jobs=None):
    """Allow one explicit HTTPS frontend origin; never wildcard authenticated APIs."""
    if allowed_origin:
        origin = urlsplit(allowed_origin)
        if (origin.scheme != 'https' or not origin.hostname or origin.username or origin.password
                or origin.path or origin.query or origin.fragment):
            raise ValueError('Allowed frontend origin must be a bare HTTPS origin')
        try:
            origin.port
        except ValueError:
            raise ValueError('Invalid frontend origin port') from None
    db_path = init_db(db_path)
    data_dir = Path(data_dir).resolve()
    media_lock = threading.Lock()
    image_provider = CloudflareImages()
    videos = video_jobs or VideoJobs(data_dir/'video-jobs')
    class Handler(BaseHTTPRequestHandler):
        video_jobs = videos
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def _headers(self, status, mime, length, extra=None):
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(length))
            self.send_header('Cache-Control', 'no-store')
            if allowed_origin and self.headers.get('Origin') == allowed_origin:
                self.send_header('Access-Control-Allow-Origin', allowed_origin)
                self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-WEC-Token')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Vary', 'Origin')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
        def _send(self, status, body, mime='application/json; charset=utf-8'):
            content = json.dumps(body, allow_nan=False, ensure_ascii=False).encode() if mime.startswith('application/json') else body
            self._headers(status, mime, len(content))
            self.wfile.write(content)
        def _movie(self, jid):
            # Authentication ran before this route. Credentials never enter URLs.
            path = videos.movie(jid)
            with path.open('rb') as source:
                size = os.fstat(source.fileno()).st_size
                start, end, status = 0, size-1, 200
                headers = {'Accept-Ranges': 'bytes', 'Content-Disposition': f'inline; filename="wec-video-{jid[:8]}.mp4"'}
                value = self.headers.get('Range')
                if value:
                    match = re.fullmatch(r'bytes=(\d{0,12})-(\d{0,12})', value)
                    if not match or not any(match.groups()):
                        self._headers(416, 'video/mp4', 0, {'Content-Range': f'bytes */{size}'}); return
                    first, last = match.groups()
                    if first:
                        start, end = int(first), min(int(last), size-1) if last else size-1
                    else:
                        start = max(0, size-int(last))
                    if start > end or start >= size or (not first and int(last) == 0):
                        self._headers(416, 'video/mp4', 0, {'Content-Range': f'bytes */{size}'}); return
                    status = 206
                    headers['Content-Range'] = f'bytes {start}-{end}/{size}'
                self._headers(status, 'video/mp4', end-start+1, headers)
                source.seek(start)
                remaining = end-start+1
                while remaining:
                    chunk = source.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        def _read_body(self, limit):
            if self.headers.get('Transfer-Encoding'):
                raise ValueError('Send a request with Content-Length')
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0:
                raise ValueError('Request body is required')
            if size > limit:
                raise StorageLimitError(f'Request exceeds {limit // (1024 * 1024)} MB' if limit >= 1024 * 1024 else 'Project request is too large')
            value = self.rfile.read(size)
            if len(value) != size:
                raise ValueError('Incomplete request body')
            return value
        def _authorized(self):
            if token and not hmac.compare_digest(self.headers.get('X-WEC-Token', ''), token):
                self._send(401, {'error':'Authentication required'})
                return False
            return True
        def _route(self):
            path = urlparse(self.path).path
            if self.command == 'GET' and path == '/':
                self._send(200, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8'); return
            # Fixed asset allowlist: user artwork is handled in the browser only.
            coloring_assets = {
                '/coloring': ('index.html', 'text/html; charset=utf-8'),
                '/coloring/': ('index.html', 'text/html; charset=utf-8'),
                '/coloring/app.js': ('app.js', 'application/javascript; charset=utf-8'),
                '/coloring/zip.js': ('zip.js', 'application/javascript; charset=utf-8'),
                '/coloring/style.css': ('style.css', 'text/css; charset=utf-8'),
            }
            if self.command == 'GET' and path in coloring_assets:
                name, mime = coloring_assets[path]
                self._send(200, (ROOT / 'coloring' / name).read_bytes(), mime); return
            if self.command == 'GET' and path in ('/app.js','/device-backup.js','/style.css','/config.js'):
                mime = 'application/javascript; charset=utf-8' if path.endswith('.js') else 'text/css; charset=utf-8'
                self._send(200, (ROOT / path.lstrip('/')).read_bytes(), mime); return
            if path == '/api/health' and self.command == 'GET':
                self._send(200, {'ok':True}); return
            if not self._authorized(): return
            if path == '/api/video' and self.command == 'GET':
                if not token or len(token) < 32:
                    self._send(200, {'ready': False, 'message': 'Set a studio access token of at least 32 characters to enable video export.',
                                     'jobs': [], 'max_duration': 35, 'max_scenes': 7, 'attempts_today': 0, 'daily_limit': 2})
                else:
                    self._send(200, videos.status())
                return
            video_start = re.fullmatch(r'/api/projects/([a-f0-9]{32})/video', path)
            if (video_start or path.startswith('/api/video-jobs/')) and (not token or len(token) < 32):
                self._send(503, {'error': 'Video export requires a studio access token of at least 32 characters.'}); return
            if video_start and self.command == 'POST':
                try:
                    body = json.loads(self._read_body(1024))
                    if not isinstance(body, dict) or set(body) - {'ambience'}:
                        raise ValueError('Choose the ambience setting only.')
                    with media_lock:
                        snapshot = export_backup(db_path, video_start.group(1))
                    self._send(202, videos.start(snapshot, video_start.group(1), ambience=body.get('ambience', True)))
                except VideoJobError as exc:
                    self._send(exc.status, {'error': str(exc)})
                except LookupError as exc:
                    self._send(404, {'error': str(exc)})
                except StorageLimitError as exc:
                    self._send(413, {'error': str(exc)})
                except (ValueError, TypeError) as exc:
                    self._send(400, {'error': str(exc)})
                return
            video_job = re.fullmatch(r'/api/video-jobs/([a-f0-9]{32})(/file|/cancel|/remove)?', path)
            if video_job:
                try:
                    jid, action = video_job.groups()
                    if self.command == 'GET' and action == '/file':
                        self._movie(jid); return
                    if self.command == 'GET' and not action:
                        self._send(200, videos.get(jid)); return
                    if self.command == 'POST' and action in ('/cancel', '/remove'):
                        self._send(200, videos.cancel(jid) if action == '/cancel' else videos.remove(jid)); return
                except VideoJobError as exc:
                    self._send(exc.status, {'error': str(exc)})
                    return
            if path == '/api/generation' and self.command == 'GET':
                self._send(200, {'ready': image_provider.ready(), 'provider': 'Cloudflare Workers AI',
                                 'model': 'FLUX.1 schnell', 'attempts_today': generation_usage(db_path),
                                 'daily_limit': MAX_GENERATIONS_PER_DAY})
                return
            generate_match = re.fullmatch(r'/api/projects/([a-f0-9]{32})/scenes/(scene-[0-9]{3})/generate', path)
            if generate_match and self.command == 'POST':
                if not media_lock.acquire(blocking=False):
                    self._send(429, {'error': 'Another image or backup operation is running. Try again shortly.'}); return
                try:
                    body = json.loads(self._read_body(16 * 1024))
                    prompt = validate_prompt(body.get('prompt') if isinstance(body, dict) else None)
                    if not image_provider.ready():
                        raise GenerationError('Image generation needs owner setup before it can run.', 503)
                    pid, sid = generate_match.groups()
                    project = get_project(db_path, pid)
                    if not project:
                        raise LookupError('Project not found')
                    reserve_generation(db_path, pid, sid, project)
                    raw = image_provider.generate(prompt)
                    try:
                        value = save_scene_image(db_path, pid, sid, raw, expected_project=project)
                    except (StorageLimitError, ProjectConflictError):
                        raise
                    except (ValueError, OSError):
                        raise GenerationError('The generated image could not be stored. Reopen the project before trying again.') from None
                    self._send(200, value)
                except GenerationError as exc:
                    self._send(exc.status, {'error': str(exc)})
                except GenerationLimitError as exc:
                    self._send(429, {'error': str(exc)})
                except StorageLimitError as exc:
                    self._send(413, {'error': str(exc)})
                except ProjectConflictError as exc:
                    self._send(409, {'error': str(exc)})
                except LookupError as exc:
                    self._send(404, {'error': str(exc)})
                except (ValueError, TypeError) as exc:
                    self._send(400, {'error': str(exc)})
                finally:
                    media_lock.release()
                return
            if path == '/api/backup' and self.command == 'GET':
                with media_lock:
                    self._send(200, export_backup(db_path))
                return
            if path == '/api/restore' and self.command == 'POST':
                if not media_lock.acquire(blocking=False):
                    self._send(429, {'error': 'Another image or backup operation is running. Try again shortly.'}); return
                try:
                    body = json.loads(self._read_body(MAX_BACKUP_BYTES))
                    only_if_empty = body.get('only_if_empty', False) if isinstance(body, dict) else False
                    self._send(200, restore_backup(db_path, body, only_if_empty=only_if_empty))
                except ProjectConflictError as exc:
                    self._send(409, {'error': str(exc)})
                except StorageLimitError as exc:
                    self._send(413, {'error': str(exc)})
                except (ValueError, TypeError) as exc:
                    self._send(400, {'error': str(exc)})
                finally:
                    media_lock.release()
                return
            image_match = re.fullmatch(r'/api/projects/([a-f0-9]{32})/scenes/(scene-[0-9]{3})/image(/remove)?', path)
            if image_match:
                pid, sid, remove = image_match.groups()
                if self.command == 'GET' and not remove:
                    try:
                        self._send(200, get_scene_image(db_path, pid, sid), 'image/jpeg')
                    except LookupError as exc:
                        self._send(404, {'error': str(exc)})
                    return
                if self.command == 'POST':
                    if not media_lock.acquire(blocking=False):
                        self._send(429, {'error': 'Another image or backup operation is running. Try again shortly.'}); return
                    try:
                        if remove:
                            value = remove_scene_image(db_path, pid, sid)
                        else:
                            value = save_scene_image(db_path, pid, sid, self._read_body(MAX_UPLOAD_BYTES))
                        self._send(200, value)
                    except StorageLimitError as exc:
                        self._send(413, {'error': str(exc)})
                    except LookupError as exc:
                        self._send(404, {'error': str(exc)})
                    except (ValueError, TypeError) as exc:
                        self._send(400, {'error': str(exc)})
                    finally:
                        media_lock.release()
                    return
            if path == '/api/projects' and self.command == 'GET':
                self._send(200, {'projects':list_projects(db_path)}); return
            m = re.fullmatch(r'/api/projects/([a-f0-9]{32})(/plan|/dry-run)?', path)
            if m and self.command == 'GET' and m.group(2) != '/dry-run':
                p = get_project(db_path, m.group(1))
                if not p: self._send(404, {'error':'Project not found'}); return
                self._send(200, project_plan(p) if m.group(2) else p); return
            if self.command == 'POST' and (path == '/api/projects' or (m and not m.group(2))):
                try:
                    body = json.loads(self._read_body(MAX_BODY))
                    if not isinstance(body, dict): raise ValueError('Expected a JSON object')
                    if m and not get_project(db_path, m.group(1)):
                        self._send(404, {'error':'Project not found'}); return
                    p = save_project(db_path, body, m.group(1) if m else None)
                    self._send(200, p)
                except StorageLimitError as e:
                    self._send(413, {'error':str(e)})
                except ProjectConflictError as e:
                    self._send(409, {'error':str(e)})
                except (ValueError, TypeError) as e:
                    self._send(400, {'error':str(e)})
                return
            if m and m.group(2) == '/dry-run' and self.command == 'GET':
                p = get_project(db_path, m.group(1))
                if not p: self._send(404, {'error':'Project not found'}); return
                folder = data_dir / 'projects' / p['id']
                self._send(200, run_production(folder / 'plan.json', folder / 'render',
                                               dry_run=True, _plan=project_plan(p))); return
            self._send(404, {'error':'Not found'})
        def do_OPTIONS(self):
            if allowed_origin and self.headers.get('Origin') == allowed_origin:
                self._send(204, b'', 'text/plain')
            else:
                self._send(403, {'error':'Origin not allowed'})
        def do_HEAD(self):
            self._send(405, {'error':'Method not allowed'})
        def do_GET(self):
            try: self._route()
            except (BrokenPipeError, ConnectionResetError): pass
            except Exception: self._send(500, {'error':'Internal server error'})
        def do_POST(self):
            try: self._route()
            except Exception: self._send(500, {'error':'Internal server error'})
    return Handler

def main(argv=None):
    parser = argparse.ArgumentParser(description='WEC responsive studio (single backend)')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--data-dir', default=os.environ.get('WEC_DATA_DIR', str(Path.home() / '.wec-studio')))
    args = parser.parse_args(argv)
    token = os.environ.get('WEC_STUDIO_TOKEN')
    if args.host not in ('127.0.0.1', 'localhost', '::1') and (not token or len(token) < 32):
        parser.error('Non-loopback access requires WEC_STUDIO_TOKEN with at least 32 characters. Use HTTPS reverse proxy for remote access.')
    directory = Path(args.data_dir)
    server = ThreadingHTTPServer((args.host, args.port), create_handler(directory/'studio.sqlite3', directory, token, os.environ.get('WEC_FRONTEND_ORIGIN')))
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(f'WEC Studio at http://{args.host}:{args.port} (Ctrl+C to stop)', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.RequestHandlerClass.video_jobs.close()
        server.server_close()

if __name__ == '__main__': main()
