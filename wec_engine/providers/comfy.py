"""ComfyUI API client; workflow JSON must include a SaveImage node."""
import json
import os
import time
import uuid
from pathlib import Path
from urllib.parse import quote
import requests

class ComfyProvider:
    def __init__(self, base_url=None, timeout=300):
        self.base_url = (base_url or os.environ.get("WEC_COMFY_URL") or "http://127.0.0.1:8188").rstrip("/")
        self.timeout = timeout

    def available(self):
        try:
            return requests.get(f"{self.base_url}/system_stats", timeout=4).ok
        except requests.RequestException:
            return False

    def generate(self, workflow_path, output_path):
        workflow = json.loads(Path(workflow_path).read_text(encoding="utf-8"))
        response = requests.post(f"{self.base_url}/prompt", json={"prompt": workflow, "client_id": str(uuid.uuid4())}, timeout=20)
        response.raise_for_status()
        prompt_id = response.json()["prompt_id"]
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            history_response = requests.get(f"{self.base_url}/history/{prompt_id}", timeout=15)
            history_response.raise_for_status()
            history = history_response.json().get(prompt_id)
            if history:
                status = history.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(f"ComfyUI generation failed: {status.get('messages', [])}")
                for node in history.get("outputs", {}).values():
                    for item in node.get("images", []):
                        params = {"filename": item["filename"], "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")}
                        image = requests.get(f"{self.base_url}/view", params=params, timeout=60)
                        image.raise_for_status()
                        target = Path(output_path)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        temp = target.with_suffix(target.suffix + ".tmp")
                        temp.write_bytes(image.content)
                        temp.replace(target)
                        return target
                if status.get("completed"):
                    raise RuntimeError("ComfyUI completed without SaveImage output")
            time.sleep(2)
        raise TimeoutError(f"ComfyUI timed out waiting for prompt {prompt_id}")
