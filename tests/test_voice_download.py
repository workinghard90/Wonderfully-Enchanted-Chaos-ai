import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from wec_engine.download_voice import download


class Response:
    def __init__(self, raw, start=0):
        self.raw=raw; self.status_code=206; self.headers={'Content-Range':f'bytes {start}-{start+len(raw)-1}/8'}
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def raise_for_status(self): pass
    def iter_content(self,_): yield self.raw


class VoiceDownloadTests(unittest.TestCase):
    def test_resume_and_checksum_before_publish(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); (root/'voice.partial').write_bytes(b'part')
            files={'voice':(8,hashlib.sha256(b'partdone').hexdigest())}
            with patch('wec_engine.download_voice.FILES',files), patch('wec_engine.download_voice.requests.get',return_value=Response(b'done',4)) as get:
                download(root)
            self.assertEqual((root/'voice').read_bytes(),b'partdone')
            self.assertEqual(get.call_args.kwargs['headers']['Range'],'bytes=4-')

    def test_bad_checksum_is_never_installed(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);files={'voice':(4,hashlib.sha256(b'good').hexdigest())}
            with patch('wec_engine.download_voice.FILES',files), patch('wec_engine.download_voice.requests.get',return_value=Response(b'evil')):
                with self.assertRaisesRegex(RuntimeError,'checksum'):
                    download(root)
            self.assertFalse((root/'voice').exists())
