import json
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from wec_engine.automation_jobs import AutomationJobs, AutomationJobError, MAX_JOBS
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

    def test_unfinished_work_is_not_reported_success_on_restart(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "jobs.sqlite3"
            jobs = AutomationJobs(db)
            record, _ = jobs.create(payload())
            with sqlite3.connect(db) as conn:
                conn.execute("UPDATE jobs SET status='running' WHERE id=?", (record["id"],))
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
                # No asynchronous queue, media worker, or generation call is created.
                self.assertFalse((root / "automation-jobs" / created["id"]).exists())
            finally:
                server.shutdown()
                server.server_close()
                server.RequestHandlerClass.video_jobs.close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
