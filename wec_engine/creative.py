"""Bounded, on-demand creative exports. No model calls, retries or disk jobs here."""
import base64
import binascii
import io
import math
from pathlib import Path
import threading
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError
from .video_limits import plan_video
from .studio_store import _read_image, restore_backup, StorageLimitError

MAX_CREATIVE_BODY = 42 * 1024 * 1024
MAX_ASSETS = 30 * 1024 * 1024
MAX_PIXELS = 320_000_000
MAX_IMAGE_PIXELS = 12_000_000
FONT_LOCK = threading.Lock()


def text(value, name, limit, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError(f'{name} must contain {"1" if required else "0"}-{limit} characters')
    if any(ord(c) < 32 and c not in '\n\r\t' for c in value):
        raise ValueError(f'{name} contains unsupported control characters')
    try:
        value.encode('utf-8')
    except UnicodeEncodeError:
        raise ValueError(f'{name} contains invalid characters') from None
    return value.strip()


def plan(payload):
    if not isinstance(payload, dict):
        raise ValueError('Expected story settings')
    story = text(payload.get('story'), 'Story', 30000, True)
    count, duration = payload.get('scenes', 7), payload.get('duration', 35)
    if type(count) is not int or not 1 <= count <= 7:
        raise ValueError('Choose 1-7 scenes for phone video export')
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 1 <= duration <= 35:
        raise ValueError('Choose a video duration from 1 to 35 seconds')
    return plan_video(story, scenes=count, duration=duration)


def prepare(payload):
    """Validate/decode every input before exporting or writing a server project."""
    if not isinstance(payload, dict) or payload.get('kind') not in ('video', 'art', 'coloring', 'storybook'):
        raise ValueError('Choose a supported creative project')
    result = {'kind': payload['kind'], 'title': text(payload.get('title'), 'Title', 150, True),
              'author': text(payload.get('author', ''), 'Author', 100), 'pages': []}
    pages = payload.get('pages')
    maximum = 7 if result['kind'] == 'video' else 80
    if not isinstance(pages, list) or not 1 <= len(pages) <= maximum:
        raise ValueError(f'Add 1-{maximum} pages')
    total_bytes = total_pixels = 0
    for number, page in enumerate(pages, 1):
        if not isinstance(page, dict):
            raise ValueError('Invalid page')
        narration = text(page.get('text', ''), f'Page {number} text', 1800)
        encoded = page.get('image_base64')
        if not isinstance(encoded, str) or len(encoded) > 14 * 1024 * 1024:
            raise ValueError(f'Page {number} needs a PNG, JPEG or WebP image under 10 MiB')
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError(f'Invalid image on page {number}') from None
        total_bytes += len(raw)
        if not raw or len(raw) > 10 * 1024 * 1024 or total_bytes > MAX_ASSETS:
            raise StorageLimitError('PDF/video export supports up to 30 MiB of images; the device ZIP keeps larger originals')
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw)) as image:
                    if image.format not in ('PNG', 'JPEG', 'WEBP') or getattr(image, 'n_frames', 1) != 1:
                        raise ValueError('Choose still PNG, JPEG or WebP images')
                    width, height = image.size
                    if width * height > MAX_IMAGE_PIXELS:
                        raise StorageLimitError('Each export image must be at most 12 megapixels')
                    total_pixels += width * height
                    if total_pixels > MAX_PIXELS:
                        raise StorageLimitError('Export supports up to 320 megapixels across the book')
                    image.verify()
        except (OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise ValueError(f'Page {number} has an unreadable image') from None
        result['pages'].append({'text': narration, 'raw': raw})
    return result


def _fonts():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    with FONT_LOCK:
        if 'WECBook' not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont('WECBook', str(Path(__file__).parent / 'fonts' / 'DejaVuSans.ttf')))


def _lines(value, width, size):
    from reportlab.pdfbase.pdfmetrics import stringWidth, getFont
    glyphs = getFont('WECBook').face.charWidths
    if any(ord(char) not in glyphs and char not in '\n\r\t' for char in value):
        raise ValueError('Book text contains a character this print font cannot display. Replace symbols or emoji before export')
    lines = []
    for paragraph in value.splitlines() or ['']:
        current = ''
        for word in paragraph.split():
            if stringWidth(word, 'WECBook', size) > width:
                raise ValueError('A word is too long for the page; add spaces or shorten it')
            candidate = (current + ' ' + word).strip()
            if current and stringWidth(candidate, 'WECBook', size) > width:
                lines.append(current); current = word
            else:
                current = candidate
        lines.append(current)
    return lines


