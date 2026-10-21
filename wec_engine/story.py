"""Deterministic story-to-scene planning; does not pretend to be an LLM."""
import json
import math
import re
from pathlib import Path


def plan_story(story, *, total_duration=35.0, scene_count=7, character=None):
    if not isinstance(story, str) or not story.strip():
        raise ValueError('Story text is required')
    if isinstance(scene_count, bool) or not isinstance(scene_count, int) or not 1 <= scene_count <= 100:
        raise ValueError('scene_count must be between 1 and 100')
    if isinstance(total_duration, bool) or not isinstance(total_duration, (int, float)) or not math.isfinite(total_duration) or not 0 < total_duration <= 3600:
        raise ValueError('total_duration must be between 0 and 3600 seconds')
    sentences = re.findall(r'[^.!?\n]+(?:[.!?]+|$)', story.strip())
    sentences = [s.strip() for s in sentences if s.strip()]
    # Evenly allocate narrative chunks, preserving original order.
    words = story.split()
    segments = []
    for i in range(scene_count):
        a, b = round(i * len(words) / scene_count), round((i + 1) * len(words) / scene_count)
        segments.append(' '.join(words[a:b]))
    if float(total_duration) / scene_count < 1 / 30:
        raise ValueError('Each scene must last at least one frame at 30 fps')
    scenes = []
    for i, segment in enumerate(segments):
        start = round(float(total_duration) * i / scene_count, 3)
        end = round(float(total_duration) * (i + 1) / scene_count, 3)
        scenes.append({
            'id': f'scene-{i+1:03d}', 'start': start, 'duration': round(end-start, 3),
            'narration': segment, 'prompt': f'Whimsical cinematic fantasy storybook scene: {segment}',
            'motion_prompt': 'Subtle natural character movement and cinematic camera motion',
            'character_id': character, 'status': 'planned',
            'image': None, 'video': None,
        })
    return {'version': 1, 'title': 'Untitled Story', 'duration': float(total_duration),
            'format': {'width': 1080, 'height': 1920, 'fps': 30}, 'scenes': scenes}


def save_plan(plan, output):
    target = Path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(plan, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    return target
