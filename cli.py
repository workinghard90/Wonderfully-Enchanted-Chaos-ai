import argparse
import json
from pathlib import Path
from .router import HybridRouter
from .video import render_stills, probe

def main():
    parser = argparse.ArgumentParser(prog="wec")
    sub = parser.add_subparsers(dest="command", required=True)
    gen = sub.add_parser("generate")
    gen.add_argument("scene_json")
    gen.add_argument("--out", default="assets/scenes")
    gen.add_argument("--cloud", action="store_true")
    gen.add_argument("--cloud-estimate", type=float)
    gen.add_argument("--cloud-budget", type=float, default=0)
    render = sub.add_parser("render-stills")
    render.add_argument("manifest")
    render.add_argument("output")
    check = sub.add_parser("probe")
    check.add_argument("file")
    args = parser.parse_args()
    if args.command == "generate":
        scene = json.loads(Path(args.scene_json).read_text(encoding="utf-8"))
        print(json.dumps(HybridRouter().generate(scene, args.out, allow_cloud=args.cloud, cloud_estimate_usd=args.cloud_estimate, cloud_budget_usd=args.cloud_budget), indent=2))
    elif args.command == "render-stills":
        print(render_stills(args.manifest, args.output))
    else:
        print(json.dumps(probe(args.file), indent=2))

if __name__ == "__main__":
    main()
