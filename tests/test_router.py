import tempfile
import unittest
from pathlib import Path
from PIL import Image
from wec_engine.router import HybridRouter

class FakeComfy:
    def available(self): return True
    def generate(self, workflow_path, output_path):
        Image.new("RGB", (512, 768)).save(output_path)

class FakeCloud:
    def available(self): return True
    def generate(self, *args, **kwargs): raise AssertionError("Cloud should not run")

class RouterTests(unittest.TestCase):
    def test_local_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = HybridRouter(FakeComfy(), FakeCloud()).generate({"id":"test_1","prompt":"test","comfy_workflow":"workflow.json"}, tmp)
            self.assertEqual(result["provider"], "comfyui")
            self.assertTrue(Path(result["image_path"]).exists())
    def test_cloud_requires_estimate(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                HybridRouter().generate({"id":"test_2","prompt":"test"}, tmp, allow_cloud=True)

if __name__ == "__main__": unittest.main()
