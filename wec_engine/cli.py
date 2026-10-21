import argparse
import json
import os
from .providers.comfy import ComfyProvider
from pathlib import Path
from .router import HybridRouter
from .video import render_stills, probe
from .animation import ComfyAnimation
from .motion import render_clips
from .story import plan_story, save_plan
from .finishing import attach_audio
from .production import captions_from_plan, synthesize_piper, finalize_video, verify_delivery
from .orchestrator import run_production
from .deployment import diagnose, save_diagnostics
from .readiness import preflight
from .integration import live_check, upload_reference

def main(argv=None):
    parser = argparse.ArgumentParser(prog="wec")
    sub = parser.add_subparsers(dest="command", required=True)
    gen = sub.add_parser("generate")
    gen.add_argument("scene_json")
    gen.add_argument("--comfy-url", default=os.environ.get("WEC_COMFY_URL", "http://127.0.0.1:8188"))
    gen.add_argument("--out", default="assets/scenes")
    gen.add_argument("--cloud", action="store_true")
    gen.add_argument("--cloud-estimate", type=float)
    gen.add_argument("--cloud-budget", type=float, default=0)
    render = sub.add_parser("render-stills")
    render.add_argument("manifest")
    render.add_argument("output")
    movie = sub.add_parser("export-backup", help="Render a studio backup as a narrated vertical MP4, offline")
    movie.add_argument("backup")
    movie.add_argument("output")
    movie.add_argument("--voice-model", required=True, help="Local Piper .onnx model with matching .onnx.json")
    movie.add_argument("--workdir", help="New directory for images, audio, captions and verification")
    movie.add_argument("--project-index", type=int, help="Project position in a multi-project backup, starting at 0")
    movie.add_argument("--ambience", action="store_true", help="Add a quiet original procedural pad and transition chimes")
    anim = sub.add_parser("animate")
    anim.add_argument("workflow")
    anim.add_argument("--comfy-url", default=os.environ.get("WEC_COMFY_URL", "http://127.0.0.1:8188"))
    anim.add_argument("output")
    anim.add_argument("--bindings", help="JSON file of explicit node input bindings")
    clips = sub.add_parser("render-clips")
    clips.add_argument("manifest")
    clips.add_argument("output")
    story = sub.add_parser("plan-story")
    story.add_argument("story_file")
    story.add_argument("output")
    story.add_argument("--duration", type=float, default=35.0)
    story.add_argument("--scenes", type=int, default=7)
    story.add_argument("--character")
    mux = sub.add_parser("attach-audio")
    mux.add_argument("video")
    mux.add_argument("audio")
    mux.add_argument("output")
    caps = sub.add_parser("captions")
    caps.add_argument("plan")
    caps.add_argument("output")
    voice = sub.add_parser("speak-piper")
    voice.add_argument("text")
    voice.add_argument("model")
    voice.add_argument("output")
    finish = sub.add_parser("finalize")
    finish.add_argument("video")
    finish.add_argument("output")
    finish.add_argument("--audio")
    finish.add_argument("--captions")
    verify = sub.add_parser("verify-delivery")
    verify.add_argument("video")
    verify.add_argument("--duration", type=float)
    verify.add_argument("--allow-silent", action="store_true")
    pipeline = sub.add_parser("produce")
    pipeline.add_argument("plan")
    pipeline.add_argument("workdir")
    pipeline.add_argument("--audio")
    pipeline.add_argument("--dry-run", action="store_true")
    pipeline.add_argument("--generate-images", action="store_true")
    pipeline.add_argument("--animate", action="store_true")
    pipeline.add_argument("--no-captions", action="store_true")
    pipeline.add_argument("--allow-silent", action="store_true")
    pipeline.add_argument("--comfy-url", default=os.environ.get("WEC_COMFY_URL"))
    doctor = sub.add_parser("doctor", help="Inspect local hardware and dependencies without installing anything")
    doctor.add_argument("--comfy-url", default=os.environ.get("WEC_COMFY_URL", "http://127.0.0.1:8188"))
    doctor.add_argument("--check-network", action="store_true")
    doctor.add_argument("--output", help="Write diagnostics JSON to a file")
    ready = sub.add_parser("preflight", help="Audit a ComfyUI workflow and optionally check installed node classes")
    ready.add_argument("--workflow")
    ready.add_argument("--kind", choices=["image", "video"], default="image")
    ready.add_argument("--bindings")
    ready.add_argument("--comfy-url", default=os.environ.get("WEC_COMFY_URL", "http://127.0.0.1:8188"))
    ready.add_argument("--check-network", action="store_true")
    ready.add_argument("--output")
    live = sub.add_parser("live-check", help="Read-only check of a running ComfyUI server")
    live.add_argument("--comfy-url", default=os.environ.get("WEC_COMFY_URL", "http://127.0.0.1:8188"))
    upload = sub.add_parser("upload-reference", help="Explicitly upload a local image to ComfyUI")
    upload.add_argument("image")
    upload.add_argument("--comfy-url", default=os.environ.get("WEC_COMFY_URL", "http://127.0.0.1:8188"))
    check = sub.add_parser("probe")
    check.add_argument("file")
    args = parser.parse_args(argv)
    if args.command == "generate":
        scene = json.loads(Path(args.scene_json).read_text(encoding="utf-8"))
        workflow = scene.get("comfy_workflow")
        if workflow and not Path(workflow).is_absolute():
            scene["comfy_workflow"] = str((Path(args.scene_json).resolve().parent / workflow).resolve())
        print(json.dumps(HybridRouter(comfy=ComfyProvider(args.comfy_url)).generate(scene, args.out, allow_cloud=args.cloud, cloud_estimate_usd=args.cloud_estimate, cloud_budget_usd=args.cloud_budget), indent=2))
    elif args.command == "render-stills":
        print(render_stills(args.manifest, args.output))
    elif args.command == "export-backup":
        from .backup_video import render_backup_video
        result = render_backup_video(args.backup, args.output, voice_model=args.voice_model,
                                     workdir=args.workdir, project_index=args.project_index, ambience=args.ambience)
        print(json.dumps(result, indent=2))
        return 0 if result['ok'] else 1
    elif args.command == "animate":
        bindings = json.loads(Path(args.bindings).read_text(encoding="utf-8")) if args.bindings else {}
        print(ComfyAnimation(args.comfy_url).animate(args.workflow, args.output, bindings=bindings))
    elif args.command == "render-clips":
        print(render_clips(args.manifest, args.output))
    elif args.command == "plan-story":
        plan = plan_story(Path(args.story_file).read_text(encoding="utf-8"), total_duration=args.duration, scene_count=args.scenes, character=args.character)
        print(save_plan(plan, args.output))
    elif args.command == "attach-audio":
        print(attach_audio(args.video, args.audio, args.output))
    elif args.command == "captions":
        print(captions_from_plan(args.plan, args.output))
    elif args.command == "speak-piper":
        print(synthesize_piper(args.text, args.model, args.output))
    elif args.command == "finalize":
        print(finalize_video(args.video, args.output, audio=args.audio, captions=args.captions))
    elif args.command == "produce":
        result = run_production(args.plan, args.workdir, audio=args.audio, dry_run=args.dry_run, generate_images=args.generate_images, animate=args.animate, captions=not args.no_captions, allow_silent=args.allow_silent, comfy_url=args.comfy_url)
        print(json.dumps(result, indent=2))
        return 0 if result.get("dry_run") or result.get("ok") else 1
    elif args.command == "doctor":
        options = {"comfy_url": args.comfy_url, "check_network": args.check_network}
        print(json.dumps(save_diagnostics(args.output, **options) if args.output else diagnose(**options), indent=2))
    elif args.command == "preflight":
        bindings = json.loads(Path(args.bindings).read_text(encoding="utf-8")) if args.bindings else None
        report = preflight(args.workflow, kind=args.kind, bindings=bindings, comfy_url=args.comfy_url, check_network=args.check_network)
        if args.output:
            target = Path(args.output)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    elif args.command == "live-check":
        print(json.dumps(live_check(args.comfy_url), indent=2))
    elif args.command == "upload-reference":
        print(json.dumps(upload_reference(args.image, comfy_url=args.comfy_url), indent=2))
    elif args.command == "verify-delivery":
        result = verify_delivery(args.video, expected_duration=args.duration, require_audio=not args.allow_silent)
        print(json.dumps(result, indent=2))
        return 0 if result["ok"] else 1
    else:
        print(json.dumps(probe(args.file), indent=2))

if __name__ == "__main__":
    raise SystemExit(main())
