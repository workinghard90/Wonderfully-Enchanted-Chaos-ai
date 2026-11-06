"""Real original-artwork ZIP, safety and authenticated HTTP coverage."""
import base64
import hashlib
import io
import json
import os
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from PIL import Image

from wec_engine.automation_jobs import AutomationJobs, AutomationJobError
from wec_engine.automation_approvals import AutomationApprovals
from wec_engine.automation_artwork import ArtworkArchives
from wec_engine.online_store import OnlineStore
from wec_engine.studio import create_handler

PROJECT = "b9f83452-ec2a-4818-82a7-e5231b344143"
TOKEN = "test-artwork-export-owner-token-32-characters"


def artwork_bytes(format="PNG"):
    buffer = io.BytesIO()
    Image.new("RGB", (12, 12), (80, 90, 110)).save(buffer, format=format)
    return buffer.getvalue()


def recovery(approved=True, *, original_id=PROJECT, revision=3):
    pictures = []
    pages = []
    for i, fmt in enumerate(("PNG", "JPEG"), 1):
        image = artwork_bytes(fmt)
        pictures.append(image)
        pages.append({
            "id": "page-" + str(i), "review": "approved" if approved or i == 1 else "unreviewed",
            "asset": {"image_base64": base64.b64encode(image).decode(),
                      "sha256": hashlib.sha256(image).hexdigest(),
                      "extension": "png" if fmt == "PNG" else "jpg"},
            "text": "Private narration: never export", "prompt": "Private prompt: never export"})
    project = {"app": "wec-creative-studio", "schema_version": 1,
               "backup_version": 2, "id": original_id, "kind": "art",
               "title": "Private title never export", "pages": pages}
    payload = json.dumps({"source_revision": revision, "project": project, "checkpoint": None})
    envelope = {"app": "wec-recovery-package", "package_version": 1,
                "payload": payload, "sha256": hashlib.sha256(payload.encode()).hexdigest()}
    return json.dumps(envelope).encode(), pictures


def setup_plan(root, *, approved=True, key="artwork-export-key-123"):
    jobs = AutomationJobs(root / "automation-jobs.sqlite3")
    approvals = AutomationApprovals(jobs)
    online = OnlineStore(root / "creative-snapshots")
    archives = ArtworkArchives(jobs, approvals, online, root)
    raw, pictures = recovery(approved=approved)
    metadata = online.save(raw)
    job, _ = jobs.create({"project_id": PROJECT, "kind": "art", "recipe": "artwork",
                          "idempotency_key": key})
    jobs.bind_verified_source(job["id"], metadata["id"], lambda _:metadata)
    req = {"confirm": job["id"], "operation": "artwork_export",
           "source_sha256": metadata["payload_sha256"]}
    consent, created = approvals.approve(job["id"], req, lambda _:metadata)
    assert created and consent["state"] == "approved"
    return jobs, approvals, online, archives, job, metadata, pictures


