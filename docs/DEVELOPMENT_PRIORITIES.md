# WEC development priorities

WEC is one creative production platform with Video, Artwork, Storybook, and Coloring studios sharing projects, references, assets, review decisions, and finished outputs. These priorities turn the revised builder playbook and founder discussion into an implementation sequence. Update the evidence in `ENGINEERING_AUDIT.md` as changes land.

## Personal production first

Make the application dependable for the owner's creative businesses before treating public launch as the next delivery milestone. Shared external access requires verified account isolation; payments and public beta work must not block improvements to the owner's production workflows. Preserve mobile creation, editing, generation, resumption, review, and export wherever those workflows are supported.

## Immediate sequence

1. Finish the recovery checkpoint: one explicit device-local saved version per project, opened as a separate copy without replacing current work. Test migration, storage failures, and stale-tab conflicts. This is not a cloud backup.
2. Decide durable storage: identify authoritative project records, original assets, results, and exports; define retention, backups, restoration targets, migration, and cost. Preserve existing data until migration and restoration are verified. New recurring costs require the owner's approval.
3. Complete approved artwork to narrated promotional video: reuse assets without uploading again, record source versions, preserve review decisions, resume interrupted work, inspect the actual MP4, and retain a downloadable result.
4. Advance each studio toward its finished-product test. Add account isolation before shared external testing; prepare public launch separately when requested.

## Shared product requirements

- Projects should support a brand or business, audience, tone, visual style, and reusable references. Begin with simple project metadata rather than an organization or teams system.
- Originals and approved versions remain tied to their source versions. A changed reference flags dependent outputs for review without overwriting or automatically regenerating them.
- Eventually export a portable project package containing artwork, text, references, finished files, and source relationships. Verify restoration into WEC and keep standard files usable outside it. Existing JSON backups remain supported during this work.
- Keep a representative sample project once the connected journey passes, for regression checks, onboarding, and demonstrations.

## Studio completion tests

| Studio | Finished-product requirement |
| --- | --- |
| Video | Reviewed, downloadable video with intelligible narration and aligned captions, linked to its source assets. |
| Artwork | Approved images and reusable references saved with clear versions and review state. |
| Storybook | Complete reviewed interior and matching cover for an explicitly supported and verified publishing configuration. |
| Coloring | Clean reviewed illustrations with duplicates flagged, assembled into an interior and matching cover for a supported configuration. |

The first connected journey establishes the foundation; it does not replace the other studios' completion milestones. PDF export alone does not prove publishing compliance, and grayscale conversion alone does not prove usable coloring line art.

## Conditional enhancements

Evaluate enhancements at the work package they support. Include one only when it helps meet that package's requirements without delaying the connected journey.

- Surface approved assets and references before another generation; measure whether this reduces redundant work.
- Failure reports must show what will be sent and exclude credentials and private project content by default.
- Cost views must distinguish measured charges, estimates, and free usage.
- Reuse completed narration or scene assets where practical. Add render checkpointing only when measured restart costs justify its complexity.
- Duplicate detection flags candidates for human review; it never automatically discards artwork.
- Save export presets only after validating the relevant destination configuration; record the requirements checked and revalidate when they change.

## Engineering and adoption rules

Keep working components unless a measured gap justifies replacement. Candidate libraries are research leads, not approved dependencies. Verify exact releases, code/model/voice/font terms, maintenance, infrastructure, costs, and rollback before adoption; do not rely on unsupported archive or licensing assertions.

Use routine automated self-tests and mocks; use separately approved live generation for output evidence when needed. Distinguish local implementation, tests, PR, merge, deployment, and live verification. The owner merges PRs, and external product publishing remains a separate human decision.
