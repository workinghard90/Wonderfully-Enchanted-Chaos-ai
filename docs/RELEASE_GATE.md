# WEC production release gate (PR #36 work package)

The owner's next phase is **prove what is actually running**, without making paid
AI calls, deleting data, starting video jobs or silently deploying code.

## Verified deployment baseline (October 31, 2026)

- Existing WEC Render service: \`wec-studio-free-test\` (\`srv-dbc2cb5g1s2s73bjbh40\`).
- Existing Docker service is on a Starter instance with one **5 GB** disk mounted
  at \`/var/data\`. This is account configuration, not evidence that every app
  feature works.
- **Auto-deploy is off**. Merging a PR will not deploy it.
- Last Render deployment inspected: \`dep-dbj67d7lk1mc738c6obg\`, live on
  merge commit \`20f11979d36ee658cd0bac16bab2ba96a3a72830\` (PR #34).
- PR #35 (video package download) was merged later, so this live deployment
  has **not** been verified to contain PR #35.
- The engineering audit records a successful synthetic online-snapshot
  persistence test across a previous Render redeploy, not a guaranteed
  offsite backup or comprehensive restore drill.

These are a dated observation, **not a promise about future deploy state**.

## Safe gate included with this PR

Run from the exact repository checkout (or commit) you intend to deploy:

\`\`\`bash
python -m unittest discover -s tests -p test_release_gate.py -v
python tools/release_gate.py \
  --url https://wec-studio-free-test.onrender.com \
  --public-only
\`\`\`

Public-only gate checks:
1. \`/api/health\` returns the expected health JSON.
2. Six actual \`/studio/\` HTML, JS and CSS assets have **exact byte hashes**
   matching the selected checkout; this detects a stale UI deployment.
3. Unauthenticated \`/api/projects\` requests return HTTP **401**, not data.

Run the fuller **owner read-only** gate by supplying your existing token as a
local environment variable (not via URL, committed file, or chat):

\`\`\`bash
# Bash example
export WEC_STUDIO_TOKEN='YOUR_EXISTING_STUDIO_TOKEN'
python tools/release_gate.py --url https://wec-studio-free-test.onrender.com
unset WEC_STUDIO_TOKEN
\`\`\`

In PowerShell:

\`\`\`powershell
$env:WEC_STUDIO_TOKEN = 'YOUR_EXISTING_STUDIO_TOKEN'
python tools/release_gate.py --url https://wec-studio-free-test.onrender.com
Remove-Item Env:WEC_STUDIO_TOKEN
\`\`\`

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
   \`main\` commit to the **existing** WEC service. Auto-deploy is off.
4. Run the owner release gate against that exact source checkout and save the
   resulting JSON report for the owner.
5. In the authenticated UI, **manually** test a previously retained render:
   MP4 playback; review decision; download a video ZIP; inspect the expected
   MP4, \`render-inputs.json\` and \`manifest.json\` inside that ZIP.
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