class ArtworkArchiveUnitTests(unittest.TestCase):
    def test_real_zip_manifest_exact_originals_idempotency_restart_and_revocation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jobs, approvals, online, archive, job, meta, pictures = setup_plan(root)
            jid = job["id"]
            receipt, created = archive.prepare(jid, {"confirm":jid})
            self.assertTrue(created)
            self.assertEqual(receipt["state"], "succeeded")
            self.assertEqual(receipt["image_count"], 2)
            with archive.open_download(jid)[0] as src:
                raw = src.read()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), receipt["archive_sha256"])
            self.assertEqual(len(raw), receipt["archive_bytes"])
            with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
                self.assertEqual(zipped.namelist(), ["artwork/page-001.png",
                                                      "artwork/page-002.jpg", "manifest.json"])
                self.assertEqual(zipped.read("artwork/page-001.png"), pictures[0])
                self.assertEqual(zipped.read("artwork/page-002.jpg"), pictures[1])
                manifest = json.loads(zipped.read("manifest.json"))
                self.assertEqual(manifest["image_count"], 2)
                self.assertEqual(manifest["source_sha256"], meta["payload_sha256"])
                for item in manifest["files"]:
                    self.assertEqual(hashlib.sha256(zipped.read(item["file"])).hexdigest(), item["sha256"])
                self.assertNotIn(b"Private prompt", raw)
                self.assertNotIn(b"Private narration", raw)
            # Archived source remains unmodified and untouched.
            with online.open(meta["id"]) as source:
                self.assertEqual(hashlib.sha256(source.read()).hexdigest(), meta["id"])
            same, created = archive.prepare(jid, {"confirm":jid})
            self.assertFalse(created)
            self.assertEqual(same, receipt)
            restarted = ArtworkArchives(AutomationJobs(jobs.path),
                         AutomationApprovals(AutomationJobs(jobs.path)), online, root)
            self.assertEqual(restarted.status(jid), receipt)
            with restarted.open_download(jid)[0] as source:
                self.assertEqual(source.read(), raw)
            revoked = approvals.revoke(jid, {"confirm":jid, "operation":"artwork_export"})
            self.assertEqual(revoked["state"], "revoked")
            with self.assertRaises(AutomationJobError) as error:
                archive.open_download(jid)
            self.assertEqual(error.exception.status, 409)
            with self.assertRaises(AutomationJobError):
                archive.prepare(jid, {"confirm":jid})
            self.assertEqual(archive.status(jid), receipt)

    def test_unapproved_pages_rejected_with_explicit_retry_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            jobs, approvals, online, archive, job, meta, pictures=setup_plan(root,approved=False)
            jid=job["id"]
            for attempt in range(1, 4):
                request={"confirm":jid, **({"retry":True} if attempt>1 else {})}
                with self.assertRaises(AutomationJobError) as error:
                    archive.prepare(jid, request)
                self.assertEqual(error.exception.status,409)
                self.assertEqual(archive.status(jid)["attempts"],attempt)
                self.assertEqual(archive.status(jid)["state"],"failed")
            with self.assertRaises(AutomationJobError):
                archive.prepare(jid, {"confirm":jid,"retry":True})
            self.assertEqual(archive.status(jid)["attempts"],3)
            self.assertFalse((root/"automation-exports"/(jid+".zip")).exists())
            # Existing source is still readable after failed outputs.
            with online.open(meta["id"]) as source:
                self.assertTrue(source.read())

    def test_oversized_image_dimensions_fail_closed_with_durable_receipt(self):
        # Source snapshots verify original bytes and digests, but Pillow may
        # separately reject declared dimensions during image inspection.
        # Mock the image pixel safety threshold instead of allocating
        # dangerous test images on 512 MiB CI workers.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jobs, approvals, online, archive, job, meta, _ = setup_plan(root)
            jid = job["id"]
            with patch.object(Image, "MAX_IMAGE_PIXELS", 10):
                with self.assertRaises(AutomationJobError) as error:
                    archive.prepare(jid, {"confirm": jid})
            self.assertEqual(error.exception.status, 409)
            receipt = archive.status(jid)
            self.assertEqual(receipt["state"], "failed")
            self.assertEqual(receipt["attempts"], 1)
            self.assertIsNone(receipt["archive_sha256"])
            self.assertFalse((root / "automation-exports" / (jid + ".zip")).exists())
            with online.open(meta["id"]) as source:
                self.assertTrue(source.read())
            # The original valid source can still be processed on deliberate
            # retry with the normal image safety threshold.
            completed, created = archive.prepare(jid, {"confirm": jid, "retry": True})
            self.assertTrue(created)
            self.assertEqual(completed["state"], "succeeded")
            self.assertEqual(completed["attempts"], 2)

    def test_aggregate_zip_budget_fails_closed_without_deleting_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jobs, approvals, online, archive, job, meta, _ = setup_plan(root)
            jid = job["id"]
            # Simulate an existing approved export while keeping all source
            # archives and receipts intact; no heavy fixture allocations.
            existing = root / "automation-exports" / ("a" * 32 + ".zip")
            existing.write_bytes(b"existing-owner-zip")
            with patch("wec_engine.automation_artwork.MAX_EXPORT_FILES", 1):
                with self.assertRaises(AutomationJobError) as error:
                    archive.prepare(jid, {"confirm":jid})
            self.assertEqual(error.exception.status, 507)
            self.assertEqual(existing.read_bytes(), b"existing-owner-zip")
            self.assertEqual(archive.status(jid)["state"], "failed")
            self.assertFalse((root / "automation-exports" / (jid + ".zip")).exists())
            # Explicit retry succeeds once there is capacity; no auto cleanup.
            existing.unlink()
            receipt, created = archive.prepare(jid, {"confirm":jid,"retry":True})
            self.assertTrue(created)
            self.assertEqual(receipt["state"], "succeeded")

    def test_aggregate_byte_limit_rejects_without_mutating_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jobs, approvals, online, archive, job, meta, _ = setup_plan(root)
            jid = job["id"]
            with patch("wec_engine.automation_artwork.MAX_EXPORT_TOTAL", 1):
                with self.assertRaises(AutomationJobError) as error:
                    archive.prepare(jid, {"confirm":jid})
            self.assertEqual(error.exception.status,507)
            with online.open(meta["id"]) as src:
                self.assertTrue(src.read())
            self.assertEqual(archive.status(jid)["state"],"failed")

    def test_missing_source_cancel_and_corrupt_output_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            jobs, approvals, online, archive, job, meta, pictures=setup_plan(root)
            jid=job["id"]
            archive.prepare(jid, {"confirm":jid})
            output = root/"automation-exports"/(jid+".zip")
            original = output.read_bytes()
            output.write_bytes(b"tampered")
            with self.assertRaises(AutomationJobError) as error:
                archive.open_download(jid)
            self.assertEqual(error.exception.status,503)
            with self.assertRaises(AutomationJobError):
                archive.prepare(jid, {"confirm":jid})
            output.write_bytes(original)
            online.remove(meta["id"])
            with self.assertRaises(AutomationJobError) as error:
                archive.open_download(jid)
            self.assertEqual(error.exception.status,404)
            self.assertEqual(archive.status(jid)["state"],"succeeded")
            jobs.cancel(jid, {"confirm":jid})
            with self.assertRaises(AutomationJobError):
                archive.open_download(jid)

    def test_approval_is_operation_specific_and_legacy_plan_cannot_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            jobs=AutomationJobs(root/"automation-jobs.sqlite3")
            approvals=AutomationApprovals(jobs)
            online=OnlineStore(root/"creative-snapshots")
            archive=ArtworkArchives(jobs,approvals,online,root)
            meta=online.save(recovery()[0])
            legacy,_=jobs.create({"project_id":PROJECT,"kind":"art","recipe":"artwork",
                                   "idempotency_key":"legacy-artwork-export-123"})
            jobs.bind_source(legacy["id"],{"source_revision":1,"source_sha256":"a"*64})
            with self.assertRaises(AutomationJobError):
                approvals.approve(legacy["id"],
                    {"confirm":legacy["id"],"operation":"artwork_export",
                     "source_sha256":"a"*64},lambda _:meta)
            verified,_=jobs.create({"project_id":PROJECT,"kind":"art","recipe":"artwork",
                                     "idempotency_key":"separate-artwork-approval-123"})
            jobs.bind_verified_source(verified["id"],meta["id"],lambda _:meta)
            approvals.approve(verified["id"],
                {"confirm":verified["id"],"operation":"inventory_report",
                 "source_sha256":meta["payload_sha256"]},lambda _:meta)
            with self.assertRaises(AutomationJobError):
                archive.prepare(verified["id"],{"confirm":verified["id"]})
            for forbidden in ("publish", "ai_image", "render_video", "cozy_handoff"):
                with self.subTest(forbidden=forbidden),self.assertRaises(AutomationJobError):
                    approvals.approve(verified["id"],
                        {"confirm":verified["id"],"operation":forbidden,
                         "source_sha256":meta["payload_sha256"]},lambda _:meta)


