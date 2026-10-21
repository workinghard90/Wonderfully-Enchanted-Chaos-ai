"""Real FFmpeg tests with synthetic inputs, no AI or paid requests."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from wec_engine.motion import render_clips
from wec_engine.orchestrator import run_production
from wec_engine.production import verify_delivery
from wec_engine.video import render_stills

@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg/FFprobe unavailable')
class MediaSmokeTests(unittest.TestCase):
    def test_full_audio_cannot_hide_a_short_video_track(self):
        with tempfile.TemporaryDirectory() as td:
            output = Path(td)/'short-picture.mp4'
            subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                            '-f', 'lavfi', '-i', 'color=c=teal:s=1080x1920:r=30:d=1',
                            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
                            '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', '-movflags', '+faststart', str(output)], check=True)
            report = verify_delivery(output, expected_duration=2, tolerance=.1)
            self.assertTrue(report['checks']['duration'])
            self.assertFalse(report['checks']['video_duration'])
            self.assertFalse(report['ok'])
    def test_stills_audio_captions_delivery_and_resume(self):
        with tempfile.TemporaryDirectory(prefix="wec path's [test], ") as td:
            root=Path(td)
            for name,color in (('one','purple'),('two','orange')):
                Image.new('RGB',(256,384),color).save(root/(name+'.png'))
            audio=root/'mix.wav'
            subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=2',str(audio)],check=True)
            plan={'duration':2,'scenes':[
                {'id':'one','start':0,'duration':1,'image':'one.png','narration':'The lantern rose.'},
                {'id':'two','start':1,'duration':1,'image':'two.png','narration':'It lit the sky.'}]}
            source=root/'plan.json';source.write_text(json.dumps(plan))
            report=run_production(source,root/'job',audio=audio)
            self.assertTrue(report['ok'],report)
            self.assertEqual(report['mode'],'stills')
            self.assertTrue(all(report['report']['checks'].values()))
            final=Path(report['video']);before=final.stat().st_mtime_ns
            resumed=run_production(source,root/'job',audio=audio)
            self.assertTrue(resumed['ok']);self.assertEqual(final.stat().st_mtime_ns,before)
            manifest=root/'clips.json';manifest.write_text(json.dumps({'scenes':[{'video':'job/final.mp4','duration':3}]}))
            output=render_clips(manifest,root/'clips.mp4')
            delivery=verify_delivery(output,expected_duration=3,require_audio=False)
            self.assertTrue(delivery['ok'],delivery)

    def test_failed_assembly_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);Image.new('RGB',(256,256)).save(root/'source.png')
            manifest=root/'manifest.json';manifest.write_text(json.dumps({'scenes':[{'image':'source.png','duration':1}]}))
            target=root/'out.mp4';target.write_bytes(b'previous successful output')
            with patch('wec_engine.video.subprocess.run',side_effect=subprocess.CalledProcessError(1,'ffmpeg')):
                with self.assertRaises(subprocess.CalledProcessError):render_stills(manifest,target)
            self.assertEqual(target.read_bytes(),b'previous successful output')
            self.assertFalse((root/'out.partial.mp4').exists())
