# Wonderfully Enchanted Chaos AI

A local-first creative studio for planning stories and assembling vertical videos.
The responsive dashboard saves stories, previews deterministic scene plans and
production dry-runs, and exports project backups. The CLI handles existing media
and opt-in ComfyUI integration. **Live AI generation has not been validated.**

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
story-planning dashboard. The Docker image intentionally includes no GPU stack,
FFmpeg, or voice models.

## What works and what needs setup

| Capability | Status |
| --- | --- |
| Create, edit, list and back up stories | Implemented; HTTP integration tests |
| Scene planning and production dry-run | Implemented; offline deterministic word segmentation, no LLM |
| Silent still/clip assembly, audio mux and burned-in captions | Implemented; FFmpeg smoke tests with synthetic media |
| Production checkpoints and delivery verification | Implemented; use a fresh workdir when source media/audio changes |
| ComfyUI images and video | Adapter code and mocked tests; requires compatible workflows, nodes, models and worker |
| Character references | Metadata plus explicit reference upload/binding; no guarantee of visual consistency |
| Piper narration | Optional adapter; binary and licensed voice model required; not live tested |
| Cloud image fallback | Custom gateway contract; explicit CLI opt-in only; not live tested |
| Cloud video, web rendering jobs, accounts, automatic sync/backup restore | Not implemented |

Caption times are estimated from scene times, **not aligned to recorded speech**.
Music/SFX must be supplied as a completed audio mix. The dashboard never submits
generation jobs. No paid service calls are made by the test suite.

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
[generation setup](docs/GENERATION.md). Never commit secrets or model weights.

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
```

Set `PYTHON` to the installed Python executable if `python` is outside your
virtual environment. CI covers Windows/Linux Python 3.10, 3.12 and 3.13,
Linux media rendering, and Chromium dashboard checks. Its results are separate
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
