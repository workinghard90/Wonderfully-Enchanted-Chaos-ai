# Phase 10 — Hybrid Cloud Foundation

## What is included
- Same responsive UI on iPhone and Windows, served from the backend by default.
- Optional **separate static frontend**: copy `wec_engine/studio_web/` to a static host, then set `window.WEC_API_BASE = 'https://your-backend.example'` in `config.js`.
- Backend restricts cross-origin browser access to the exact HTTPS origin in `WEC_FRONTEND_ORIGIN` (no wildcard).
- Authenticated `GET /api/backup` exports complete project records to a JSON download. Backups are **manual**, not scheduled; store separately.
- SQLite persists only if `WEC_DATA_DIR` points to durable storage. Free ephemeral hosting can lose projects.

## Local test (Python 3.10+)
```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
$env:WEC_STUDIO_TOKEN = 'choose-a-long-random-secret'
.\.venv\Scripts\wec-studio.exe
```
Open `http://127.0.0.1:8765` on the PC. Enter the token when prompted.

## Remote deployment checklist
1. Deploy the backend to an HTTPS service with persistent volume, set `WEC_STUDIO_TOKEN` to a long random secret and `WEC_DATA_DIR` to its persistent directory.
2. For static hosting, set `WEC_FRONTEND_ORIGIN=https://your-frontend.example` on backend and set `WEC_API_BASE` in frontend `config.js` to backend HTTPS URL. Keep the frontend and backend origins exact, with no trailing slash.
3. Use HTTPS only. Do not publish an unauthenticated backend; the token is stored per browser tab and is sent in request headers.
4. Export backups regularly. Do not treat the included Render starter + disk template as free; verify pricing before deploying.
5. Cloud rendering, real-time sync between *different* backend databases, multi-user accounts, automatic backup/restore, and GPU workers are **not** implemented.

For simplicity and fewer moving parts, deploying one backend that serves both frontend and API remains the recommended first live trial. This split option prepares a future free static frontend without promising a free persistent backend.
