# Automatic device backup and recovery

The dashboard copies **saved** stories and their attached pictures into this
browser after loading a nonempty studio, saving a project, uploading/removing
or generating a picture, or restoring a backup. The **Your device backup** panel
shows the last completed storage write, project count and picture count. No AI
generation or video render is started by this feature.

## On iPhone or Windows

1. Use your own device and the same studio URL/browser. Enter the studio token
   when prompted. The automatic copy is enabled by default.
2. Save your work normally. Wait for **Saved on this device**. Unsaved editor
   changes are not protected by this copy.
3. If the server restarts with an empty project list, return in the same browser
   and enter the same token if needed. The last nonempty device backup is kept.
4. Tap **Recover projects from this device** and confirm. Recovery creates new
   project copies, including pictures. It never starts generation or rendering.
5. Continue using **Download backup**, and save finished MP4 files separately.
   **Download device backup** exports the last successful browser copy; it can
   be older than the server if a copy failed.

Recovery requires a reachable, authenticated server. If the page has already
loaded but the API is unavailable, its device-backup download still works.
There is no service worker or promise of opening the entire app offline.

## Preserve earlier work

An empty API response never replaces a nonempty device copy. If the server has
an entirely different set of project IDs, the earlier copy is also preserved.
Download that earlier device backup before choosing **Use current server
projects**, which explicitly replaces it. This handles a reset followed by new
work on another device without silently losing the earlier backup.

The recovery button is offered only for an empty server, checks again before
restoring, and sends `only_if_empty: true` to `POST /api/restore`. The server
checks emptiness inside the same SQLite `BEGIN IMMEDIATE` transaction that
inserts projects/images. A concurrent save or recovery makes the request fail
with 409 and no imported projects. Normal manual **Restore backup** continues
to create additional copies on a nonempty server.

## Privacy, limits and failure behavior

- Browser storage is best effort. Private browsing, clearing site data, storage
  pressure, device loss or switching browsers can remove or hide it. It is not
  cloud storage, a scheduled server backup or cross-device synchronization.
- IndexedDB stores one current snapshot per backend URL and studio-token
  scope. The scope key is SHA-256 of the URL and token; the token itself is not
  written to IndexedDB. The existing token stays in tab session storage.
  A changed backend URL or token uses a separate scope. Export a backup before
  rotating a token or moving the studio. Do not weaken or reuse credentials to
  retrieve an old browser copy; retain independent JSON exports instead.
- Project data is stored locally without application-level encryption. Anyone
  with access to this browser profile or same-origin scripts may access it.
  A scope key prevents accidental mixing; it is not an encryption/access-control
  boundary. Use **Turn off & remove device copy** on a shared device. This
  removes this scope's snapshot and pauses copying across reloads. **Enable
  device backup** resumes it. Server projects/downloaded files are unchanged.
- No tokens, video files, render jobs or unsaved drafts are included in project
  snapshots. Photos are the studio's optimized JPEGs, not original uploads.
- The application caps a device snapshot at 40 MiB; browser quotas can be lower.
  An atomic transaction preserves the previous copy if an update fails. Storage
  denial, quota errors, timeouts and failed backup fetches show a warning without
  converting a successful server save into a failure. Downloads remain available.
- No voice/model downloads, external services, paid resources, timers, keepalive
  requests or automatic render retries are added. Copying occurs on page load
  and successful saved-project changes. Keep a downloaded JSON and each MP4.

The same-server dashboard serves `device-backup.js` before `app.js`. For a
separately hosted frontend, copy **all** `studio_web` assets and use HTTPS.
IndexedDB and Web Crypto must be available (localhost also works for development).

## Verification

`node tests/browser_recovery.cjs` uses a real local server and IndexedDB at phone
and desktop Chromium sizes. It checks image/story round trips, reset recovery,
cancel/confirmation, offline API downloads, credential/backend separation,
preserved conflicting copies, pause/resume and quota/blocked-storage failures.
Python tests cover the authenticated HTTP contract and concurrent empty-server
recovery. The tests make no image generation calls or video renders. Phone-sized
Chromium checks do not substitute for testing Safari on a physical iPhone.
