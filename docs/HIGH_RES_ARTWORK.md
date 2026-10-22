# High-resolution artwork: private GPU workflow

WEC can now validate and explicitly submit a reviewed ComfyUI artwork workflow,
select its final image, keep the exact PNG bytes and check actual output pixels
against a print-size target. This is a **local CLI integration**, separate from
the hosted dashboard's Cloudflare scene-image button. No new dashboard button,
GPU service, account, model download or paid fallback is enabled.

## GitHub candidates investigated

Primary repositories and model cards checked October 21, 2026:

| Project | Role and evidence | Decision for WEC |
| --- | --- | --- |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | Local workflow engine with an API and queued execution; supports different generation/editing models. It is not itself an image model. | Extend WEC's existing connection rather than bundle another GPU engine into Render. |
| [SANA](https://github.com/NVlabs/Sana) / [Sana 1600M 4K model](https://huggingface.co/Efficient-Large-Model/Sana_1600M_4Kpx_BF16_diffusers) | Publisher documents up to 4096 x 4096 generation and a 4K multi-scale model. This is the strongest pixel-resolution candidate from this review. The card lists Apache 2.0, additional Gemma text-encoder terms and intended research use. | Candidate for new full-size artwork. Check the exact weights/components and worker workflow before adopting it. Reference conditioning and Pip consistency are not established by the text-to-image model card. |
| [FLUX.2 Klein 4B](https://github.com/black-forest-labs/flux2) | Publisher documents text-to-image and single/multiple-reference editing, Apache 2.0 for the 4B variants, and approximately 8 GB VRAM for Klein 4B. Other FLUX.2 variants have different licenses. | First candidate to benchmark for preserving Pip's reference design. A requested large canvas is not proof the workflow/model produces it well; validate actual pixels, line quality and memory use. |
| [Qwen-Image family](https://github.com/QwenLM/Qwen-Image) | Generation and editing variants; the README's native 2K claim is for Qwen-Image-2.0, not automatically every downloadable checkpoint. | Alternative to evaluate if the first candidates do not preserve the character or line work. Check the exact version, weights and dependencies. |

No model was run or visually benchmarked in this change. No claim is made about
Pip consistency, reliable coloring outlines, achievable speed on the owner's
hardware, or KDP acceptance. Code licenses and model/component terms are separate;
this change bundles none of their code or weights. Upscaling can introduce or
alter detail; it is not evidence of native high-resolution generation.

The SANA publisher reports 4K operation with tiling/offload/quantization on 8 GB
VRAM and other configurations with more memory. These are publisher results,
not WEC measurements. Model, dimensions, precision, nodes and GPU determine real
requirements. A GPU-capable Windows PC or separately supplied worker is still
needed. The free Render web service remains a lightweight dashboard.

## Prepare the worker and job

1. Install ComfyUI separately on the GPU machine, following its official Windows
   instructions. Choose the exact model/weights and review its terms. Install
   only the nodes the reviewed workflow needs. Keep ComfyUI bound to loopback.
2. In ComfyUI, build and review a workflow that creates **one final image** and
   ends in a standard `SaveImage` node. For edits, connect the reference through
   the model's actual conditioning/edit path; simply adding `LoadImage` is not
   enough. Export **API format** JSON, not the editor canvas JSON.
3. Save that export under ignored `workflows/local/artwork-api.json`. Copy
   `examples/artwork-job.example.json` to an ignored local job file and edit its
   workflow path, real node IDs and existing prompt/width/height/seed inputs.
   The example IDs are illustrative and are **not a supplied model workflow**.
4. Set `save_image_node` explicitly. If there are preview/intermediate outputs,
   WEC will not pick them just because they appear first. Set model-compatible
   dimensions **inside the workflow or bindings**; `expected_pixels` only checks
   the returned image and never resizes it or edits width/height nodes for you.
5. For a reference edit, set `source_method` to `reference_edit`, provide the
   original PNG/JPEG/WebP file and the real `LoadImage` binding. Otherwise remove
   `reference` and declare `generation` or `upscale` accurately. Keep prompts,
   references and weights private; the example contains no user artwork.

For SANA, start with the publisher's [ComfyUI setup guide](https://nvlabs.github.io/Sana/docs/ComfyUI/comfyui/)
and [4K example](https://nvlabs.github.io/Sana/docs/ComfyUI/Sana_FlowEuler_4K.json).
The example inspected here is **editor/UI format and ends in PreviewImage**.
Add/connect a final standard SaveImage, then export API format from the prepared
worker. Passing the unmodified publisher JSON directly to WEC will fail
validation. That example is text-to-image, not a reference-edit workflow.
The publisher also links a [browser demo](https://sana.hanlab.ai/); its current
availability, resolution settings and output quality have not been tested here.

A useful initial portrait target is **2304 x 3072**, which fits 7.5 x 10 inches
at 307.2 PPI. This is a requested test target, **not a promise that each candidate
supports it or has been benchmarked at that resolution**. The 300-PPI target for
an exact 7.5 x 10 inch canvas is 2250 x 3000 pixels. Pixel-count checks cannot
recognize an artificially enlarged thumbnail or certify actual detail.

## Validate without generation

```powershell
wec doctor
wec artwork workflows/local/pip-job.json output/pip-page-001
```

The second command validates local files, bindings, export-node selection,
reference bytes and expected print resolution. It creates no output directory,
downloads no weights, probes no hosts and submits no job. Paths inside a job
are relative to the job file. Use the normal Windows installation in
[WINDOWS.md](WINDOWS.md); no Torch, Diffusers or ComfyUI dependencies are added
to WEC or Render.

## Execute one reviewed job

Only after the GPU worker, model and workflow are prepared:

```powershell
wec artwork workflows/local/pip-job.json output/pip-page-001 --execute --comfy-url http://127.0.0.1:8188 --wait-seconds 600
```

WEC checks the worker's installed node classes, optionally uploads the supplied
reference once under a unique filename, binds its returned input path and queues
exactly one workflow. It waits for completion, retrieves exactly one `output`
image from the chosen standard `SaveImage`, validates it and writes:

- `artwork.png`: byte-identical downloaded PNG; no JPEG conversion, resizing,
  cropping or upload into the story database.
- `artwork-report.json`: job ID, state, bound-workflow hash, output hash/bytes,
  actual dimensions/fitted PPI, expected-pixel match, operator-declared source
  method and review limitations. Prompt/reference bytes are not included.

Successful pixel checks give exit code 0. A valid but undersized or unexpected
PNG is **kept** for review with failed checks and exit code 1. Native generation
and visual quality are never certified from dimensions. Structural validation
and a reference upload do not prove installed weights, connected conditioning,
correct character design or sufficient GPU memory.

The output directory must be new. Existing folders/files are never overwritten
or reused for another submission. If waiting times out or a connection fails,
read the saved state/job ID and inspect ComfyUI's queue/history before another
manual attempt: the worker may still be running or may already have completed.
WEC does not retry, cancel the worker, interrupt other jobs, or silently switch
to cloud. An uncertain submission is recorded before the request is sent.

## Privacy, cost and phone use

This command accepts only an explicit HTTP loopback address with a port
(`127.0.0.1` or `[::1]`). It rejects public/LAN URLs, embedded credentials, query
secrets and redirects; it bypasses environment proxies for the local connection.
For a remote GPU, an operator must arrange an authenticated private tunnel with
a loopback endpoint on the machine running the CLI. Do not publish port 8188
or expose an unsecured generation service. Arbitrary custom nodes/workflows can
execute code, download models or call paid APIs: inspect the export and nodes,
and use local model workflows. WEC itself supplies no paid provider fallback.

On iPhone today, generate on the separately prepared worker, transfer the final
PNG to Files, then add it to the hosted Coloring Book Studio. Automatic
phone-to-worker job submission, cloud GPU provisioning and Supabase backups are
**not implemented by this PR**. The current Cloudflare story-image feature and
existing saved books remain independent.

Coloring imports retain their existing bounds: 10 MiB/image, 24 megapixels/image,
80 MiB total bytes and 100 megapixels total. For example, forty 2304 x 3072
images exceed the aggregate pixel bound. Do not raise the phone memory limit
blindly; a large high-resolution book needs a separate desktop/page-streamed
assembly path. The worker integration prepares individual artwork files; it
does not claim full forty-page high-resolution assembly is solved.

## Verification

Tests use a local fake ComfyUI HTTP server and synthetic PNGs, never model
inference. They cover original-byte high-resolution download, explicit final-node
selection, reference upload/binding, bad inputs, undersized output, existing work
protection, missing nodes, corrupt/preview/multiple/traversal outputs, failed
execution, timeout with retained job ID, no automatic retries and no redirects.
Windows/Linux matrix tests cover the CLI integration. A real model run, VRAM
benchmark, line-art inspection and print proof remain necessary before calling
this a working AI artwork production workflow.
