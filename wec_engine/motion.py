"""Assemble existing clips into silent video; short clips hold their last frame."""
from .video import _render


def render_clips(manifest_path, output_path, *, fps=30, width=1080, height=1920):
    return _render(manifest_path, output_path, clips=True, fps=fps, width=width, height=height)
