# WEC — Full application acceptance plan

> Status: November 5, 2026. This is a release acceptance specification, not a claim that all functions are production-certified. Production stays on the last approved Render release until CI, code review and owner approval permit deployment.

## Goal

One mobile-friendly studio for creating and safely recovering artwork, printable books, faceless videos and private Cozy publishing packages. All supported steps need real execution, observable outcomes, explicit consent for spending and export, and a testable recovery path.

## Current verified implementation baseline

- Four URL-addressable pages: Create, Library, Studio, Renders. Five creative workspace steps inside Studio.
- Browser-saved projects with version checks, portable backup/recovery packages and optional authenticated online snapshots. Browser local storage is **not** cross-device synchronization.
- Artwork upload, review selections and original ZIP; coloring/storybook draft, layout and PDF handlers; faceless still-image narration/caption render and retained server job controls.
- Opt-in AI drafting/image requests when the configured providers and owner credentials are available. **Do not assume** provider billing, matching or actual output quality from synthetic tests.
- Private WEC → Cozy package handoff only; no automatic store or KDP publishing.
- PR #72 adds a bounded two-step real local automation (save, then production inventory) with verification and a failure stop. It does **not** make the studio an unattended job runner.

## Required completion gates, in dependency order

### A. Durable orchestration (next implementation)

- Store a minimal per-project automation job manifest with schema version, project ID, source revision/checksum, steps, timestamps and terminal state.
- Pending/running/waiting-for-approval/succeeded/failed/interrupted must be explicit and recoverable on reload and server restart, without falsely claiming a lost operation succeeded.
- A task can be retried only through a user action; idempotency and source-revision checks prevent duplicate pages, renders or billing calls.
- Cancellation and failures must leave original assets and existing project exports intact.
- Job history must not contain secrets or original images/narration.

### B. Approved operations with limits

- Connect existing draft, image, render and export handlers as separate, typed steps.
- Show input/provider/cost/slot limits before any billable operation; require an explicit owner approval, especially for AI images, rendering, external handoff or publishing.
- Never infer an artwork approval or print-readiness result from a successful generation request.
- Reject format mismatches and incomplete assets, and permit safe human edits between steps.

### C. End-to-end functional tests

- Art: create → save → attach or generate one image with explicit consent → review → original-artwork ZIP → separate backup restore → checksum comparison.
- Coloring and storybooks: plan → create → attach approved art → validate print geometry/PPI/margins → download PDF → inspect real output → backup recovery.
- Faceless video: script → scene split → images → voice/captions → render (one owner-confirmed job) → verify downloadable playable MP4/package → review.
- Cozy: prepare an approved-only private proposal ZIP; validate importer without auto-publishing and without bypassing Cozy ownership checks.
- Exercise cancel/timeout/restart/duplicate request/insufficient disk/failed backup/device storage quota/unauthorized token.

### D. Production readiness

- Run manual public-only release smoke check against the **exact deployed SHA**; source mismatch must block.
- Run authenticated read-only readiness with owner's token in their environment, not in CI or chat.
- Verify available persistent-disk headroom, snapshot counts/limits, retained projects and recoverable backup artifacts. Never delete owner work to make a check pass.
- Complete a controlled restore into a **separate** test project, not an original.
- Inspect at least one real finished file per format (including playback and audio timing for video, print geometry for PDFs).
- Keep rollback deployment, manual Render deploys and existing disk; no additional infrastructure spending or automatic publishing without explicit owner direction.

## Completion definition

**Full application** means every claimed workflow passes its functional and failure tests; owner-private capabilities pass live acceptance; no stage reports success from a click alone; the generated files are actually usable; and recovery is demonstrably safe. Any unavailable provider, untested paid action or owner-only acceptance step remains clearly marked pending.

This plan intentionally separates automated test evidence from human review and private owner checks.
