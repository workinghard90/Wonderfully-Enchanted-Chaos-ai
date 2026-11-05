# WEC production release gate (updated after Creative Automation phases 1–7)

The owner's next phase is **prove what is actually running**, without making paid
AI calls, deleting data, starting video jobs or silently deploying code.

## Verified pre-release baseline (November 5, 2026)

- Existing Render service: `wec-studio-free-test` (`srv-dbc2cb5g1s2s73bjbh40`).
- Manual deployment remains in effect; **auto-deploy is off**.
- Render reports one 0.5 CPU / 512 MiB Docker instance and a **5 GB**
  persistent disk mounted at `/var/data`. The allocation does **not** reveal
  actual free disk bytes, snapshot limits or retained video usage.
- Latest inspected live deployment is `dep-dbm9um6c6qcc738dm4qg` on
  `cb3c73690e5d6aa20d3eaa977260e40856dbd709` (PR #59).
- Creative Automation Phase 7 merged on
  `ed09b411bf2380cff3f5a9873274f817e5be4866` (PR #67);
  the newer automation modules are **not yet deployed**.
- PR #67's complete branch CI passed. The post-merge `main` CI requires
  independent verification before rollout.
- WEC's browser test pins Cozy validation commit
  `dfe4b9fc4d0201268769dbc1f1153a6425826476`. At this audit,
  Cozy `main` at `955f6051a8603943ddd24408629b38639d7d26c0`
  contained that validation with a merge-only commit and no additional
  file differences.

These are dated connector observations, **not a promise of later deployment
state** or evidence of free storage. Do not remove any retained work as part
of release verification.

## One-click public release smoke check (PR #71)

The repository includes a **manually triggered** GitHub Actions workflow named
**Read-only production smoke check**. From the Actions tab, select that workflow,
choose **Run workflow** on the commit that Render is currently serving (normally
`main` immediately after a verified deployment), and inspect both the summary
and its downloadable JSON report. It invokes the existing release gate with
`--public-only`: GET-only health, exact deployed bytes for every documented
Studio asset, and unauthenticated-project rejection. It **does not** access
saved projects, provide an owner token, invoke AI providers, start video,
restore backups, change configuration or deploy the service.

**Important:** Running this workflow on a commit that differs from the current
Render deployment should report a **BLOCKED** asset-parity result; that is
expected and must not be "fixed" by weakening SHA checks. This public check
cannot certify server disk free bytes, snapshots, saved project integrity,
authenticated media or completed recovery. Those require the separately
documented owner read-only gate and hands-on acceptance.

## Safe gate included with this PR

Run from the exact repository checkout (or commit) you intend to deploy:

```bash
python -m unittest discover -s tests -p test_release_gate.py -v
python tools/release_gate.py \
  --url https://wec-studio-free-test.onrender.com \
  --public-only
```

Public-only gate checks:
1. `/api/health` returns the expected health JSON.
2. Ten actual `/studio/` HTML, JS and CSS assets have **exact byte hashes**
   matching the selected checkout, including `workflow.js`, `automation.js`, and
   `production.js`; this detects stale or missing automation modules.
3. Unauthenticated `/api/projects` requests return HTTP **401**, not data.

Run the fuller **owner read-only** gate by supplying your existing token as a
local environment variable (not via URL, committed file, or chat):

```bash
# Bash example
export WEC_STUDIO_TOKEN='YOUR_EXISTING_STUDIO_TOKEN'
python tools/release_gate.py --url https://wec-studio-free-test.onrender.com
unset WEC_STUDIO_TOKEN
```

In PowerShell:

```powershell
$env:WEC_STUDIO_TOKEN = 'YOUR_EXISTING_STUDIO_TOKEN'
python tools/release_gate.py --url https://wec-studio-free-test.onrender.com
Remove-Item Env:WEC_STUDIO_TOKEN
```

The owner gate additionally verifies **read-only** video readiness and online
snapshot availability with GET requests. It never prints the token or project
contents. All requests are GET; redirects are not followed. Only HTTPS remote
origins are allowed (plain HTTP is limited to loopback).

The JSON exit status is 0 on pass and 1 on failure. A failure is a blocker for
release approval; investigate before further changes. The release gate can only
be run successfully against assets from the **same commit** that Render serves.
A failed byte comparison on the pre-deploy baseline is **expected** and useful.

## Release sequence — no automatic production changes

1. Review and merge the relevant PRs **only after their CI checks pass**.
   GitHub CI uses mocks and synthetic media; it does not claim paid AI quality.
2. Check Render's deploy history and confirm which commit is *live*. **Do not
   create a new service, disk, worker or database.**
3. When the owner approves production rollout, manually deploy the intended
   `main` commit to the **existing** WEC service. Auto-deploy is off.
4. Run the owner release gate against that exact source checkout and save the
   resulting JSON report for the owner.
5. In the authenticated UI, **manually** test a previously retained render:
   MP4 playback; review decision; download a video ZIP; inspect the expected
   MP4, `render-inputs.json` and `manifest.json` inside that ZIP.
6. With an expendable synthetic Creative project, explicitly upload an online
   snapshot, download it, and restore into a **new** local project. Never
   overwrite existing real work for a test.
7. Only with owner approval and an independent recovery package, repeat the
   synthetic snapshot test **across a redeploy** and compare checksums.
8. Record CPU/memory/disk headroom and verify the live flags/mount through
   Render configuration; never print environment secrets.
9. If any gate fails, stop: leave stored videos and original projects alone,
   diagnose the failed check, and redeploy the previous known-good commit if
   needed with the owner's approval.

### What this does NOT verify

The script cannot prove actual billing cost, disk mount persistence after
restart, correct video narration/caption timing, KDP readiness, quality of
provider images, end-to-end automatic workflows, or independent offsite backup.
Its output must **not** be described as complete production certification.

The next product improvement should follow a successful release gate: finish
one real reviewed, playable, downloadable, recoverable faceless video with
source-artwork lineage and a human-approved visual/audio check.

## Maintenance and security rules

- Keep this gate read-only and dependency-free (Python standard library).
- Keep tests offline and synthetic so CI never incurs inference costs.
- Never put a token in request URLs, CLI arguments, CI logs, or documentation
  examples using actual values.
- Do not mistake "GitHub PR merged" for "deployed to Render".
- Do not enable auto-deploy or buy additional resources as part of this gate.
