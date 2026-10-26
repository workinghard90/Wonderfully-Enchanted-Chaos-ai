# One studio for videos, artwork and books

Open **`/`** (or `/studio/`) on the same studio host. The original story/video dashboard
at `/video/` and coloring editor at `/coloring/` remain available. This release adds
a multi-project workspace without migrating or replacing either older store.

## Create and keep a project

1. Choose Faceless video, Art collection, Coloring book or Storybook.
2. Name it and add your author/creator name. Save a character description and
   visual style plus an approved reference picture to reuse in other projects. Prompts include these descriptions;
   the current image provider does not accept reference images.
3. Write/paste content or use the optional **Start from an idea with AI** section.
   Drafts are reviewed before any pictures are generated. Book drafts append
   pages; replacing a video draft requires confirmation.
4. Add pictures or generate **one** picture after reviewing its full prompt and
   confirming the provider request. There is no automatic image batch or retry.
5. Save and download a **project JSON backup**. It includes incomplete pages,
   text, prompts, character settings, cover settings and original image bytes.
   Opening a backup creates a separate project; existing work is kept.

Projects and character descriptions are stored in IndexedDB in this browser.
They survive an ordinary refresh and a server restart, but browser cleanup,
private mode and quota limits can remove or prevent a save. There is a visible
save status, an explicit Save button, debounced text saves, a before-leaving
warning and revision checks to prevent an older tab overwriting a newer save.
If saving fails, download the current edits as a backup before leaving. Do not
use this device store on a shared browser profile: it is not encrypted or scoped
to the studio access token. It does **not** sync across phones/computers.

The library loads summaries, not every project's full images. Up to 80 pages
per book/art project, or seven video scenes; 10 MiB and 12 megapixels per image;
30 MiB and 320 megapixels across a project, including a separate cover image.
These bounds accommodate forty typical 300-PPI Letter illustrations while
bounding CPU exports. The browser decodes image inputs to check dimensions;
large imports can still be demanding on an iPhone. Keep the backup/originals.

## Four delivery paths

| Format | What the app produces | Further review/setup |
| --- | --- | --- |
| Faceless video | Original script arranged into scenes, attached/generated pictures, a saved server snapshot rendered, previewed and downloaded inside the shared workspace | Configure Piper/FFmpeg; existing 35-second/seven-scene bounds and render allowance apply. Still-image movies are not AI character animation. |
| Art | Individual picture prompts, original-byte artwork ZIP and optional Letter portfolio PDF | Visually review character consistency and source resolution. |
| Coloring book | Ordered grayscale Letter PDF with two opening pages and a blank back per illustration; original artwork ZIP | New line art is required for a coloring variant of colored artwork. Grayscale conversion does not create coloring outlines. |
| Storybook | Ordered pictures plus editable page text in a Letter color PDF; artwork ZIP | Review story, text fit, image resolution, color print cost and minimum pages. |

**Use this idea in another format** creates a separate project copy. Text, visual
descriptions and prompts are reused. Colored pictures are omitted from coloring
variants. Video variants preserve pictures only when the scene narration exactly
matches the original page text; otherwise new scenes need pictures. Narration is
split deterministically, not rewritten by the scene planner. Review boundaries
before generating images. The video handoff validates and restores a complete
server project transactionally; rejected handoffs do not leave partial projects.

The artwork ZIP contains original files and a manifest. Use the JSON backup to
keep all editor settings. The older coloring ZIP importer retains its original
100-megapixel limit; high-resolution ZIPs from this workspace can exceed that
limit. Its JSON backups support the new 320-megapixel budget. Existing WEC
coloring ZIPs can be imported into this workspace within its limits; third-party
compressed/ZIP64/encrypted ZIPs are unsupported.

## Paperback PDFs and covers

PDF generation runs on the authenticated backend using ReportLab and the bundled
DejaVu Sans font. No print-dialog scaling, image upscaling or model call is used.
Interior size is 612 x 792 points (8.5 x 11 inches), no bleed, with 0.75-inch
margins. Images are oriented, contain-fitted without cropping, and transparent
backgrounds are composited. Coloring images become grayscale. Short opening
pages use both sides of the first sheet. Only coloring illustrations get blank
backs. Storybook text wraps with an embedded font and rejects overflow,
unsupported symbols and unbreakable words instead of silently clipping them.

