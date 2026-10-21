import tempfile
import unittest
from pathlib import Path
from wec_engine.story import plan_story, save_plan
from wec_engine.finishing import attach_audio

class StoryTests(unittest.TestCase):
    def test_duration_and_order(self):
        plan = plan_story('One two three four five six seven eight nine ten', total_duration=35, scene_count=7, character='lantern')
        self.assertEqual(len(plan['scenes']), 7)
        self.assertAlmostEqual(sum(s['duration'] for s in plan['scenes']), 35, places=2)
        self.assertEqual(' '.join(s['narration'] for s in plan['scenes']), 'One two three four five six seven eight nine ten')
    def test_invalid(self):
        with self.assertRaises(ValueError): plan_story(' ', scene_count=2)
        with self.assertRaises(ValueError): plan_story('Hello', scene_count=0)
    def test_save(self):
        with tempfile.TemporaryDirectory() as d:
            path = save_plan(plan_story('Hello world'), Path(d)/'nested'/'plan.json')
            self.assertTrue(path.is_file())
    def test_missing_audio(self):
        with self.assertRaises((FileNotFoundError, RuntimeError)):
            attach_audio('missing.mp4','missing.wav','output.mp4')
