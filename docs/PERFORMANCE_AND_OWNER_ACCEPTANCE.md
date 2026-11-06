# WEC optimization and owner acceptance checklist — Phase 18

## Goal

Optimize the existing 512 MiB Render web service / 5 GB persistent disk
without purchasing infrastructure or deleting existing projects. Do not
interpret a green GitHub run as production acceptance.

## Optimizations in this PR

1. Cache `pip` downloads in every Python matrix job and in browser/media
   jobs using the checked-in `pyproject.toml` dependency key. Package installs,
   `pip check`, tests and doctor checks still run every time.
2. Cache the exact Playwright 1.62.1 Chromium binary and npm package downloads.
   Run `playwright install-deps chromium` to ensure platform system libraries
   remain installed even on a cache hit. Install the browser binary only on
   a cache miss. System FFmpeg and poppler tools remain installed; the browser
   job now performs one apt update and one bundled install instead of two.
3. Preserve all six cross-platform Python CI combinations plus complete
   media, browser and container workflows. First cached run may be no faster;
   compare warm-cache job durations across at least two future builds before
   claiming a measured speed improvement.
4. Protect the shared persistent disk: a new artwork export is refused after
   20 archived ZIP files or 512 MiB total verified ZIP bytes. Individual
   36 MiB output cap and 64 MiB free-space headroom still apply. A
   `507` refusal does not delete originals, historical ZIPs or receipts.
   Successful previous export replays remain allowed if output verifies.
   Limits only apply to this WEC `automation-exports` area, not all disk
   users; other media, logs and snapshots need monitoring.

## Owner acceptance testing (after explicitly authorized production deploy)

Do this only when the currently **deployed** commit has been verified and
the owner has approved the upgrade. No testing against unfinished PR code.

1. **Login:** Open the WEC URL and confirm private owner login succeeds.
   Confirm no project data appears while signed out.
2. **Preservation:** Verify existing projects, saved artwork, saved video
   output and recovery snapshots are still present. Do not erase anything.
3. **Isolated test project:** Create a new test-only artwork project with
   1–2 small PNG/JPEG images that you are permitted to use. Save it and
   capture a new online recovery snapshot. Do not use personal/master books.
4. **Approval + output:** Create a plan for that project; bind the snapshot;
   approve the `artwork_export` operation only; explicitly prepare the ZIP.
   Download the ZIP and confirm it opens, includes `manifest.json`, and the
   pages correspond to the test project.
5. **Recovery:** Reload Studio, check that the export receipt is retained,
   and that re-requesting the ZIP doesn't generate duplicate output.
6. **Revocation:** Revoke that test-plan export approval; verify later
   downloads are denied. Do not expect previously saved downloads to vanish.
7. **Storage:** Check disk-capacity status before and after; report any warning
   or unexpectedly slow action. Do not manually delete Render storage.
8. **Performance:** Note rough times for sign-in, loading a project, opening
   approval controls, preparing and downloading the small test ZIP. A mobile
   browser check is valuable if that's the main way you use WEC.

If any step fails, stop before adding more data, capture the redacted error
message and relevant UI screenshot (without tokens), and provide the time and
step number. Keep the previous live commit available for rollback.

## Explicit non-goals

No hosting plan upgrade, live deployment, paid provider execution, automatic
publishing, deletion or migration of owner projects, forced background jobs,
or change to the Cozy store. `pip` / npm caching and export quotas are
performance and safety improvements, not evidence of production readiness.
