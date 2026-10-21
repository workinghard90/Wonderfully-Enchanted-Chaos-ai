# Configuration and HTTP API

Environment variables are read at process start. `.env.example` is a template,
not an automatic loader. Do not commit populated environment files.

| Variable | Default / purpose |
| --- | --- |
| `WEC_STUDIO_TOKEN` | Optional on loopback; required, 32+ characters outside loopback. Sent as `X-WEC-Token`. |
| `WEC_DATA_DIR` | `~/.wec-studio`; stores `studio.sqlite3`. CLI `--data-dir` overrides. |
| `WEC_FRONTEND_ORIGIN` | Unset; one exact bare HTTPS frontend origin for CORS, no path, credentials, query or fragment. |
| `WEC_COMFY_URL` | `http://127.0.0.1:8188`; CLI `--comfy-url` overrides. Keep the worker on a private network/VPN. |
| `WEC_FFMPEG_THREADS` | `2`; positive integer encoder thread count for assembly/finalization. |
| `WEC_CLOUD_ENDPOINT` | Unset; custom cloud image gateway endpoint, not a provider built into the app. Use HTTPS. |
| `WEC_CLOUD_API_KEY` | Unset; backend/CLI secret, never frontend config. |
| `PORT` | Docker only, defaults to `8765`. Native studio uses `--port 8765`. |

`wec-studio --host` defaults to `127.0.0.1`. `WEC_API_BASE` is **not** a backend
environment variable: `window.WEC_API_BASE` in `studio_web/config.js` controls
only the optional separate static frontend. Leave it empty for same-server use.
Separate backends must use HTTPS. Do not place the access token in this file.

All project/backup endpoints require the token when configured. Health and
static dashboard assets are public. A missing/incorrect token returns 401.
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
| GET | `/api/backup` | Complete project JSON export, schema version 1 |
| OPTIONS | API paths | Preflight for exactly configured frontend origin |

Create/update bodies contain `title` (1–150 characters), `story` (1–30000),
`duration` (finite number, >0 and <=3600 seconds), and `scenes` (integer 1–100).
Each scene needs at least 1/30 second. Request bodies are limited to 128 KiB.
Invalid data returns 400, missing records/routes return 404. Production dry-runs
only list tasks; they do not assert that media, models or credentials exist.
No HTTP endpoint submits generation, uploads local files, deletes projects,
restores backups or serves rendered movies.

Backup exports include story content; store securely. To preserve a SQLite DB
copy, stop the studio first or use SQLite's backup API. Do not blindly copy a live
database. JSON backup restore/import UI is not implemented.
