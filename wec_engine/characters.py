"""Character reference registry. Records references; conditioning depends on workflow."""
import json
from pathlib import Path


def load_character(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    for field in ("id", "name", "description", "reference_images"):
        if field not in data:
            raise ValueError(f"Character missing {field}")
    if not isinstance(data["reference_images"], list) or not data["reference_images"]:
        raise ValueError("Character must have at least one reference image")
    return data
