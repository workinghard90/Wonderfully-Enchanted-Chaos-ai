# Wonderfully Enchanted Chaos AI

A local-first creative studio for planning stories and assembling vertical videos.
The responsive dashboard saves stories, accepts scene-image uploads, previews
deterministic scene plans and production dry-runs, and exports/restores portable
project backups with images. The CLI handles existing media and opt-in ComfyUI
integration. An optional Cloudflare adapter adds one-scene image generation to
the dashboard after owner setup. A live FLUX image request has been verified
through the hosted studio API. The offline `export-backup` command turns a
complete image backup into a narrated vertical MP4.

## Start the studio on Windows

Requires Python 3.10 or newer. Run from the folder containing `pyproject.toml`:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\wec-studio.exe
```

Open **http://127.0.0.1:8765**. Activation is optional; the commands above avoid
PowerShell execution-policy problems. Stop with Ctrl+C. Projects persist in
`~/.wec-studio/studio.sqlite3`. See [Windows setup](docs/WINDOWS.md).

On Linux/macOS:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/wec-studio
```

No Node build or separate frontend server is needed. The backend serves the
frontend and `/api/*` together. FFmpeg and AI models are unnecessary for the
story-planning dashboard. The Docker image includes CPU video tools and a
checksum-pinned Piper voice; web rendering stays off until enabled by the owner.
It includes no GPU stack.

## Coloring books

Open **Coloring Book Studio** from the dashboard, or visit `/coloring/` on the
same server. Add finished PNG/JPG/WebP artwork, reorder pages, download an
original-artwork ZIP and print a Letter-size PDF with optional blank backs.
Print-readiness checks flag page-count, margin and image-resolution issues;
download the check report before reviewing the final PDF.
The browser automatically saves one book and reopens it after refresh. Open a
WEC artwork ZIP to recover a book or move it between devices; keep ZIPs and originals
because browser storage can be cleared. It uses no generation credits and is separate from story
backups. On iPhone use the hosted page in Safari. See the
[coloring workflow and prototype limits](docs/COLORING_STUDIO.md).

## What works and what needs setup

| Capability | Status |
| --- | --- |
| Coloring book assembly | Browser device save/reopen, portable WEC ZIP import/export, ordering and print layout; not KDP-certified |
| Create, edit, list and back up stories | Implemented; HTTP integration tests |
| Upload/replace/remove scene images | Implemented; authenticated JPEG/PNG/WebP uploads and browser previews |
| Restore project backups with images | Implemented; version 1 text and version 2 image backups restore as new copies |
| Automatic device copy and empty-server recovery | Saved stories/pictures in this browser, visible timestamp, explicit recovery; browser storage is best effort. [Recovery guide](docs/DEVICE_RECOVERY.md) |
| Cloudflare scene images from the dashboard | Implemented behind opt-in; mocked provider/browser tests and a successful live FLUX request. Account setup required |
| Scene planning and production dry-run | Implemented; offline deterministic word segmentation, no LLM |
| Silent still/clip assembly, audio mux and burned-in captions | Implemented; FFmpeg smoke tests with synthetic media |
| Production checkpoints and delivery verification | Implemented; use a fresh workdir when source media/audio changes |
| ComfyUI images and video | Adapter code and mocked tests; requires compatible workflows, nodes, models and worker |
| Character references | Metadata plus explicit reference upload/binding; no guarantee of visual consistency |
| Narrated movie from a studio backup | Offline `export-backup`; all scene images, local Piper voice and FFmpeg required |
| Dashboard movie render/play/download | Opt-in CPU job with progress/cancel and authenticated MP4 downloads; bounded free-host test configuration |
| Faster captioned movie assembly | One encode per scene, final video stream copy; 3.80× faster in one matched local cached-audio comparison, not a hosted speed guarantee. [Evidence](docs/VIDEO_PERFORMANCE.md) |
| Piper narration | Live CPU smoke test with LJ Speech high; optional `[narration]` installation and separately supplied voice model |
| Cloud image fallback | Custom gateway contract; explicit CLI opt-in only; not live tested |
| AI character-animation service, accounts, scheduled server backups and cross-device sync | Not implemented |

