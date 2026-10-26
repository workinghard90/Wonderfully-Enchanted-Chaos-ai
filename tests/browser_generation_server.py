"""Local browser-only fixture. Synthetic image; no live AI or network provider."""
import io
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from wec_engine.providers.cloudflare_images import GenerationError
from wec_engine.studio import create_handler


class SyntheticProvider:
    def ready(self): return True
    def setup_message(self): return "Synthetic Cloudflare fixture configured."
    def generate(self, prompt):
        if prompt == 'simulate provider failure':
            raise GenerationError('Simulated provider failure', 503)
        output = io.BytesIO(); Image.new('RGB', (512, 512), 'gold').save(output, format='JPEG')
        return output.getvalue()


if __name__ == '__main__':
    port, directory, token = int(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    with patch('wec_engine.studio.CloudflareImages', SyntheticProvider):
        handler = create_handler(directory/'studio.sqlite3', directory, token=token)
    server = ThreadingHTTPServer(('127.0.0.1', port), handler)
    try: server.serve_forever()
    finally: server.server_close()
