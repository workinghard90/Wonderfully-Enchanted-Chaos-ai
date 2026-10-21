"""Phase 9 responsive, single-server studio. Standard-library HTTP and SQLite.

Bind to loopback by default. Remote access requires TLS termination and authentication.
"""
import argparse
from contextlib import closing, contextmanager
import hmac
import json
import os
import re
import sqlite3
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, urlsplit
from .story import plan_story
from .orchestrator import run_production

ROOT = Path(__file__).parent / 'studio_web'
MAX_BODY = 128 * 1024

@contextmanager
def _database(path):
    # SQLite's transaction context commits/rolls back but does not close handles.
    # Explicit closure is necessary for Windows file access and long-running HTTP use.
    with closing(sqlite3.connect(path)) as db:
        with db:
            yield db


def init_db(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _database(path) as db:
        db.execute('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, story TEXT NOT NULL, duration REAL NOT NULL, scenes INTEGER NOT NULL, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    return path

def list_projects(path):
    with _database(path) as db:
        db.row_factory = sqlite3.Row
        return [dict(x) for x in db.execute('SELECT id,title,duration,scenes,updated FROM projects ORDER BY updated DESC')]

def get_project(path, pid):
    with _database(path) as db:
        db.row_factory = sqlite3.Row
        row = db.execute('SELECT * FROM projects WHERE id=?', (pid,)).fetchone()
        return dict(row) if row else None

def save_project(path, payload, pid=None):
    title = payload.get('title', '')
    story = payload.get('story', '')
    duration = payload.get('duration', 35)
    scenes = payload.get('scenes', 7)
    if not isinstance(title, str) or not title.strip() or len(title) > 150:
        raise ValueError('Title must be 1–150 characters')
    if not isinstance(story, str) or not story.strip() or len(story) > 30000:
        raise ValueError('Story must be 1–30000 characters')
    if isinstance(scenes, bool) or not isinstance(scenes, int):
        raise ValueError('Scene count must be an integer')
    plan_story(story, total_duration=duration, scene_count=scenes)
    pid = pid or uuid.uuid4().hex
    with _database(path) as db:
        if get_project(path, pid):
            db.execute('UPDATE projects SET title=?,story=?,duration=?,scenes=?,updated=CURRENT_TIMESTAMP WHERE id=?', (title.strip(), story.strip(), float(duration), scenes, pid))
        else:
            db.execute('INSERT INTO projects(id,title,story,duration,scenes) VALUES (?,?,?,?,?)', (pid,title.strip(),story.strip(),float(duration),scenes))
    return get_project(path, pid)

def project_plan(project):
    plan = plan_story(project['story'], total_duration=project['duration'], scene_count=project['scenes'])
    plan['title'] = project['title']
    return plan

def create_handler(db_path, data_dir, token=None, allowed_origin=None):
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
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def _send(self, status, body, mime='application/json; charset=utf-8'):
            content = json.dumps(body, allow_nan=False).encode() if mime.startswith('application/json') else body
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            if allowed_origin and self.headers.get('Origin') == allowed_origin:
                self.send_header('Access-Control-Allow-Origin', allowed_origin)
                self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-WEC-Token')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Vary', 'Origin')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(content)
        def _authorized(self):
            if token and not hmac.compare_digest(self.headers.get('X-WEC-Token', ''), token):
                self._send(401, {'error':'Authentication required'})
                return False
            return True
        def _route(self):
            path = urlparse(self.path).path
            if self.command == 'GET' and path == '/':
                self._send(200, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8'); return
            if self.command == 'GET' and path in ('/app.js','/style.css','/config.js'):
                mime = 'application/javascript; charset=utf-8' if path.endswith('.js') else 'text/css; charset=utf-8'
                self._send(200, (ROOT / path.lstrip('/')).read_bytes(), mime); return
            if path == '/api/health' and self.command == 'GET':
                self._send(200, {'ok':True}); return
            if not self._authorized(): return
            if path == '/api/backup' and self.command == 'GET':
                self._send(200, {'schema_version':1, 'projects':[get_project(db_path, x['id']) for x in list_projects(db_path)]}); return
            if path == '/api/projects' and self.command == 'GET':
                self._send(200, {'projects':list_projects(db_path)}); return
            m = re.fullmatch(r'/api/projects/([a-f0-9]{32})(/plan|/dry-run)?', path)
            if m and self.command == 'GET' and m.group(2) != '/dry-run':
                p = get_project(db_path, m.group(1))
                if not p: self._send(404, {'error':'Project not found'}); return
                self._send(200, project_plan(p) if m.group(2) else p); return
            if self.command == 'POST' and (path == '/api/projects' or (m and not m.group(2))):
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= MAX_BODY: raise ValueError('Invalid request size')
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body, dict): raise ValueError('Expected a JSON object')
                    if m and not get_project(db_path, m.group(1)):
                        self._send(404, {'error':'Project not found'}); return
                    p = save_project(db_path, body, m.group(1) if m else None)
                    self._send(200, p)
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
    print(f'WEC Studio at http://{args.host}:{args.port} (Ctrl+C to stop)', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__': main()
