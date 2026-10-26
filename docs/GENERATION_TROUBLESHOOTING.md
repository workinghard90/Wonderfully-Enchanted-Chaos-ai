# Generation incident and application checks — 2026-10-26

Saving a shared-studio project uses browser IndexedDB. It does not prove that
server authentication, Cloudflare configuration or inference is working.

## Observed live evidence

- The public homepage and `/studio/app.js` fetched during this audit matched the
  files from commit `1d66f34a06f2b5cead4b158090792ca731be245e` (PR #18). A fresh
  no-cache request with a unique query also lacked the new reference-generation
  controls. The public frontend is behind merged main; the backend's precise
  deployed commit has not been verified.
- `/api/health` returned 200. Protected generation/video endpoints returned 401
  without a studio token, which is expected. This does not establish whether the
  user's saved token or Cloudflare credentials are valid.
- Main commit `44cb25069a970e5aeb99b7313bdacb7a0c96dbc9` passed GitHub's Python
  matrix, media and container jobs. Its browser job failed at
  `tests/browser_coloring.cjs:47`: an obsolete assertion expected `_blank`, while
  the central-navigation update intentionally links home in the same tab.
  Subsequent browser steps, including the creative studio, were skipped.
- CI evidence: https://github.com/workinghard90/Wonderfully-Enchanted-Chaos-ai/actions/runs/40333286423
- Render deployment settings/logs remain unverified: the connector has no
  selected workspace and requires the user to confirm the intended workspace.
  A failed CI check can block an auto-deploy configured to wait for checks, but
  that setting has not been established here. No deployment was triggered.

**The exact live inference failure is not yet established.** An old frontend,
authentication, owner configuration, quota exhaustion and provider rejection are
separate conditions. No successful or failed live Cloudflare inference was made
by this audit, and no credentials were retrieved.

## Reproduced issues and fixes

| Issue | Resulting behavior |
| --- | --- |
| Cancelling authentication left generation disabled with no reconnect control | New AI connection panel and Connect / check AI action; initial page load checks quietly and saving remains available |
| Generic setup messages obscured which setting was missing | Authenticated status explains disabled generation, invalid/missing account setup, missing/invalid token setup, or too-short studio token, without exposing values |
| Creative readiness could be true even though its 32-character studio-token requirement failed | Separate creative readiness gates the shared studio; legacy readiness remains compatible |
| Known daily cap left generation controls available | Text/reference controls disable at the shared daily cap; the status shows the UTC reset rule |
| Requests could leave controls locked while waiting indefinitely for response headers | 90-second client timeout releases the UI and does not replay a generation; provider processing may already have consumed an attempt |
| Errors appeared above the viewport on long mobile projects | Status remains visible while scrolling |
| Editing character/style after creating a page left its prompt preview stale | Both text/reference previews update to match current settings |
| Upstream rejection was reduced to a generic message | Errors show bounded HTTP status and numeric provider code only; credentials and upstream message bodies remain redacted |
| Obsolete coloring-navigation assertion stopped browser CI | Test now checks same-tab All studios navigation; a dedicated AI-connection regression suite is added to CI |

## Current practical limits

| Area | Current limit / implication |
| --- | --- |
| Images | 20 attempts per UTC day shared by text, reference and original scene generation. Valid provider failures count; invalid input is rejected before reservation. Cloudflare has separate account allowances. |
| AI drafting | 5 attempts per UTC day; up to 12 book/art pages or 7 video scenes per request. Separate owner opt-in. |
| Reference generation | One approved input; at most 10 MiB / 12 megapixels. Uploaded provider copy fits 512×512; requested output is 1024×1024. It is not inherently full-page 300-PPI print artwork. |
| Web videos | 2 attempts/day, one active render, 3 saved jobs, maximum 35 seconds / 7 scenes / 100 words / 1,000 characters. Each scene at most 25 words / 200 characters. |
| Render output | MP4 up to 20,000,000 bytes; worker timeout 1,200 seconds. Still-image motion, narration and captions rather than character animation. |
| Shared project artwork | 80 pages (7 for video), 10 MiB / 12 megapixels per picture; aggregate 30 MiB / 320 megapixels including cover and approved reference. |
| Server story storage | 100 projects; normalized scene images up to 2 MiB and 2,048 pixels on the longest edge; 16 MiB aggregate scene-image budget. Device originals are separate. |
| Books | Fixed Letter layouts; story text limited to nine wrapped lines per page at export. Cover templates require matching paper/ink/page settings and human KDP review. |
| Image formats | PNG, JPEG and WebP; no shared-studio SVG conversion or HEIC support. |
| Recovery | Shared project/profile data is local to this browser; downloaded backups are required for durable copies and transfer. MP4s require separate download. |
| Processing | Image/export/backup operations share a media lock; overlapping operations can return 429. Image requests are synchronous, with no persistent retry queue. |

Duplicate-art detection, native high-resolution guided generation, full shared
asset versioning/cloud sync and automatic cross-studio workflows remain roadmap
work. Existing optional local ComfyUI tooling is not a hosted GPU service.

## Verification

- 137 Python tests passed locally, including real media/export checks, provider
  protocol tests, safe diagnostic responses and quota validation.
- All ten browser/helper suites passed: story smoke, legacy image generation,
  device recovery, video, print checks, coloring browser/PDF, coloring ZIP,
  coloring recovery, creative studio and the new AI connection suite.
- The legacy generation fixture initially needed the new setup-message method;
  after updating that fixture, its rerun passed at 390px and 1440px.
- Connection tests cover saving without authentication, cancelled/wrong tokens,
  successful reconnect, disabled-provider explanation, current prompt previews,
  network errors, simulated 90-second timeouts, quota blocking and mobile error
  visibility. They never call a live AI provider.
- The creative suite retains reference preservation, PDF/ZIP, synthetic FFmpeg
  MP4, reload/recovery and mocked generation checks. Mobile UI inspected.
- Local test results are not a claim that the live inference problem is solved.

## Release and live follow-up

After review/merge, confirm that Render actually deploys the updated branch and
that the live frontend contains Connect / check AI and Generate using reference.
Use the connection panel with the studio token to see the authenticated setup
status. A confirmed request should then produce a specific error or an image;
check the first image against the approved character before producing a batch.
Read Render's latest deploy and relevant request/app logs once its workspace is
confirmed. Do not reset project storage or repeatedly retry chargeable requests.
