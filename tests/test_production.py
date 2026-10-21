import json
import tempfile
import unittest
from pathlib import Path
from wec_engine.production import _timecode, captions_from_plan, finalize_video, verify_delivery

class ProductionTests(unittest.TestCase):
    def test_timecode(self):
        self.assertEqual(_timecode(65.125), '00:01:05,125')

    def test_captions(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p/'plan.json').write_text(json.dumps({'scenes':[
                {'start':0,'duration':2,'narration':'Hello world'},
                {'start':2,'duration':1.5,'narration':'Next scene'}]}))
            output = captions_from_plan(p/'plan.json', p/'captions.srt')
            self.assertIn('00:00:02,000 --> 00:00:03,500', output.read_text())

    def test_reject_overlaps(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p/'plan.json').write_text(json.dumps({'scenes':[
                {'start':0,'duration':3,'narration':'One'},
                {'start':2,'duration':1,'narration':'Two'}]}))
            with self.assertRaises(ValueError):
                captions_from_plan(p/'plan.json',p/'x.srt')

    def test_reject_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'video.mp4'
            p.write_bytes(b'test')
            with self.assertRaises(ValueError):
                finalize_video(p,p)

if __name__ == '__main__':
    unittest.main()
