import json
import hashlib
import os
from unittest.mock import patch
from contextlib import closing
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from wec_engine.automation_jobs import AutomationJobs, AutomationJobError, MAX_JOBS
from wec_engine.automation_steps import AutomationSteps
from wec_engine.online_store import OnlineStore
from wec_engine.studio import create_handler


PROJECT = "b9f83452-ec2a-4818-82a7-e5231b344143"
TOKEN = "test-only-automation-token-32-characters"


def payload(key="automation-key-1234567"):
    return {"project_id": PROJECT, "kind": "art", "recipe": "artwork",
            "idempotency_key": key}


class AutomationJobsTests(unittest.TestCase):
    def test_persistent_idempotency_and_cancellation(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "jobs.sqlite3"
            jobs = AutomationJobs(db)
            record, created = jobs.create(payload())
            self.assertTrue(created)
            self.assertEqual(record["status"], "awaiting_approval")
            same, again = jobs.create(payload())
            self.assertFalse(again)
            self.assertEqual(same["id"], record["id"])
            with self.assertRaises(AutomationJobError) as err:
                jobs.create({**payload(), "project_id": "a" * 32})
            self.assertEqual(err.exception.status, 409)
            reopened = AutomationJobs(db)
            self.assertEqual(reopened.get(record["id"])["status"], "awaiting_approval")
            with self.assertRaises(AutomationJobError):
                reopened.cancel(record["id"], {"confirm": "wrong"})
            cancelled = reopened.cancel(record["id"], {"confirm": record["id"]})
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertEqual(reopened.cancel(record["id"], {"confirm": record["id"]}), cancelled)
            self.assertEqual(reopened.list()[0]["status"], "cancelled")

    def test_source_revision_lock_migration_and_replay(self):
        sha = "a" * 64
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "jobs.sqlite3"
            jobs = AutomationJobs(db)
            record, _ = jobs.create(payload())
            self.assertIsNone(record["source_revision"])
            source = {"source_revision": 7, "source_sha256": sha}
            bound = jobs.bind_source(record["id"], source)
            self.assertEqual(bound["source_revision"], 7)
            self.assertEqual(bound["source_sha256"], sha)
            self.assertEqual(jobs.bind_source(record["id"], source), bound)
            with self.assertRaises(AutomationJobError) as err:
                jobs.bind_source(record["id"], {**source, "source_revision": 8})
            self.assertEqual(err.exception.status, 409)
            for invalid in (
                {"source_revision": True, "source_sha256": sha},
                {"source_revision": 0, "source_sha256": sha},
                {"source_revision": 7, "source_sha256": "A" * 64},
                {**source, "token": "private"},
            ):
                with self.subTest(invalid=invalid), self.assertRaises(AutomationJobError):
                    jobs.bind_source(record["id"], invalid)
            restarted = AutomationJobs(db)
            self.assertEqual(restarted.get(record["id"])["source_sha256"], sha)
            new_record, _ = restarted.create(payload("different-key-123456"))
            restarted.cancel(new_record["id"], {"confirm": new_record["id"]})
            with self.assertRaises(AutomationJobError) as err:
                restarted.bind_source(new_record["id"], source)
            self.assertEqual(err.exception.status, 409)

    def test_verified_snapshot_binding_is_immutable_and_restart_safe(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "jobs.sqlite3"
            jobs = AutomationJobs(db)
            record, _ = jobs.create(payload())
            jobs.bind_source(record["id"], {"source_revision": 3, "source_sha256": "a" * 64})
            calls = []
            def verify(identifier):
                calls.append(identifier)
                return {"project_id": PROJECT, "kind": "art"}
            identifier = "b" * 64
            attached = jobs.bind_snapshot(record["id"], identifier, verify)
            self.assertEqual(attached["snapshot_id"], identifier)
            self.assertEqual(jobs.bind_snapshot(record["id"], identifier, verify), attached)
            self.assertEqual(calls, [identifier, identifier])
            with self.assertRaises(AutomationJobError) as err:
                jobs.bind_snapshot(record["id"], "c" * 64, verify)
            self.assertEqual(err.exception.status, 409)
            restarted = AutomationJobs(db)
            self.assertEqual(restarted.get(record["id"])["snapshot_id"], identifier)
            other, _ = restarted.create(payload("snapshot-mismatch-key-1"))
            restarted.bind_source(other["id"], {"source_revision": 2, "source_sha256": "d" * 64})
            for bad in ({"project_id": "f" * 32, "kind": "art"},
                        {"project_id": PROJECT, "kind": "video"}):
                with self.subTest(bad=bad), self.assertRaises(AutomationJobError) as err:
                    restarted.bind_snapshot(other["id"], "e" * 64, lambda _key: bad)
                self.assertEqual(err.exception.status, 409)
            self.assertIsNone(restarted.get(other["id"])["snapshot_id"])
            unbound, _ = restarted.create(payload("snapshot-unbound-key-1"))
            with self.assertRaises(AutomationJobError) as err:
                restarted.bind_snapshot(unbound["id"], identifier, verify)
            self.assertEqual(err.exception.status, 409)
            restarted.cancel(unbound["id"], {"confirm": unbound["id"]})
            with self.assertRaises(AutomationJobError):
                restarted.bind_snapshot(unbound["id"], identifier, verify)

    def test_verified_source_atomic_binding_and_legacy_rejection(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "jobs.sqlite3"
            jobs = AutomationJobs(db)
            plan, _ = jobs.create(payload("verified-source-key-123"))
            metadata = {"project_id": PROJECT, "kind": "art",
                        "source_revision": 9, "payload_sha256": "b" * 64}
            def verified(_key):
                return metadata
            locked = jobs.bind_verified_source(plan["id"], "a" * 64, verified)
            self.assertEqual(locked["source_revision"], 9)
            self.assertEqual(locked["source_sha256"], "b" * 64)
            self.assertEqual(locked["snapshot_id"], "a" * 64)
            self.assertEqual(locked["source_format"], "recovery_payload_v1")
            self.assertEqual(jobs.bind_verified_source(plan["id"], "a" * 64, verified), locked)
            with self.assertRaises(AutomationJobError) as err:
                jobs.bind_verified_source(plan["id"], "c" * 64, verified)
            self.assertEqual(err.exception.status, 409)
            self.assertEqual(AutomationJobs(db).get(plan["id"]), locked)
            legacy, _ = jobs.create(payload("legacy-source-key-1234"))
            jobs.bind_source(legacy["id"], {"source_revision": 1, "source_sha256": "c" * 64})
            with self.assertRaises(AutomationJobError) as err:
                jobs.bind_verified_source(legacy["id"], "a" * 64, verified)
            self.assertEqual(err.exception.status, 409)
            invalid, _ = jobs.create(payload("invalid-source-key-123"))
            for meta in ({"project_id": "f" * 32, "kind": "art",
                          "source_revision": 3, "payload_sha256": "a" * 64},
                         {"project_id": PROJECT, "kind": "art",
                          "source_revision": None, "payload_sha256": "a" * 64}):
                with self.assertRaises(AutomationJobError):
                    jobs.bind_verified_source(invalid["id"], "a" * 64, lambda _:meta)
            self.assertIsNone(jobs.get(invalid["id"])["snapshot_id"])
            jobs.cancel(invalid["id"], {"confirm": invalid["id"]})
            with self.assertRaises(AutomationJobError):
                jobs.bind_verified_source(invalid["id"], "a" * 64, verified)

    def test_readonly_steps_receipts_retry_restart_and_cancel(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = AutomationJobs(Path(td) / "jobs.sqlite3")
            steps = AutomationSteps(jobs)
            job, _ = jobs.create(payload("readonly-steps-123456"))
            source = {"project_id": PROJECT, "kind": "art", "source_revision": 3,
                      "payload_sha256": "b" * 64, "page_count": 4, "approved_pages": 2}
            jobs.bind_verified_source(job["id"], "a" * 64, lambda _: source)
            command = {"confirm":job["id"],"step":"inspect_inventory"}
            first, created = steps.execute(job["id"], command, lambda _:source)
            self.assertTrue(created)
            self.assertEqual(first["state"], "succeeded")
            self.assertEqual(first["result"]["page_count"], 4)
            self.assertEqual(first["result"]["approved_pages"], 2)
            self.assertEqual(first["attempts"],1)
            same, created = steps.execute(job["id"], command, lambda _:source)
            self.assertFalse(created)
            self.assertEqual(first,same)
            with self.assertRaises(AutomationJobError):
                steps.execute(job["id"], command, lambda _: (_ for _ in ()).throw(
                    AutomationJobError("Snapshot disappeared.", 404)))
            self.assertEqual(AutomationSteps(AutomationJobs(jobs.path)).list(job["id"])[0], first)
            verify_command = {"confirm":job["id"],"step":"verify_source"}
            with self.assertRaises(AutomationJobError):
                steps.execute(job["id"], verify_command, lambda _: (_ for _ in ()).throw(
                    AutomationJobError("Read failed.",503)))
            self.assertEqual(next(x for x in steps.list(job["id"]) if x["step"]=="verify_source")["state"],"failed")
            with self.assertRaises(AutomationJobError) as err:
                steps.execute(job["id"],verify_command,lambda _:source)
            self.assertEqual(err.exception.status,409)
            retry, created = steps.execute(job["id"],{**verify_command,"retry":True},lambda _:source)
            self.assertTrue(created)
            self.assertEqual(retry["attempts"],2)
            self.assertEqual(retry["state"],"succeeded")
            with closing(sqlite3.connect(jobs.path)) as db:
                db.execute("UPDATE automation_steps SET state='running' WHERE job_id=? AND step='verify_source'",
                           (job["id"],))
                db.commit()
            restarted = AutomationSteps(AutomationJobs(jobs.path))
            self.assertEqual(next(x for x in restarted.list(job["id"])
                                  if x["step"]=="verify_source")["state"], "interrupted")
            with self.assertRaises(AutomationJobError):
                restarted.execute(job["id"],verify_command,lambda _:source)
            completed, _ = restarted.execute(job["id"],{**verify_command,"retry":True},lambda _:source)
            self.assertEqual(completed["attempts"],3)
            jobs.cancel(job["id"],{"confirm":job["id"]})
            with self.assertRaises(AutomationJobError):
                restarted.execute(job["id"],verify_command,lambda _:source)
            with self.assertRaises(AutomationJobError):
                restarted.execute(job["id"],{"confirm":job["id"],"step":"render_video"},lambda _:source)
            with self.assertRaises(AutomationJobError):
                restarted.execute(job["id"],{"confirm":job["id"],"step":"verify_source","retry":1},lambda _:source)

    def test_unfinished_work_is_not_reported_success_on_restart(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "jobs.sqlite3"
            jobs = AutomationJobs(db)
            record, _ = jobs.create(payload())
            with closing(sqlite3.connect(db)) as conn:
                conn.execute("UPDATE jobs SET status='running' WHERE id=?", (record["id"],))
                conn.commit()
            restarted = AutomationJobs(db)
            self.assertEqual(restarted.get(record["id"])["status"], "interrupted")

    def test_invalid_payloads_do_not_change_store(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = AutomationJobs(Path(td) / "jobs.sqlite3")
            bad = [
                {"project_id": PROJECT, "kind": "video", "recipe": "book",
                 "idempotency_key": "valid-key-123456"},
                {**payload(), "prompt": "hidden input"},
                {**payload(), "idempotency_key": "short"},
                {**payload(), "project_id": "../wrong"},
                {**payload(), "recipe": "publish"},
            ]
            for value in bad:
                with self.subTest(value=value), self.assertRaises(AutomationJobError):
                    jobs.create(value)
            self.assertEqual(jobs.list(), [])

    def test_limit_never_deletes_user_records(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = AutomationJobs(Path(td) / "jobs.sqlite3")
            for i in range(MAX_JOBS):
                jobs.create(payload("automation-key-%04d" % i))
            with self.assertRaises(AutomationJobError) as err:
                jobs.create(payload("automation-key-extra"))
            self.assertEqual(err.exception.status, 409)
            self.assertEqual(len(jobs.list()), MAX_JOBS)


class AutomationJobsAPITests(unittest.TestCase):
    def test_authenticated_snapshot_attachment_verifies_real_stored_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with patch.dict(os.environ, {"WEC_ENABLE_ONLINE_STORAGE": "1", "RENDER": ""}):
                server = ThreadingHTTPServer(("127.0.0.1", 0),
                    create_handler(root / "studio.sqlite3", root, token=TOKEN))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = "http://127.0.0.1:%d" % server.server_port
            def request(route, data=None, auth=True):
                headers = {"Content-Type": "application/json"}
                if auth:
                    headers["X-WEC-Token"] = TOKEN
                value = json.dumps(data).encode() if data is not None else None
                with urlopen(Request(origin + route, headers=headers, data=value,
                                     method="POST" if data is not None else "GET"), timeout=10) as response:
                    return response.status, json.load(response)
            try:
                _, plan = request("/api/automation/jobs", payload("snapshot-api-key-1234"))
                jid = plan["id"]
                request("/api/automation/jobs/" + jid + "/source",
                        {"source_revision": 1, "source_sha256": "a" * 64})
                saved = {"app": "wec-creative-studio", "schema_version": 1,
                         "backup_version": 2, "id": PROJECT, "kind": "art",
                         "title": "Snapshot test", "pages": []}
                content = json.dumps({"project": saved, "checkpoint": None})
                envelope = {"app": "wec-recovery-package", "package_version": 1,
                            "payload": content, "sha256": hashlib.sha256(content.encode()).hexdigest()}
                metadata = OnlineStore(root / "creative-snapshots").save(json.dumps(envelope).encode())
                sid = metadata["id"]
                _, new_plan = request("/api/automation/jobs", payload("verified-api-key-12345"))
                verified_route = "/api/automation/jobs/" + new_plan["id"] + "/verified-source"
                with self.assertRaises(HTTPError) as err:
                    request(verified_route, {"snapshot_id": sid})
                self.assertEqual(err.exception.code, 409, "Legacy backups have no source revision")
                current_content = json.dumps({"source_revision": 4, "project": saved, "checkpoint": None})
                current_envelope = {"app": "wec-recovery-package", "package_version": 1,
                                    "payload": current_content,
                                    "sha256": hashlib.sha256(current_content.encode()).hexdigest()}
                current_meta = OnlineStore(root / "creative-snapshots").save(
                    json.dumps(current_envelope).encode())
                with self.assertRaises(HTTPError) as err:
                    request(verified_route, {"snapshot_id": current_meta["id"]}, auth=False)
                self.assertEqual(err.exception.code, 401)
                _, verified = request(verified_route, {"snapshot_id": current_meta["id"]})
                self.assertEqual(verified["source_format"], "recovery_payload_v1")
                self.assertEqual(verified["source_revision"], 4)
                self.assertEqual(verified["source_sha256"], current_meta["payload_sha256"])
                self.assertEqual(verified["snapshot_id"], current_meta["id"])
                steps_url = "/api/automation/jobs/" + new_plan["id"] + "/steps"
                with self.assertRaises(HTTPError) as err:
                    request(steps_url, {"confirm":new_plan["id"],"step":"verify_source"}, auth=False)
                self.assertEqual(err.exception.code,401)
                _, empty_steps = request(steps_url)
                self.assertEqual(empty_steps["steps"], [])
                self.assertFalse(empty_steps["execution_enabled"])
                status, first_step = request(steps_url, {"confirm":new_plan["id"],"step":"verify_source"})
                self.assertEqual(status,201)
                self.assertEqual(first_step["state"],"succeeded")
                self.assertEqual(first_step["result"]["source_sha256"],current_meta["payload_sha256"])
                status, replayed_step = request(steps_url, {"confirm":new_plan["id"],"step":"verify_source"})
                self.assertEqual(status,200)
                self.assertEqual(replayed_step,first_step)
                status, inventory = request(steps_url, {"confirm":new_plan["id"],"step":"inspect_inventory"})
                self.assertEqual(status,201)
                self.assertEqual(inventory["result"]["page_count"],0)
                _, steps_readback = request(steps_url)
                self.assertEqual(len(steps_readback["steps"]),2)
                with self.assertRaises(HTTPError) as err:
                    request(steps_url, {"confirm":new_plan["id"],"step":"render_video"})
                self.assertEqual(err.exception.code,400)
                # Preserve both receipts if the owner removes the source snapshot;
                # an existing success must NOT conceal a missing source.
                OnlineStore(root / "creative-snapshots").remove(current_meta["id"])
                with self.assertRaises(HTTPError) as err:
                    request(steps_url, {"confirm":new_plan["id"],"step":"verify_source"})
                self.assertEqual(err.exception.code,404)
                _, retained_steps = request(steps_url)
                self.assertEqual(len(retained_steps["steps"]),2)
                _, persisted = request("/api/automation/jobs/" + new_plan["id"])
                self.assertEqual(persisted, verified)
                _, replay = request(verified_route, {"snapshot_id": current_meta["id"]})
                self.assertEqual(replay, verified)
                with self.assertRaises(HTTPError) as err:
                    request(verified_route, {"snapshot_id": sid})
                self.assertEqual(err.exception.code, 409)
                with self.assertRaises(HTTPError) as err:
                    request("/api/automation/jobs/" + jid + "/snapshot",
                            {"snapshot_id": sid}, auth=False)
                self.assertEqual(err.exception.code, 401)
                _, linked = request("/api/automation/jobs/" + jid + "/snapshot", {"snapshot_id": sid})
                self.assertEqual(linked["snapshot_id"], sid)
                _, repeated = request("/api/automation/jobs/" + jid + "/snapshot", {"snapshot_id": sid})
                self.assertEqual(repeated, linked)
                _, readback = request("/api/automation/jobs/" + jid)
                self.assertEqual(readback["snapshot_id"], sid)
                with self.assertRaises(HTTPError) as err:
                    request("/api/automation/jobs/" + jid + "/snapshot", {"snapshot_id": "f" * 64})
                self.assertEqual(err.exception.code, 409)
                # A mismatched project is never linked, despite a valid
                # self-consistent package and image-checksum verification.
                _, other = request("/api/automation/jobs", payload("snapshot-other-key-123"))
                request("/api/automation/jobs/" + other["id"] + "/source",
                        {"source_revision": 2, "source_sha256": "b" * 64})
                other_saved = {**saved, "id": "e" * 32}
                other_content = json.dumps({"project": other_saved, "checkpoint": None})
                other_envelope = {"app": "wec-recovery-package", "package_version": 1,
                                  "payload": other_content,
                                  "sha256": hashlib.sha256(other_content.encode()).hexdigest()}
                other_sid = OnlineStore(root / "creative-snapshots").save(
                    json.dumps(other_envelope).encode())["id"]
                with self.assertRaises(HTTPError) as err:
                    request("/api/automation/jobs/" + other["id"] + "/snapshot",
                            {"snapshot_id": other_sid})
                self.assertEqual(err.exception.code, 409)
                _, unchanged = request("/api/automation/jobs/" + other["id"])
                self.assertIsNone(unchanged["snapshot_id"])
            finally:
                server.shutdown()
                server.server_close()
                server.RequestHandlerClass.video_jobs.close()
                thread.join(timeout=5)

    def test_auth_create_read_cancel_no_execution(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            server = ThreadingHTTPServer(("127.0.0.1", 0),
                create_handler(root / "studio.sqlite3", root, token=TOKEN))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = "http://127.0.0.1:%d" % server.server_port

            def request(route, data=None, auth=True):
                headers = {"Content-Type": "application/json"}
                if auth:
                    headers["X-WEC-Token"] = TOKEN
                method = "POST" if data is not None else "GET"
                value = json.dumps(data).encode() if data is not None else None
                with urlopen(Request(origin + route, headers=headers, data=value,
                                     method=method), timeout=10) as result:
                    return result.status, json.load(result)

            try:
                for path in ("/api/automation/jobs", "/api/automation/jobs/" + "a" * 32):
                    with self.assertRaises(HTTPError) as err:
                        request(path, auth=False)
                    self.assertEqual(err.exception.code, 401)
                status, created = request("/api/automation/jobs", payload())
                self.assertEqual(status, 201)
                self.assertEqual(created["status"], "awaiting_approval")
                self.assertNotIn("key", created)
                status, repeated = request("/api/automation/jobs", payload())
                self.assertEqual(status, 200)
                self.assertEqual(repeated, created)
                _, listing = request("/api/automation/jobs")
                self.assertFalse(listing["execution_enabled"])
                self.assertEqual(listing["jobs"], [created])
                _, fetched = request("/api/automation/jobs/" + created["id"])
                self.assertEqual(fetched, created)
                with self.assertRaises(HTTPError) as err:
                    request("/api/automation/jobs/" + created["id"] + "/cancel",
                            {"confirm": "different"})
                self.assertEqual(err.exception.code, 400)
                _, cancelled = request("/api/automation/jobs/" + created["id"] + "/cancel",
                                       {"confirm": created["id"]})
                self.assertEqual(cancelled["status"], "cancelled")
                source = {"source_revision": 5, "source_sha256": "b" * 64}
                with self.assertRaises(HTTPError) as err:
                    request("/api/automation/jobs/" + created["id"] + "/source", source, auth=False)
                self.assertEqual(err.exception.code, 401)
                with self.assertRaises(HTTPError) as err:
                    request("/api/automation/jobs/" + created["id"] + "/source", source)
                self.assertEqual(err.exception.code, 409, "Cancelled jobs cannot acquire source locks")
                _, fresh = request("/api/automation/jobs", payload("fresh-source-key-123"))
                _, locked = request("/api/automation/jobs/" + fresh["id"] + "/source", source)
                self.assertEqual(locked["source_sha256"], "b" * 64)
                self.assertEqual(locked["source_revision"], 5)
                _, again = request("/api/automation/jobs/" + fresh["id"] + "/source", source)
                self.assertEqual(again, locked)
                _, persisted = request("/api/automation/jobs/" + fresh["id"])
                self.assertEqual(persisted, locked)
                with self.assertRaises(HTTPError) as err:
                    request("/api/automation/jobs/" + fresh["id"] + "/source",
                            {"source_revision": 6, "source_sha256": "c" * 64})
                self.assertEqual(err.exception.code, 409)
                # No asynchronous queue, media worker, or generation call is created.
                self.assertFalse((root / "automation-jobs" / created["id"]).exists())
            finally:
                server.shutdown()
                server.server_close()
                server.RequestHandlerClass.video_jobs.close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
