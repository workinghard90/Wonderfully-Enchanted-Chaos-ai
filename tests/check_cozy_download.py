"""Check an actual browser download through both independently checked-out validators."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.cozy_handoff_validate import validate

package, cozy_root, count = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
spec = importlib.util.spec_from_file_location("cozy_preview", cozy_root / "scripts/wec_handoff_preview.py")
cozy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cozy)
assert validate(package) == []
proposal = cozy.preview(package)
assert proposal["reviewOnly"] is True
assert proposal["catalogProposal"]["collectionId"] == "coloring-books"
assert proposal["catalogProposal"]["status"] == "coming-soon"
assert proposal["catalogProposal"]["title"] == "Synthetic handoff"
assert proposal["catalogProposal"]["description"] == "Synthetic handoff description"
with zipfile.ZipFile(package) as z:
    assert z.testzip() is None
    manifest = json.loads(z.read("manifest.json"))
    assert manifest["creator"] == "Fixture Author"
    assert len(manifest["assets"]["previews"]) == count
    for name, checksum in manifest["sha256"].items():
        raw = z.read(name)
        assert hashlib.sha256(raw).hexdigest() == checksum
        assert raw == base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==")
        from PIL import Image
        import io
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            assert image.size == (40, 30)
    # Changed content, even if the ZIP itself has valid CRCs, must be rejected.
    bad = package.with_suffix(".tampered.zip")
    with zipfile.ZipFile(bad, "w") as out:
        for name in z.namelist():
            out.writestr(name, b"tampered" if name.startswith("assets/") else z.read(name))
assert validate(bad)
try:
    cozy.preview(bad)
except ValueError:
    pass
else:
    raise AssertionError("Cozy accepted a tampered download")
bad.unlink()
print(json.dumps({"passed": True, "pages": count}))
