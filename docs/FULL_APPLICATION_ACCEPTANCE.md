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

## Phase 10 — Server automation job plans (PR #74)

WEC now supports a **server-persisted, owner-authenticated automation plan ledger**
in SQLite alongside other WEC data on the configured WEC data volume.
Under Studio → Plan → **Server automation plans**, owners can explicitly
record, list and cancel an automation plan associated with a creative project.
The server API is `GET/POST /api/automation/jobs`,
`GET /api/automation/jobs/{id}`, and
`POST /api/automation/jobs/{id}/cancel` with the exact ID in the JSON body.

This release is deliberately **non-executing**. Plans are stored as
`awaiting_approval`. No server worker is started, no AI charges are incurred,
and creation is not permission to render, export, or publish. An explicit
idempotency key prevents duplicate plan records on retry; a reused key for a
different project is rejected. Strictly bounded input fields exclude title,
story text, images, tokens, and external destinations. Fifty records maximum
are retained without automatic deletion, and cancellation does not remove
work or projects. If a future executor leaves a record in `running`, server
initialization changes it to `interrupted`, never to completed; this phase
does not yet provide an executor.

**Remaining:** a server-side executor with version/checksum-based step
idempotency, durable output receipts, explicit approval per paid/irreversible
operation, bounded retries, restart-safe locks, and actual end-to-end
verification of printable PDF, image ZIP, finished MP4 and Cozy importer.
Until those exist, “record plan” must never be described as automated
generation or a working background job.

### Phase 11 — Immutable source lock for stored plans (PR #76)

A pending, owner-authenticated server plan may pin a **caller-declared**
project revision and SHA-256 using
`POST /api/automation/jobs/{id}/source` with JSON
`{"source_revision": 1, "source_sha256": "<64 lowercase hex characters>"}`.
This is an additive SQLite migration; existing records keep their IDs, keys and
states, and their source fields remain null until explicitly bound.

- A matching repeated request is idempotent. A changed revision/hash is
  rejected with 409 rather than silently replacing the source of a plan.
- Cancelled or interrupted plans cannot be newly bound; all owner-only routes
  still require authentication. No workers or provider calls are started.
- **Security limitation:** the hash is supplied by the caller. Server storage
  cannot inspect the browser's actual project bytes from this declaration.
  The future executor must retrieve a permitted project snapshot, verify its
  canonical digest and revision itself, and recheck before each step. A source
  lock is NOT an approval, an execution receipt or a completed output.
- This is a backend contract only. The Studio UI currently records plans
  without capturing a canonical project snapshot; browser-local data and
  source-lock readiness must not be conflated.

**Remaining:** verified snapshot capture and binding in the UI, typed executor
steps and durable receipts, explicit per-operation consent, retry semantics,
failure recovery, owner acceptance and real file verification.

### Phase 12 — Browser-saved source fingerprints (PR #77)

Studio → Plan now provides an explicit **Lock saved source** action for
unbound pending server plans. It reopens the current project from IndexedDB,
requires a positive saved revision and matching ID/format, recursively hashes
binary Blob/ArrayBuffer content, and hashes a deterministic representation
of the saved record using browser SHA-256. A second read checks the revision
before transmitting only `source_revision` and `source_sha256` to the
owner-authenticated PR #76 source-lock route. The plan can only be locked once.
No original images, narration, titles or prompts are transmitted by this action.

This does **not** independently verify the server has the source bytes:
the server currently receives a client-reported digest only. It does not
freeze future editing in the browser and does not assert that an unsaved editor
matches the saved snapshot. An executor must later obtain and authenticate
a canonical project snapshot, verify bytes/checksum/revision again and block
stale inputs. Browser tests cover explicit locking, saved revision and
server persistence across a new list request. They do not replace manual
output inspection or licensed provider verification.

### Phase 13 — Owner-verified online snapshot association (PR #78)

A pending server plan with an immutable source fingerprint can now link one
existing online recovery snapshot via
`POST /api/automation/jobs/{id}/snapshot`, with an exact
`{"snapshot_id": "<64 hex characters>"}` body. The server **reopens the
stored bytes**, checks the immutable package ID/content hash, validates the
recovery payload and original-artwork checksums, and confirms that project ID
and format match the requested job before the snapshot identifier is stored.
The link is immutable, idempotent and retained across restarts. Studio Plan
offers a selector for matching existing online snapshots. The owner confirms
before association. No new backup is made automatically.

This remains a **non-executing provenance link**, not a verified input for a
worker: recovery backups omit the browser revision, and the source-lock
digest in Phase 12 describes a different canonical representation. Therefore
the locked source hash and the associated online snapshot are **not yet
cryptographically reconciled**, even if the project ID matches. The plan
must not be runnable until a later phase defines and verifies a shared
canonical source format and checks revision and source digest together.
The snapshot may also be independently removed through the Library; an
executor must reopen and reverify availability and integrity immediately
before every step. Deleting a snapshot never deletes a creative project or
plan. No provider calls, rendering, publishing or background execution occur.

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