class ArtworkArchiveAPITests(unittest.TestCase):
    def test_authenticated_real_zip_download_duplicate_and_revocation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.dict(os.environ, {"WEC_ENABLE_ONLINE_STORAGE":"1","RENDER":""}):
                server=ThreadingHTTPServer(("127.0.0.1",0),
                    create_handler(root/"studio.sqlite3",root,token=TOKEN))
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            base=f"http://127.0.0.1:{server.server_port}"
            def call(path, data=None, auth=True):
                headers={"X-WEC-Token":TOKEN} if auth else {}
                if data is not None:
                    headers["Content-Type"]="application/json"
                with urlopen(Request(base+path,headers=headers,
                         data=json.dumps(data).encode() if data is not None else None,
                         method="POST" if data is not None else "GET"),timeout=10) as response:
                    return response.status, response.headers, response.read()
            try:
                online=OnlineStore(root/"creative-snapshots")
                meta=online.save(recovery()[0])
                _,_,raw=call("/api/automation/jobs",{
                    "project_id":PROJECT,"kind":"art","recipe":"artwork",
                    "idempotency_key":"artwork-http-export-123"})
                jid=json.loads(raw)["id"]
                _,_,raw=call(f"/api/automation/jobs/{jid}/verified-source",{"snapshot_id":meta["id"]})
                self.assertEqual(json.loads(raw)["source_sha256"],meta["payload_sha256"])
                route=f"/api/automation/jobs/{jid}/artwork-export"
                with self.assertRaises(HTTPError) as err:
                    call(route,{"confirm":jid})
                self.assertEqual(err.exception.code,409)
                approval=f"/api/automation/jobs/{jid}/approvals"
                request={"confirm":jid,"operation":"artwork_export",
                         "source_sha256":meta["payload_sha256"]}
                with self.assertRaises(HTTPError) as err:
                    call(approval,request,auth=False)
                self.assertEqual(err.exception.code,401)
                status,_,raw=call(approval,request)
                self.assertEqual(status,201)
                status,_,raw=call(route,{"confirm":jid})
                self.assertEqual(status,201)
                receipt=json.loads(raw)
                self.assertEqual(receipt["image_count"],2)
                status,_,raw=call(route,{"confirm":jid})
                self.assertEqual(status,200)
                self.assertEqual(json.loads(raw),receipt)
                with self.assertRaises(HTTPError) as err:
                    call(route+"/file",auth=False)
                self.assertEqual(err.exception.code,401)
                status,headers,raw=call(route+"/file")
                self.assertEqual(status,200)
                self.assertEqual(headers.get_content_type(),"application/zip")
                self.assertEqual(headers["X-WEC-Archive-SHA256"],hashlib.sha256(raw).hexdigest())
                with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
                    self.assertEqual(len(zipped.namelist()),3)
                    self.assertEqual(json.loads(zipped.read("manifest.json"))["image_count"],2)
                _,_,raw=call(approval+"/revoke",
                    {"confirm":jid,"operation":"artwork_export"})
                self.assertEqual(json.loads(raw)["state"],"revoked")
                with self.assertRaises(HTTPError) as err:
                    call(route+"/file")
                self.assertEqual(err.exception.code,409)
                _,_,raw=call(route)
                self.assertEqual(json.loads(raw)["export"],receipt)
            finally:
                server.shutdown()
                server.server_close()
                server.RequestHandlerClass.video_jobs.close()
                thread.join(timeout=5)
