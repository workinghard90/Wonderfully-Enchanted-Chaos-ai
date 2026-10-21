# From a studio backup to a narrated movie

`wec export-backup` produces a 1080 × 1920, 30 fps H.264/AAC MP4 from a
version 2 studio backup. Each scene must have its own attached image. It runs
on your computer or a separate rendering machine; **the hosted dashboard has
no video-render button yet**. The free Render planning service does not gain
FFmpeg, voice weights or background jobs from this change.

The exporter uses local Piper narration, gentle camera movement, and burned-in
captions timed to each measured narration clip. It preserves the complete image
over a blurred background. This is a movie assembled from still pictures, not
AI character animation. Caption intervals follow each recorded utterance;
individual words are not force-aligned. Quiet procedural ambience and chimes
are optional and use no sampled music.

## Windows

Install Python 3.10+, FFmpeg (including FFprobe and the subtitles/libass filter),
then run from the repository folder:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[narration]"
.\.venv\Scripts\python.exe -m pip check
New-Item -ItemType Directory -Force voices
.\.venv\Scripts\python.exe -m piper.download_voices en_US-ljspeech-high --data-dir voices
.\.venv\Scripts\wec.exe export-backup "C:\Users\Autumn\Downloads\wec-projects-backup.json" "output\lantern.mp4" --voice-model "voices\en_US-ljspeech-high.onnx" --ambience
```

The voice-download command is an **explicit** network operation. The exporter
itself never downloads models, sends a story to a service, or calls a paid API.
Review the model card for any voice you choose. The example voice is the Piper
LJ Speech high model, whose model card identifies its dataset as public domain:
<https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/high/MODEL_CARD>.
Piper software is distributed under GPLv3. No voice weights are bundled in this
repository or its Docker image.

On Linux/macOS use `.venv/bin/python` and `.venv/bin/wec` instead. Install FFmpeg
through your operating system's trusted package manager.

## Files, limits and recovery

- Download a fresh studio backup after attaching all pictures. Keep that JSON
  backup: the movie does not replace the editable project.
- For several projects, explicitly select `--project-index 0`, `1`, etc. The
  default accepts a backup with exactly one project.
- Export supports up to 300 seconds, 30 scenes and the studio's 40 MiB backup
  limit. Every scene needs narration and an image. Missing images stop the job.
- Existing output files and workdirs are never deliberately replaced. Choose
  a new output name for another export. `--workdir` can choose a new directory.
- The default `lantern-work/` beside `lantern.mp4` retains the extracted images,
  source plan, voice recordings, mix, SRT/ASS captions, per-scene clips, final
  MP4 and `verification.json`. A failed export leaves these for diagnosis;
  another run needs a fresh workdir. There is no automatic resume yet.
- Speech is fitted into its scene without cutting words. If more than a 35%
  speed increase would be required, export stops and asks for longer scenes or
  less narration. It does not silently discard text.
- The final file is published only after checking duration, dimensions,
  H.264/yuv420p, AAC audio, faststart and the 20 MB delivery limit.

For an iPhone-only workflow, keep creating images and downloading backups in
the studio. The first video can be rendered outside the free web service and
returned as a downloadable MP4. Hosting a reliable render queue and durable
movie storage is a separate deployment task; do not expose a local generation
service or add paid infrastructure to enable this command.

## Validation

The initial end-to-end run produced a 35.0-second 1080 × 1920 H.264/yuv420p
movie with 44.1 kHz stereo AAC, burned-in captions, seven scene images and
actual local Piper narration using `en_US-ljspeech-high`. All delivery checks
passed. Seven extracted scene frames were reviewed; the source project was
preserved. Some original test artwork does not match the story and some image
generation output contains unwanted lettering, so this first movie is a
technical preview rather than a finished art pass.

Automated tests use synthetic images/audio and mocked speech synthesis. They
cover backup validation, missing images, explicit project selection, unsafe
scene IDs, output preservation, caption markup, overlong narration and a real
FFmpeg MP4. CI does not download voices or make paid inference requests.
