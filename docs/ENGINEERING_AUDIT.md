# WEC unified creative studio: audit and engineering roadmap

Audit baseline: `d5b35ae8bdcad619bbcefa2844c3113d92935594`, including merged PR #15 and the high-resolution artwork work formerly in PR #14. Repository inspection covered backend/CLI modules, providers, browser workspaces and stores, tests, examples, packaging, CI and deployment configuration. This is a source and local-test audit, not certification of every model or production output.

## Current capabilities

| System | Implemented | Remaining gaps |
| --- | --- | --- |
| Faceless video | Optional Cloudflare script drafting; deterministic scene splitting; uploads and one-image generation; handoff to saved server projects; Piper narration; measured utterance captions; procedural ambience/chimes; 1080×1920 H.264/AAC MP4; progress/cancel/download | No complete automatic idea-to-video job; caption timing is not word alignment; no production-tested model animation; only 35 seconds/7 scenes/100 words in the web renderer; two daily attempts and three retained jobs |
| Artwork | Original-byte browser projects and ZIPs; Cloudflare generation; reusable character/style descriptions; optional local ComfyUI CLI for generation/reference editing/upscaling with explicit workflows and pixel checks | No shared original asset registry, version history or image-reference conditioning in the Cloudflare UI; no standalone visual editor; live high-resolution model quality unverified |
| Storybooks | Optional page drafts; editable page text/pictures; embedded-font Letter PDF; text overflow checks; premium-color-white wrap cover template; backups | No configurable trim/bleed/layout engine, spread editor or illustration consistency guarantee; no automated final PDF visual approval; front matter is fixed |
| Coloring books | Original artwork import/order/ZIP; new grayscale Letter interior with blank backs and opening pages; cover template; legacy browser-print workspace; PPI guidance | Grayscale is not line-art conversion; no SVG import/export or vectorization; no duplicate detection; no generic KDP certification |
| Cross-format work | Separate variants reuse text/prompts/descriptions; appropriate pictures reused; colored images omitted from coloring variants; transactional video handoff | No durable workflow graph or reusable approval stages; copies have no lineage tracking; no single canonical asset library |

Primary evidence: `creative.py`, `studio_web/creative/{app.js,store.js}`, `providers/cloudflare_text.py`, `artwork.py`, `studio_video.py`, `backup_video.py`, `studio_store.py` and their tests. The new `/studio/` workspace materially supersedes an audit of the earlier two-workspace release.

## Shared infrastructure and constraints

- Standard-library threaded HTTP server serves same-origin HTML/JS/CSS and authenticated APIs. SQLite holds legacy story projects, normalized scene JPEGs and usage counters. Creative projects and profiles live in browser IndexedDB, not that database.
- Three stores remain: legacy server stories, legacy device coloring book, and the new multi-project creative browser store. Their backups are different formats. Browser saves are not cross-device synchronization or durable off-device backups.
- Creative originals are retained; legacy story ingestion converts to JPEG with a 2048-pixel maximum edge. Preserve originals separately when handing off a print project to video.
- Creative project limits: 80 pages, 10 MiB/12 MP per image, 30 MiB/320 MP total. Legacy coloring import remains capped at 100 MP. Large high-resolution ZIPs therefore cannot necessarily round-trip through the older importer.
- Cloudflare image calls share 20 attempts per UTC day; text drafts have five. Attempts include failures. These counters are not actual dollar budgets. CLI cloud routing is separate and uses an operator-supplied estimate.
- Image generation and PDF exports are synchronous and share a media-operation lock. A large export delays other media work. Video jobs run in subprocesses with an OS lease, resource bounds and restart recovery; interruption requires a new render rather than stage resume.
- The CLI orchestrator checkpoints plan/options but does not hash source media/audio at the same path. Reusing a work directory after changing those files can reuse stale output. Continue using a fresh work directory until content fingerprints are implemented.
- One shared access token supports an owner-operated studio, not separate customer accounts. New device projects are not scoped to that token. Do not present current storage as multi-user isolation.
- Docker includes CPU FFmpeg and a pinned Piper voice. `render.yaml` declares a Starter instance and a persistent disk; this does not establish the configuration of the separately named free-test deployment. No GPU worker is bundled.
- CI includes Python on Windows/Linux, media rendering, browser checks and container voice/export checks. Prior recorded CI results are not substituted for checks on this change.

## Production observation

During this audit the public health endpoint returned 200. The live `/` and `/app.js` bytes matched the pre-update `2b1190f` version, rather than latest main. `/studio/` and `/studio/app.js` returned 401, whereas latest source serves those static routes publicly. The observations indicate the latest workspace was not being served at that time; they do not identify the deployed commit conclusively. No deployment was triggered.

