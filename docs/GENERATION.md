# Image, video and narration integration

No live AI generation was tested during repository integration. Supplied tests
mock model endpoints. The real FFmpeg test uses synthetic color images and a
sine-wave audio track. No paid API is invoked.

## Local/private ComfyUI

Install ComfyUI, compatible licensed models and required custom nodes on your
worker separately. Export **API-format JSON**, not the editor's canvas format.
Image workflows need an image export (`SaveImage`). Video workflows need an
export node whose history exposes `videos` or `gifs` entries with MP4/WebM/MOV.
Other history formats need adapter work. Preflight is structural validation,
not proof of installed weights, available VRAM or a successful render.

```bash
wec doctor
wec preflight --workflow workflows/image-api.json --kind image
wec preflight --workflow workflows/video-api.json --kind video --check-network
wec live-check
```

Default worker: `http://127.0.0.1:8188`. Set `WEC_COMFY_URL` or pass
`--comfy-url` explicitly. Read-only network checks contact only that configured
worker. Tests neither download models nor discover remote hosts.

Add `comfy_workflow` to a scene JSON; its path is relative to the scene file:

```json
{
  "id": "scene-001",
  "prompt": "An enchanted lantern in a forest",
  "comfy_workflow": "../workflows/image-api.json"
}
```

```bash
wec generate examples/my-scene.json --out assets/scenes
wec animate workflows/video-api.json assets/clips/scene-001.mp4 --bindings examples/animation-bindings.json
```

Scene prompts/references do **not** automatically rewrite the image workflow.
Configure image prompts and conditioning inside your exported workflow. Video
bindings explicitly map `node_id.input_name` to a value; missing targets fail.
Character JSON stores references, not conditioning or consistency guarantees.

In a production plan, each scene can set `comfy_workflow`,
`animation_workflow`, `animation_bindings`, and `animation_image_binding` (e.g.
`12.image`). The latter must target an existing LoadImage node's `image` input;
it explicitly uploads and binds the still before animation. Workflows are
resolved relative to the plan file. An upload's returned subfolder is preserved.

```bash
wec produce output/plan.json output/generated-job --generate-images --animate --audio assets/audio/final-mix.wav
```

Review every workflow before execution. Production cloud fallback is disabled.
A complete set of stills/clips is required; no placeholder art is generated
implicitly. Workdirs are single-process checkpoints, not a job queue. Fresh
workdirs are required when replacing media/audio at unchanged file paths.

## Optional dashboard images through Cloudflare

The studio now has a provider-specific Workers AI adapter, disabled by default.
See [Cloudflare scene-image setup](CLOUDFLARE_IMAGES.md). It sends one reviewed
prompt to FLUX.1 schnell, stores the returned picture as a scene attachment and
includes it in standard version 2 backups. Tests use mocked REST responses and
a synthetic browser fixture; **no live model output has been verified**.

This is separate from the CLI custom gateway below. Enabling the studio does
not enable CLI cloud fallback, private workers, narration, animation or web video
rendering. Prompt edits are one-request inputs, not saved project fields.

## Full-resolution artwork export

For individual coloring illustrations and high-resolution original files, use
[the artwork job command](HIGH_RES_ARTWORK.md). It adds explicit bindings,
optional reference upload, final-output selection, original-byte preservation
and actual pixel/PPI checks. This is distinct from the existing scene-image
path and does not downsize the original into a story preview.

## Custom cloud image gateway

`providers/cloud.py` defines a generic contract, not a provider-specific API.
Configure your own HTTPS endpoint and secret through `WEC_CLOUD_ENDPOINT` and
`WEC_CLOUD_API_KEY`. Request: bearer authorization and JSON `prompt`, `width`,
`height`, `references`. Response: JSON `image_base64` with raw encoded image
bytes. Do not assume OpenAI or another commercial API implements this schema.

The only entry point that can spend through this adapter is explicit CLI use:

```bash
wec generate examples/my-scene.json --cloud --cloud-estimate 0.10 --cloud-budget 1.00
```

The estimate gate is per invocation and supplied by the caller. It is **not** a
cumulative spending cap or billing ledger. Configure service-side caps before
using paid services. No cloud credentials were supplied or tested here.

## Narration, captions and delivery

Optional `wec speak-piper TEXT MODEL OUTPUT` needs a separately installed Piper
binary and licensed voice model. Narration does not mix music or SFX. Supply a
completed audio mix to `wec produce` or `wec finalize`. SRT captions are estimated
from scene times, not forced-aligned speech; review before publication. FFmpeg
must include libx264, AAC and libass/subtitles. Delivery verification checks
codec, dimensions, pixel format, duration tolerance, audio when required, size
and MP4 atom order. It does not judge art quality or narration synchronization.