def book_pdf(payload):
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader
    value = prepare(payload)
    if value['kind'] == 'video':
        raise ValueError('Use the Video Studio for movie export')
    _fonts()
    output = io.BytesIO()
    c = canvas.Canvas(output, pagesize=(612, 792), pageCompression=1, initialFontName='WECBook')
    c.setTitle(value['title']); c.setAuthor(value['author'])
    # One title/name page and a short introduction on its reverse.
    title_lines = _lines(value['title'], 468, 28)
    if len(title_lines) > 5:
        raise ValueError('Shorten the book title to fit its title page')
    for i, line in enumerate(title_lines):
        c.setFont('WECBook', 28); c.drawCentredString(306, 640 - i * 38, line)
    c.setFont('WECBook', 12); c.drawCentredString(306, 360, 'This book belongs to')
    c.line(150, 322, 462, 322)
    if value['author']:
        for i, line in enumerate(_lines(value['author'], 468, 12)):
            c.drawCentredString(306, 108-i*18, line)
    c.showPage()
    c.setFont('WECBook', 20)
    c.drawCentredString(306, 620, "Let's color!" if value['kind'] == 'coloring' else 'Let your imagination wander')
    tips = ('Choose any colors you love.\nMake each picture your own.\nPlace a spare sheet behind the page when using markers.'
            if value['kind'] == 'coloring' else 'A collection of pictures and little adventures to enjoy together.')
    c.setFont('WECBook', 12)
    for i, line in enumerate(_lines(tips, 468, 12)):
        c.drawCentredString(306, 530 - i * 24, line)
    c.showPage()
    for page in value['pages']:
        # Process one image at a time and never upscale or crop its pixels.
        with Image.open(io.BytesIO(page['raw'])) as source:
            image = ImageOps.exif_transpose(source)
            if image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info):
                rgba = image.convert('RGBA')
                image = Image.new('RGB', rgba.size, 'white'); image.paste(rgba, mask=rgba.getchannel('A'))
            else:
                image = image.convert('RGB')
            if value['kind'] == 'coloring':
                image = image.convert('L')
            lines = _lines(page['text'], 468, 14) if value['kind'] == 'storybook' else []
            if value['kind'] == 'storybook' and not page['text']:
                raise ValueError('Every storybook page needs story text')
            if len(lines) > 9:
                raise ValueError('A storybook page has too much text; keep it to nine wrapped lines or split the page')
            text_height = len(lines) * 21 + (24 if lines else 0)
            available_height = 684 - text_height
            scale = min(468 / image.width, available_height / image.height)
            w, h = image.width * scale, image.height * scale
            c.drawImage(ImageReader(image), (612-w)/2, 54+text_height+(available_height-h)/2, w, h)
            c.setFont('WECBook', 14)
            for i, line in enumerate(lines):
                c.drawCentredString(306, 54 + (len(lines)-1-i)*21 + 7, line)
        c.showPage()
        if value['kind'] == 'coloring':
            c.showPage()
    # Even total page count for book interiors; art/storybooks are double-sided.
    if value['kind'] != 'coloring' and len(value['pages']) % 2:
        c.showPage()
    c.save()
    return output.getvalue()