The legacy `captions` command estimates caption times from scene times.
`export-backup` times each caption to its measured narration clip; it does not
perform word-level forced alignment. See the
[narrated movie guide](docs/NARRATED_VIDEO.md).
The legacy production pipeline needs a supplied audio mix; the backup and web
exporters can add quiet procedural ambience. Dashboard image generation
is off by default; optional Cloudflare setup permits one image per confirmed
click. No paid service calls are made by the test suite. Uploaded
images can be rendered into narrated movies after optional video setup. See
[dashboard video setup](docs/DASHBOARD_VIDEO.md) and the
[scene images and recovery guide](docs/SCENE_IMAGES.md) for the iPhone workflow,
file limits and backup compatibility.

## Offline story workflow

Use `wec` from the installed environment (Windows: `.venv\Scripts\wec.exe`):

```bash
wec plan-story examples/lantern-story.txt output/lantern-plan.json --duration 35 --scenes 7
wec produce output/lantern-plan.json output/lantern-job --dry-run
wec captions output/lantern-plan.json output/lantern.srt
wec doctor
```

Review the plan and supply real scene images or clips before producing. Media and
`comfy_workflow`/`animation_workflow` paths inside a manifest are relative to that
manifest, not the shell's working directory. Examples reference assets you must
create; bundled media/workflows/models are not provided.

```bash
# After supplying the images in examples/phase5-plan.json and a completed audio mix:
wec produce examples/phase5-plan.json output/lantern-job --audio assets/audio/final-mix.wav
wec verify-delivery output/lantern-job/final.mp4 --duration 35
# Explicitly permit a silent preview only:
wec produce examples/phase5-plan.json output/silent-job --allow-silent
```

The controller prefers a complete set of clips, otherwise a complete set of
stills. It does not mix missing media or invent assets. Changed plans or render
options are rejected in an existing workdir. Changes to source media/audio at the
same path are not fingerprinted: use a new workdir. Run only one production
process per workdir. `produce` and `verify-delivery` exit nonzero when verification
fails. Finalization trims to the shorter audio/video input; verify duration.

## Configure and generate deliberately

`.env.example` documents settings. **The app does not automatically read `.env`.**
Export environment variables in your shell or configure them on the host.
See [configuration and API](docs/CONFIGURATION.md) and
[generation setup](docs/GENERATION.md). For the hosted one-scene image test, see
[Cloudflare setup](docs/CLOUDFLARE_IMAGES.md). Never commit secrets or model weights.

## iPhone and online access

Both devices must reach the same backend. A phone's `127.0.0.1` is the phone,
not the Windows PC. Remote binding requires a 32+ character `WEC_STUDIO_TOKEN`.
Use a private VPN or an authenticated HTTPS reverse proxy; keep ComfyUI private
and never forward its port to the public Internet. A Windows-hosted studio stops
being reachable when the PC is off.

[Deployment instructions](docs/DEPLOYMENT.md) cover the optional Docker/Render
planning dashboard, persistent SQLite storage, backups, and separate static
frontend configuration. Hosting can incur charges. **Nothing is deployed by this
repository integration.** Public deployment and paid services require approval.

## Development and verification

```bash
python -m pip install -e .
python -m pip check
python -m unittest discover -s tests -v
```

Media smoke tests use synthetic images and a sine-wave audio track; they skip
when FFmpeg/FFprobe is absent. They are not AI generation tests. Optional browser
checks require Node and Playwright:

```bash
npm install --no-save playwright@1.62.1
npx playwright install chromium
node tests/browser_smoke.cjs
node tests/browser_generation.cjs
node tests/browser_video.cjs
```

Set `PYTHON` to the installed Python executable if `python` is outside your
virtual environment. CI covers Windows/Linux Python 3.10, 3.12 and 3.13,
Linux media rendering, Chromium dashboard checks and a container voice check. Its results are separate
from local verification; see [integration report](docs/INTEGRATION_REPORT.md).

## Repository layout

- `wec_engine/`: Python backend, CLI and production modules.
- `wec_engine/providers/`: local ComfyUI and custom cloud image adapters.
- `wec_engine/studio_web/`: packaged HTML/CSS/JavaScript dashboard.
- `examples/`: story, scene, character, binding and media manifest templates.
- `tests/`: offline, HTTP, mocked provider, media and browser tests.
- `docs/`: setup, deployment, configuration and phase provenance.

The original Phase 1 commit remains in Git history. Available cumulative archives
were compared rather than copied into duplicate phase directories. Phase 4's
standalone upload was unavailable; later archives contain its labeled modules.
See [phase provenance](docs/PHASE_PROVENANCE.md).
