import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from wec_engine.readiness import audit_workflow, preflight

class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'workflow.json'
        self.path.write_text(json.dumps({'1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'test.safetensors'}}, '2': {'class_type': 'SaveImage', 'inputs': {'images': ['1', 0]}}}))

    def test_image_audit(self):
        r = audit_workflow(self.path)
        self.assertTrue(r['ready_for_execution'])
        self.assertEqual(r['model_filenames_referenced'], ['test.safetensors'])

    def test_binding_fails_closed(self):
        with self.assertRaises(ValueError):
            audit_workflow(self.path, bindings={'2.nonexistent': 'x'})

    def test_reject_ui_format(self):
        self.path.write_text(json.dumps({'nodes': []}))
        with self.assertRaises(ValueError):
            audit_workflow(self.path)

    def test_video_missing_export(self):
        self.assertFalse(audit_workflow(self.path, kind='video')['ready_for_execution'])

    @patch('wec_engine.readiness.requests.get')
    def test_remote_missing_nodes(self, get):
        get.return_value.ok = True
        get.return_value.json.return_value = {'SaveImage': {}}
        r = preflight(self.path, check_network=True)
        self.assertEqual(r['workflow']['missing_node_classes'], ['CheckpointLoaderSimple'])
        self.assertFalse(r['workflow']['ready_for_execution'])

if __name__ == '__main__':
    unittest.main()
