# Creative Automation Phases 1–7 — Pre-release Audit
**Audit date:** 2026-11-05
**Status:** Pre-release verification; **production rollout not authorized**.
**WEC release candidate:** `ed09b411bf2380cff3f5a9873274f817e5be4866` (merged PR #67).
**Cozy importer main:** `955f6051a8603943ddd24408629b38639d7d26c0`.
**Production WEC baseline:** `cb3c73690e5d6aa20d3eaa977260e40856dbd709` (PR #59), Render deploy `dep-dbm9um6c6qcc738dm4qg`.

## Findings

| Area | Evidence | Audit result |
| --- | --- | --- |
| WEC Phase 7 branch CI | GitHub Actions run 42077328458: 9 of 9 jobs passed, including browser, Python across Linux/Windows, container memory/media and Cozy synthetic handoff | Passed for that branch SHA |
| Phase 7 browser | Real Chromium suites on 320/390/1440 px; Phase 7 inventory/report/consent and pre-existing studio, video and recovery regressions passed | Passed synthetic browser tests |
| Post-merge WEC main | GitHub Actions run 42080674832 (release-candidate SHA) | In progress during this audit; must confirm 9/9 before release |
| Cozy validation | Cozy main run 41886878484 passed; Cozy main is one merge-only commit ahead of WEC's pinned compatible importer `dfe4b9fc4d0201268769dbc1f1153a6425826476`, with no file diffs | Passed static/CI compatibility |
| Render deployment | Existing service `srv-dbc2cb5g1s2s73bjbh40`; `autoDeploy=no`, one 0.5 CPU / 512 MiB Docker instance; latest deployed commit is PR #59 | Safe baseline retained; new features are NOT live |
| Persistent disk | Render configured 5 GB at `/var/data`; service/metric records do not provide available disk bytes or offsite backup confirmation | **Unverified**, must check authenticated capacity report |
| Operational metrics | Observed roughly 25 MB application memory and one instance in available 15-min aggregates; no new deploy/disk-change events inspected | Healthy baseline observation only; not a load test |
| Ownership and authentication | Backend tests cover 401 for unauthenticated owner project/storage endpoints; full owner gate requires privately supplied access token | Synthetic checks passed; owner live gate not run |
| Release file parity | Original release gate checked only 7 static UI assets and omitted `workflow.js`, `automation.js`, `production.js` | **Release-gate gap**; fix in PR #68 |
| Existing production live check | Connector deployment history/logs inspected; no authenticated browser session and no direct browser connectivity available for this audit | Requires separate post-deploy smoke tests |

## Risk review / scope boundaries

- Creative projects and characters are primarily retained in browser IndexedDB, not a synchronized multi-user store. Keep independent recovery packages and original artwork copies.
- Phase 6 step review does **not** imply output approval. Phase 7 production manifests are guidance documents, not certified media or authorized publishing packages.
- Phase 7 only invokes existing *local* backup/artwork ZIP handlers after independent confirmation. PDF, private Cozy, and video output are delegated to their existing validation and user-consent controls. No server-side batch job, unattended AI generation or auto-publish was added.
- Cozy import is a **private read-only catalog proposal**, not automatic storefront publishing. ZIP integrity and image/PDF type checks do **not** establish KDP print readiness, authenticity signatures or human creative approval.
- One owner token does not give separate accounts or role-based isolation; device-local content is not encrypted by WEC.
- CI uses synthetic data and fixtures. It cannot certify real Cloudflare image quality, narration/caption alignment, real KDP PDFs, cost, actual 5-GB disk free space or persistence of new data through a post-release restart.

## Release blockers / remaining owner-safe checks

1. Verify post-merge `main` CI run 42080674832 is fully green.
2. Merge release-gate fix PR #68 only after its own CI passes. Record the exact tested merge commit as the intended release source.
3. Obtain explicit owner approval **before** deploying to the existing Render service. Keep auto-deploy disabled, keep the persistent disk and prior live commit for rollback.
4. On the deployed exact SHA, run the owner read-only `tools/release_gate.py` with the private `WEC_STUDIO_TOKEN` provided **only as a local environment variable**. The full gate must verify 10 UI assets, health, 401 authentication, video and snapshot readiness. The pre-deploy gate is expected to fail asset parity against the older PR #59 release.
5. In an authorized owner session, use **Check server storage & limits** or the authenticated `GET /api/storage/capacity` endpoint to check disk free bytes, persistent mount, snapshot quota, retained video slots and warnings. Do not delete any saved assets to make room.
6. Use expendable synthetic content for a post-deploy browser run: recipe selection, approved one-action save/conversion, guided pause/resume, Phase 7 manifest/backup/artwork ZIP and manual Review/Export. Verify real downloaded bytes and preserve originals.
7. With owner permission and an existing recovery package, verify an isolated online snapshot download/restore and, if a redeploy is separately approved, persistence/checksums across it. Confirm MP4 package/visual playback and PDF quality with human review; do not incur paid AI usage without separate approval.

**Decision at this audit:** Continue to keep the prior production deploy live. Phase 7 feature-branch CI is green; release approval remains blocked pending completion of post-merge CI, PR #68, exact-deploy owner release gate and the unverified live disk/restore checks. No data was deleted, no paid AI called, and no deployment was triggered.
