# Configuration and HTTP API

Environment variables are read at process start. `.env.example` is a template,
not an automatic loader. Do not commit populated environment files.

| Variable | Default / purpose |
| --- | --- |
| `WEC_STUDIO_TOKEN` | Optional on loopback; required, 32+ characters outside loopback. Sent as `X-WEC-Token`. |
| `WEC_DATA_DIR` | `~/.wec-studio`; stores `studio.sqlite3`. CLI `--data-dir` overrides. |
| `WEC_FRONTEND_ORIGIN` | Unset; one exact bare HTTPS frontend origin for CORS, no path, credentials, query or fragment. |
| `WEC_ENABLE_IMAGE_GENERATION` | `0`/unset; only `1` opts into studio Cloudflare generation. Credentials are also required. |
| `WEC_CLOUDFLARE_ACCOUNT_ID` | Unset; Cloudflare account ID, 32 hexadecimal characters. Server only. |
| `WEC_CLOUDFLARE_API_TOKEN` | Unset; scoped Workers AI token. Server secret, never frontend config. |
| `WEC_COMFY_URL` | `http://127.0.0.1:8188`; CLI `--comfy-url` overrides. Keep the worker on a private network/VPN. |
| `WEC_FFMPEG_THREADS` | `2`; positive integer encoder thread count for assembly/finalization. |
| `WEC_CLOUD_ENDPOINT` | Unset; custom cloud image gateway endpoint, not a provider built into the app. Use HTTPS. |
| `WEC_CLOUD_API_KEY` | Unset; backend/CLI secret, never frontend config. |
| `PORT` | Docker only, defaults to `8765`. Native studio uses `--port 8765`. |

`wec-studio --host` defaults to `127.0.0.1`. `WEC_API_BASE` is **not** a backend
environment variable: `window.WEC_API_BASE` in `studio_web/config.js` controls
only the optional separate static frontend. Leave it empty for same-server use.
Separate backends must use HTTPS. Do not place the access token in this file.

All project, image and backup endpoints require the token when configured.
Health and static dashboard assets are public. A missing/incorrect token returns 401.
Authorization uses a single shared secret, not user accounts. CORS limits browser
response access; it is not a substitute for authentication.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/health` | `{ "ok": true }`, no secrets |
| GET | `/api/projects` | Project summaries |
| POST | `/api/projects` | Create a project |
| GET | `/api/projects/{id}` | Full project including story |
| POST | `/api/projects/{id}` | Update existing project |
| GET | `/api/projects/{id}/plan` | Deterministic scene plan |
| GET | `/api/projects/{id}/dry-run` | Planned steps only; no rendering or filesystem writes |
| POST | `/api/projects/{id}/scenes/{scene-id}/image` | Upload raw JPEG/PNG/WebP bytes; stores normalized JPEG |
| GET | `/api/projects/{id}/scenes/{scene-id}/image` | Authenticated JPEG bytes, no public file URL |
| POST | `/api/projects/{id}/scenes/{scene-id}/image/remove` | Remove an attached image; no body required |
| GET | `/api/generation` | Readiness, fixed model name, today’s attempt count/limit; no credentials or remote probe |
| POST | `/api/projects/{id}/scenes/{scene-id}/generate` | Confirmed single-image request; JSON `prompt` of 1–2048 characters, at most 16 KiB |
| GET | `/api/backup` | All stories and embedded images, schema version 2 |
| POST | `/api/restore` | Import version 1 or 2 JSON; returns new project IDs |
| OPTIONS | API paths | Preflight for exactly configured frontend origin |

Create/update bodies contain `title` (1–150 characters), `story` (1–30000),
`duration` (finite number, >0 and <=3600 seconds), and `scenes` (integer 1–100).
Each scene needs at least 1/30 second. Project request bodies are limited to
128 KiB. `images` on a project and `image_asset` on each planned scene contain
metadata, never filesystem paths. The original `image`/`video` CLI plan fields
remain unset; stored scene images do not submit video rendering jobs.

Changing the story or scene count of a project with images returns 409 unless
`reset_images: true` is explicitly supplied. This clears attached images in the
same transaction as the edit. Title/duration edits retain them. The UI asks for
confirmation before sending the reset flag.

Uploads are limited to 8 MiB and 32 million pixels, normalized to JPEG at most
2048 pixels per edge and 2 MiB each. Total stored images are limited to 16 MiB
per studio, with at most 100 projects. A backup request body is limited to
40 MiB. Image/restore operations are serialized; concurrent uploads/imports may
return 429 and should be retried after the other operation finishes. These
bounds do not replace proxy-level rate and connection limits.

Invalid input returns 400, missing records/routes 404, conflicts 409 and size or
storage limits 413. Production dry-runs only list tasks; they do not assert that
media, models or credentials exist. The optional `/generate` endpoint submits
one image prompt to Cloudflare; it does not render movies. No HTTP endpoint
deletes projects or serves rendered movies.

Version 2 JSON exports embed normalized JPEGs as base64 in each project's
`scene_images` array. Restore accepts old version 1 text-only exports and version
2 exports. It validates the entire import and atomically inserts new projects
with fresh IDs; existing projects are never overwritten. An invalid image or
quota failure imports nothing. It does not trust imported paths or filenames.
See [scene images and recovery](SCENE_IMAGES.md).

Backup exports include story and image content; store securely. To preserve a
SQLite DB copy, stop the studio first or use SQLite's backup API. Do not blindly
copy a live database. Manual JSON backup/restore is available in the dashboard;
automatic backups and durable hosting are separate responsibilities.

## Optional image generation

See [Cloudflare images](CLOUDFLARE_IMAGES.md) before enabling. The studio uses
only FLUX.1 schnell, four steps, with no automatic retries, fallback model,
batch generation, image-reference upload or paid gateway fallback. Existing
scene images cause 409 before any provider call. Story/scene-count changes while
a call runs discard its result rather than attaching it to a changed scene.

The daily limit is 20 provider attempts per studio database, resetting at
midnight UTC. Failed/timeout requests consume an attempt. Quota exhaustion and
concurrent media operations return 429. Owner setup/access errors return 503,
provider failures 502, and provider timeouts 504. Provider error bodies are not
returned to the browser. Upload/restore limits still apply to generated images.

Counters are not included in project backups and reset if the hosting database
is lost. They are not a billing cap: the app cannot verify a Cloudflare plan.
Stay on Workers Free for the provider-enforced free allowance. No account
creation, billing change, credential provision or inference is done by installing
the package or requesting readiness.
