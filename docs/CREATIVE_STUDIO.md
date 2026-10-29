# One studio for videos, artwork and books

Open **`/`** (or `/studio/`) on the same studio host. The original story/video dashboard
at `/video/` and coloring editor at `/coloring/` remain available. This release adds
a multi-project workspace without migrating or replacing either older store.

## Create and keep a project

1. Choose Faceless video, Art collection, Coloring book or Storybook.
2. Name it and add your author/creator name. Save a character description and
   visual style plus an approved reference picture to reuse in other projects. Prompts include these descriptions;
   standard generation uses those descriptions; choose Generate using reference to send the approved image to the reference-capable model.
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
score. Standard generation uses FLUX.1 schnell with text descriptions. The separate
Generate using reference action sends a resized copy to FLUX.2 klein 4B; character
matching still needs visual review.

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

## Reference-guided generation

Select or upload an approved reference, review the **Reference generation prompt**
on a page, then choose **Generate using reference**. Confirm the provider upload
and any replacement of existing artwork. The request uses Cloudflare
`@cf/black-forest-labs/flux-2-klein-4b` with the reference as `input_image_0` in
multipart form data and a fixed 1024×1024 output request. Standard **Generate this
picture** continues to use FLUX.1 schnell without sending the reference.

No additional service or environment switch is needed beyond the existing
`WEC_ENABLE_IMAGE_GENERATION=1`, Cloudflare account/token settings and a studio
token of at least 32 characters. Status means locally configured, not that the
new model has been successfully called on your account. Provider permissions,
allowance and availability can still reject requests. There is no automatic
fallback or retry.

The server validates the original (10 MiB / 12 megapixels), applies EXIF
orientation, resizes proportionally to fit 512×512, flattens transparency on white
and removes metadata before sending a PNG copy. The project reference retains
its original bytes. Input validation occurs before reserving an attempt; provider
failures consume an attempt. Both models and older scene generation share the
same 20-attempt UTC daily allowance. The UI refreshes attempt counts after requests.
This is an attempt counter, not a provider billing ledger.

Cloudflare's published rates checked October 26, 2026 list $0.000059 per input
512×512 tile and $0.000287 per output tile for Klein 4B. One input tile and four
output tiles gives an estimated $0.001207 list price per request before the
account's free allowance. Account billing and other usage determine actual cost.
The UI displays an approximate estimate; it is not a spending guarantee.

Official protocol and pricing sources:
- https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/
- https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/
- https://developers.cloudflare.com/workers-ai/platform/pricing/

Automated tests use mocked Cloudflare responses. Live account access and actual
character consistency require a first confirmed generation after deployment.

## When saving works but generation does not

Saving is local to your browser. Open **AI connection → Connect / check AI** to
authenticate and refresh setup/allowance status without generating anything.
Missing settings and the shared daily cap are shown explicitly. Errors remain
visible while scrolling. A request that receives no response headers within
90 seconds releases the controls without an automatic retry. Provider work may
already have consumed an attempt, so check before retrying.

See [the generation audit and current limits](GENERATION_TROUBLESHOOTING.md) for
verified findings, deployment evidence and the remaining live-account checks.

## Reuse saved artwork across studios

Each page or video scene now offers **Reuse saved artwork**. Choose another
saved project from this browser, preview its page pictures and select one.
Replacing an existing picture asks for confirmation. Cancel or Escape keeps the
current picture. The picker reads one source project at a time and copies the
original bytes into the destination, subject to the usual image/project limits.
No AI request is made. Source artwork, destination text and prompts remain unchanged.

This works across all four formats without an export/upload round trip. Save
source work first; the picker sees saved page pictures, not unsaved edits, covers
or reference-only images. Copies are independent, so later source edits do not
update the destination. Backups include the copied original. This is a first
step toward a shared asset library, not cloud sync or deduplicated storage.
Colored pictures remain colored originals; choosing one for a coloring project
does not convert it into line art. Review suitability and print quality before export.

## Guided video preparation and scene recovery

Video projects now show **Finish your video** near the top of the editor.
It tracks narration, whether scenes match the current script, and missing
pictures. Its next-step button takes you to the relevant script, split control,
first missing scene, or render control. Navigation does not generate images or
start rendering. Reopening a saved project reconstructs this progress.

Splitting again preserves a scene's original picture, prompt and ID only when
its narration uniquely matches one old scene and one new scene (ignoring
whitespace differences). Changed, merged, split or repeated scenes do not
silently inherit artwork. Review the confirmation and download a backup before
rebuilding. Cancelled or failed planning requests leave the current scenes intact.

This panel describes input readiness, not completed render status. Follow actual
jobs and downloads in **Video renders**. Server limits, narration timing and
provider availability are still checked by the existing APIs. No automatic
batch generation, retries, publishing or additional paid dependency is added.

## Book review before PDF export

The **Review before printing → Check book** panel checks editor pages locally:
missing pictures, missing storybook text, the existing 300 PPI interior target,
and exact duplicate files grouped by SHA-256. Page numbers refer to editor
pages, not printed sheet numbers. Each listed page issue has a navigation button.

Both interior and wrap-cover exports rerun the review. Missing required content
blocks the request before it reaches the server. Warnings allow an explicit
review export, so intentional repetition remains possible. Cancelling does not
submit an export, change artwork or remove pages. Project backups still support
unfinished drafts. Editing refreshes the panel's reminder to check again.

