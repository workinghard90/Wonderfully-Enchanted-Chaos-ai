# Owner-only WEC → Cozy Creations publishing handoff (Phase 1)

This is a **contract and rollout plan**, not a live connection. WEC is the private source studio; Cozy Creations is the public catalog. No public AI access, subscription, new paid service, direct KDP submission, or unattended deployment is authorized.

## Source of truth and safety

- WEC browser projects currently live in device-local IndexedDB. They are **not cloud-synced**. Export a project JSON backup before publishing; do not delete or migrate the source project.
- Only the owner may initiate an export. A saved draft is **not** publication approval.
- Preserve approved originals and existing Cozy brand assets; do not generate replacement covers or emblems.
- Secrets, studio access tokens, GitHub credentials, and provider API keys must never be written into exported project JSON, the public website, or browser URLs.
- The public website must not fetch WEC's private API or expose WEC projects. Publishing is a controlled handoff, not a public cross-origin connection.
- Maintain the site's prelaunch restrictions: no invented KDP links, checkout, public indexing, or product availability.

## Proposed portable handoff package (v1)

A ZIP downloaded after explicit owner review, with these files:

```text
manifest.json
assets/                # only explicitly approved public previews/cover assets
kdp/                   # optional existing reviewed interior and cover PDFs
```

`manifest.json` fields (all strings unless noted):

```json
{
  "schemaVersion": "wec-cozy-handoff-v1",
  "sourceProjectId": "example-local-project-id",
  "productSlug": "example-product",
  "title": "Example product",
  "creator": "Melody Autumn Hall",
  "productType": "coloring-book",
  "description": "Example only; owner must approve final copy.",
  "publicationStatus": "draft",
  "assets": { "cover": "assets/cover.png", "previews": [] },
  "kdp": { "interior": null, "cover": null },
  "purchaseUrl": null
}
```

This is a **design example**, not a real product, publication, or claim that WEC already exports this format. The owner must review all fields and images. `publicationStatus` remains `draft` until explicit approval; approval does not itself deploy.

## Integration stages

1. **WEC:** implement validated owner-only handoff export. Reject missing files, unsafe ZIP paths, unsupported media, oversized payloads, and secrets. Preserve source project. Add fixture tests.
2. **Cozy:** implement a local/CI importer that validates schema, file hashes, image paths and approved status; maps into the existing catalog data model; generates a reviewable GitHub PR. No direct production write from the browser.
3. **Owner review:** preview the resulting catalog change and merge the PR. Only verified purchase URLs may be published. Keep prelaunch robots restrictions until separately approved.
4. **KDP:** attach reviewed print files and metadata to the owner package; do not claim direct KDP API submission or automatically publish to KDP.
5. **Verification:** run WEC tests, Cozy `npm run check:release`, and inspect the actual deployed site separately. Cloudflare GitHub status alone is not a live-site verdict.

## Definition of done for a working connection

A real existing WEC project can be exported, independently validated and imported into a Cozy preview PR, with correct assets and metadata; the public site does not access private WEC data; and the owner explicitly approves publication. Until these checks pass, the systems are **not connected**.
