import json
import tempfile
import unittest
from pathlib import Path
from wec_engine.orchestrator import run_production

class OrchestratorTests(unittest.TestCase):
    def test_dry_run_does_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / 'plan.json'
            p.write_text(json.dumps({'duration': 5, 'scenes': [{'id':'s-1','duration':5,'prompt':'test'}]}))
            result = run_production(p, root/'work', dry_run=True, generate_images=True)
            self.assertTrue(result['dry_run'])
            self.assertFalse((root/'work').exists())

    def test_resume_rejects_changed_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            p=root/'plan.json'
            p.write_text(json.dumps({'duration':5,'scenes':[{'id':'s-1','duration':5}]}))
            with self.assertRaises(FileNotFoundError):
                run_production(p,root/'work',allow_silent=True)
            p.write_text(json.dumps({'duration':6,'scenes':[{'id':'s-1','duration':6}]}))
            with self.assertRaisesRegex(ValueError,'Plan changed'):
                run_production(p,root/'work',allow_silent=True)

    def test_duplicate_ids_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'plan.json'
            p.write_text(json.dumps({'duration':5,'scenes':[{'id':'a','duration':2},{'id':'a','duration':3}]}))
            with self.assertRaisesRegex(ValueError,'unique'):
                run_production(p,Path(tmp)/'work',dry_run=True)
