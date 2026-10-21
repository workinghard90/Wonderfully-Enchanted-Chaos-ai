"""ComfyUI video workflow runner. Workflow must export video via a node returning gifs/videos."""
import json
import os
import time
import uuid
from pathlib import Path
import requests


def bind_workflow(workflow, bindings):
    """Bind explicit node input paths, without guessing model-specific node types.

    bindings: {"node_id.input_name": value}. Missing targets fail closed.
    """
    result = json.loads(json.dumps(workflow))
    for key, value in bindings.items():
        if not isinstance(key, str) or "." not in key:
            raise ValueError("Binding must be node_id.input_name")
        node_id, input_name = key.split(".", 1)
        if node_id not in result or input_name not in result[node_id].get("inputs", {}):
            raise ValueError(f"Unknown workflow input: {key}")
        result[node_id]["inputs"][input_name] = value
    return result


class ComfyAnimation:
    def __init__(self, base_url=None, timeout=1200, poll_interval=2):
        self.base_url = (base_url or os.environ.get("WEC_COMFY_URL") or "http://127.0.0.1:8188").rstrip("/")
        self.timeout = timeout
        self.poll_interval = poll_interval

    def animate(self, workflow_path, output_path, *, bindings=None):
        workflow = json.loads(Path(workflow_path).read_text(encoding="utf-8"))
        workflow = bind_workflow(workflow, bindings or {})
        response = requests.post(f"{self.base_url}/prompt", json={"prompt": workflow, "client_id": str(uuid.uuid4())}, timeout=30)
        response.raise_for_status()
        prompt_id = response.json()["prompt_id"]
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            resp = requests.get(f"{self.base_url}/history/{prompt_id}", timeout=20)
            resp.raise_for_status()
            job = resp.json().get(prompt_id)
            if job:
                status = job.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(f"Animation failed: {status.get('messages', [])}")
                for node in job.get("outputs", {}).values():
                    for kind in ("gifs", "videos"):
                        for media in node.get(kind, []):
                            name = media.get("filename", "")
                            if not name.lower().endswith((".mp4", ".webm", ".mov")):
                                continue
                            params = {"filename": name, "subfolder": media.get("subfolder", ""), "type": media.get("type", "output")}
                            download = requests.get(f"{self.base_url}/view", params=params, timeout=120)
                            download.raise_for_status()
                            target = Path(output_path)
                            target.parent.mkdir(parents=True, exist_ok=True)
                            temp = target.with_name(target.name + ".tmp")
                            temp.write_bytes(download.content)
                            temp.replace(target)
                            return target
                if status.get("completed"):
                    raise RuntimeError("Workflow completed without a supported video file output; configure a video export node")
            time.sleep(self.poll_interval)
        raise TimeoutError(f"Animation timed out: {prompt_id}")
