# WEC Faceless Video Studio — verified recovery handoff

## Goal

A completed movie is not safely handed off just because a download button was clicked. This phase lets the owner **verify the actual downloaded video package on their own device** before considering deletion of a server copy to reclaim space.

In the unified Creative Studio, visit **Video renders → Verify a downloaded video package** and choose an existing WEC `-package.zip`. Everything below happens **inside the browser**; the selected file is never uploaded to Render or to an AI provider.

The check:

1. Refuses empty, oversized, truncated, compressed, encrypted, ZIP64 or unexpectedly structured packages.
2. Requires exactly the four archive entries written by the current WEC server: `movie.mp4`, `render-inputs.json`, `manifest.json` and `README.txt`; refuses duplicate or unfamiliar entries and unexpected additional data.
3. Checks each ZIP entry's stored byte count and CRC-32 for accidental damage.
4. Parses the WEC video package manifest, requiring version 1 and a finished render.
5. Confirms both the MP4 and saved render inputs match the precise SHA-256 digests and byte sizes in that manifest.
6. Displays confirmation and the original review decision **without modifying the downloaded package, server copy, review status or usage quota**.

The verifier uses the browser's built-in Web Crypto SHA-256 function and a shared, already-existing WEC ZIP CRC-32 implementation. It needs no new library, cloud compute, paid inference, worker, database, or file storage.

### A strict limitation of integrity checks

The WEC manifest is unsigned. A matching SHA-256 proves that the included media and inputs agree with the **included manifest**; it is not independent proof of provenance, authenticity, ownership, media quality, or rights. A malicious party could replace the whole archive and generate new checksums. Do not describe this as a cryptographic signature.

This also does not decode the full movie for playback or validate audio and subtitles. Use the separate **Inspect finished MP4** server check from PR #38 and watch/listen to the entire movie before owner approval.

## Safe end-to-end acceptance path

1. In Studio, click **Check server storage & limits** from PR #37. If the three saved-video slots are full, don't delete anything yet.
2. Open a saved Video project (or prepare approved scenes). Avoid billable image generation in routine smoke tests.
3. Create one render only with explicit approval and sufficient storage. Do not skip the two-attempt-per-day limit.
4. On a finished video, click **Inspect finished MP4** and review technical checks.
5. Play the complete movie, check narration, burned captions, scene order and visual quality. Mark the actual movie `Approved` or `Needs changes` only after human review.
6. Download the MP4 and its full production ZIP, then download the Creative Studio recovery package for original-resolution artwork and saved checkpoints.
7. Locate the newly downloaded `-package.zip` on your device and select it in **Verify a downloaded video package**.
8. Confirm the local integrity check passed. Keep independent backups away from the WEC Render disk. Only if the video is no longer needed on the server should the owner use the existing explicit **Remove server copy** action.
9. To complete live recovery validation, restore the saved render inputs to a **separate** new server story and an original-artwork recovery package to a **separate** browser project. Do not overwrite existing work.

**This PR does not perform a live render, take down WEC, or remove any content.** If storage remains full, separately identify the actual limit: physical disk, online snapshots, retained video jobs, or daily render quota.

## Tests and release acceptance

- The 390px mobile and 1440px desktop synthetic-browser video retry suite now downloads a ZIP from the real local test server, verifies it with the new browser component, rejects a modified-byte ZIP and a truncated ZIP, and confirms the saved video remains untouched.
- The production release gate from PR #36 now checks the deployed verifier asset byte-for-byte alongside the other Studio files.
- Unit, browser, media and Docker CI workflows must pass before merge.
- After owner merge, deploy the exact merge commit to the existing Render service (auto-deploy is off). Never make new paid resources or clear the persistent disk.

**Next product phase:** independent owner acceptance of a real, complete idea-to-voice/visual/caption/MP4 workflow, subject to measured live storage capacity and manual approval. The synthetic CI tests do not replace that acceptance.
