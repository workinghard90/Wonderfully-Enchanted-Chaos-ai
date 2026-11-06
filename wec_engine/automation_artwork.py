"""Approval-gated, deterministic ZIP of already-approved original artwork.

No generation, PDF creation, third-party publishing, external calls or
background processing. Never modify or delete the source recovery snapshot.
"""
import base64
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import zipfile
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from .automation_jobs import AutomationJobError, closing_transaction
from .online_store import MAX_PACKAGE, SnapshotError, sync_directory, validate_package

MAX_ARCHIVE = 36 * 1024 * 1024
HEADROOM = 64 * 1024 * 1024


class ArtworkArchives:
    def __init__(self, jobs, approvals, online, data_dir):
        self.jobs, self.approvals, self.online = jobs, approvals, online
        self.root = Path(data_dir).resolve() / "automation-exports"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db_path = jobs.path
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS artwork_archives (
                job_id TEXT PRIMARY KEY, state TEXT NOT NULL,
                attempts INTEGER NOT NULL, snapshot_id TEXT NOT NULL,
                source_sha256 TEXT NOT NULL, archive_sha256 TEXT,
                archive_bytes INTEGER, image_count INTEGER,
                updated INTEGER NOT NULL
            )""")
            db.execute("""UPDATE artwork_archives SET state='interrupted',updated=?
                          WHERE state='running'""", (int(time.time()),))

    def _db(self):
        return closing_transaction(sqlite3.connect(self.db_path, timeout=10))

    @staticmethod
    def _present(row):
        if row is None:
            return None
        return dict(zip(("job_id", "state", "attempts", "snapshot_id",
                         "source_sha256", "archive_sha256", "archive_bytes",
                         "image_count", "updated"), row))

    def _receipt(self, db, job_id):
        return self._present(db.execute("""SELECT job_id,state,attempts,snapshot_id,
            source_sha256,archive_sha256,archive_bytes,image_count,updated
            FROM artwork_archives WHERE job_id=?""", (job_id,)).fetchone())

    def status(self, job_id):
        self.jobs.get(job_id)
        with self.lock, self._db() as db:
            return self._receipt(db, job_id)

    def _authorized(self, job_id):
        job = self.jobs.get(job_id)
        if (job["status"] != "awaiting_approval"
                or job["kind"] != "art" or job["recipe"] != "artwork"
                or job["source_format"] != "recovery_payload_v1"
                or not job["snapshot_id"] or not job["source_revision"]
                or not job["source_sha256"]):
            raise AutomationJobError("Only verified artwork plans can export approved originals.", 409)
        self.approvals.require(job, "artwork_export")
        if self.online is None:
            raise AutomationJobError("Online snapshot storage is unavailable.", 503)
        return job

    def _source(self, job):
        try:
            with self.online.open(job["snapshot_id"]) as source:
                raw = source.read(MAX_PACKAGE + 1)
            meta = validate_package(raw)
        except SnapshotError as exc:
            raise AutomationJobError(str(exc), exc.status) from None
        except OSError:
            raise AutomationJobError("Source storage is unavailable.", 503) from None
        if (meta["project_id"] != job["project_id"]
                or meta["kind"] != job["kind"]
                or meta.get("source_revision") != job["source_revision"]
                or meta.get("payload_sha256") != job["source_sha256"]):
            raise AutomationJobError("Archived source no longer matches its locked revision and digest.", 409)
        payload = json.loads(json.loads(raw)["payload"])
        return payload["project"]

    def _bytes(self, job, project):
        pages = project["pages"]
        if not 1 <= len(pages) <= 80:
            raise AutomationJobError("Artwork export requires 1–80 approved pages.", 409)
        images, manifest = [], []
        for index, page in enumerate(pages, 1):
            if not isinstance(page, dict) or page.get("review") != "approved":
                raise AutomationJobError("Every artwork page must be explicitly approved.", 409)
            asset = page.get("asset")
            if not isinstance(asset, dict) or not isinstance(asset.get("image_base64"), str):
                raise AutomationJobError("Every approved page needs its original image.", 409)
            raw = base64.b64decode(asset["image_base64"], validate=True)
            digest = hashlib.sha256(raw).hexdigest()
            if not raw or digest != asset.get("sha256") or len(raw) > 10 * 1024 * 1024:
                raise AutomationJobError("Original artwork checksum failed.", 409)
            try:
                with Image.open(io.BytesIO(raw)) as image:
                    fmt = image.format
                    image.verify()
            except (UnidentifiedImageError, OSError, ValueError):
                raise AutomationJobError("Original artwork must be a valid PNG or JPEG.", 409) from None
            if fmt not in ("PNG", "JPEG"):
                raise AutomationJobError("Only PNG/JPEG original artwork can be exported.", 409)
            name = f"artwork/page-{index:03d}.{'png' if fmt == 'PNG' else 'jpg'}"
            images.append((name, raw))
            manifest.append({"file": name, "sha256": digest, "bytes": len(raw)})
        record = {"format": "wec-approved-artwork-v1",
                  "project_id": job["project_id"],
                  "source_revision": job["source_revision"],
                  "source_sha256": job["source_sha256"],
                  "snapshot_id": job["snapshot_id"],
                  "image_count": len(images), "files": manifest,
                  "note": "Original artwork ZIP, not a print-ready PDF or publishing approval."}
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED,
                             allowZip64=False) as archive:
            for name, raw in images + [("manifest.json", (json.dumps(record, sort_keys=True,
                                                        separators=(",", ":")) + "\n").encode())]:
                info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED
                info.external_attr = 0o600 << 16
                archive.writestr(info, raw)
        contents = output.getvalue()
        if len(contents) > MAX_ARCHIVE:
            raise AutomationJobError("Artwork archive exceeds the 36 MiB limit.", 413)
        return contents, len(images)

    def _path(self, job_id):
        if not re.fullmatch("[a-f0-9]{32}", job_id):
            raise AutomationJobError("Automation plan not found.", 404)
        return self.root / (job_id + ".zip")

    @staticmethod
    def _hash(path):
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for part in iter(lambda: source.read(65536), b""):
                digest.update(part)
        return digest.hexdigest()

    def prepare(self, job_id, request):
        if (not isinstance(request, dict)
                or set(request) not in ({"confirm"}, {"confirm", "retry"})
                or request.get("confirm") != job_id
                or type(request.get("retry", False)) is not bool):
            raise AutomationJobError("Confirm the exact plan for the approved artwork export.")
        retry = request.get("retry", False)
        # Revoke cannot race with export verification or receipt persistence.
        with self.approvals.lock, self.jobs.lock, self.lock:
            job = self._authorized(job_id)
            project = self._source(job)
            with self._db() as db:
                row = self._receipt(db, job_id)
                if row and (row["snapshot_id"],row["source_sha256"]) != (
                        job["snapshot_id"], job["source_sha256"]):
                    raise AutomationJobError("Existing export belongs to a different source.",409)
                if row and row["state"] == "succeeded":
                    path=self._path(job_id)
                    if (not path.is_file() or path.stat().st_size != row["archive_bytes"]
                            or self._hash(path) != row["archive_sha256"]):
                        raise AutomationJobError("Export receipt exists but file is missing or corrupt.", 503)
                    return row, False
                if row and row["state"] in ("interrupted","failed") and not retry:
                    raise AutomationJobError("Explicit retry required after export interruption.",409)
                if row and row["state"] == "running":
                    raise AutomationJobError("Export already in progress.",409)
                attempt = (row["attempts"] if row else 0) + 1
                if attempt > 3:
                    raise AutomationJobError("Export retry limit reached.",409)
                now=int(time.time())
                db.execute("""INSERT INTO artwork_archives
                    (job_id,state,attempts,snapshot_id,source_sha256,updated)
                    VALUES (?,'running',?,?,?,?)
                    ON CONFLICT(job_id) DO UPDATE SET state='running',
                    attempts=excluded.attempts,updated=excluded.updated""",
                    (job_id,attempt,job["snapshot_id"],job["source_sha256"],now))
            try:
                raw, count = self._bytes(job, project)
                if shutil.disk_usage(self.root).free < len(raw) + HEADROOM:
                    raise AutomationJobError("Insufficient disk headroom for artwork ZIP.",507)
                target = self._path(job_id)
                digest = hashlib.sha256(raw).hexdigest()
                if target.exists():
                    if target.stat().st_size != len(raw) or self._hash(target) != digest:
                        raise AutomationJobError("Existing output differs; preserved for recovery.",409)
                else:
                    fd, tmp = tempfile.mkstemp(prefix=".artwork-", dir=self.root)
                    try:
                        with os.fdopen(fd, "wb") as output:
                            output.write(raw)
                            output.flush()
                            os.fsync(output.fileno())
                        os.replace(tmp, target)
                        sync_directory(self.root)
                    finally:
                        if os.path.exists(tmp):
                            os.unlink(tmp)
                # No paid or remote action, but consent and cancellation still
                # need to hold at completion.
                self._authorized(job_id)
                self._source(job)
                with self._db() as db:
                    db.execute("""UPDATE artwork_archives SET state='succeeded',
                        archive_sha256=?,archive_bytes=?,image_count=?,updated=?
                        WHERE job_id=? AND state='running'""",
                        (digest,len(raw),count,int(time.time()),job_id))
                    return self._receipt(db,job_id), True
            except Exception:
                with self._db() as db:
                    db.execute("""UPDATE artwork_archives SET state='failed',updated=?
                        WHERE job_id=? AND state='running'""",
                        (int(time.time()),job_id))
                raise

    def open_download(self, job_id):
        with self.approvals.lock, self.jobs.lock, self.lock:
            job=self._authorized(job_id)
            self._source(job)
            with self._db() as db:
                receipt=self._receipt(db,job_id)
            if not receipt or receipt["state"] != "succeeded":
                raise AutomationJobError("No completed artwork ZIP exists.",404)
            if (receipt["snapshot_id"],receipt["source_sha256"]) != (
                    job["snapshot_id"],job["source_sha256"]):
                raise AutomationJobError("Artifact source mismatch.",409)
            path=self._path(job_id)
            if not path.is_file() or path.stat().st_size != receipt["archive_bytes"]:
                raise AutomationJobError("Artwork ZIP is missing; output receipt preserved.",503)
            if self._hash(path) != receipt["archive_sha256"]:
                raise AutomationJobError("Artwork ZIP checksum failed; output preserved.",503)
            return path.open("rb"), receipt
