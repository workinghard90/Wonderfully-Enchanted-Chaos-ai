# Deployment preparation — no deployment performed

The simplest first online setup is **one backend serving both the dashboard and
API** over HTTPS. iPhone and Windows then share the same SQLite database.
The dashboard is a story planner; this deployment does not provide AI rendering.

1. Review the integration PR and its CI. Keep secrets outside Git.
2. Choose an approved HTTPS host with durable storage and review its costs.
3. Generate a 32+ character `WEC_STUDIO_TOKEN` and set `WEC_DATA_DIR` to the
   persistent mount. Use the same token after redeploys.
4. Put the studio behind HTTPS termination, access controls and request limits.
   Its standard-library HTTP server is not an Internet-facing hardened web
   server. Keep its origin port private; use the host's reverse proxy.
5. Run `wec-studio --host 0.0.0.0 --port 8765 --data-dir /var/data` only behind
   that protected proxy. A weak/missing token blocks non-loopback startup.
6. Check `/api/health`, confirm unauthenticated `/api/projects` returns 401,
   then save a test story. Restart the service and verify it remains present.
7. Open the same HTTPS URL from iPhone Safari and Windows. Test backups and
   recovery before relying on the service for important work.

## Docker and Render template

`Dockerfile` packages the dashboard as a non-root user. Its startup command
honors `PORT` and `WEC_DATA_DIR`. Mount writable storage at `/var/data`, owned
by UID 10001. It does not install FFmpeg, ComfyUI, GPU libraries or Piper.
No container runtime was available during local integration, so Docker image
build/launch must be verified on the target host.

`render.yaml` is an optional **paid-capable starter + persistent disk** blueprint.
It sets `/api/health` and `/var/data`; enter the token through the host's secret
settings (`sync: false`). Do not apply the blueprint or approve billing until
you review current pricing and authorize deployment. Nothing here automatically
deploys on PR creation. Ephemeral filesystems lose SQLite projects on redeploy.

## Optional separate static frontend

Copy **all** files in `wec_engine/studio_web/` to a static host. In its `config.js`:

```javascript
window.WEC_API_BASE = 'https://your-backend.example';
```

Set `WEC_FRONTEND_ORIGIN=https://your-frontend.example` on the backend, without a
trailing slash or path. CORS accepts exactly that HTTPS origin and allows only
`Content-Type` and `X-WEC-Token` headers with GET/POST/OPTIONS. Asset links are
relative, so the static UI can live in a subdirectory. Configure the static
host's CSP to allow the backend in `connect-src`; the backend's own dashboard
CSP permits same-origin connections only. Do not wildcard authenticated origins.
Prefer the one-server setup until there is a concrete reason to split it.

## Private local worker

Keep ComfyUI on loopback or a private VPN. Never publicly forward port 8188.
The web dashboard has no rendering endpoint. CLI generation must run where the
private worker is reachable with validated workflows and licensed models. The
hosted dashboard cannot reach a Windows PC's `127.0.0.1`; that address refers to
the host itself. Designing a durable job queue and authenticated private worker
connection is future work, not part of this deployment template.

## Operational limits

One shared token grants all project access; no accounts, per-user permissions,
rate limiting or audit trail are implemented. Use proxy-level protections and
keep sensitive content out until access controls suit your needs. Export JSON
backups, keep independent storage and test a recovery procedure. Automatic
backup schedules, database replication, multi-instance
SQLite hosting and browser rendering jobs are not implemented. Use one instance
with one durable database. Do not expose the database or generated files as
static assets.

## Manual recovery on temporary storage

The dashboard's **Download backup** includes saved stories and attached scene
images. **Restore backup** accepts earlier text-only exports and new image
exports, creating new copies without replacing existing projects. See the
[recovery walkthrough](SCENE_IMAGES.md). Keep originals of uploaded photos:
backups hold optimized JPEG copies, not original files.

Free or otherwise ephemeral hosting still loses the SQLite database when the
host replaces its filesystem. This feature does not add a persistent disk or
automatic backup. Download a backup after edits and image uploads, before a
restart or redeploy. The free test service uses `/tmp/wec-studio`; do not apply
the paid `render.yaml` blueprint as part of this feature update. A manual
redeploy can erase its current test projects, so export them first.

A separate static host must permit `blob:` in its image CSP as well as the
backend HTTPS origin in `connect-src`. The bundled same-server CSP already
allows authenticated image fetches and local blob previews. Never put a token
in an image URL, query string or static configuration file.
