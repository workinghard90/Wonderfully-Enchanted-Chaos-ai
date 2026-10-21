# Coloring Book Studio

Open `/coloring/` on the same server as the story/video studio, or use the
**Open Coloring Book Studio** link on its home page. It opens a separate tab
so an existing story draft or movie progress page stays open. The return link
also opens a new tab to preserve the coloring workspace.

On iPhone, open the hosted HTTPS URL in Safari. Choose **Add coloring pages**
and select PNG, JPG or WebP files from Photos or Files. Files-app HTML previews
may disable scripts; use the hosted page rather than a downloaded HTML file.
HEIC must be exported as JPG/PNG first. Empty, unsupported, corrupt and oversized
files show an error; valid files in the same selection still load.

1. Set a title and add your finished illustrations.
2. Use **Move earlier**, **Move later** and **Remove** to set the order.
3. Choose whether to include a blank back after every illustration.
4. Download the **artwork ZIP**. It contains byte-identical originals in the
   current order and a JSON manifest with the title, dimensions and settings.
   Use **Open a saved WEC book ZIP** to continue editing it later; keep originals too.
5. Choose **Print / Save as PDF**. Use Letter, 100% scale, no browser margins,
   and no browser headers/footers. Use the browser or system print controls to
   save the resulting PDF. The book title is used as the document title.

The print layout contains one 8.5 × 11 inch sheet per illustration and optional
blank back, with a 0.5 inch inset. Images keep their aspect ratio and are not
cropped. PPI estimates use the actual fitted size inside 7.5 × 10 inches; they
are informational and do not resample or certify the artwork.

## Storage, privacy and cost

Artwork is processed in the open browser tab. Import, order, ZIP and print make
no backend requests and consume no WEC generation attempts. Loading the page
and assets still requires an available server; it is not a fully offline PWA.
The packaged assets use the existing content security policy and need no CDN.

The browser automatically saves **one current coloring book** in IndexedDB,
including the title, original artwork bytes, order and blank-back setting. It
reopens on the same origin/browser after a reload. Wait for **Saved on this
device** before leaving. **Save on this device** retries a failed write, and
**Load saved book** explicitly reloads the last committed copy. Title edits are
saved after a short pause; other changes are queued immediately. Pending writes
can be lost if the tab is terminated, so the saved status matters.

Browser cleanup, private browsing, storage limits and eviction can remove or
block this copy. Save a ZIP outside the browser too. It is not encrypted or
protected by the story access token: anyone using this browser/origin may reopen
it. **Turn off & remove device copy** deletes the stored artwork and pauses
saving; the currently open pages remain exportable. **Enable device saving**
explicitly stores the open book again. A confirmed **Clear pages** updates the
device copy to empty so deleted pages do not reappear on refresh.

A revision guard rejects stale-tab writes rather than silently replacing a
newer copy. On a conflict, download your current ZIP, then load the saved book or
reload. This is one book per browser/origin, not a multi-book library. Use ZIPs
to keep multiple projects or transfer them to another device. Story/device
backups and server restore do not include coloring pages; no cloud sync or
transfer from scene images is implemented.

## Reopen a book ZIP

**Open a saved WEC book ZIP** restores the original title, order, image names,
bytes and blank-back setting. Replacing a nonempty workspace requires
confirmation. The complete archive, manifest and every image are validated
before any open page changes; an error keeps the entire current book and device
save intact. This also accepts the schema-version-1 ZIPs from the previous
integrated Coloring Book Studio.

The reader accepts only unmodified WEC stored-entry ZIPs up to 81 MiB, with a
bounded number of entries and an explicit manifest. It checks local/central
headers, CRCs, unique fixed page names, page references, dimensions and actual
image decoding. It never extracts paths onto disk, decompresses unknown input,
or fetches URLs from the archive. Encrypted, compressed, ZIP64, duplicate,
traversal-path and unsupported-schema archives are rejected. Unzipping a WEC
book for inspection is fine; rezipping it with another app can change its format
and make it unsupported. Keep the original export.

Bounds: 100 illustrations, 10 MiB per file, 80 MiB total file bytes, 24 megapixels
per image and 100 megapixels total. Imports are sequential, and mutating/export
controls are disabled while an operation is running. These bounds reduce memory
pressure but do not guarantee a particular phone can print the maximum book.

## Deployment and Windows

The existing Python package and Docker image include all five coloring assets.
The server serves only fixed asset paths: `/coloring`, `/coloring/`,
`/coloring/app.js`, `/coloring/zip.js`, `/coloring/project-store.js` and
`/coloring/style.css`. Static assets
are public like the story shell; all existing story/media API routes remain
protected by the configured studio token. No upload endpoint, generation
service or new Render resource is created.

Use the normal Windows installation in `docs/WINDOWS.md`, start `wec-studio`
and visit `http://127.0.0.1:8765/coloring/`. No Node build is required.
For Render, merge the reviewed integration first, preserve project backups and
finished movies, then deploy the existing service when no render is active.
Do not apply a paid service template merely to enable this page.

## Verification and limits

The browser regression covers imports, errors, ordering, original-byte ZIP/CRC
validation with Python's independent ZIP reader, loading-operation exclusion,
no artwork/API traffic, clear cancellation, layouts at phone/desktop widths,
and a four-sheet Letter PDF fixture with blank backs. HTTP tests cover packaged
assets, content security policy, exact-path routing and protected APIs. Wheel
installation is checked outside the source tree. ZIP-parser fixtures cover CRC
damage, truncation, bounds, invalid manifests, duplicate/traversal paths,
dimensions and unsupported compression using an independent Python ZIP writer.
Real IndexedDB browser tests cover reload, bytes/order/settings, bad import
atomicity, corrupt stored images, stale-tab conflicts, quota failures/retries,
pause/resume, explicit clear and blocked storage with usable ZIP workflows.
All these operations use local fixtures and make no image or movie API calls.

Browser print is a prototype, not a KDP-certified interior. Page-count rules,
bleed, gutter, front matter, cover dimensions and final print acceptance require
a separate publishing review. A PPI estimate alone is not a publishing audit.
Chromium phone-size checks do not replace testing on physical iPhone Safari.
