# Wonderfully Enchanted Chaos — Hybrid AI Engine

A **starter implementation** for local-first image generation and vertical video assembly. It is not yet a full AI animation studio. No GPU or API credentials are needed to run unit tests.

## Install

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -e .
python -m unittest discover -s tests -v
```

Install FFmpeg separately to render video. To generate locally, install and run ComfyUI, download compatible models, and export a working **API-format** ComfyUI workflow JSON containing a SaveImage node. Add its path as `comfy_workflow` in your scene JSON. Prompts and reference inputs must be configured inside the workflow; this starter does **not** automatically rewrite workflow nodes from the scene prompt.

```bash
wec generate examples/scene.json --out assets/scenes
wec render-stills examples/video-manifest.json output/preview.mp4
wec probe output/preview.mp4
```

The sample scene intentionally omits `comfy_workflow`; add one before generation. Cloud fallback requires a separately implemented endpoint that accepts the JSON payload documented in `wec_engine/providers/cloud.py`, and returns base64-encoded image data. Enable explicitly with `--cloud --cloud-estimate 0.10 --cloud-budget 1.00`. **The budget check is per invocation, not cumulative accounting.** Do not use it as an enforceable production spending cap until a persistent ledger and provider billing reconciliation are added.

## Existing studio integration

The `render-stills` command outputs a **silent** H.264 MP4, intended as an intermediate input to the existing narration, caption, music, and SFX pipeline. Do not replace the existing final renderer with it. The engine has not been deployed to `/home/team/shared/studio/` and the existing pipeline has not been inspected.

## Next implementation milestones

- ComfyUI workflow parameter binding and reference-image conditioning
- Provider-specific cloud adapters and durable cost ledger
- Image-to-video generation (Wan/LTX via ComfyUI) with motion manifests
- Audio and caption timing integration into the existing renderer
- GPU detection, worker scheduling, end-to-end production tests

Keep `.env` secrets out of version control. Confirm model licenses before commercial use.
