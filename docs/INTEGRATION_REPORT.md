# Integration report

Verified October 20, 2026. Base: `main` at
`c1eea9a95e5c17af935a6f1d18e734d72dd13426`.
Integration branch: `integration/phases-1-10`. Original history is retained.
No merge, public deployment, original-branch deletion or paid API call was made.

## Sources and scope

Inspected the original repository (one Phase 1 commit) and every file in the
available Phase 2, 3, 5, 6, 7, 8, 9 and 10 archives. These are cumulative snapshots;
Phase 10 includes all paths from earlier available archives. Reconciled by file
hash, selected the later revisions and repaired the resulting integrated package.
Phase 1 was read from GitHub; no separate Phase 1 ZIP was supplied. The standalone
Phase 4 attachment failed to materialize and was not inspected. Phase 4-labeled
production/finishing capabilities are present in subsequent archives. Independent
comparison requires the failed archive to be uploaded again. See
[provenance and source hashes](PHASE_PROVENANCE.md).

## Changes

- Reorganized flat Phase 1 sources into `wec_engine/`, `providers/`, `tests/`
  and `examples/`; incorporated later modules and the packaged dashboard.
- Removed five tracked Python cache files; added ignore rules for secrets,
  virtual environments, SQLite data, model weights and generated media.
- Added package metadata/version 0.2.0, line-ending rules, Docker/Render planning
  configuration and Windows/Linux test workflows.
- Fixed manifest-relative paths, missing image-output directories, reference
  upload subfolders, ComfyUI URL configuration and non-finite cloud estimates.
- Made scene assembly atomic, protected completed output on failure, used unique
  temporary output names and made caption filtering independent of special path
  characters/Windows drive delimiters. Limited encoder threads by configuration.
- Added finite/timeline validation, rejected changed rendering options on resume
  and made verification failure visible through CLI exit status.
- Added dashboard New Project and unsaved-edit handling, stale-preview protection,
  bounded authentication retries, caught project-opening failures and relative
  static asset paths. Dry-runs no longer write project files.
- Tightened origin validation, request timeouts, remote-binding token length and explicit SQLite connection
  closure for Windows file access;
  retained the rule that the web API cannot submit generation jobs.
- Replaced the accumulated historical README with current setup/configuration,
  feature status, API and deployment docs. Preserved historical notes separately.

## Verification results

| Check | Result | Evidence and limits |
| --- | --- | --- |
| Python editable installation | PASS | Clean virtual environment, declared dependencies installed |
| Wheel build and installation | PASS | Version 0.2.0, installed in separate virtual environment; all four dashboard assets packaged |
| Dependency checks | PASS | `python -m pip check`, both environments |
| Python suite | PASS: 54 tests | `python -m unittest discover -s tests -v`, Linux Python 3.12.14 |
| Real media smoke tests | PASS: 2 tests included above | FFmpeg/FFprobe 6.1.1; two synthetic stills, 2-second sine audio, burned-in captions, production/resume and 3-second padded clip assembly |
| Delivery verification | PASS in media smoke | 1080×1920, H.264, yuv420p, AAC when required, duration, size, faststart |
| Provider protocols | PASS with mocks | ComfyUI submission/history/download, video bindings, custom cloud contract, reference upload and workflow resolution; no real model inference |
| Dashboard browser workflow | PASS | Chromium 153 at 390×844 and 1440×1000: save, plan, dry-run, backup, multiple projects, reload persistence, bounded bad-token prompt, no JS errors or horizontal overflow |
| Visual review | PASS | Phone/desktop screenshots inspected; no clipped controls or overflow |
| API routes and auth | PASS | Static assets, health, create/read/update/list, plan, dry-run, backup, missing records, invalid payloads, token protection and exact-origin CORS |
| CLI entry points/doctor | PASS | `wec --help`, `wec-studio --help`, `wec doctor`; exercised outside source directory using installed wheel |
| Source/JS checks | PASS | Python compilation, JS syntax, Git whitespace, tracked cache/environment-file and recognized secret-pattern scans |
| Windows and Safari | NOT locally tested | Windows instructions reviewed; Windows/Linux CI matrix supplied; Chromium mobile viewport is not an iPhone Safari device test |
| Container launch | NOT tested | No Docker runtime available here; image/template reviewed only |
| Public hosting/live AI | NOT performed | No public deployment, GPU worker, compatible exported workflows, model weights, voice model or cloud credentials supplied |

The browser package's default browser download failed; a separately packaged
Chromium binary was used successfully for local verification. Browser/runtime
dependencies and screenshots are not added to the repository. CI uses standard
Playwright installation. GitHub Actions results must be checked separately and
are not implied by the local results above.

## Confirmed behavior and remaining setup

The package installs; backend and bundled frontend start; authenticated project
workflows persist in SQLite; deterministic story planning and read-only dry-runs
work; backup exports include stories; local media assembly/finalization works
with supplied assets. These are operational foundations, not evidence of live
AI artwork, animation, narration quality or speech-aligned captions.

