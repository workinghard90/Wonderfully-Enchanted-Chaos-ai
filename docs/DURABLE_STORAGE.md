# Durable storage decision and staged delivery

## Current authority

Creative projects, original artwork, character profiles, and recovery checkpoints are currently authoritative in this browser's IndexedDB. The server's SQLite records contain legacy projects, usage records, and bounded generation receipts; video files live in its data directory. These are separate stores, not synchronized replicas. The current free Render service has no established durable storage guarantee across redeploy or instance replacement. The repository's paid-disk Blueprint is not evidence that the live service uses that configuration.

## First deliverable without a hosting change

The recovery package exports one saved creative project together with its optional checkpoint. Each version contains its original page artwork, cover, reference, text, prompts, review decisions, and unresolved generation receipt identifiers. A checksum covers the serialized payload, and existing image checksums verify original bytes. Checksums detect damage; they do not authenticate an author or encrypt private content.

The creator must finish saving the downloaded file outside the browser, for example in Files or their own cloud drive. Opening the package on a clean browser validates both versions before a single transaction creates the new project, summary, and checkpoint. Existing data is not overwritten, and the editor switches only after commit. Packages without checkpoints also work. Existing project JSON backups remain supported.

This is a manual off-browser recovery path, not automatic cloud backup, device synchronization, or complete workspace export. Other projects, standalone character profiles, server receipts/results, finished MP4s, and PDF exports are not included. Download final products separately. Receipt identifiers do not contain missing server images and never trigger generation on restore. Maximum package size is 90 MiB; each contained project retains its existing image and page limits.

## Next online storage design

Use an explicit owner-operated snapshot service before multiuser synchronization. Keep device editing and existing backups working while adding an optional durable online copy. Store immutable asset bytes by content hash and versioned project manifests referencing those bytes. Each acknowledged snapshot must refer only to committed, recoverable assets. Use revision preconditions for updates and preserve prior recoverable versions according to a declared retention policy. Failed uploads must leave the last complete snapshot usable.

Select the physical backend only after checking the owner's approved budget and actual deployment capabilities. The existing Python application can support durable database/file storage on an appropriately configured persistent volume or a managed database/object store. Do not create paid resources, apply the repository Blueprint, or relabel temporary server storage as durable merely to complete this work package.

Before enabling online saves, record:

- The authoritative project and asset locations, ownership model, expected volume, and monthly cost ceiling.
- Retention for current and previous snapshots, deleted assets, job results, and independent backups.
- A recovery target for acknowledged saves and a measured full-restoration time target. Do not promise zero loss across every infrastructure failure.
- Backup storage independent of the primary failure domain, backup verification, and a clean-store restoration drill.
- Migration from existing browser projects with IDs, exact bytes, reviews, references, and checkpoint relationships preserved. Verify remote restoration before offering to retire any local copy.
- Authentication, size limits, usage accounting, safe deletion, and rollback compatibility. Require account isolation before shared external access.

## Acceptance evidence

The first slice tests clean-browser package restoration, separate current/checkpoint versions, byte preservation, generation-receipt preservation, corrupt-payload rejection, rollback when the final checkpoint write fails, and packages without checkpoints at phone and desktop widths. Existing single-project backups remain regression-tested.

Online durability is still incomplete until the selected backend survives process restart and instance replacement, independent backups restore all linked files into a clean store, concurrent writes are protected, and documented recovery targets are met. Do not count this package feature as passing those online-storage tests.
