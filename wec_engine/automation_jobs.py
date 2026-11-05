"""Persistent owner-only automation job plans; no background executor.

This phase records intent, idempotent creation and cancellation. It deliberately
does NOT run AI, download files, render media or publish on any request.
"""
import re
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path

MAX_JOBS = 50
KINDS = {"art", "coloring", "storybook", "video"}
RECIPES = {"plan", "artwork", "book", "video"}
FORMATS = {
    "plan": KINDS, "artwork": {"art"},
    "book": {"coloring", "storybook"}, "video": {"video"},
}
UUID_PATTERN = re.compile(r"[0-9a-f-]{20,80}", re.I)
IDEMPOTENCY = re.compile(r"[a-zA-Z0-9_-]{12,100}")


class AutomationJobError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class AutomationJobs:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                key TEXT NOT NULL UNIQUE,
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                recipe TEXT NOT NULL,
                status TEXT NOT NULL,
                created INTEGER NOT NULL,
                updated INTEGER NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS jobs_recent ON jobs(updated DESC)")
            # Defensive recovery for any jobs that a later executor may leave
            # in the running state; never claim that missing work succeeded.
            db.execute("UPDATE jobs SET status='interrupted', updated=? WHERE status='running'",
                       (int(time.time()),))

    def _db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return closing_transaction(db)

    @staticmethod
    def _present(row):
        return {field: row[field] for field in
                ("id", "project_id", "kind", "recipe", "status", "created", "updated")}

    def create(self, value):
        if not isinstance(value, dict) or set(value) != {"project_id", "kind", "recipe", "idempotency_key"}:
            raise AutomationJobError("Only project_id, kind, recipe and idempotency_key are accepted.")
        project_id, kind, recipe, key = (value[field] for field in
                                        ("project_id", "kind", "recipe", "idempotency_key"))
        if (not isinstance(project_id, str) or not UUID_PATTERN.fullmatch(project_id)
                or kind not in KINDS or recipe not in RECIPES
                or kind not in FORMATS[recipe]
                or not isinstance(key, str) or not IDEMPOTENCY.fullmatch(key)):
            raise AutomationJobError("Invalid project, recipe, format or idempotency key.")
        with self.lock, self._db() as db:
            existing = db.execute("SELECT * FROM jobs WHERE key=?", (key,)).fetchone()
            if existing:
                if (existing["project_id"], existing["kind"], existing["recipe"]) != (project_id, kind, recipe):
                    raise AutomationJobError("Idempotency key already belongs to another plan.", 409)
                return self._present(existing), False
            count = db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
            if count >= MAX_JOBS:
                raise AutomationJobError("Automation plan limit reached. Existing plans were kept.", 409)
            now = int(time.time())
            jid = uuid.uuid4().hex
            db.execute("""INSERT INTO jobs (id,key,project_id,kind,recipe,status,created,updated)
                          VALUES (?,?,?,?,?,'awaiting_approval',?,?)""",
                       (jid, key, project_id, kind, recipe, now, now))
            return self._present(db.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()), True

    def list(self):
        with self.lock, self._db() as db:
            return [self._present(row) for row in db.execute(
                "SELECT * FROM jobs ORDER BY created DESC,id DESC LIMIT ?", (MAX_JOBS,))]

    def get(self, job_id):
        if not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise AutomationJobError("Automation plan not found.", 404)
        with self.lock, self._db() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise AutomationJobError("Automation plan not found.", 404)
            return self._present(row)

    def cancel(self, job_id, confirmation):
        if not isinstance(confirmation, dict) or confirmation != {"confirm": job_id}:
            raise AutomationJobError("Confirm the exact automation plan ID.")
        with self.lock, self._db() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise AutomationJobError("Automation plan not found.", 404)
            if row["status"] not in ("cancelled", "awaiting_approval", "interrupted"):
                raise AutomationJobError("This plan cannot be cancelled in its current state.", 409)
            if row["status"] != "cancelled":
                db.execute("UPDATE jobs SET status='cancelled',updated=? WHERE id=?",
                           (int(time.time()), job_id))
            return self._present(db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())


class closing_transaction:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self.db

    def __exit__(self, kind, error, tb):
        try:
            if kind is None:
                self.db.commit()
            else:
                self.db.rollback()
        finally:
            self.db.close()
