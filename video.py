"""Assemble still-image scenes into a silent vertical video; audio/captions remain external."""
import json
import shutil
import subprocess
from pathlib import Path

def render_stills(manifest_path, output_path, *, fps=30):
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg executable not found")
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    scenes = manifest["scenes"]
    if not scenes:
        raise ValueError("No scenes")
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    args = ["ffmpeg", "-y"]
    for scene in scenes:
        duration = float(scene["duration"])
        if duration <= 0:
            raise ValueError("Scene duration must be positive")
        path = Path(scene["image"])
        if not path.is_file():
            raise FileNotFoundError(path)
        args += ["-loop", "1", "-framerate", str(fps), "-t", str(duration), "-i", str(path)]
    filters = []
    for i, scene in enumerate(scenes):
        frames = max(1, round(float(scene["duration"]) * fps))
        filters.append(f"[{i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps={fps},trim=end_frame={frames},setpts=PTS-STARTPTS,format=yuv420p[v{i}]")
    filters.append("".join(f"[v{i}]" for i in range(len(scenes))) + f"concat=n={len(scenes)}:v=1:a=0[outv]")
    args += ["-filter_complex", ";".join(filters), "-map", "[outv]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
    subprocess.run(args, check=True)
    return output

def probe(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)