Render's connector reported no selected workspace. Internal service settings, live flags, resource metrics and deployed SHA were therefore not inspected. Confirm the intended workspace before account-level inspection. No secrets were retrieved or inferred.

## First implemented improvement: reliable video handoff

The creative editor could retain earlier scene text after the user edited its main narration or scene count, then create a server movie project from that earlier text. Planning and AI draft validation could also accept scripts rejected later by the bounded renderer.

This change:

1. Checks current narration/count against attached scenes in the browser and API. Whitespace-only changes remain valid. Older API callers supplying only page text remain supported.
2. Rejects mismatches before image decoding or writing a server project. The browser keeps existing pictures and asks the user to split/review the changed narration.
3. Shares narration limits across creative planning, generated draft validation and video job admission. Overlong scripts are caught earlier and no automatic provider retry is introduced.
4. Adjusts AI instructions for short scene counts; a one-scene draft is no longer instructed to produce 50–80 words despite a 25-word scene limit.
5. Adds HTTP, storage, boundary and phone/desktop browser regressions.

These structural checks cannot guarantee speech fits the requested duration. Measured narration verification remains necessary during rendering.

## Prioritized roadmap

| Order | Increment | Completion evidence |
| --- | --- | --- |
| P0 — this change | Prevent stale narration and inconsistent render admission | Changed narration/count rejected without a server copy; images retained; valid handoff works; existing tests pass |
| P0 — release | Verify approved commit and backup recovery on intended Render service | Confirm actual plan/disk/flags and live SHA; `/studio/` loads on phone/desktop; restore a fixture and export once; publish only after owner approval |
| P1 — protect work | Shared asset catalog and versioned project manifests | Original bytes stored once under content hashes; immutable versions and lineage; thumbnails separate from print originals; transactional project references; export/restore verifies checksums |
| P1 — recovery | Durable backups and explicit storage status | Off-device export/recovery round-trip for all formats, including character settings and original assets; clear ephemeral/persistent status; no silent overwrite on conflict or quota failure |
| P1 — jobs | Shared persisted job records for generation/export | State transitions, stage inputs/output hashes, provider request IDs, progress, cancellation and interrupted recovery; failed stages resumed without duplicate billable submissions |
| P2 — videos | Coordinated script → reviewed storyboard → images → narration → MP4 | One approved workflow produces a playable movie; failed-stage retry keeps successful assets; verify duration, streams, faststart, bytes, captions and sampled frames; track per-job cost/attempts |
| P2 — artwork | Reference profiles and provider capability routing | Saved reference images/style presets; explicit capability checks for edit/upscale/reference requests; preserve prompts/model/seed where supported; reviewed character consistency across a small scene set |
| P3 — publishing | Configurable book layout, duplicate checks and SVG conversion | Trim/bleed/paper profiles; exact duplicates by hash and reviewable near-duplicate candidates; optional isolated vector conversion; inspect rendered PDFs for clipping, page count, grayscale, PPI and cover dimensions |
| P3 — workflows | Reusable cross-format templates | A storybook can create a coloring variant and a promotional video with shared assets, recorded transformations and separate approval checkpoints; no silent reuse of incompatible art |
| P4 — scale | Performance and operating-cost controls | Measure peak memory/time on target host; stream large exports; configurable bounded concurrency and real usage ledger; add a worker or paid capacity only after evidence and approval |

## Architecture direction

Keep one application and evolve its existing modules. Introduce small shared services for projects/assets, provider capabilities, jobs and output validation. Studio-specific screens remain thin clients of those services. Avoid a framework rewrite or four independent backends.

Use immutable asset IDs and project revisions in job inputs. Record provider/model/prompt provenance, parent asset, intended use and human approval separately from generation success. Derivative JPEG video assets must point back to original PNG/WebP assets. A successful technical export is not publishing approval.

Start with SQLite metadata and a storage abstraction usable with the existing single-server deployment. Evaluate durable storage based on actual hosting configuration before selecting a paid service. Do not add Redis, a new database, GPU hosting or another subscription merely to make the architecture more elaborate. Background work must be recoverable from records, not just browser polling or process memory.

## Validation and limits

The updated main baseline passed 127 Python tests after installing declared dependencies. The first reliability change passed all 131 Python tests, including four new tests and existing real FFmpeg synthetic-media tests. Provider requests are mocked; no paid inference was performed. PNG preservation, PDF structure/page geometry and audio/MP4 behavior are covered by the existing suites. SVG output is not implemented and cannot be reported as verified.

Browser results are recorded in the accompanying PR. Local browser installation initially failed because downloaded archives were invalid; this is an environment issue, not a passed browser check. No live Piper/model quality benchmark or new container build is claimed. Nothing in this audit certifies KDP acceptance or creative quality.
