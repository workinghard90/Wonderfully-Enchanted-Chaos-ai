# Narrated movies from the dashboard

The **Your movie** section renders a saved story from its already attached
pictures. It does not request new AI images, call Cloudflare, or charge a text
model. Narration runs locally with Piper, and FFmpeg assembles the MP4. This is
still-image assembly with gentle camera motion, not animated character video.

The exporter burns captions while encoding each scene, then joins those scenes
with `-c:v copy`. It no longer encodes the entire movie a second time at the
finishing stage. Resolution stays 1080 × 1920 at 30 fps, with CRF 22, AAC audio
and the same delivery checks. A `veryfast` encoder preset and one filter thread
reduce CPU work and memory use; compression is not pixel-identical to the older
two-encode output. See the [measured local comparison](VIDEO_PERFORMANCE.md).
This improves rendering and transfer time but does not make free-host storage
durable or guarantee completion before a host restart. Download finished movies.

## Phone workflow

1. Save the story and attach a picture to every scene.
2. Tap **Render video**, then confirm the saved version should be rendered.
3. Keep the page open and follow progress. Free hosting can take several
   minutes. One movie renders at a time; you may edit the project while its
   saved snapshot renders.
4. Tap **Play video** or **Download video** when ready.
5. Keep both the downloaded MP4 and the project JSON backup. JSON backups
   contain the story and pictures, **not completed movies**.

Reopening the page shows jobs that still exist on that server. **Cancel render**
stops the worker and its child processes. **Remove server copy** asks for
confirmation and removes only that job's files; saved projects/pictures remain.
Download a movie before removing its server copy.

In the unified studio's **Video renders** section, failed, cancelled and
interrupted attempts offer **Retry saved render**. After confirmation, this
starts a fresh attempt using that job's saved pictures, narration and ambience;
later edits to the project are excluded. The saved input checksum is checked
before reserving an attempt. Missing or damaged inputs require a new render
from a saved project. A retry starts from the beginning, counts toward the same
two attempts per UTC day, and needs one of the three retained-job slots.

The original attempt stays in the list. A repeated request for the same parent
returns its existing retained retry, including after a server restart or a lost
response, rather than creating another job. If that retry also fails, retry the
new failed attempt. Removing a server copy also removes its saved render inputs.
There is no automatic restart or reuse of partially encoded clips.

## Review a finished movie

The unified studio distinguishes a technically **ready** movie from one you
have reviewed. Play or download the finished MP4 and check its narration,
caption timing and pictures. Choose **Approve video** and confirm your review,
or choose **Needs changes**. **Clear review** returns it to Not reviewed.
Downloading is available in every review state so you can inspect it elsewhere.

The decision and timestamp are stored with that particular server render and
survive reopening the service when its data directory persists. Existing jobs
default to Not reviewed; a new render or retry starts without an approval.
Changing the editable project does not alter the already rendered movie or its
review. Removing the server copy removes that review too. This owner decision
does not publish a video, certify platform compliance or replace watching it.

## Enable on the existing service

The updated Dockerfile includes FFmpeg, fonts, Piper 1.8.0 and the
`en_US-ljspeech-high` voice. The voice and configuration are downloaded during
the explicit image build from a pinned repository revision and verified against
SHA-256 checksums. Startup and render requests never download a voice. The
voice's model card identifies its source dataset as public domain:
<https://huggingface.co/rhasspy/piper-voices/blob/5041a7a49ae5b3a0f30e6837769eb03fdbb231bd/en/en_US/ljspeech/high/MODEL_CARD>.
Piper is GPLv3 software; its source is available at
<https://github.com/OHF-Voice/piper1-gpl>. No API secrets enter Docker build args.

After merging and deploying this change, merge these runtime settings into the
existing service's environment; preserve the studio access token and existing
image-generation credentials:

```text
WEC_ENABLE_VIDEO_RENDER=1
WEC_PIPER_MODEL=/opt/wec-voices/en_US-ljspeech-high.onnx
```

The flag is **off by default**. A 32+ character studio access token is required
for video exports even on loopback. `GET /api/video` is authenticated and reports
readiness and job state. Local Windows setups can install `.[narration]`, FFmpeg
and the voice as described in [the offline movie guide](NARRATED_VIDEO.md), then
set `WEC_PIPER_MODEL` to the full `.onnx` path. `.env` is not loaded automatically.

Deploys on the free test service reset its local files. Download the current
project backup before deploying and restore it afterward if the project list
is empty. Do not apply the separate paid `render.yaml` template to enable this
feature. No extra Render worker, Redis, paid disk or paid model is required by
this implementation.

## Bounded test deployment

- At most **35 seconds and 7 scenes**, with an image and narration for every
  scene, and **100 words / 1000 characters** of story text. Longer scripts are
  rejected before loading a voice. Each scene is limited to 25 words and 200
  characters to bound individual speech requests. One shared CPU render at a time, with a
  20-minute hard timeout.
- **Two accepted attempts per UTC day**, including failed/cancelled jobs.
  Rejected incomplete projects do not reserve an attempt. This is a local CPU
  test limit, independent of the Cloudflare image allowance.
- At most **three saved jobs**. Download/remove an older one when full. No
  completed job is automatically deleted by this application.
- The output must pass existing 1080 × 1920 H.264/yuv420p, AAC, duration,
  faststart and 20 MB checks before becoming downloadable.
- Narration exits its own subprocess before video encoding starts, reducing
  simultaneous memory use. CPU narration uses one ONNX thread. A local
  seven-scene HTTP job was verified; that does not prove equivalent Render Free
  capacity. Confirm one live render after deployment before relying on it.
- Finished job state survives a process restart only when the data directory
  survives. Interrupted jobs are marked as interrupted, not automatically
  retried. A process-scoped OS file lease prevents overlapping jobs and handles
  containers reusing a PID after restart. Free Render storage disappears on restart/spin-down/redeploy; keep
  backups and movies on your device. This remains a test setup, not durable
  production video hosting.

All video start, status, cancel, remove and MP4/range-download routes require
the existing studio token. Playback uses a browser blob URL and credentials
stay in request headers. The shared token is a single-owner studio model,
not separate user accounts. Run one studio server process per data directory.
