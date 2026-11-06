# WEC owner sign-in: deployment and credential rotation

## What changed

The main Creative Studio and legacy Video Studio now display **Owner sign in**.
Public/basic pages remain navigable without signing in. Server-owned saved
projects, automation receipts, stored recovery snapshots, paid provider
entrypoints and video server APIs retain their existing server-enforced
`X-WEC-Token` authentication. The one owner sign-in panel validates the token
against `GET /api/auth/status`, and the credential stays in tab-scoped
`sessionStorage` (not localStorage, URLs, GitHub, server-side logs or HTML).
**Lock owner features** clears the token in that tab; it cannot revoke token
copies in other tabs or on other devices.

This is a cleaner login *interface*, not a separate user-account system or
a substitute for changing the secret stored in Render. It is deliberately
backwards compatible with the existing studio token and does not migrate,
clear, or expose owner projects.

## Important security and capability boundaries

- Public/basic pages and the **client-only** tools are not protected by the
  server token. A browser already holding local IndexedDB projects can still
  access those local files using its browser tools; lock only removes
  authenticated *server* access. Do not use shared/public devices for projects.
- Signing in unlocks server endpoints that are already authorized for this
  owner token. It **does not activate or bypass** Cloudflare provider
  credentials, image/text generation limits, export approval requirements,
  review gates, publishing controls or paid operation authorization.
- A password typed into the owner panel travels over HTTPS to the backend
  as a request header; do not send it through chat, screenshots or code.
- The current server uses one shared `WEC_STUDIO_TOKEN`, not individually
  revocable accounts. Replacing it immediately revokes **all prior sessions**
  on future authenticated API requests after the new deployment is running.

## Safely rotate the owner token after this PR is merged

1. Pick a new unique random 32+ character secret in your password manager.
   **Never paste the actual value into a GitHub commit, chat or screenshot.**
2. In Render, open your existing `wec-studio-free-test` web service and
   choose **Environment** (not Blueprint or create a new service).
3. Edit/create **only** `WEC_STUDIO_TOKEN`, preserving the other entries.
   Keep `WEC_DATA_DIR`, provider secrets and disk mount settings unchanged.
4. Apply the environment setting using Render's controlled deploy/restart
   options **only when the release commit is approved for deployment**.
   The secret change requires a running service with the new environment to
   take effect and may restart the process.
5. Open the site over HTTPS, click **Owner sign in**, enter the saved new
   secret, and verify the panel reports owner features unlocked.
6. Click **Lock owner features**, confirm protected APIs return 401 and public
   pages remain available. Verify another device using the *old* token now
   receives 401. Old downloads and local files remain on their devices.

If the old token is unknown, **you do not need it to replace the Render
environment variable**. Before applying the change, make sure the new
secret is securely saved, or you could temporarily lock yourself out.

## Acceptance / non-goals

Expected tests: no-token 401, incorrect-token 401, valid owner sign-in 200,
explicit sign-out, public page 200, and no token leaks in response. No change
to paid provider activation, auto-publishing, Render spending, persistent
disk data, scheduled work, full multi-user session management or deploy
policy. The owner must explicitly approve any actual Render deployment.
