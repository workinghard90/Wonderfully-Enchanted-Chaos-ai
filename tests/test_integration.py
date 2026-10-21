import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from wec_engine.integration import prepare_video_reference, live_check, upload_reference


class Response:
    def __init__(self, payload):
        self.payload = payload
    def raise_for_status(self):
        pass
    def json(self):
        return self.payload


class IntegrationTests(unittest.TestCase):
    def test_live_registry(self):
        with patch('wec_engine.integration.requests.get', return_value=Response({'LoadImage': {}, 'SaveImage': {}})):
            result = live_check()
        self.assertTrue(result['reachable'])
        self.assertEqual(result['node_count'], 2)

    def test_upload_reference(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'reference.png'
            path.write_bytes(b'fake bytes for mocked HTTP request')
            with patch('wec_engine.integration.requests.post', return_value=Response({'name': 'reference_1.png'})) as post:
                result = upload_reference(path)
            self.assertEqual(result['name'], 'reference_1.png')
            self.assertTrue(post.called)

    def test_reference_binding_validation_precedes_upload(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'workflow.json'
            path.write_text(json.dumps({'1': {'class_type': 'LoadImage', 'inputs': {'image': 'old.png'}},
                                        '2': {'class_type': 'VHS_VideoCombine', 'inputs': {'images': ['1', 0]}}}))
            with patch('wec_engine.integration.upload_reference', return_value={'name': 'new.png'} ) as upload:
                result = prepare_video_reference(path, __file__, '1.image')
                self.assertEqual(result, {'1.image': 'new.png'})
                with self.assertRaises(ValueError):
                    prepare_video_reference(path, __file__, '2.images')
                self.assertEqual(upload.call_count, 1)

    def test_invalid_extension_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'not_image.txt'
            path.write_text('x')
            with self.assertRaises(ValueError):
                upload_reference(path)

if __name__ == '__main__':
    unittest.main()
