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
from urllib.parse import parse_qs, urlparse, urlsplit
from .studio_store import (
    init_db, list_projects, get_project, save_project, project_plan,
    save_scene_image, get_scene_image, remove_scene_image,
    export_backup, restore_backup, StorageLimitError, ProjectConflictError,
    MAX_UPLOAD_BYTES, MAX_BACKUP_BYTES,
    generation_usage, reserve_generation, MAX_GENERATIONS_PER_DAY, GenerationLimitError,
)
from .orchestrator import run_production
from .providers.cloudflare_images import CloudflareImages, GenerationError, validate_prompt, prepare_reference
from .studio_video import VideoJobs, VideoJobError, TERMINAL
from .studio_image_requests import ImageRequests, ReceiptError
from . import creative
from .online_store import OnlineStore, SnapshotError, MAX_PACKAGE
from .studio_store import reserve_creative_generation, reserve_text_generation
from .providers.cloudflare_text import CloudflareText, MODEL as TEXT_MODEL, draft_settings

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
    text_provider = CloudflareText()
    image_requests = ImageRequests(db_path)
    videos = video_jobs or VideoJobs(data_dir/'video-jobs')
    online_reason = 'Online storage is not enabled. Local saves and downloaded recovery packages still work.'
    online = None
    if os.environ.get('WEC_ENABLE_ONLINE_STORAGE') == '1':
        if not token or len(token) < 32:
            online_reason = 'Online storage requires authenticated owner access.'
        elif os.environ.get('RENDER') and not os.path.ismount(data_dir):
            online_reason = 'Online storage requires a persistent disk mounted at WEC_DATA_DIR.'
        else:
            try:
                online = OnlineStore(data_dir/'creative-snapshots')
            except OSError:
                online_reason = 'Online storage is unavailable. Check the disk mount and write permissions.'
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
        def _online(self, path):
            if path == '/api/creative/snapshots' and self.command == 'GET' and online is None:
                self._send(200, {'enabled': False, 'reason': online_reason}); return
            if online is None:
                self._send(503, {'error': online_reason}); return
            if not media_lock.acquire(blocking=False):
                self._send(429, {'error': 'Another image, export or storage operation is running. Try again when it finishes.'}); return
            try:
                if path == '/api/creative/snapshots':
                    if self.command == 'GET':
                        self._send(200, online.list())
                    elif self.command == 'POST':
                        if any(job['status'] not in TERMINAL for job in videos.status()['jobs']):
                            raise SnapshotError('Wait for the current video render to finish before uploading an online snapshot.', 429)
                        self._send(201, online.save(self._read_body(MAX_PACKAGE)))
                    return
                match = re.fullmatch(r'/api/creative/snapshots/([a-f0-9]{64})(/remove)?', path)
                if not match:
                    self._send(404, {'error': 'Snapshot not found'}); return
                key, remove = match.groups()
                if remove and self.command == 'POST':
                    body = json.loads(self._read_body(1024))
                    if body != {'confirm': key}:
                        raise SnapshotError('Confirm the exact snapshot to remove.')
                    online.remove(key)
                    self._send(200, {'removed': key})
                elif not remove and self.command == 'GET':
                    with online.open(key) as source:
                        self._headers(200, 'application/json', os.fstat(source.fileno()).st_size,
                                      {'Content-Disposition': f'attachment; filename="wec-{key[:12]}-recovery.json"'})
                        for chunk in iter(lambda: source.read(65536), b''):
                            self.wfile.write(chunk)
                else:
                    self._send(405, {'error': 'Method not allowed'})
            except SnapshotError as error:
                self._send(error.status, {'error': str(error)})
            except StorageLimitError as error:
                self._send(413, {'error': str(error)})
            except (ValueError, TypeError, RecursionError):
                self._send(400, {'error': 'Invalid snapshot request. Existing snapshots were kept.'})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass  # A committed snapshot remains discoverable after a lost response.
            except OSError:
                self._send(503, {'error': 'Storage is unavailable. Refresh the online library before retrying; keep your local project.'})
            finally:
                media_lock.release()
        def _image_receipt(self, receipt):
            if receipt['state'] == 'ready':
                self._send(200, receipt['image'], receipt['mime'])
            else:
                self._send(receipt['status'], {'error': receipt['message'], 'request_state': receipt['state']})

        def _creative_image(self):
            request_id = None
            started = locked = completed = False
            try:
                if not token or len(token) < 32:
                    raise GenerationError('Creative image generation requires a studio token of at least 32 characters.', 503)
                body = json.loads(self._read_body(14 * 1024 * 1024))
                prompt = validate_prompt(body.get('prompt') if isinstance(body, dict) else None)
                if set(body) - {'prompt', 'mode', 'reference_image_base64', 'request_id'}:
                    raise ValueError('Unsupported image generation options')
                if 'request_id' in body:
                    request_id, fingerprint = image_requests.identity(body)
                    receipt = image_requests.get(request_id, fingerprint)
                    if receipt:
                        self._image_receipt(receipt)
                        return
                if not media_lock.acquire(blocking=False):
                    raise GenerationError('Another image, export or backup operation is running.', 429)
                locked = True
                if not image_provider.ready():
                    raise GenerationError(image_provider.setup_message(), 503)
                mode = body.get('mode', 'text')
                if mode not in ('text', 'reference'):
                    raise ValueError('Choose text or reference generation')
                reference = None
                if mode == 'reference':
                    reference = prepare_reference(body.get('reference_image_base64'))
                elif 'reference_image_base64' in body:
                    raise ValueError('Choose reference mode to send a reference image')
                if request_id:
                    image_requests.start(request_id, fingerprint)
                    started = True
                reserve_creative_generation(db_path)
                raw = image_provider.generate(prompt, reference=reference) if reference is not None else image_provider.generate(prompt)
                import io
                from PIL import Image
                with Image.open(io.BytesIO(raw)) as image:
                    mime = Image.MIME[image.format]
                if request_id:
                    image_requests.complete(request_id, raw, mime)
                completed = True
                self._send(200, raw, mime)
            except (BrokenPipeError, ConnectionResetError):
                # Preserve completed receipts; unfinished provider calls are never retried.
                if started and not completed:
                    image_requests.fail(request_id, 'The connection ended before this picture was saved. No automatic retry was made.', 502)
            except Exception as exc:
                if completed:
                    # A response-write failure must not tell the browser to discard recovery.
                    raise
                if isinstance(exc, (GenerationError, ReceiptError)):
                    status, message = exc.status, str(exc)
                elif isinstance(exc, GenerationLimitError):
                    status, message = 429, str(exc)
                elif isinstance(exc, StorageLimitError):
                    status, message = 413, str(exc)
                elif isinstance(exc, (ValueError, TypeError, KeyError)):
                    status, message = 400, str(exc)
                else:
                    status, message = 500, 'The picture could not be saved. Check its recovery status before starting another attempt.'
                if started:
                    image_requests.fail(request_id, message, status)
                self._send(status, {'error': message, 'request_state': 'failed' if started else 'not_started'})
            finally:
                if locked:
                    media_lock.release()

        def _route(self):
            path = urlparse(self.path).path
            # Preserve old project bookmarks while making the shared studio the home page.
            if self.command == 'GET' and (path in ('/video', '/video/') or
                    (path == '/' and 'project' in parse_qs(urlparse(self.path).query))):
                self._send(200, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8'); return
            creative_assets = {
                '/': ('index.html', 'text/html; charset=utf-8'),
                '/studio': ('index.html', 'text/html; charset=utf-8'),
                '/studio/': ('index.html', 'text/html; charset=utf-8'),
                '/studio/app.js': ('app.js', 'application/javascript; charset=utf-8'),
                '/studio/video.js': ('video.js', 'application/javascript; charset=utf-8'),
                '/studio/artwork-picker.js': ('artwork-picker.js', 'application/javascript; charset=utf-8'),
                '/studio/store.js': ('store.js', 'application/javascript; charset=utf-8'),
                '/studio/style.css': ('style.css', 'text/css; charset=utf-8'),
            }
            if self.command == 'GET' and path in creative_assets:
                name, mime = creative_assets[path]
                self._send(200, (ROOT / 'creative' / name).read_bytes(), mime); return
            # Fixed public asset allowlist; saved artwork requires authenticated APIs.
            coloring_assets = {
                '/coloring': ('index.html', 'text/html; charset=utf-8'),
                '/coloring/': ('index.html', 'text/html; charset=utf-8'),
                '/coloring/app.js': ('app.js', 'application/javascript; charset=utf-8'),
                '/coloring/zip.js': ('zip.js', 'application/javascript; charset=utf-8'),
                '/coloring/project-store.js': ('project-store.js', 'application/javascript; charset=utf-8'),
                '/coloring/print-check.js': ('print-check.js', 'application/javascript; charset=utf-8'),
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
            if path == '/api/creative/snapshots' or path.startswith('/api/creative/snapshots/'):
                self._online(path); return
            match = re.fullmatch(r'/api/creative/image-requests/([a-f0-9]{32})', path)
            if match and self.command == 'GET':
                receipt = image_requests.get(match.group(1))
                if receipt:
                    self._image_receipt(receipt)
                else:
                    self._send(404, {'error': 'No saved result was found. Temporary server storage may have reset or the receipt expired. No new generation was started.', 'request_state': 'missing'})
                return
            if path == '/api/creative/image' and self.command == 'POST':
                self._creative_image(); return
            if path == '/api/creative/text' and self.command == 'GET':
                self._send(200, {'ready': bool(text_provider.ready() and token and len(token) >= 32), 'model': TEXT_MODEL, 'daily_limit': 5}); return
            if path in ('/api/creative/plan', '/api/creative/pdf', '/api/creative/cover', '/api/creative/video', '/api/creative/draft') and self.command == 'POST':
                if not media_lock.acquire(blocking=False):
                    self._send(429, {'error': 'Another image, export or backup operation is running.'}); return
                try:
                    limit = 128 * 1024 if path.endswith(('/plan', '/draft')) else creative.MAX_CREATIVE_BODY
                    body = json.loads(self._read_body(limit))
                    if path.endswith('/plan'):
                        self._send(200, creative.plan(body))
                    elif path.endswith('/pdf'):
                        self._send(200, creative.book_pdf(body), 'application/pdf')
                    elif path.endswith('/cover'):
                        self._send(200, creative.cover_pdf(body), 'application/pdf')
                    elif path.endswith('/video'):
                        self._send(200, creative.video_project(db_path, body))
                    elif path.endswith('/draft'):
                        if not token or len(token) < 32 or not text_provider.ready():
                            raise GenerationError('AI drafting needs owner setup and a studio token of at least 32 characters.', 503)
                        settings = draft_settings(body)
                        reserve_text_generation(db_path)
                        self._send(200, text_provider.generate(settings))
                except GenerationError as exc:
                    self._send(exc.status, {'error': str(exc)})
                except GenerationLimitError as exc:
                    self._send(429, {'error': str(exc)})
                except StorageLimitError as exc:
                    self._send(413, {'error': str(exc)})
                except (ValueError, TypeError, KeyError, OSError) as exc:
                    self._send(400, {'error': str(exc)})
                finally:
                    media_lock.release()
                return
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
                        job = videos.start(snapshot, video_start.group(1), ambience=body.get('ambience', True))
                    self._send(202, job)
                except VideoJobError as exc:
                    self._send(exc.status, {'error': str(exc)})
                except LookupError as exc:
                    self._send(404, {'error': str(exc)})
                except StorageLimitError as exc:
                    self._send(413, {'error': str(exc)})
                except (ValueError, TypeError) as exc:
                    self._send(400, {'error': str(exc)})
                return
            video_job = re.fullmatch(r'/api/video-jobs/([a-f0-9]{32})(/file|/cancel|/remove|/retry)?', path)
            if video_job:
                try:
                    jid, action = video_job.groups()
                    if self.command == 'GET' and action == '/file':
                        self._movie(jid); return
                    if self.command == 'GET' and not action:
                        self._send(200, videos.get(jid)); return
                    if self.command == 'POST' and action == '/retry':
                        if not media_lock.acquire(blocking=False):
                            self._send(429, {'error': 'Another media or storage operation is running. Try again when it finishes.'}); return
                        try:
                            self._send(202, videos.retry(jid))
                        finally:
                            media_lock.release()
                        return
                    if self.command == 'POST' and action in ('/cancel', '/remove'):
                        self._send(200, videos.cancel(jid) if action == '/cancel' else videos.remove(jid)); return
                except VideoJobError as exc:
                    self._send(exc.status, {'error': str(exc)})
                    return
            if path == '/api/generation' and self.command == 'GET':
                self._send(200, {'ready': image_provider.ready(), 'provider': 'Cloudflare Workers AI',
                                 'model': 'FLUX.1 schnell',
                                 'creative_ready': bool(image_provider.ready() and token and len(token) >= 32),
                                 'message': (image_provider.setup_message() if token and len(token) >= 32 else
                                             'Creative generation requires WEC_STUDIO_TOKEN with at least 32 characters on the server.'),
                                 'reference_ready': bool(image_provider.ready() and token and len(token) >= 32),
                                 'reference_model': 'FLUX.2 klein 4B', 'attempts_today': generation_usage(db_path),
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
                        raise GenerationError(image_provider.setup_message(), 503)
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
