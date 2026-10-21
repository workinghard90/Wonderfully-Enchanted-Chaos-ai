import array
import base64
import io
import json
import math
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from wec_engine.backup_video import (
    SAMPLE_RATE, _caption_line, _write_pcm, make_narration, prepare_backup,
    render_backup_video,
)


def backup(images=True, duration=2):
    out = io.BytesIO()
    Image.new('RGB', (256, 384), 'teal').save(out, format='JPEG')
    picture = base64.b64encode(out.getvalue()).decode('ascii')
    return {'schema_version': 2, 'projects': [{'title': 'A tiny film',
            'story': 'The lantern glows. The fox smiles.', 'scenes': 2, 'duration': duration,
            'scene_images': [{'scene_id': f'scene-{i:03d}', 'mime': 'image/jpeg', 'image_base64': picture}
                             for i in (1, 2)] if images else []}]}


class BackupVideoTests(unittest.TestCase):
    def test_validated_extraction_preserves_backup(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = root / 'backup.json'
            original = json.dumps(backup()).encode(); source.write_bytes(original)
            plan = prepare_backup(source, root / 'work')
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual([s['narration'] for s in plan['scenes']], ['The lantern glows.', 'The fox smiles.'])
            self.assertTrue((root / 'work' / 'scene-002.jpg').is_file())
            with self.assertRaises(FileExistsError):
                prepare_backup(source, root / 'work')

    def test_missing_images_rejected_before_workdir_creation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = root / 'backup.json'
            source.write_text(json.dumps(backup(images=False)))
            with self.assertRaisesRegex(ValueError, 'Attach an image'):
                prepare_backup(source, root / 'work')
            self.assertFalse((root / 'work').exists())

    def test_explicit_project_selection_and_invalid_ids(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = root / 'backup.json'
            data = backup(); data['projects'] *= 2
            source.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'Multiple projects'):
                prepare_backup(source, root / 'work')
            with self.assertRaisesRegex(ValueError, 'index'):
                prepare_backup(source, root / 'work', project_index=-1)
            data['projects'][0]['scene_images'][0]['scene_id'] = '../../outside'
            source.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                prepare_backup(source, root / 'work', project_index=0)
            self.assertFalse((root / 'work').exists())

    def test_existing_movie_is_preserved(self):
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / 'film.mp4'; target.write_bytes(b'keep this movie')
            with self.assertRaises(FileExistsError):
                render_backup_video('missing.json', target, voice_model='missing.onnx')
            self.assertEqual(target.read_bytes(), b'keep this movie')

    def test_story_text_cannot_inject_caption_control_markup(self):
        line = _caption_line(r'{\pos(1,1)} <font>fox</font>')
        self.assertNotIn('{', line)
        self.assertNotIn('\\', line)
        self.assertNotIn('<', line)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg unavailable')
    def test_fitted_speech_stays_within_its_scene(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _write_pcm(root / 'scene-001-raw.wav', (int(5000 * math.sin(2 * math.pi * 220 * i / SAMPLE_RATE)) for i in range(round(SAMPLE_RATE * 0.9))))
            plan = {'duration': 1, 'scenes': [{'id': 'scene-001', 'start': 0, 'duration': 1, 'narration': 'A fitted sentence.'}]}
            timing = make_narration(plan, root)[0]
            self.assertGreater(timing['speed'], 1)
            self.assertLessEqual(timing['speed'], 1.35)
            self.assertLess(timing['end'], 1)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg unavailable')
    def test_long_narration_rejected_instead_of_truncated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _write_pcm(root / 'scene-001-raw.wav', (int(5000 * math.sin(2 * math.pi * 220 * i / SAMPLE_RATE)) for i in range(SAMPLE_RATE * 2)))
            plan = {'duration': 1, 'scenes': [{'id': 'scene-001', 'start': 0, 'duration': 1, 'narration': 'Too much speech'}]}
            with self.assertRaisesRegex(ValueError, 'too long'):
                make_narration(plan, root)


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg/FFprobe unavailable')
class BackupMovieMediaTests(unittest.TestCase):
    def test_real_mp4_with_synthetic_voice_fixture(self):
        # Real FFmpeg, isolated backup and synthetic audio. Never downloads a voice.
        with tempfile.TemporaryDirectory(prefix="wec movie's [test], ") as td:
            root = Path(td); source = root / 'backup.json'; source.write_text(json.dumps(backup()))
            model = root / 'fixture.onnx'; model.write_bytes(b'test fixture')
            (root / 'fixture.onnx.json').write_text('{}')
            def fake_voice(plan, _model, work):
                for scene in plan['scenes']:
                    _write_pcm(work / (scene['id'] + '-raw.wav'),
                               (int(5000 * math.sin(2 * math.pi * 220 * i / SAMPLE_RATE)) for i in range(SAMPLE_RATE // 4)))
            with patch('wec_engine.backup_video._synthesize_scenes', side_effect=fake_voice):
                report = render_backup_video(source, root / 'film.mp4', voice_model=model, ambience=True)
            self.assertTrue(report['ok'], report)
            self.assertTrue(all(report['checks'].values()))
            self.assertAlmostEqual(report['duration'], 2, delta=0.1)
            self.assertEqual(len(report['scenes']), 2)
            self.assertLess(report['scenes'][0]['end'], report['scenes'][1]['start'])
            with __import__('wave').open(str(root / 'film-work' / 'narration-mix.wav')) as audio:
                self.assertEqual(audio.getnframes(), 2 * SAMPLE_RATE)


if __name__ == '__main__':
    unittest.main()
