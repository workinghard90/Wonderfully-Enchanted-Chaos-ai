"""Bounded image receipts for one studio process; never resubmit a provider call.

The existing synchronous worker may finish after its HTTP client disconnects.
Keep its result before writing the response. Receipts require persistent storage
for recovery across server replacements; they are not an external job queue.
"""
import hashlib
import json
import re
import time

from .studio_store import _database

RESULT_TTL = 24 * 60 * 60
RECEIPT_TTL = 30 * RESULT_TTL
MAX_RESULTS = 5
MAX_RECEIPTS = 1000
MAX_RESULT_BYTES = 8 * 1024 * 1024


class ReceiptError(ValueError):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


class ImageRequests:
    def __init__(self, path):
        self.path = path
        with _database(path) as db:
            db.execute('''CREATE TABLE IF NOT EXISTS creative_image_requests (
                id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
                created REAL NOT NULL, updated REAL NOT NULL, status INTEGER NOT NULL,
                message TEXT NOT NULL, mime TEXT, image BLOB)''')
            db.execute("UPDATE creative_image_requests SET state='interrupted', status=409, "
                       "message='The server restarted before this picture was saved. No automatic retry was made.', "
                       "updated=? WHERE state='running'", (time.time(),))
            self._prune(db)

    @staticmethod
    def identity(body):
        request_id = body.get('request_id')
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-f0-9]{32}', request_id):
            raise ValueError('Invalid image request ID')
        inputs = {key: value for key, value in body.items() if key != 'request_id'}
        fingerprint = hashlib.sha256(json.dumps(inputs, sort_keys=True, ensure_ascii=True,
                                                separators=(',', ':'), allow_nan=False).encode()).hexdigest()
        return request_id, fingerprint

    def _prune(self, db):
        now = time.time()
        db.execute("UPDATE creative_image_requests SET image=NULL, mime=NULL, state='expired', status=410, "
                   "message='This saved picture has expired. Check your device project and backups.' "
                   "WHERE state='ready' AND updated < ?", (now - RESULT_TTL,))
        db.execute("DELETE FROM creative_image_requests WHERE state != 'running' AND created < ?",
                   (now - RECEIPT_TTL,))

    def get(self, request_id, fingerprint=None):
        with _database(self.path) as db:
            self._prune(db)
            row = db.execute('SELECT fingerprint,state,status,message,mime,image FROM creative_image_requests WHERE id=?',
                             (request_id,)).fetchone()
        if row is None:
            return None
        if fingerprint is not None and row[0] != fingerprint:
            raise ReceiptError('This request ID belongs to different generation inputs. No new attempt was made.')
        return dict(id=request_id, state=row[1], status=row[2], message=row[3], mime=row[4], image=row[5])

    def start(self, request_id, fingerprint):
        with _database(self.path) as db:
            db.execute('BEGIN IMMEDIATE')
            self._prune(db)
            if db.execute('SELECT 1 FROM creative_image_requests WHERE id=?', (request_id,)).fetchone():
                raise ReceiptError('This generation request already exists. Check its saved result.')
            if db.execute('SELECT COUNT(*) FROM creative_image_requests').fetchone()[0] >= MAX_RECEIPTS:
                raise ReceiptError('Generation receipt storage is full. No new attempt was made.', 429)
            now = time.time()
            db.execute('INSERT INTO creative_image_requests VALUES (?,?,?,?,?,?,?,?,?)',
                       (request_id, fingerprint, 'running', now, now, 202,
                        'This picture is still generating. Check again shortly; no new attempt is needed.', None, None))

    def complete(self, request_id, raw, mime):
        if len(raw) > MAX_RESULT_BYTES:
            raise ValueError('Generated picture exceeds the recovery storage limit')
        with _database(self.path) as db:
            db.execute('BEGIN IMMEDIATE')
            self._prune(db)
            row = db.execute('SELECT state FROM creative_image_requests WHERE id=?', (request_id,)).fetchone()
            if not row or row[0] != 'running':
                raise ReceiptError('This generation request is no longer active. Check its saved status.')
            # Evict bytes, retaining receipts so repeated POSTs cannot spend again.
            rows = db.execute("SELECT id FROM creative_image_requests WHERE state='ready' ORDER BY updated DESC,id DESC").fetchall()
            for (old_id,) in rows[MAX_RESULTS - 1:]:
                db.execute("UPDATE creative_image_requests SET state='expired', status=410, image=NULL, mime=NULL, "
                           "message='This saved picture was replaced in temporary recovery storage. Check your device project and backups.' WHERE id=?", (old_id,))
            db.execute("UPDATE creative_image_requests SET state='ready', status=200, message='Picture ready to recover.', "
                       "mime=?, image=?, updated=? WHERE id=? AND state='running'", (mime, raw, time.time(), request_id))

    def fail(self, request_id, message, status):
        with _database(self.path) as db:
            db.execute("UPDATE creative_image_requests SET state='failed', message=?, status=?, updated=? "
                       "WHERE id=? AND state='running'", (message, status, time.time(), request_id))
