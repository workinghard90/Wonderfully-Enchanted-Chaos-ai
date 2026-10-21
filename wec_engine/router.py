"""Local-first scene generation with explicit cloud spend authorization."""
import json
import math
from pathlib import Path
from PIL import Image
from .providers.comfy import ComfyProvider
from .providers.cloud import CloudProvider

class HybridRouter:
    def __init__(self, comfy=None, cloud=None):
        self.comfy = comfy or ComfyProvider()
        self.cloud = cloud or CloudProvider()

    def generate(self, scene, out_dir, *, allow_cloud=False, cloud_estimate_usd=None, cloud_budget_usd=0):
        scene_id = scene["id"]
        if not scene_id.replace("-", "").replace("_", "").isalnum():
            raise ValueError("Invalid scene ID")
        target = Path(out_dir) / f"{scene_id}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        errors = []
        provider = None
        workflow = scene.get("comfy_workflow")
        if workflow and self.comfy.available():
            try:
                self.comfy.generate(workflow, target)
                provider = "comfyui"
            except Exception as exc:
                errors.append(f"ComfyUI: {exc}")
        else:
            errors.append("ComfyUI unavailable or scene lacks comfy_workflow")
        if provider is None and allow_cloud:
            if cloud_estimate_usd is None or not math.isfinite(cloud_estimate_usd) or cloud_estimate_usd < 0:
                raise ValueError("A nonnegative cloud cost estimate is required before cloud generation")
            if not math.isfinite(cloud_budget_usd) or cloud_budget_usd < 0 or cloud_estimate_usd > cloud_budget_usd:
                raise ValueError("Estimated cloud cost exceeds configured budget")
            try:
                self.cloud.generate(scene["prompt"], target, scene.get("width", 1024), scene.get("height", 1792), scene.get("references", []))
                provider = "cloud"
            except Exception as exc:
                errors.append(f"Cloud: {exc}")
        if provider is None:
            raise RuntimeError("No image generated: " + "; ".join(errors))
        try:
            with Image.open(target) as image:
                image.verify()
            with Image.open(target) as image:
                width, height = image.size
                if width < 256 or height < 256:
                    raise ValueError("Generated image is too small")
        except Exception:
            target.unlink(missing_ok=True)
            raise
        metadata = {"scene_id": scene_id, "provider": provider, "image_path": str(target), "width": width, "height": height, "prompt": scene["prompt"]}
        target.with_suffix(".json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        return metadata