Hashing runs on this device, one picture at a time, and makes no AI request.
Different encodings/crops of the same drawing are not detected; this is not
near-duplicate matching. PPI checks describe the interior box, not cover fit.
Text overflow remains enforced by the PDF backend. These checks are not a KDP
certification: visually review the exported interior and cover before publishing.

## Track artwork review

Under each attached page or scene picture, **Artwork review** offers **Not
reviewed**, **Approved**, and **Needs changes**. Changing the selection saves it
with the project. The summary counts approved pictures. This is a manual note
about the current picture, not an AI quality score or publishing authorization.

Project JSON backups preserve these markers. Older backups default to Not
reviewed; unknown marker values are ignored. Uploading, generating or reusing a
replacement resets the destination to Not reviewed, even for identical bytes.
New format variants also start unreviewed. Re-splitting video scenes preserves
markers only for uniquely matching unchanged scenes whose pictures are retained.
Changing text, prompts or character settings does not review the picture for you.

Book checks warn about pictures not approved, and the video confirmation counts
outstanding reviews. Review exports/renders remain available after confirmation;
there is no automatic publishing. These markers cover page/scene pictures, not
separate covers or character reference profiles.

### Verified picture backups

New project JSON downloads include `backup_version: 2` and a SHA-256 checksum for every original page, cover and reference image. Restore checks every checksum before saving a new project. Missing or mismatched checksums reject the whole restore. A failed device save leaves the previously open project intact. Older backups without `backup_version` remain supported and explicitly report that checksums were unavailable; unknown backup versions are rejected.

Checksums detect accidental picture changes; they are not signatures, do not authenticate a backup, and do not verify story text or approval metadata. Keep a separate copy in Files or another off-device location: browser saves are still local, and opening a download does not prove it was saved off-device.

### Recovering an interrupted image request

Image generation now saves a receipt in the device project before contacting the provider. If the response is lost, reopen the saved project and choose **Check generated picture** on that page. This retrieves the saved result without making another provider call, including when the daily generation limit has been reached. If the page already contains artwork, attachment requires replacement confirmation. A failed device save keeps the current picture and receipt available for another recovery attempt. Valid receipt IDs survive project JSON backup/restore; new format variants do not inherit them.

The server saves the exact returned image bytes before sending its response. Matching repeated submissions reuse the receipt; changing the inputs under an existing request ID is rejected. A pending receipt blocks another generation on that page until it is recovered or explicitly dismissed. Dismissing a receipt does not cancel provider work or refund an attempt. A known provider failure clears the device receipt, but another attempt still requires generation confirmation.

Recovery holds the latest five results, each at most 8 MiB, for up to 24 hours. Small receipt records remain for 30 days (at most 1,000) to prevent repeated submissions from spending again after the image expires. Inputs are fingerprinted; raw prompts and reference uploads are not stored in the receipts. The receipt store shares the studio's existing authentication and SQLite data directory.

This is response recovery for the existing synchronous, single-process generation path. It does not resume a provider request after a server restart. When the same database survives, unfinished receipts become Interrupted and completed receipts remain available. Free Render storage can reset on redeploy or instance replacement, losing receipts and results; a missing result is reported without starting a generation. Save recovered pictures into the device project and download backups. Older API clients without a `request_id` retain their existing synchronous behavior and do not receive receipt recovery.

### Project recovery checkpoint

Open **Recovery checkpoint** beside the project editing controls and choose **Save checkpoint** before major edits. The current project is saved first, then its complete saved state is captured: original pictures, page order and text, prompts, review markers, cover, reference, character/style settings and any unresolved image receipts. There is one checkpoint per source project. Replacing or removing it requires confirmation; normal autosaves do not change it.

**Open checkpoint copy** saves a separate project before switching the editor. The current source project and checkpoint stay intact. The copy can be edited independently, starts without a checkpoint of its own, and retains any generation receipt only as an explicit recovery link. An unavailable or expired server image is never regenerated automatically. Save or download unsaved edits before opening a copy.

Checkpoints live in this browser on this device and may require up to another project's worth of local storage. Clearing browser data can remove both projects and checkpoints. A project JSON backup contains the version currently open, not the separate checkpoint. **Download recovery package** saves both versions in one file; alternatively, open a checkpoint copy and download its project backup. No hosting service, subscription or cloud synchronization is added.

The creative IndexedDB database upgrades from version 1 to 2 by adding a checkpoints store and preserving projects, summaries and character profiles. If an old tab blocks the upgrade, close the other WEC tabs and reload. Reload stale tabs after the update. Checkpoint writes and copy creation are transactional; revision and checkpoint identifiers prevent an older tab from silently replacing a newer checkpoint, and a failed copy leaves no partial project or summary behind.

### Portable recovery package

Under **Recovery checkpoint**, choose **Download recovery package**. The current edits are saved first; the saved project and checkpoint are read together. Finish saving the download to Files or a cloud drive you control. Use **Open project backup or recovery package** to restore it, including in a fresh browser. Both versions are validated before a new project and checkpoint are committed together; existing projects remain unchanged. A failed save leaves the current editor intact.

Packages include original pictures, cover, reference, prompts, text, review decisions, and unresolved receipt links for this project. They exclude other projects, standalone profiles, finished movies, and exported PDFs. Download those separately. The payload and pictures have integrity checksums, not encryption or proof of authorship. Retain packages privately. Downloads are limited to 90 MiB, and each project still has its normal limits. This is manual recovery, not automatic online storage; see `DURABLE_STORAGE.md` for the next stage.
