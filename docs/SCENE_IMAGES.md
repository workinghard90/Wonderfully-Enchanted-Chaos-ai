# Scene images and portable backups

The dashboard accepts pictures you supply. Optional AI image generation needs
[Cloudflare owner setup](CLOUDFLARE_IMAGES.md) and a first live verification. Web
video export is still unconnected. No external service or paid API is called
by image upload, preview, backup or restore.

## iPhone workflow

1. Enter a title and story, choose duration/scene count, then tap **Save project**.
   The header button stays visible when you scroll.
2. Tap **Preview scenes & images**. Scroll to **Scene images**, then tap
   **Upload image** on a scene. Choose a JPG, PNG or WebP from your photo/file
   picker. Uploads are processed immediately; there is no second submit button.
3. Wait for **Image attached** and its preview. Use **Replace image** or
   **Remove image** on that scene to make changes.
4. Tap **Download backup** after saving edits or attaching images. Keep the JSON
   file in Files/iCloud Drive or another location you control. The backup
   contains all saved projects, including their attached pictures.
5. To recover after a server reset, open the studio, tap **Restore backup**,
   choose the JSON in Files, and confirm. Imported projects appear as new copies.
   Existing saved projects stay in place. This also works with earlier text-only
   backups, including version 1 exports.

A file picker may label its final action **Add**, **Open** or **Choose**. HEIC,
Live Photos and videos are not supported uploads. If your photo picker does not
provide a JPEG, convert/export a JPEG/PNG copy first. Keep original photos; WEC
stores optimized JPEG copies up to 2048 pixels per edge, strips EXIF metadata
and flattens transparency onto white. Backups contain these optimized copies.

Save edits before previewing or uploading. Changing story text or scene count
can change scene assignments, so the studio asks before clearing attached
images. Download a backup first to keep the previous version. Changing only the
title or duration keeps images. Unsaved edits are not included in backups.

## Limits and recovery behavior

| Item | Limit or behavior |
| --- | --- |
| Uploaded file | JPEG/PNG/WebP, up to 8 MiB and 32 million pixels |
| Stored copy | JPEG, at most 2048 pixels per edge and 2 MiB |
| Studio image storage | 16 MiB total across all projects |
| Projects | 100 per studio |
| Backup import | JSON version 1 or 2, up to 40 MiB |
| Restore | Entire import validated before one transaction; new IDs, no overwrites |
| Failed import | No projects/images added |
| Repeated import | Another set of copies; counts toward the same limits |
| Access | Same studio token protects stories, image bytes, backups and restore |

Malformed images, unknown/duplicate scene IDs, corrupt base64 and oversized
backups are rejected. Restore accepts WEC JPEG backup images, not arbitrary
paths. Repeated export/import preserves the stored JPEG bytes without another
lossy conversion. Imported timestamps are not used to replace saved records.

To test recovery, download a backup with one attached image, restore it, open
the new project and check the text and picture. Your original project should
remain. A server reset is unnecessary for this test.

The SQLite migration adds the image table while keeping existing projects.
Projects and images share the same database and storage lifetime. Free test
hosting still needs downloaded backups: this update adds neither durable
storage nor automatic sync. Opening another device on the same server accesses
the same database; it does not synchronize separate installations.

Uploaded images currently support dashboard preview and backup only. Producing
movies still uses CLI manifests with explicit media paths. A private generation
worker, authenticated web job execution and video delivery require separate
implementation and testing.
