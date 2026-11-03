# WEC Phase 41 — approved artwork reuse with source lineage

## Why

WEC already allowed manually choosing an image from another saved Creative project,
but the picker could borrow unreviewed artwork and the destination had **no recorded
origin**. A later change to the source image, approval, or character reference
could leave a reused picture appearing independent of its original review.

This phase strengthens the **existing local-first** reuse workflow rather than
adding a new paid asset-storage service or changing the database.

## Owner experience

1. Open a saved Creative project with at least one **approved** artwork page.
2. In a different art, video, storybook, or coloring project, select
   **Reuse saved artwork** on a page or scene.
3. The picker shows only pages with an explicit **Approved** review status,
   from other projects **on the same device/browser**. It refuses an image
   whose source was changed or whose approval was revoked after the picker
   opened. It does not generate anything.
4. Select a picture and confirm replacement if the destination already has
   artwork. The original image bytes are copied into this destination, not
   moved or deleted. The new copy begins **Not reviewed**, so approval is
   specific to its new use.
5. WEC records the source project ID, title, page ID and ordinal, saved
   revision, image SHA-256, and character/style/reference fingerprint in the
   destination page. This provenance is included in existing Creative project
   backups and recovery packages and survives browser reloads.
6. Use **Check reused artwork sources**. WEC warns if the source is missing,
   its current pixels differ from the saved copy, source approval was revoked,
   source character/style/reference differs, or destination image bytes
   changed. It never overwrites the destination copy or automatically calls AI.
7. If you intentionally attach or generate a different picture in that page,
   WEC **clears the old source link**. The new picture starts Not reviewed.

### Important limitations

- This is a **project-to-project** artwork picker within the existing
  browser IndexedDB. There is no global content-addressable registry,
  cross-device library sync, deduplication, or offsite backup in this PR.
- Source revision is recorded, but ordinary edits to unrelated project fields
  do not by themselves fail the source check; image hash, approval, and
  character/reference fingerprint are the safety criteria.
- An existing borrowed image remains available even if the source later
  disappears; this is intentional preservation, not validation of rights.
- An Approved label is owner review metadata, **not** licensing, copyright,
  KDP compliance, professional-quality or publishing certification.
- Reusing colored artwork does **not** convert it into printable coloring
  line art. Preserve originals and manually review print resolution.
- Original source project and destination may each use storage for their
  own image copy. This PR makes no claim of reduced disk or browser usage.

## Test and release gate

The existing `tests/browser_creative.cjs` suite runs the real WEC backend
and IndexedDB store on iPhone-sized (390 px) and desktop (1440 px) viewports.
It verifies:

- Only approved source page images can be chosen; an unapproved second image
  is not offered.
- Canceling the picker or destination replacement does not change artwork.
- A selected picture retains exact original bytes and records image/project
  provenance in the downloadable backup, with a fresh Not reviewed state.
- Source review revocation triggers a warning without changing the copy.
- A source change **while the picker is open** prevents the stale selection.
- Invalid source image bytes are rejected without replacing the destination.
- Independent replacement clears the obsolete provenance link.
- Existing print/export, reference profile, book and video paths still work.

Full GitHub CI must pass on Python, browser, media and Docker targets. CI
uses synthetic images and does not call paid AI models.

## Rollout / next phase

Deploy only after the owner reviews and merges this PR. Render auto-deploy is
off; use the existing service and its current 5 GB persistent disk. No new
subscription, worker, database, or migration is needed.

**Next milestone:** with the existing live capacity check, confirm one owner-
approved promotional video made from a previously approved artwork project.
Inspect real narration/captions, technical MP4 properties, review and backup
integrity, and restore inputs from its package. After that, build a shared
versioned asset catalog if actual production demonstrates a need for it.
