"""Fixture tests for the read-only WEC handoff importer.

Run: python -m unittest discover -s tests -p 'test_wec_handoff.py'
"""
from PIL import Image
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

MODULE = Path(__file__).resolve().parents[1] / "tools" / "cozy_handoff_validate.py"
spec = importlib.util.spec_from_file_location("wec_handoff_preview", MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def checked(path):
    errors = module.validate(path)
    if errors:
        raise ValueError("; ".join(errors))
    return None


class HandoffPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "handoff.zip"
        buffer = io.BytesIO()
        Image.new("RGB", (40, 30), "red").save(buffer, format="PNG")
        self.asset = buffer.getvalue()
        self.manifest = {
            "schemaVersion": "wec-cozy-handoff-v1",
            "sourceProjectId": "fixture-project",
            "productSlug": "fixture-book",
            "title": "Fixture Book",
            "creator": "Fixture Author",
            "productType": "coloring-book",
            "description": "Fixture description",
            "publicationStatus": "approved",
            "assets": {"cover": "assets/cover.png", "previews": []},
            "kdp": {"interior": None, "cover": None},
            "purchaseUrl": None,
            "sha256": {"assets/cover.png": hashlib.sha256(self.asset).hexdigest()},
        }

    def write(self, asset=None, extra=None):
        with zipfile.ZipFile(self.path, "w") as archive:
            archive.writestr("manifest.json", json.dumps(self.manifest))
            archive.writestr("assets/cover.png", self.asset if asset is None else asset)
            if extra:
                archive.writestr(extra, b"bad")

    def test_real_image_is_accepted(self):
        self.write()
        self.assertEqual(module.validate(self.path), [])

    def test_draft_can_be_validated_without_publication(self):
        self.manifest["publicationStatus"] = "draft"
        self.write()
        self.assertEqual(module.validate(self.path), [])

    def test_modified_asset_is_rejected(self):
        self.write(asset=b"tampered")
        with self.assertRaisesRegex(ValueError, "Checksum"):
            checked(self.path)

    def test_traversal_is_rejected(self):
        self.write(extra="../outside.txt")
        with self.assertRaises(ValueError):
            checked(self.path)

    def test_unverified_purchase_link_is_rejected(self):
        self.manifest["purchaseUrl"] = "https://example.com/unverified"
        self.write()
        with self.assertRaises(ValueError):
            checked(self.path)

    def test_supported_image_formats(self):
        for extension, format_name in (("png", "PNG"), ("jpg", "JPEG"), ("webp", "WEBP")):
            with self.subTest(format=format_name):
                buffer = io.BytesIO()
                Image.new("RGB", (40, 30), "red").save(buffer, format=format_name)
                raw = buffer.getvalue()
                name = "assets/cover." + extension
                self.manifest["assets"]["cover"] = name
                self.manifest["sha256"] = {name: hashlib.sha256(raw).hexdigest()}
                with zipfile.ZipFile(self.path, "w") as z:
                    z.writestr("manifest.json", json.dumps(self.manifest))
                    z.writestr(name, raw)
                checked(self.path)

    def test_fake_image_with_matching_hash_is_rejected(self):
        self.asset = b"not an image"
        self.manifest["sha256"]["assets/cover.png"] = hashlib.sha256(self.asset).hexdigest()
        self.write()
        with self.assertRaises(ValueError):
            checked(self.path)

    def test_truncated_image_with_matching_hash_is_rejected(self):
        self.asset = self.asset[:40]
        self.manifest["sha256"]["assets/cover.png"] = hashlib.sha256(self.asset).hexdigest()
        self.write()
        with self.assertRaises(ValueError):
            checked(self.path)

    def test_image_extension_mismatch_is_rejected(self):
        buffer = io.BytesIO()
        Image.new("RGB", (40, 30)).save(buffer, format="JPEG")
        self.asset = buffer.getvalue()
        self.manifest["sha256"]["assets/cover.png"] = hashlib.sha256(self.asset).hexdigest()
        self.write()
        with self.assertRaises(ValueError):
            checked(self.path)

    def test_pdf_in_image_slot_is_rejected(self):
        for slot in ("cover", "previews"):
            with self.subTest(slot=slot):
                self.manifest["assets"] = {"cover": None, "previews": []}
                self.manifest["assets"][slot] = "kdp/book.pdf" if slot == "cover" else ["kdp/book.pdf"]
                raw = b"%PDF-1.4 fixture"
                self.manifest["sha256"] = {"kdp/book.pdf": hashlib.sha256(raw).hexdigest()}
                with zipfile.ZipFile(self.path, "w") as z:
                    z.writestr("manifest.json", json.dumps(self.manifest))
                    z.writestr("kdp/book.pdf", raw)
                with self.assertRaises(ValueError):
                    checked(self.path)

    def test_image_in_kdp_slot_is_rejected(self):
        for slot in ("cover", "interior"):
            self.manifest["kdp"][slot] = "assets/cover.png"
            self.write()
            with self.assertRaises(ValueError):
                checked(self.path)

    def test_invalid_pdf_content_is_rejected(self):
        raw = b"not a PDF"
        self.manifest["kdp"]["interior"] = "kdp/book.pdf"
        self.manifest["sha256"]["kdp/book.pdf"] = hashlib.sha256(raw).hexdigest()
        self.write()
        with zipfile.ZipFile(self.path, "a") as z:
            z.writestr("kdp/book.pdf", raw)
        with self.assertRaises(ValueError):
            checked(self.path)

    def test_oversized_entry_is_rejected(self):
        raw = bytes(42 * 1024 * 1024 + 1)
        self.manifest["sha256"]["assets/cover.png"] = hashlib.sha256(raw).hexdigest()
        self.write(asset=raw)
        with self.assertRaises(ValueError):
            checked(self.path)

    def test_truncated_zip_is_rejected(self):
        self.write()
        self.path.write_bytes(self.path.read_bytes()[:40])
        with self.assertRaises(zipfile.BadZipFile):
            checked(self.path)


if __name__ == "__main__":
    unittest.main()
