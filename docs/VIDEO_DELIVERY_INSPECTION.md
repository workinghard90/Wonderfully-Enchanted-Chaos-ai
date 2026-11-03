# Faceless Video Studio — finished-video inspection checkpoint

## What this phase adds

The existing WEC video pipeline can render narrated still-image movies, resume
failed renders from saved inputs, play and download MP4s, record an owner review
decision, and download recoverable video ZIPs. This phase adds a **read-only
technical inspection** of an existing finished MP4 as a distinct acceptance
checkpoint. It does not start a render or use a provider.

In **Video renders**, select **Inspect finished MP4** beside a completed movie.
The server analyzes the saved movie, not whatever project is currently open.

The `GET /api/video-jobs/{id}/inspect` endpoint is protected by the existing
owner token and checks:

- Exactly one H.264 video stream
- 1080×1920 portrait dimensions
- YUV420P video format
- An AAC audio stream
- Recorded vs observed container duration and actual video-track duration
- Maximum MP4 file size
- Faststart atom layout for web playback

The response includes a pass/fail per check, the observed duration/bytes and a
non-publishing guidance note. It never returns server paths, logs, credentials,
source images, or private story content. FFprobe execution is bounded by a
30-second timeout; unreadable or corrupted movies produce an owner-safe error.
The check operates on the preserved disk copy and does not change any saved
movie, review decision, render attempt count, or online snapshot.

## What technical inspection cannot establish

Captions are **burned into video pixels**, so stream analysis cannot prove
their text matches narration or they remain visible and well timed. FFprobe
also cannot judge voice naturalness, accessibility, whether images match the
script, harmful or infringing content, or creative/publishing suitability.

A green technical report is **not** owner approval, content certification,
publication or authorization to upload to social platforms. The owner must:

1. Play the full MP4 and listen to intelligible narration.
2. Check readable and correctly aligned burned captions against speech.
3. Verify picture quality, intended scene order, and visual consistency.
4. Check rights, brands, content relevance and final presentation.
5. Mark **Approved** only after viewing/listening.
6. Download the MP4 and a video production ZIP, and retain the Creative Studio
   original-artwork recovery package separately.

Technical inspection and owner review remain independent. A failed inspection
also leaves the movie available to download and troubleshoot.

## Benchmark / acceptance

- `python -m unittest discover -s tests -p test_studio_video.py -v`
  exercises authenticated inspection, a deliberately sub-1080p synthetic
  fixture, no mutation of review/attempts/project contents, and corrupted or
  missing media behavior.
- `node tests/browser_video_retry.cjs` runs the UI inspection on 390px phone
  and 1440px desktop and verifies that the technical failure cannot silently
  change an owner's review decision.
- Existing Python, browser, real FFmpeg, and Docker jobs must all pass.

All fixtures are locally synthesized; **no AI inference, paid rendering, new
resources or owner-project uploads** occur. No production deployment is
included. When the owner merges this PR, deploy the intended `main` commit to
the **existing** Render service explicitly (auto-deploy is off). Then run the
capacity check from PR #37 before spending any render attempt.

## Next complete-product benchmark

After the live disk capacity / saved-video slot blocker is understood, run
one owner-approved, real idea-to-video acceptance journey on the existing
service: reuse approved artwork, save immutable inputs, produce narrated MP4,
run technical inspection, complete human review, download a package, and
confirm it survives a restart. This is the next milestone, not automatically
certified by this PR.
