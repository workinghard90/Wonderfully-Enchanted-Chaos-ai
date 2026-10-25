"""Shared, side-effect-free validation for the bounded dashboard renderer."""
from .story import plan_story

MAX_SECONDS = 35
MAX_SCENES = 7
MAX_STORY_WORDS = 100
MAX_STORY_CHARACTERS = 1000
MAX_SCENE_WORDS = 25
MAX_SCENE_CHARACTERS = 200


def plan_video(story, *, duration, scenes):
    """Reject unsupported narration before images, storage or render attempts."""
    planned = plan_story(story, total_duration=duration, scene_count=scenes)
    if duration > MAX_SECONDS or scenes > MAX_SCENES:
        raise ValueError('This video test supports up to 35 seconds and 7 scenes.')
    if len(story) > MAX_STORY_CHARACTERS or len(story.split()) > MAX_STORY_WORDS:
        raise ValueError('Keep this short-video test to 100 words and 1000 characters. Shorten the story before rendering.')
    if any(len(scene['narration']) > MAX_SCENE_CHARACTERS or
           len(scene['narration'].split()) > MAX_SCENE_WORDS for scene in planned['scenes']):
        raise ValueError('Shorten long scene narration or increase the scene count. This test allows 25 words and 200 characters per scene.')
    if any(not scene['narration'] for scene in planned['scenes']):
        raise ValueError('Every scene needs narration. Reduce the scene count.')
    return planned