def video_project(db_path, payload):
    if not isinstance(payload, dict) or payload.get('kind') != 'video':
        raise ValueError('Choose a video project')
    pages = payload.get('pages')
    if not isinstance(pages, list) or not 1 <= len(pages) <= 7 or any(not isinstance(p, dict) for p in pages):
        raise ValueError('Add 1-7 video scenes')
    words = [text(p.get('text', ''), 'Scene text', 1800) for p in pages]
    story = ' '.join(words)
    # Older API clients supply only page text. New workspace payloads also carry
    # the editable narration and count: never silently discard those edits.
    if 'narration' in payload:
        narration = text(payload['narration'], 'Narration', 30000, True)
        if ' '.join(narration.split()) != ' '.join(story.split()):
            raise ValueError('Narration changed. Use Split narration and review the pictures before opening Video Studio.')
    if 'sceneCount' in payload and (type(payload['sceneCount']) is not int or payload['sceneCount'] != len(pages)):
        raise ValueError('Scene count changed. Use Split narration and review the pictures before opening Video Studio.')
    planned = plan({'story': story, 'scenes': len(pages), 'duration': payload.get('duration', 35)})
    if any(' '.join(page_text.split()) != scene['narration'] for page_text, scene in zip(words, planned['scenes'])):
        raise ValueError('Scene text changed. Use Split narration before attaching pictures so scene boundaries match the video renderer')
    value = prepare(payload)
    images = []
    for index, page in enumerate(value['pages'], 1):
        raw, _, _ = _read_image(page['raw'])
        images.append({'scene_id': f'scene-{index:03d}', 'mime': 'image/jpeg',
                       'image_base64': base64.b64encode(raw).decode('ascii')})
    return restore_backup(db_path, {'schema_version': 2, 'projects': [{
        'title': value['title'], 'story': story, 'scenes': len(images),
        'duration': planned['duration'], 'scene_images': images}]})


def cover_pdf(payload):
    """Letter wrap for this exporter: B/W white or premium color white only."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader
    from reportlab.lib.colors import HexColor
    value = prepare(payload)
    if value['kind'] == 'video':
        raise ValueError('A movie does not have a paperback cover')
    blurb = text(payload.get('back_text', ''), 'Back cover text', 800, True)
    encoded = payload.get('cover_image_base64') or payload['pages'][0]['image_base64']
    cover = prepare({'kind': 'art', 'title': value['title'], 'pages': [{'image_base64': encoded}]})['pages'][0]['raw']
    if sum(len(p['raw']) for p in value['pages']) + (len(cover) if payload.get('cover_image_base64') else 0) > MAX_ASSETS:
        raise StorageLimitError('Cover plus interior artwork exceeds 30 MiB')
    count = 2+len(value['pages'])*2 if value['kind'] == 'coloring' else 2+len(value['pages'])+(len(value['pages'])%2)
    spine = count*(.002252 if value['kind'] == 'coloring' else .002347)*72
    width, height = 1242+spine, 810
    front = 621+spine
    _fonts()
    output = io.BytesIO()
    c = canvas.Canvas(output, pagesize=(width, height), pageCompression=1, initialFontName='WECBook')
    c.setTitle(value['title']); c.setAuthor(value['author'])
    c.setFillColor(HexColor('#fff8eb'));c.rect(0, 0, width, height, fill=1, stroke=0)
    c.setFillColor(HexColor('#49315c'));c.setFont('WECBook', 26)
    title_lines = _lines(value['title'], 468, 26)
    if len(title_lines)>5:
        raise ValueError('Shorten the title to fit this cover template')
    for i,line in enumerate(title_lines):c.drawCentredString(front+306, 704-i*35, line)
    with Image.open(io.BytesIO(cover)) as source:
        rgba=ImageOps.exif_transpose(source).convert('RGBA')
        picture=Image.new('RGB',rgba.size,'#fff8eb');picture.paste(rgba,mask=rgba.getchannel('A'))
        scale=min(450/picture.width, 300/picture.height);w,h=picture.width*scale,picture.height*scale
        c.drawImage(ImageReader(picture),front+306-w/2,210+(300-h)/2,w,h)
    c.setFont('WECBook',12)
    subtitle=f'{len(value["pages"])} illustrations to make your own' if value['kind']=='coloring' else 'A world of imagination, one page at a time'
    c.drawCentredString(front+306,180,subtitle)
    for i,line in enumerate(_lines(value['author'],468,12)):c.drawCentredString(front+306,115-i*18,line)
    c.setFont('WECBook',20);c.drawCentredString(315,690,'A little imagination goes a long way.')
    c.setFont('WECBook',13)
    lines=_lines(blurb,450,13)
    if len(lines)>23:
        raise ValueError('Shorten the back-cover description to fit above the barcode')
    for i,line in enumerate(lines):c.drawString(90,620-i*21,line)
    c.setFont('WECBook',11);c.drawString(90,126,f'{count} pages | 8.5 x 11 inches')
    # 2 x 1.2 inches, at least .25 inches inside back trim and away from spine.
    c.setFillColorRGB(1,1,1);c.rect(441,27,144,86.4,fill=1,stroke=0)
    c.showPage();c.save()
    return output.getvalue()
