"""Owner-scoped, immutable consent for bounded zero-cost automation only.

No approval in this module authorizes AI, video rendering, publishing,
network handoff, purchases or any other resource-consuming operation.
"""
import re
import sqlite3
import threading
import time

from .automation_jobs import AutomationJobError, closing_transaction

SAFE_OPERATIONS = ("inventory_report", "artwork_export")


class AutomationApprovals:
    def __init__(self, jobs):
        self.jobs = jobs
        self.path = jobs.path
        self.lock = threading.RLock()
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS automation_approvals (
                job_id TEXT NOT NULL, operation TEXT NOT NULL,
                snapshot_id TEXT NOT NULL, source_sha256 TEXT NOT NULL,
                state TEXT NOT NULL, granted INTEGER NOT NULL,
                updated INTEGER NOT NULL,
                PRIMARY KEY (job_id, operation)
            )""")

    def _db(self):
        return closing_transaction(sqlite3.connect(self.path, timeout=10))

    @staticmethod
    def _present(row):
        return dict(zip(("job_id","operation","snapshot_id","source_sha256",
                         "state","granted","updated"), row))

    def list(self, job_id):
        self.jobs.get(job_id)
        with self.lock, self._db() as db:
            return [self._present(r) for r in db.execute(
                """SELECT job_id,operation,snapshot_id,source_sha256,state,
                   granted,updated FROM automation_approvals WHERE job_id=?
                   ORDER BY operation""", (job_id,))]

    def approve(self, job_id, request, verify):
        if (not isinstance(request, dict)
                or set(request) != {"confirm","operation","source_sha256"}
                or request.get("confirm") != job_id
                or request.get("operation") not in SAFE_OPERATIONS
                or not isinstance(request.get("source_sha256"), str)
                or not re.fullmatch("[a-f0-9]{64}", request["source_sha256"])):
            raise AutomationJobError("Confirm the exact plan, safe operation and source digest.")
        with self.lock:
            job = self.jobs.get(job_id)
            if (job["status"] != "awaiting_approval"
                    or job["source_format"] != "recovery_payload_v1"
                    or not job["snapshot_id"] or not job["source_revision"]
                    or job["source_sha256"] != request["source_sha256"]):
                raise AutomationJobError("Plan is not eligible for this source-bound approval.", 409)
            # A source verification is required for every approval, including
            # repeated requests, even when an approval row already exists.
            meta = verify(job["snapshot_id"])
            if (meta["project_id"] != job["project_id"]
                    or meta["kind"] != job["kind"]
                    or meta.get("source_revision") != job["source_revision"]
                    or meta.get("payload_sha256") != job["source_sha256"]):
                raise AutomationJobError("Verified source no longer matches the plan.", 409)
            with self._db() as db:
                row = db.execute("""SELECT job_id,operation,snapshot_id,source_sha256,
                        state,granted,updated FROM automation_approvals
                        WHERE job_id=? AND operation=?""",
                        (job_id,request["operation"])).fetchone()
                if row:
                    if (row[2],row[3]) != (job["snapshot_id"],job["source_sha256"]):
                        raise AutomationJobError("Approval refers to a different source.", 409)
                    if row[4] == "revoked":
                        raise AutomationJobError("Approval was revoked. Create a new plan to grant again.", 409)
                    return self._present(row), False
                now=int(time.time())
                db.execute("""INSERT INTO automation_approvals
                    (job_id,operation,snapshot_id,source_sha256,state,granted,updated)
                    VALUES (?,?,?,?,'approved',?,?)""",
                    (job_id,request["operation"],job["snapshot_id"],job["source_sha256"],now,now))
                row=db.execute("""SELECT job_id,operation,snapshot_id,source_sha256,
                    state,granted,updated FROM automation_approvals WHERE job_id=?
                    AND operation=?""",(job_id,request["operation"])).fetchone()
                return self._present(row), True

    def revoke(self, job_id, request):
        if (not isinstance(request,dict)
                or set(request) != {"confirm","operation"}
                or request.get("confirm") != job_id
                or request.get("operation") not in SAFE_OPERATIONS):
            raise AutomationJobError("Confirm the exact plan and approval to revoke.")
        with self.lock, self._db() as db:
            self.jobs.get(job_id)
            row=db.execute("""SELECT job_id,operation,snapshot_id,source_sha256,
                    state,granted,updated FROM automation_approvals
                    WHERE job_id=? AND operation=?""",
                    (job_id,request["operation"])).fetchone()
            if not row:
                raise AutomationJobError("No approval exists for this operation.",404)
            if row[4] != "revoked":
                db.execute("""UPDATE automation_approvals SET state='revoked',
                    updated=? WHERE job_id=? AND operation=?""",
                    (int(time.time()),job_id,request["operation"]))
                row=db.execute("""SELECT job_id,operation,snapshot_id,source_sha256,
                    state,granted,updated FROM automation_approvals
                    WHERE job_id=? AND operation=?""",
                    (job_id,request["operation"])).fetchone()
            return self._present(row)

    def require(self, job, operation="inventory_report"):
        if operation not in SAFE_OPERATIONS:
            raise AutomationJobError("Unknown or disabled operation.", 400)
        with self.lock, self._db() as db:
            row=db.execute("""SELECT state,snapshot_id,source_sha256
                FROM automation_approvals WHERE job_id=? AND operation=?""",
                (job["id"],operation)).fetchone()
        if (job["status"]!="awaiting_approval" or not row or row[0]!="approved"
                or (row[1],row[2])!=(job["snapshot_id"],job["source_sha256"])):
            raise AutomationJobError("An active approval for this exact source is required.",409)
