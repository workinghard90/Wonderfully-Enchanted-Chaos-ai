"""Read-only, owner-scoped WEC storage capacity diagnostics.

Distinguish three independent limits: filesystem headroom, immutable Creative
snapshot quotas, and retained video slots. No project bytes, paths, titles,
credentials, or per-job details are returned. No cleanup is performed.
"""
import os
import shutil

from .online_store import HEADROOM, MAX_PACKAGE
from .studio_video import MAX_VIDEO_PACKAGE_BYTES


def capacity_report(data_dir, online_store, video_jobs):
    """Return only aggregate usage; all disk and store access is read-only."""
    disk = shutil.disk_usage(data_dir)
    video = video_jobs.status()
    jobs = video['jobs']
    max_jobs = int(video['max_saved_videos'])
    saved = len(jobs)
    attempts = int(video['attempts_today'])
    daily = int(video['daily_limit'])

    result = {
        'schema_version': 1,
        'storage': {
            'total_bytes': int(disk.total),
            'used_bytes': int(disk.used),
            'free_bytes': int(disk.free),
            # Render's persistent disk is different from image-build cache.
            'mount_confirmed': bool(os.path.ismount(data_dir)) if os.getenv('RENDER') else None,
            'max_snapshot_bytes_possible': max(0, int(disk.free) - HEADROOM),
            'video_package_headroom_bytes': HEADROOM + MAX_VIDEO_PACKAGE_BYTES,
        },
        'snapshots': {'enabled': online_store is not None},
        'videos': {
            'saved': saved,
            'max_saved': max_jobs,
            'remaining_slots': max(0, max_jobs - saved),
            'attempts_today': attempts,
            'daily_limit': daily,
            'remaining_attempts_today': max(0, daily - attempts),
            'active': sum(j.get('status') in ('queued', 'running') for j in jobs),
        },
        'warnings': [],
    }

    if online_store is not None:
        online = online_store.list()
        count = len(online['snapshots'])
        result['snapshots'].update({
            'saved': count,
            'max_saved': int(online['max_snapshots']),
            'used_bytes': int(online['used_bytes']),
            'max_bytes': int(online['max_bytes']),
            'max_package_bytes': int(online['max_package_bytes']),
            'remaining_slots': max(0, int(online['max_snapshots']) - count),
            'remaining_quota_bytes': max(0, int(online['max_bytes']) - int(online['used_bytes'])),
        })

    def warn(code, message):
        result['warnings'].append({'code': code, 'message': message})

    if result['storage']['mount_confirmed'] is False:
        warn('persistent_mount_missing', 'Render persistent disk mount is not confirmed. Do not rely on server copies as backups.')
    if saved >= max_jobs:
        warn('video_slots_full',
             'The saved video limit is full; this does not mean the 5 GB disk is full. Download and verify an older video package before removing its server copy.')
    if attempts >= daily:
        warn('daily_render_limit', 'The daily render attempt limit is reached; removing old videos does not reset this counter.')
    if online_store is not None:
        snapshots = result['snapshots']
        if snapshots['remaining_slots'] == 0:
            warn('snapshot_count_full', 'Online snapshot count limit reached; download and verify an older snapshot before removing it.')
        if snapshots['remaining_quota_bytes'] == 0:
            warn('snapshot_quota_full', 'Online snapshot byte quota reached; the physical disk may still have space.')
    if disk.free < HEADROOM + MAX_PACKAGE:
        warn('snapshot_headroom_low', 'The disk may not have enough free space for a maximum-size snapshot.')
    if disk.free < HEADROOM + MAX_VIDEO_PACKAGE_BYTES:
        warn('video_package_headroom_low', 'The disk may not have enough temporary space to build a video ZIP package.')
    return result
