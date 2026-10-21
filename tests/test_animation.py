import unittest
from wec_engine.animation import bind_workflow
from wec_engine.characters import load_character

class TestAnimation(unittest.TestCase):
    def test_binding(self):
        original = {"12": {"inputs": {"text": "before"}, "class_type": "CLIPTextEncode"}}
        updated = bind_workflow(original, {"12.text": "after"})
        self.assertEqual(updated["12"]["inputs"]["text"], "after")
        self.assertEqual(original["12"]["inputs"]["text"], "before")

    def test_reject_unknown(self):
        with self.assertRaises(ValueError):
            bind_workflow({"12": {"inputs": {"text": "a"}}}, {"12.bad": "x"})

    def test_character_validation(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "character.json"
            path.write_text('{"id":"a","name":"A","description":"test","reference_images":["ref.png"]}')
            self.assertEqual(load_character(path)["id"], "a")
