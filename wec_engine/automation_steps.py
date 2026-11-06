"""Durable, explicitly triggered read-only automation steps.

Only two source-inspection operations exist. No worker, provider, render,
publishing, file creation or background retries are reachable through here.
"""
import json
import re
import sqlite3
import threading
import time
from pathlib import Path

from .automation_jobs import AutomationJobError, closing_transaction

STEPS = ("verify_source", "inspect_inventory", "inventory_report")


class AutomationSteps:
    def __init__(self, jobs):
        self.jobs = jobs
        self.lock = threading.RLock()
        self.path = Path(jobs.path)
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS automation_steps (
                job_id TEXT NOT NULL,
                step TEXT NOT NULL,
                state TEXT NOT NULL,
                attempts INTEGER NOT NULL,
                snapshot_id TEXT NOT NULL,
                source_sha256 TEXT NOT NULL,
                result_json TEXT,
                updated INTEGER NOT NULL,
                PRIMARY KEY(job_id,step)
            )""")
            db.execute("""UPDATE automation_steps SET state='interrupted',updated=?
                          WHERE state='running'""", (int(time.time()),))

    def _db(self):
        return closing_transaction(sqlite3.connect(self.path, timeout=10))

    @staticmethod
    def _row(row):
        return {"job_id": row[0], "step": row[1], "state": row[2],
                "attempts": row[3], "snapshot_id": row[4],
                "source_sha256": row[5],
                "result": json.loads(row[6]) if row[6] is not None else None,
                "updated": row[7]}

    def list(self, job_id):
        self.jobs.get(job_id)  # Unknown identifiers never expose step data.
        with self.lock, self._db() as db:
            return [self._row(row) for row in db.execute(
                """SELECT job_id,step,state,attempts,snapshot_id,source_sha256,
                   result_json,updated FROM automation_steps WHERE job_id=?
                   ORDER BY step""", (job_id,))]

    def execute(self, job_id, command, verify, approvals=None):
        if (not isinstance(command, dict)
                or set(command) not in ({"confirm", "step"}, {"confirm", "step", "retry"})
                or command.get("confirm") != job_id
                or command.get("step") not in STEPS
                or command.get("retry", False) not in (False, True)
                or type(command.get("retry", False)) is not bool):
            raise AutomationJobError("Confirm the exact plan ID and an allowed read-only step.")
        step = command["step"]
        retry = command.get("retry", False)
        with self.lock:
            job = self.jobs.get(job_id)
            if job["status"] != "awaiting_approval":
                raise AutomationJobError("This plan is not eligible for source inspection.", 409)
            if (job["source_format"] != "recovery_payload_v1" or not job["snapshot_id"]
                    or not job["source_sha256"] or not job["source_revision"]):
                raise AutomationJobError("A verified recovery source is required.", 409)
            if step == "inventory_report":
                if approvals is None:
                    raise AutomationJobError("Approval controller is unavailable.", 503)
                approvals.require(job)
            with self._db() as db:
                row = db.execute("""SELECT job_id,step,state,attempts,snapshot_id,
                                    source_sha256,result_json,updated FROM automation_steps
                                    WHERE job_id=? AND step=?""", (job_id, step)).fetchone()
                if row and (row[4],row[5]) != (job["snapshot_id"],job["source_sha256"]):
                    raise AutomationJobError("Saved step is tied to another source.", 409)
                if row and row[2] == "running":
                    raise AutomationJobError("The step is already running.", 409)
                if row and row[2] in ("interrupted", "failed") and not retry:
                    raise AutomationJobError("Explicit retry is required after interruption or failure.", 409)
                if row and row[2] == "succeeded":
                    # A prior receipt is not proof that a deleted/corrupt
                    # source still exists. Verify again, without re-running.
                    metadata = verify(job["snapshot_id"])
                    self._match(job, metadata)
                    return self._row(row), False
                attempts = (row[3] if row else 0) + 1
                if attempts > 3:
                    raise AutomationJobError("Step retry limit reached. Existing receipts were kept.", 409)
                db.execute("""INSERT INTO automation_steps
                            (job_id,step,state,attempts,snapshot_id,source_sha256,
                            result_json,updated) VALUES (?,?,?,?,?,?,NULL,?)
                            ON CONFLICT(job_id,step) DO UPDATE SET state='running',
                            attempts=excluded.attempts,result_json=NULL,updated=excluded.updated""",
                           (job_id,step,"running",attempts,job["snapshot_id"],
                            job["source_sha256"],int(time.time())))
                db.commit()
            # Intentionally outside the transaction: a process crash leaves
            # 'running' on disk, which startup demotes to 'interrupted'.
            try:
                metadata = verify(job["snapshot_id"])
                self._match(job, metadata)
                result = {"snapshot_id": job["snapshot_id"],
                          "source_revision": job["source_revision"],
                          "source_sha256": job["source_sha256"]}
                if step in ("inspect_inventory", "inventory_report"):
                    result.update(page_count=metadata["page_count"],
                                  approved_pages=metadata["approved_pages"],
                                  kind=job["kind"])
                if step == "inventory_report":
                    approvals.require(self.jobs.get(job_id))
                if self.jobs.get(job_id)["status"] != "awaiting_approval":
                    raise AutomationJobError("Plan changed or was cancelled during verification.", 409)
            except Exception:
                with self._db() as db:
                    db.execute("""UPDATE automation_steps SET state='failed',updated=?
                                  WHERE job_id=? AND step=? AND state='running'""",
                               (int(time.time()), job_id,step))
                    db.commit()
                raise
            with self._db() as db:
                db.execute("""UPDATE automation_steps SET state='succeeded',
                              result_json=?,updated=? WHERE job_id=? AND step=?
                              AND state='running'""",
                           (json.dumps(result,sort_keys=True),int(time.time()),job_id,step))
                db.commit()
                row=db.execute("""SELECT job_id,step,state,attempts,snapshot_id,
                                  source_sha256,result_json,updated FROM automation_steps
                                  WHERE job_id=? AND step=?""",(job_id,step)).fetchone()
                return self._row(row), True

    @staticmethod
    def _match(job, metadata):
        if (metadata["project_id"] != job["project_id"]
                or metadata["kind"] != job["kind"]
                or metadata.get("source_revision") != job["source_revision"]
                or metadata.get("payload_sha256") != job["source_sha256"]):
            raise AutomationJobError("Archived source revision or checksum no longer matches.",409)
