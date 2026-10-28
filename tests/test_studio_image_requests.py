"""Recovery receipts never submit generation and retain bounded original bytes."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from wec_engine.studio_image_requests import ImageRequests, ReceiptError, RESULT_TTL, RECEIPT_TTL
from wec_engine.studio_store import init_db, _database


class ImageRequestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = init_db(Path(self.temp.name) / 'studio.sqlite3')
        self.receipts = ImageRequests(self.path)

    def test_identity_and_input_conflicts(self):
        request_id, fingerprint = ImageRequests.identity({'request_id':'a'*32, 'prompt':'A cloud', 'mode':'text'})
        self.assertEqual((request_id, fingerprint), ImageRequests.identity({'mode':'text','prompt':'A cloud','request_id':'a'*32}))
        self.receipts.start(request_id, fingerprint)
        with self.assertRaises(ReceiptError): self.receipts.start(request_id, fingerprint)
        with self.assertRaises(ReceiptError): self.receipts.get(request_id, 'different')
        for invalid in ('../file', None, 123, 'A'*32, 'a'*33):
            with self.assertRaises(ValueError): ImageRequests.identity({'request_id':invalid})

    def test_restart_preserves_ready_bytes_and_interrupts_unfinished_work(self):
        self.receipts.start('a'*32, 'one'); self.receipts.complete('a'*32, b'original', 'image/png')
        self.receipts.start('b'*32, 'two')
        restarted = ImageRequests(self.path)
        self.assertEqual(restarted.get('a'*32)['image'], b'original')
        self.assertEqual(restarted.get('b'*32)['state'], 'interrupted')
        with self.assertRaises(ReceiptError):
            self.receipts.complete('b'*32, b'late old worker', 'image/png')
        self.assertEqual(restarted.get('b'*32)['state'], 'interrupted')
        restarted.fail('a'*32, 'lost response', 500)
        self.assertEqual(restarted.get('a'*32)['state'], 'ready')

    def test_retention_evicts_bytes_but_preserves_no_retry_receipts(self):
        with patch('wec_engine.studio_image_requests.time.time', return_value=2000000000):
            for n in range(7):
                request_id = f'{n:032x}'
                self.receipts.start(request_id, str(n))
                self.receipts.complete(request_id, bytes([n]), 'image/png')
            with _database(self.path) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM creative_image_requests WHERE image IS NOT NULL").fetchone()[0], 5)
            self.assertEqual(self.receipts.get('0'*32)['state'], 'expired')
        with patch('wec_engine.studio_image_requests.time.time', return_value=2000000000 + RESULT_TTL + 1):
            self.assertEqual(self.receipts.get(f'{6:032x}')['state'], 'expired')
            self.assertIsNone(self.receipts.get(f'{6:032x}')['image'])
        with patch('wec_engine.studio_image_requests.time.time', return_value=2000000000 + RECEIPT_TTL + 1):
            self.assertIsNone(self.receipts.get(f'{6:032x}'))

    def test_limits_reject_without_removing_existing_result(self):
        self.receipts.start('a'*32, 'one'); self.receipts.complete('a'*32, b'original', 'image/png')
        with patch('wec_engine.studio_image_requests.MAX_RECEIPTS', 1):
            with self.assertRaises(ReceiptError): self.receipts.start('b'*32, 'two')
        self.receipts.start('b'*32, 'two')
        with patch('wec_engine.studio_image_requests.MAX_RESULT_BYTES', 1):
            with self.assertRaises(ValueError): self.receipts.complete('b'*32, b'too big', 'image/png')
        self.assertEqual(self.receipts.get('a'*32)['image'], b'original')
