# First dashboard AI image test — owner setup required

Status: adapter and dashboard controls implemented; provider protocol and UI
verified using mocks/synthetic pictures only. **A real image has not been
generated or reviewed.** The feature is off by default. Installing the app,
opening the studio or previewing scenes makes no inference request.

## Free account and secret setup from your phone

1. Create/sign into a [Cloudflare account](https://dash.cloudflare.com/sign-up).
   Keep **Workers Free**. Do not upgrade, purchase credits or enable paid services
   for this test. Current published pricing includes 10,000 neurons/day on Free;
   further requests fail at the allowance instead of charging on that plan.
2. Open **Workers AI → Use REST API**. Choose **Create a Workers AI API Token**,
   review its account scope and create it. Copy the token and Account ID.
   The documented custom-token permissions are **Workers AI Read + Edit**.
3. In the existing Render service’s **Environment** page, add:

   | Name | Value |
   | --- | --- |
   | `WEC_CLOUDFLARE_ACCOUNT_ID` | Your account ID |
   | `WEC_CLOUDFLARE_API_TOKEN` | Your scoped token; keep it secret |
   | `WEC_ENABLE_IMAGE_GENERATION` | `1` |

   Enter values directly in Render. Do not paste the token in chat, GitHub,
   project JSON, `config.js` or a screenshot. No new worker, paid resource or
   database is needed for the REST adapter.
4. Before applying a Render update, download a current project backup. Apply the
   environment changes to the running service by deploying the merged code.
   Free hosting can reset its database; use **Restore backup** afterward if needed.
   Keep the existing studio token and Free instance plan.
5. Refresh the studio, open a saved project and preview scenes. The status should
   name **FLUX.1 schnell** and show today’s attempts. This means configuration is
   present, not that the token or service has been proven to work.

The app cannot inspect or enforce your Cloudflare billing plan. Its local
20-attempt daily limit is an extra operational bound, not a monetary cap. Keep
the provider account on Workers Free for the provider-enforced no-charge limit.
Other apps on the same account share its allowance.

## Generate one scene

Choose an **empty scene**. Review/edit its **Image prompt**, then tap
**Generate image** and confirm sending that prompt to Cloudflare. Only the
entered prompt is sent; project backups, existing pictures and the whole story
are not automatically uploaded to the provider. The adapter uses
`@cf/black-forest-labs/flux-1-schnell` with four steps, per the current model API.

Wait for **Image generated and attached**, inspect the result, and download a
backup. Prompt edits apply to that request only and are not saved in the backup.
The model returns its native image dimensions; this adapter does not promise
1080×1920 output or crop a picture into a vertical frame. Evaluate artwork quality
before scaling to a whole story. Character consistency across separate scenes
is not guaranteed and existing character references are not conditioning inputs.

A scene with an image has no Generate control. Keep a backup and explicitly
remove that picture if you want to generate a replacement. Failed calls do not
replace existing images. If another device changes the story or scene count
while generation runs, its result is discarded; the attempt is still consumed.
Title/duration edits do not invalidate the image assignment.

## Errors, limits and recovery

- **Owner setup required / access rejected:** check the three server settings,
  account scope, token permissions and model availability. Configuration is read
  when the backend starts. The browser never receives provider credentials.
- **Busy / quota exhausted:** wait for the other media operation to finish or
  for the provider’s allowance to reset. There is no automatic paid fallback.
- **Timed out / connection dropped:** reopen the project before trying again.
  The request might have finished after the browser disconnected. Existing
  images block another provider call to that scene.
- **Studio daily limit:** every provider attempt, including failures, counts
  toward 20 attempts per UTC day. Counters persist in SQLite, not project backups;
  temporary hosting resets them along with the database. Provider allowance is
  independently enforced by Cloudflare.

The synchronous endpoint allows one media operation at a time. There is no
persistent job queue, batch generation, auto-retry or model fallback. Image size,
normalization and total storage limits from [scene images](SCENE_IMAGES.md)
apply. API contracts/errors are in [configuration](CONFIGURATION.md).

A first live test is complete only after observing a real provider request,
opening the returned picture, saving/reopening it, and checking an image-inclusive
backup restore. Then evaluate a second scene before attempting video/narration.
No FFmpeg, video export, sound, narration or private GPU worker is enabled here.

## Official references checked for this implementation

- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [REST API setup and token scope](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [FLUX.1 schnell input/output schema](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/)

Published allowances and model availability can change; review the provider
Dashboard before enabling. No live credentials were available during development.
