"""Optional cloud adapter using an explicit, user-configured HTTP endpoint.

Expected response: JSON with image_base64 (raw image bytes encoded as base64).
This is an adapter contract, not a claim that any provider supports this exact API.
"""
import base64
import os
from pathlib import Path
import requests

class CloudProvider:
    def __init__(self, endpoint=None, api_key=None):
        self.endpoint = endpoint or os.getenv("WEC_CLOUD_ENDPOINT")
        self.api_key = api_key or os.getenv("WEC_CLOUD_API_KEY")

    def available(self):
        return bool(self.endpoint and self.api_key)

    def generate(self, prompt, output_path, width=1024, height=1792, references=None):
        if not self.available():
            raise RuntimeError("Cloud provider not configured")
        payload = {"prompt": prompt, "width": width, "height": height, "references": references or []}
        response = requests.post(self.endpoint, json=payload, headers={"Authorization": f"Bearer {self.api_key}"}, timeout=180)
        response.raise_for_status()
        raw = base64.b64decode(response.json()["image_base64"], validate=True)
        target = Path(output_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(target.suffix + ".tmp")
        temp.write_bytes(raw)
        temp.replace(target)
        return target
