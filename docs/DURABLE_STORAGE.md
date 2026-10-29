# Owner storage: explicit online snapshots

## What is authoritative

The editable Creative Studio project remains in this browser's IndexedDB. **Save online snapshot** creates a separate immutable recovery package on the server: original page images, cover, reference, text, prompts, review decisions, source-artwork provenance, unresolved receipt identifiers, and the optional checkpoint. Opening a snapshot validates both versions and creates a new local project and checkpoint in one IndexedDB transaction. Local edits and other devices' snapshots are never overwritten.

Online saves are explicit, not automatic synchronization. A successful save means the server committed the package and the browser downloaded it again and verified its SHA-256. Later local edits require another online save. An interrupted response is uncertain: refresh the online list before retrying. Sending identical package bytes again returns the same snapshot. A fresh save may contain a new local save timestamp and therefore create another snapshot.

Standalone character profiles, other projects, server generation results referenced only by receipt IDs, finished MP4s and PDF exports are **not** part of a recovery package. Save each project explicitly and download finished products separately. Existing browser projects and downloaded project backups remain usable. The original `/video/` and `/coloring/` applications retain their own storage/export paths; this feature covers projects in the unified `/` studio.

## Storage format and limits

`WEC_DATA_DIR/creative-snapshots/<SHA-256>/package.json` is the exact portable package; `metadata.json` contains its title, kind, original project ID, timestamp, size and checkpoint flag. Immutable complete packages are intentionally simpler than the earlier proposed shared asset/manifest system: no broken cross-file asset references or asset garbage collection, at the cost of repeated image bytes across versions. Asset deduplication can follow when measured usage warrants it.

A save writes and flushes both files in a staging directory, flushes that directory, atomically renames it into the visible collection, then flushes the parent directory on Linux. Failed pre-commit uploads leave older snapshots untouched. Startup removes abandoned staging/deletion directories. Downloads verify the whole package hash before streaming it. The server checks envelope, relationship and image checksums; the browser performs its existing detailed project/image validation on opening. Checksums detect corruption, not authorship, and do not encrypt downloaded files.

- Maximum 90 MiB per package, existing 30 MiB of original images per project version, 50 snapshots, 1 GiB total package bytes.
- No automatic expiry or pruning. Older versions stay until the owner explicitly confirms removal. Removal affects only that online snapshot; it is permanent and has no trash/undo.
- Saves are refused with less than 256 MiB free disk headroom after the incoming package. The rest of the disk accommodates legacy databases, generation receipts, video outputs and filesystem overhead; those have separate limits. Monitor total Render disk usage too.
- One application process/instance owns the directory. One media/storage request runs at a time. Online uploads wait until any active video render is finished, avoiding overlapping large snapshot parsing and the video worker on the 512 MiB instance.
- Owner authentication requires the existing studio token of at least 32 characters. This is not a multiuser store and must not be offered as isolated customer accounts.

## Enable on the existing Render service

The implementation is disabled by default. A feature flag alone must not make ephemeral Render storage appear persistent. On Render, initialization additionally requires `WEC_DATA_DIR` to be an actual mounted directory; if that check or snapshot-directory creation fails, the online UI reports unavailable. Mount detection does not replace a real redeploy test.

Existing service: [wec-studio-free-test](https://dashboard.render.com/web/srv-dbc2cb5g1s2s73bjbh40).

1. Merge the storage PR. Download local recovery packages and any important existing server movies/results before changing hosting: adding a new mount does not migrate files from the old ephemeral filesystem.
2. In this **existing** service's Settings, choose Starter (0.5 CPU / 512 MiB). Keep the Hobby workspace. In **Disks**, add a **5 GB** persistent disk mounted at **`/var/data`**. Do not apply `render.yaml` as a new Blueprint: it names a separate example service.
3. Keep the existing authentication/provider environment variables. Set **`WEC_DATA_DIR=/var/data`** and **`WEC_ENABLE_ONLINE_STORAGE=1`**. Never put credentials in source control, URLs, screenshots or chat.
4. Deploy the merged main commit. The existing Docker command already uses `WEC_DATA_DIR`. Verify the application can write to the mounted directory as its existing non-root user (UID 10001); fix mount permissions through Render if startup logs report permission errors. Do not run the public application as root as a workaround.
5. Open **Project library → Online project snapshots → Load online snapshots**. Save a small test project with artwork and a checkpoint. Download its snapshot and record its ID/checksum. Open it in a separate browser to verify original bytes and checkpoint contents.
6. Redeploy/restart the service. Confirm that same snapshot is listed and its download has the same checksum; open it again in the clean browser. Only then mark the live durability acceptance check complete.

Budget discussed: Starter $7/month plus 5 GB at $0.25/GB-month = **$8.25/month base**, before usage, taxes and AI charges. Confirm the dashboard price before purchase. A disk requires a paid compute instance, permits only one service instance and introduces brief deployment downtime. Only files under its mount survive replacement. See [Render disk documentation](https://render.com/docs/disks) and [pricing](https://render.com/pricing).

The connected Render tools can deploy and edit environment variables but do not expose upgrading this existing service or attaching a disk. Those two dashboard actions remain an operator step; no paid resource has been created by this PR.

## Independent backups and recovery

After a significant save, choose **Download snapshot** and finish saving it in Files or an independent cloud drive. Keep at least the newest verified snapshot of each active project and one earlier known-good version outside Render. This is a manual backup policy, not an automated offsite backup service. For a complete collection backup, download every snapshot you need to retain. Never delete your last local/offsite copy just because an online upload succeeded.

Recovery drill: use a clean browser, open the downloaded package through **Open project backup or recovery package**, inspect its artwork, review decisions and checkpoint, then save a new online snapshot into a clean store. This restores originals without AI generation. The same JSON is usable if the Render account or disk is unavailable. Downloaded files are private creative content; keep them in storage you control.

For legacy server SQLite data, use SQLite's native backup mechanism before maintenance; copying a live database or restoring a Render whole-disk snapshot is not an application-consistent database backup. Render disk snapshots are not a substitute for the independent recovery packages above.

Recovery objectives: acknowledged online snapshots should survive a normal process restart or deployment when the configured disk remains available. A lost disk/account can lose everything since the last independent download. Initial target: restore one representative project and checkpoint in under five minutes, subject to file size and network/device speed. Full collection recovery time scales with the number and size of packages; no unmeasured whole-workspace recovery SLA is claimed.

## Acceptance and rollout status

Automated coverage exercises exact-byte restart and clean-store recovery, failed commit cleanup, concurrent identical uploads, preserving separate edited snapshots, checksum damage, capacity/disk-space rejection, authentication, disabled storage, missing Render mount, explicit deletion, and separate browser contexts at phone/desktop widths. Browser tests restore original images, reviews, receipt IDs and the checkpoint, and simulate a failed upload without losing local work. Existing checkpoint/package tests remain in CI.

A maximum-image fixture with both current and checkpoint versions produces an 80 MiB package; local Linux backend peak RSS measured approximately 288 MiB. This is a measured fixture result, not a guarantee for every workload or a substitute for production monitoring.

**Live rollout is not complete until the paid disk is attached, this PR is merged/deployed, and the same snapshot passes the actual Render redeploy check.** Automated tests exercise filesystem persistence; they cannot prove that the live service has the intended mounted disk. UI polish, automatic synchronization, automatic offsite backup, deduplicated assets and public multiuser access remain outside this owner-storage release.
