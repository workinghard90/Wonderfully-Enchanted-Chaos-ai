"""Independent Poppler check of the browser_coloring.cjs synthetic proof."""
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image, ImageChops

pdf = Path(sys.argv[1])
def run(*args):
    return subprocess.check_output(args, text=True)
info = run('pdfinfo', '-f', '1', '-l', '4', str(pdf))
assert re.search(r'Pages:\s+4\b', info), info
sizes = re.findall(r'Page\s+\d+ size:\s+612 x 792 pts', info)
assert len(sizes) == 4, info
assert not run('pdftotext', str(pdf), '-').strip(), 'Dashboard text leaked into the print layout'
images = run('pdfimages', '-list', str(pdf))
assert re.search(r'\b3000\s+1000\b', images), images
assert re.search(r'\b300\s+600\b', images), images
with tempfile.TemporaryDirectory() as directory:
    prefix = str(Path(directory) / 'page')
    subprocess.check_call(['pdftoppm', '-r', '72', '-png', str(pdf), prefix], stdout=subprocess.DEVNULL)
    pages = sorted(Path(directory).glob('page-*.png'))
    assert len(pages) == 4
    for index, file in enumerate(pages):
        image = Image.open(file).convert('RGB')
        assert image.size == (612, 792)
        bounds = ImageChops.difference(image, Image.new('RGB', image.size, 'white')).getbbox()
        if index % 2:
            assert bounds is None, (index, bounds)
            continue
        assert bounds, (index, 'missing artwork')
        left, top, right, bottom = bounds
        assert left >= 35 and top >= 35 and right <= 577 and bottom <= 757, bounds
        # First artwork is tall (5 x 10 in), second wide (7.5 x 2.5 in).
        expected = (360, 720) if index == 0 else (540, 180)
        assert abs(right-left-expected[0]) <= 2 and abs(bottom-top-expected[1]) <= 2, (bounds, expected)
        assert abs((left+right)/2-306) <= 1 and abs((top+bottom)/2-396) <= 1, bounds
print('PASS independent PDF: four Letter sheets, original image dimensions, 0.5-inch inset, centered uncropped artwork, alternating blank backs, no dashboard text')
