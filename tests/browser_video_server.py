"""Browser fixture with real HTTP/jobs and a tiny synthetic FFmpeg worker."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
from unittest.mock import patch

from wec_engine.studio import create_handler
from wec_engine.studio_video import VideoJobs

if __name__ == '__main__':
    port, directory, token = int(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    jobs = VideoJobs(directory/'video-jobs', enabled=True,
                     worker_command=[sys.executable, str(Path(__file__).with_name('video_fixture_worker.py'))])
    with patch.object(jobs, 'ready', return_value=True):
        server = ThreadingHTTPServer(('127.0.0.1', port), create_handler(directory/'studio.sqlite3', directory, token=token, video_jobs=jobs))
        try:
            server.serve_forever()
        finally:
            jobs.close(); server.server_close()
