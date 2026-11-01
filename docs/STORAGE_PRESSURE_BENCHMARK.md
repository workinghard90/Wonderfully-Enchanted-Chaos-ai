# WEC storage pressure and benchmark — next-phase owner review

## Observation and safe remediation

The existing WEC Render Docker service `wec-studio-free-test` has one 5 GB persistent disk mounted at `/var/data`. Its build cache is **not** that persistent disk.

A cache-clearing rebuild was triggered on the existing service without buying any resource or deleting application data. Render reported deployment `dep-dbjcpj67bikc73f2u29g` **live**, on `8a22532b` (PR #36); the build cache was cleared as part of that deployment. Clearing build cache cannot erase the project disk or reset application quotas.

**The reported "storage is full" warning has not yet been attributed to physical disk exhaustion.** The code defines separate limits:

| Capacity | Current bound | Why it matters |
|---|---|---|
| Physical persistent disk | 5 GB configured in Render | Shared by database, saved render files and snapshots; actual current free space requires an authenticated read |
| Online snapshots | 1 GiB aggregate / 50 snapshots | Either application quota can fill even when the disk has physical space |
| Retained video renders | 3 server video jobs, including failed or interrupted | A count/slot cap rather than a 5 GB disk failure |
| Video attempts | 2 per UTC day | Removing old jobs does not replenish the daily attempt count |
| Snapshot save | Reserve 256 MiB free-space headroom plus new package | A storage safety gate; not extra billed space |
| Video ZIP export | Reserve 256 MiB headroom plus maximum ZIP size | May be blocked even if the MP4 is playable and downloadable alone |

## New owner-only capacity check

The unified Studio now has a **Check server storage & limits** button in the Video renders section. It requests `GET /api/storage/capacity` using the existing tab-scoped studio credential; the endpoint is unavailable to unauthenticated callers.

It shows:
- Actual disk free, total and used bytes (from the same WEC data directory).
- Whether Render's data mount is confirmed.
- Saved render slots used/available, daily render attempts, and active jobs.
- Online snapshot count and bytes used versus their separate quotas.
- Plain-English warnings for whichever limit is reached, and for inadequate disk headroom.

It does **not** show project titles, original assets, job IDs, disk paths or secret tokens. All probes are read-only. It does not empty the project library, reset usage counters, alter online snapshots, or remove finished video packages. A missing storage mount or unavailable storage inventory produces a clear failure rather than guessed totals.

### Safe owner cleanup path

1. Refresh the capacity panel and identify **which** limit is full.
2. **Saved videos:** In Video renders, download a finished **video package** ZIP, verify that it contains the MP4 and render-inputs/manifest, and save the ZIP independently. If the disk is too low for the ZIP, download the MP4 separately and keep the Creative recovery package. Only then optionally use **Remove server copy** for a video that is no longer needed.
3. **Online snapshots:** Open Online project snapshots, download and verify an older snapshot package. Only after retaining an independent copy should its **Remove online snapshot** control be used.
4. **Daily attempts:** Wait for the next UTC day; do not delete work or bypass quotas.
5. **Actual disk free low:** Stop automatic cleanup and investigate the aggregate usage, uncommitted media work and database contents. Never delete arbitrary files in `/var/data` or reset the database to reclaim space.
6. Keep an independent off-service recovery package. The 5 GB disk itself is **not** an offsite backup.

No automatic retention deletion or bulk "clear all" action is included in this PR. Deletion of owner material requires explicit per-item confirmation.

## Benchmark and validation

CI runs an **isolated, synthetic** snapshot throughput check using:

```bash
python -m unittest discover -s tests -p test_storage_status.py -v
python tools/storage_benchmark.py --count 12 --image-kib 128
```

The benchmark uses a new temporary directory, creates deterministic synthetic image payloads and immutable snapshot packages, verifies exact byte counts, lists packages, reopens the store and validates every saved checksum. It emits machine-readable local timing measurements. It does not contact Render storage, use AI calls, read owner data, buy inference, or define a live latency SLA.

Python regression tests cover authenticated read-only capacity reporting, missing mount, disk headroom, separate video and snapshot quotas, no private data in responses, and preservation of existing files. The existing phone/desktop online-storage browser suite also verifies the new capacity display before and after a snapshot save.

**Acceptance for PR:** GitHub Python/browser/media/Docker suites must pass; dry-run benchmark must pass exact-byte recovery. After owner merge, deployment is manual (auto-deploy is off). Only then can the owner view **actual** live capacity through the tab-authenticated button.

## Next meaningful benchmark after rollout

1. Record real free disk bytes and the three independent quota headrooms.
2. Confirm storage remains available after a deliberate Render redeploy.
3. Download an existing finished video package (or MP4 when ZIP headroom is low), verify checksums and preserve an independent copy.
4. Create one synthetic, non-billable sample project and verify its snapshot restore on a separate device/browser.
5. Record peak memory, CPU and write/recovery duration for one offline/fixture video workflow on the existing 512 MiB Render configuration without incurring provider costs.
6. Only then proceed with a human-reviewed idea-to-video production acceptance run.

**Explicitly excluded:** clearing persistent disk, resetting usage database, disabling quotas, deleting snapshots/renders automatically, changing billing, adding workers, increasing the disk, or promising "unlimited" capacity.