To generate AI media, configure a private ComfyUI worker, licensed models and
valid API-format image/video workflows. Image workflow prompts still require
explicit configuration inside that workflow. Piper needs its binary and voice
model. Cloud images need a custom compatible gateway and deliberate per-call
approval; there is no cumulative spending ledger. Music/SFX mixing, forced speech
alignment, cloud video, web job execution, multi-user accounts, automatic backup
restore and durable worker scheduling are not implemented.

Checkpoint fingerprints cover the plan and rendering options, not replacement
media/audio bytes at the same path. Use a new workdir after changing assets and
one process per workdir. SQLite is a single-instance store; a persistent volume
is necessary for hosting and is not a backup.

## Next steps toward an online dashboard

1. Review the PR and GitHub Actions, then decide whether to merge.
2. Re-upload the standalone Phase 4 ZIP for an independent comparison.
3. Select and approve hosting and its costs; use one HTTPS backend with durable
   SQLite storage, a strong secret and proxy-level access protections.
4. Test persistence across a service restart and backup/recovery on that host,
   then verify the same project from actual iPhone Safari and Windows browsers.
5. Separately connect a private generation worker and validate one image and
   one short clip before any complete story production or paid service use.

See [deployment](DEPLOYMENT.md), [Windows](WINDOWS.md),
[configuration/API](CONFIGURATION.md) and [generation setup](GENERATION.md).

## File inventory

The table records logical moves even when Git displays a heavily edited module as delete/add.

| Change | Path |
| --- | --- |
| Moved/updated | `__init__.py` → `wec_engine/__init__.py` |
| Moved/updated | `cli.py` → `wec_engine/cli.py` |
| Moved/updated | `cloud.py` → `wec_engine/providers/cloud.py` |
| Moved/updated | `comfy.py` → `wec_engine/providers/comfy.py` |
| Moved/updated | `router.py` → `wec_engine/router.py` |
| Moved/updated | `video.py` → `wec_engine/video.py` |
| Moved/updated | `test_router.py` → `tests/test_router.py` |
| Moved/updated | `scene.json` → `examples/scene.json` |
| Moved/updated | `video-manifest.json` → `examples/video-manifest.json` |
| Removed cache | `__init__.cpython-313.pyc` |
| Removed cache | `cloud.cpython-313.pyc` |
| Removed cache | `comfy.cpython-313.pyc` |
| Removed cache | `router.cpython-313.pyc` |
| Removed cache | `test_router.cpython-313.pyc` |
| Added | `.dockerignore` |
| Added | `.env.example` |
| Added | `.gitattributes` |
| Added | `.github/workflows/ci.yml` |
| Added | `.gitignore` |
| Added | `Dockerfile` |
| Added | `docs/CONFIGURATION.md` |
| Added | `docs/DEPLOYMENT.md` |
| Added | `docs/GENERATION.md` |
| Added | `docs/INTEGRATION_REPORT.md` |
| Added | `docs/PHASE_PROVENANCE.md` |
| Added | `docs/WINDOWS.md` |
| Added | `docs/archive/PHASE10_DEPLOY.md` |
| Added | `docs/archive/PHASE1_README.md` |
| Added | `examples/animated-video-manifest.json` |
| Added | `examples/animation-bindings.json` |
| Added | `examples/characters/lantern-keeper.json` |
| Added | `examples/lantern-story.txt` |
| Added | `examples/phase5-plan.json` |
| Added | `render.yaml` |
| Added | `tests/browser_smoke.cjs` |
| Added | `tests/test_animation.py` |
| Added | `tests/test_deployment.py` |
| Added | `tests/test_hybrid.py` |
| Added | `tests/test_integration.py` |
| Added | `tests/test_media_smoke.py` |
| Added | `tests/test_orchestrator.py` |
| Added | `tests/test_production.py` |
| Added | `tests/test_providers.py` |
| Added | `tests/test_readiness.py` |
| Added | `tests/test_regressions.py` |
| Added | `tests/test_story.py` |
| Added | `tests/test_studio.py` |
| Added | `wec_engine/animation.py` |
| Added | `wec_engine/characters.py` |
| Added | `wec_engine/deployment.py` |
| Added | `wec_engine/finishing.py` |
| Added | `wec_engine/integration.py` |
| Added | `wec_engine/motion.py` |
| Added | `wec_engine/orchestrator.py` |
| Added | `wec_engine/production.py` |
| Added | `wec_engine/providers/__init__.py` |
| Added | `wec_engine/readiness.py` |
| Added | `wec_engine/story.py` |
| Added | `wec_engine/studio.py` |
| Added | `wec_engine/studio_web/app.js` |
| Added | `wec_engine/studio_web/config.js` |
| Added | `wec_engine/studio_web/index.html` |
| Added | `wec_engine/studio_web/style.css` |
| Updated | `README.md` |
| Updated | `pyproject.toml` |
