# WEC Faceless Video Studio — recover an editable story from a verified video ZIP

This phase follows PR #39's downloaded-video-package verifier. It turns a verified
production ZIP into an **explicit copy-only recovery option** for its saved render
story and optimized scene pictures.

## Owner workflow

1. Open the existing WEC Studio and sign in with your current tab credential.
2. In **Video renders**, choose **Select video package ZIP** and select a
   previously downloaded `-package.zip` from a finished WEC movie.
3. WEC verifies the ZIP's structure, CRC-32 checks and both SHA-256 manifest
   digests **on this device**, without uploading it. It also checks the
   embedded backup has one project and matches the manifest's project ID/title.
4. Once verification passes, choose **Restore saved render inputs as a new
   server story**. Read the confirmation and confirm deliberately.
5. WEC sends only the verified saved render-input backup to the existing
   authenticated `POST /api/restore` endpoint, which validates it and
   inserts a **new, independently identified** story and scene images in one
   database transaction. Existing server projects are not overwritten.
6. Use **Open restored story** to inspect the new project in Video Studio.
   Verify title, script, scene order and pictures before creating any render.
7. Keep both the downloaded MP4 and ZIP in independent storage. Only then
   consider removing an old server movie to free a saved-video slot, if needed.

The restored story uses the **optimized images from the original render**.
For original-resolution art and original Creative Studio checkpoints, restore
the separate Creative recovery package. A downloaded video ZIP does not contain
those originals.

## Safety guarantees and limits

- **No automatic render, generation, new paid service, publishing, deletion,
  disk wipe, or change to video review status.**
- Recovery does not restore the already-rendered MP4 into the server's job
  queue. It creates an editable story that can be rendered later with explicit
  approval, available disk space and the existing daily render limit.
- The existing story and its images stay unchanged. Restore always creates a
  new project ID; even if the original still exists, its changes are preserved.
- Selecting a new, corrupt or truncated ZIP clears any prior authorization to
  restore. The restore control stays disabled until successful verification.
- Declining the restore confirmation has no effect.
- After a confirmed restore request begins, the control is disabled to avoid
  accidental repeats. If its HTTP response is lost, WEC **does not** retry
  automatically; inspect the server project list before selecting a package
  again, since the save may already have succeeded.
- A malicious actor could alter an unsigned ZIP *and recompute its checksums*.
  A matching manifest only demonstrates internal consistency, not
  independent proof of provenance, content rights, authenticity or media
  safety.
- The existing server enforces its project limit and **16 MiB cumulative
  optimized scene-image limit**. A full server rejects the restore without
  sacrificing existing projects. Restoring a package does not itself clear the
  original storage-full condition.
- Browser-local ZIP verification does not make a cloud backup. Keep independent
  offline or off-service copies.

## Tests / acceptance

The 390px phone and 1440px desktop synthetic browser test:
- Renders and downloads a fixture video with immutable saved inputs.
- Validates the downloaded ZIP; verifies restore is available only then.
- Cancels the confirmation and verifies nothing was written.
- Confirms restore and verifies new story, preserved source project, scene
  pictures, no extra render attempts and a working recovered-project link.
- Verifies the control is disabled after success.
- Tries modified and truncated archives and confirms the restore action stays
  unavailable and the original video still exists.

Run the full CI Python/browser/media/Docker matrix before merging. The
existing **release gate** remains active, including byte-for-byte checks
of the Studio and verifier assets.

## Live rollout

Only after the owner merges this PR and CI passes, manually deploy the new
main commit to the **existing** Render service (auto-deploy is off). No new
paid resources are necessary. Before any live render or restore, check
**Check server storage & limits** and review available story/image storage.

An offline fixture acceptance is not proof that real production narration,
captions, art quality or disk persistence are satisfactory. The next major
milestone is a human-reviewed real idea-to-video walkthrough.
