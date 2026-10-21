import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from wec_engine.deployment import diagnose, save_diagnostics, validate_comfy_url

class DeploymentTests(unittest.TestCase):
    def test_invalid_urls(self):
        for url in ('file:///etc/passwd', 'http://user:pass@localhost:8188', 'localhost:8188'):
            with self.assertRaises(ValueError):
                validate_comfy_url(url)

    @patch('wec_engine.deployment.detect_gpus', return_value={'nvidia': [], 'status': 'unknown'})
    def test_offline_diagnostics(self, _gpu):
        report = diagnose(check_network=False)
        self.assertEqual(report['comfyui']['status'], 'not checked')
        self.assertIn('recommendation', report)

    @patch('wec_engine.deployment.detect_gpus', return_value={'nvidia': [], 'status': 'unknown'})
    def test_report_write(self, _gpu):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'doctor.json'
            result = save_diagnostics(path)
            self.assertTrue(path.exists())
            self.assertEqual(result['schema_version'], 1)