The cover section accepts a separate cover image, or uses the first illustration,
and a back-cover description. It exports one wraparound PDF with 0.125-inch
outer bleed and a reserved 2 x 1.2-inch white barcode area. It never invents an
ISBN and includes no spine text. Template dimensions match this app's calculated
interior page count:

- Coloring: black ink on **white paper**, spine = pages x 0.002252 inches.
- Story/art: **premium color on white paper**, spine = pages x 0.002347 inches.

Different paper, trim or standard-color settings require another cover. The
template is a starting layout, not automatic KDP approval. Check cover text,
PPI, page count, minimum pages and metadata in KDP; order a physical proof.
Small books may export as review PDFs while still below KDP's minimum pages.
The PPI shown in the editor is a conservative estimate for the planned interior
image box; the cover's fitted PPI must be checked separately. Original pixels do
not establish native AI resolution or restored detail.

Official references: [cover sizing and spine formulas](https://kdp.amazon.com/en_US/help/topic/G201953020),
[print options](https://kdp.amazon.com/en_US/help/topic/G201834180).

## Configure AI deliberately

The existing Cloudflare image settings remain unchanged. Creative picture
requests share the same **20-attempt daily UTC allowance** with old video-scene
image generation. They return the provider's original bytes to this browser;
they do not normalize them through the server story-image store.

Optional scripts and page drafts use a separate switch:

```text
WEC_ENABLE_TEXT_GENERATION=1
WEC_CLOUDFLARE_ACCOUNT_ID=<host secret>
WEC_CLOUDFLARE_API_TOKEN=<host secret>
WEC_STUDIO_TOKEN=<at least 32 characters>
```

Text drafting is OFF by default, uses `@cf/meta/llama-3.1-8b-instruct-fp8`, and
allows five confirmed attempts per UTC day. One request produces a video script
or 1-12 art/book page drafts. Inputs/output size and schema are bounded. Invalid,
truncated, failed and timed-out responses are not retried and do not replace
existing pages. Attempts count even if a provider fails. These application
allowances are **not** a dollar spending cap: check the provider account's plan
and billing before enabling. Text/image generation and rendering remain
independent; no service is provisioned or enabled by this PR.

[Cloudflare model](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/)
and [REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).
No new live text/image inference was run during implementation. Tests mock the
provider; they verify the integration and failure behavior, not creative quality.

## Development and deployment

Install normally (`python -m pip install .`); ReportLab and the font are packaged.
Windows uses the existing `py -m venv .venv` setup from the README. No Node build
or external CDN is needed. All routes/assets are served by the same backend.
The existing Docker build installs the new dependency with the package.

New authenticated APIs: `POST /api/creative/plan`, `/draft`, `/image`, `/pdf`,
`/cover`, `/video`; `GET /api/creative/text`. PDF/cover/video bodies are bounded
at 42 MiB. Provider/plan bodies are bounded at 128 KiB. Image/draft routes require
a 32-character studio token; provider secrets never enter the browser, backup
or URL. Exports and generation share the handler's nonblocking media-operation
lock. No generation service is exposed publicly and no deployment is performed
by this branch.

## Verification for this integration

- 127 Python tests passed, including existing media, restore, worker, provider
  and new creative HTTP/PDF tests. No paid/live generation calls.
- `browser_creative.cjs` passed at 390-pixel phone and 1440-pixel desktop widths:
  all four formats, original-byte backups/ZIPs, PDF/cover downloads, character
  profiles, refresh, restore-as-new, cross-tab conflicts, AI draft fixtures,
  format variants, video handoff and one-request image failure preservation.
- All eight pre-existing browser/ZIP/print scripts passed locally.
- An isolated installed wheel passed `pip check`, version/asset/font checks,
  artwork CLI help and a real ReportLab PDF export outside the checkout.
- A synthetic 40-image, 288-megapixel line-art project produced an 82-page
  Letter interior and a 17.434664 x 11.25-inch wrap. Peak local process RSS was
  about 202 MiB. This is a fixture benchmark, not a Render performance guarantee.
- Rendered the current phone/desktop UI and sample interior/cover PDFs for
  visual review. No credentials, user artwork or generated test exports committed.

This branch also incorporates the source changes from the unmerged
`feature/high-resolution-artwork` PR #14. Review the combined branch instead of
merging both independently; the package version stays at 0.12.0. The private
GPU command is available, but remote phone control of that worker and live
high-resolution inference are not added or tested by this integration.

After review/merge, deploy the approved commit to the existing host, visit
`/studio/`, import one project, and verify a local export before enabling any
new AI setting. Keep the old backup on the phone. Publishing to KDP/TikTok and
cross-device/cloud synchronization are separate actions, not automated here.

## Video validation

Planning, AI video drafts and render admission now share the web renderer's
100-word/1000-character total and 25-word/200-character per-scene limits.
Changing narration or scene count after splitting requires splitting and
reviewing pictures again before video handoff. A rejected handoff creates no
server project. Actual speech duration is still checked during rendering.
See [engineering audit and roadmap](ENGINEERING_AUDIT.md).

## Central entrance and existing projects

The site root (`/`) now opens the shared Creative Studio with Video, Artwork,
Coloring, and Storybook choices. `/studio/` remains a compatible alias and uses
the same browser project library.

“Continue an existing project” links to `/video/` for saved stories and video
renders, and `/coloring/` for original coloring projects. Both tools include an
“All studios” link back home. The older renderer remains available at `/video/?project=…`;
older `/?project=…` bookmarks still open the correct story editor.

This change unifies navigation, not storage: existing projects remain in their
current stores. No automatic migration or deletion occurs. Download backups
from each tool before moving projects. Consolidation of project storage remains subsequent work. Existing import controls remain available in the shared library.

## Render videos without leaving the workspace

After splitting narration and attaching every scene picture, choose **Render
video** and confirm the local render attempt. The studio checks availability,
active jobs, daily allowance and saved-movie capacity before creating the server
copy. The existing server still enforces all limits. No automatic retries or new
image requests occur. If starting fails after preparation, the saved story copy
remains accessible through `/video/`; no browser originals are removed.

The **Video renders** panel lists all server projects, rather than implying that
a finished movie reflects whichever browser project is currently open. Progress
polls while jobs are active. Cancel, preview, download MP4 and remove-server-copy
controls use the existing authenticated endpoints. Playback uses a temporary blob
URL; tokens are not placed in media URLs. Preview URLs are revoked on replacement,
removal and page exit. After reloading, use **Refresh renders** to reconnect.
A polling failure stops polling and offers refresh; it never starts another job.

Rendering uses a saved snapshot. You can edit the browser project after submission
without changing the movie underway. Download movies separately: browser JSON
backups contain source pictures/text, not MP4s. Rendering remains a still-image
movie with narration/captions and optional ambience, not AI character animation.

## Approved character references

In **Character & visual style**, upload an approved PNG/JPG/WebP reference or
choose **Use as approved reference** under an existing page picture. Save the
character profile to keep the name, description, style and original reference
bytes together. Select that profile in any of the four project formats to copy
it into the project. Applying a profile replaces character/style/reference only,
not page artwork; replacing existing settings asks for confirmation.

Each page with artwork offers **Compare with approved reference**. Review key
features such as Pip's curl, eyes, arms and colors before approving artwork for
publication. This is a manual visual comparison, not an automatic consistency
score. The current Cloudflare model receives text descriptions only; reference
images are never sent to that model and do not condition generation.

References remain local, survive refresh, and are included in project JSON
backups and format variants. Restore a project backup on another device, then
save its character profile there to reuse it. Page ZIP/PDF/video exports do not
include the reference image as an output page. Changing/removing a project
reference does not alter previously saved profiles or other projects. Older
text-only profiles and backups continue to work without a reference.

Reference images use the same 10 MiB / 12 megapixel per-image limit and count
toward the project's existing 30 MiB / 320 megapixel budget. Invalid references
are rejected before a restored project is saved. Keep downloaded backups: this
is browser storage, not cloud synchronization.
