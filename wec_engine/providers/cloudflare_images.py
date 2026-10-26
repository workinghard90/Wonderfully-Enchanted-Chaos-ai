"""Opt-in Workers AI text/reference adapters; no retries or automatic fallback."""
import base64
import binascii
import io
import json
import os
import re
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError
import requests

MODEL = '@cf/black-forest-labs/flux-1-schnell'
REFERENCE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b'
MAX_REFERENCE = 10 * 1024 * 1024
MAX_PROMPT = 2048
MAX_RESPONSE = 12 * 1024 * 1024
MAX_IMAGE = 8 * 1024 * 1024


class GenerationError(Exception):
    """Safe, user-facing error. Never expose upstream bodies or credentials."""
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def validate_prompt(prompt):
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= MAX_PROMPT:
        raise ValueError('Image prompt must contain 1–2048 characters')
    try:
        prompt.encode('utf-8')
    except UnicodeEncodeError as exc:
        raise ValueError('Image prompt contains invalid characters') from exc
    return prompt.strip()


def prepare_reference(encoded):
    """Validate before reserving an attempt; upload a small metadata-free copy."""
    try:
        if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_REFERENCE + 2) // 3):
            raise ValueError('Invalid reference size')
        raw = base64.b64decode(encoded, validate=True)
        if not raw or len(raw) > MAX_REFERENCE:
            raise ValueError('Invalid reference size')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in ('PNG', 'JPEG', 'WEBP') or source.width * source.height > 12_000_000:
                    raise ValueError('Unsupported reference')
                source.load()
                image = ImageOps.exif_transpose(source).convert('RGBA')
                image.thumbnail((512, 512), Image.Resampling.LANCZOS)
                clean = Image.new('RGB', image.size, 'white')
                clean.paste(image, mask=image.getchannel('A'))
                output = io.BytesIO()
                clean.save(output, format='PNG')
                return output.getvalue()
    except (ValueError, TypeError, binascii.Error, OSError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise ValueError('Choose a valid PNG, JPEG or WebP reference up to 10 MiB and 12 megapixels.') from None


class CloudflareImages:
    def __init__(self, account_id=None, api_token=None, enabled=None):
        self.account_id = account_id if account_id is not None else os.getenv('WEC_CLOUDFLARE_ACCOUNT_ID', '')
        self.api_token = api_token if api_token is not None else os.getenv('WEC_CLOUDFLARE_API_TOKEN', '')
        self.enabled = enabled if enabled is not None else os.getenv('WEC_ENABLE_IMAGE_GENERATION') == '1'

    def configured(self):
        return bool(re.fullmatch(r'[a-fA-F0-9]{32}', self.account_id)
                    and self.api_token and all(33 <= ord(c) <= 126 for c in self.api_token))

    def ready(self):
        return self.enabled is True and self.configured()

    def generate(self, prompt, *, reference=None):
        prompt = validate_prompt(prompt)
        if not self.ready():
            raise GenerationError('Image generation needs owner setup before it can run.', 503)
        model = REFERENCE_MODEL if reference is not None else MODEL
        endpoint = f'https://api.cloudflare.com/client/v4/accounts/{self.account_id}/ai/run/{model}'
        inputs = {'json': {'prompt': prompt, 'steps': 4}}
        if reference is not None:
            # Callers use prepare_reference before quota admission. Requests supplies
            # the multipart boundary; never set Content-Type manually.
            inputs = {'data': {'prompt': prompt, 'width': '1024', 'height': '1024'},
                      'files': {'input_image_0': ('reference.png', reference, 'image/png')}}
        try:
            with requests.post(endpoint, **inputs,
                               headers={'Authorization': f'Bearer {self.api_token}'},
                               timeout=(5, 45), stream=True, allow_redirects=False) as response:
                if response.status_code in (401, 403):
                    raise GenerationError('Cloudflare rejected access. The owner should check the Workers AI token and account.', 503)
                if response.status_code == 429:
                    raise GenerationError('Cloudflare is busy or its allowance is used. Try again later.', 429)
                if response.status_code != 200:
                    raise GenerationError('Cloudflare could not generate this image. Review the prompt or try later.')
                chunks, size = [], 0
                for chunk in response.iter_content(chunk_size=65536):
                    size += len(chunk)
                    if size > MAX_RESPONSE:
                        raise GenerationError('Cloudflare returned an oversized image response.')
                    chunks.append(chunk)
            result = json.loads(b''.join(chunks))
            if not isinstance(result, dict) or result.get('success') is not True:
                raise ValueError('Invalid response envelope')
            value = result.get('result')
            encoded = value.get('image') if isinstance(value, dict) else None
            if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_IMAGE + 2) // 3):
                raise ValueError('Invalid image response')
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > MAX_IMAGE:
                raise ValueError('Image too large')
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw)) as image:
                    if image.format not in ('JPEG', 'PNG', 'WEBP') or min(image.size) < 256 or image.width * image.height > 32_000_000:
                        raise ValueError('Unsupported generated image')
                    image.verify()
            return raw
        except requests.Timeout:
            raise GenerationError('Cloudflare timed out. Reopen this project to check for an image before trying again.', 504) from None
        except requests.RequestException:
            raise GenerationError('Cloudflare could not be reached. Try again later.', 502) from None
        except (ValueError, TypeError, binascii.Error, OSError, UnidentifiedImageError,
                Image.DecompressionBombWarning, Image.DecompressionBombError, RecursionError):
            raise GenerationError('Cloudflare returned an unusable image. No existing picture was replaced.') from None
