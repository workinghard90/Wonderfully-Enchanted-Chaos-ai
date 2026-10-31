// Shared server render queue. Movies belong to immutable server snapshots,
// not to whichever browser project happens to be open while a job completes.
export function videoPanel({ api, run, busy }) {
  const $ = (id) => document.getElementById(id);
  let timer, movieURL, playing;
  function clearMovie() {
    $('render-movie').pause();
    $('render-movie').removeAttribute('src');
    $('render-movie').load();
    $('render-player').hidden = true;
    if (movieURL) URL.revokeObjectURL(movieURL);
    movieURL = playing = null;
  }
  async function load(job) {
    if (playing !== job.id) {
      const response = await api(`/api/video-jobs/${job.id}/file`);
      const blob = await response.blob();
      if (blob.size > 20000000) throw Error('This movie is too large to open here.');
      clearMovie();
      movieURL = URL.createObjectURL(blob);
      playing = job.id;
      $('render-movie').src = movieURL;
    }
    $('render-player-title').textContent = job.title + ' — saved version used for this render';
    $('render-player').hidden = false;
  }
  async function refresh(interactive = true) {
    clearTimeout(timer);
    const state = await (await api('/api/video', undefined, interactive)).json();
    $('render-availability').textContent = state.ready
      ? `${state.attempts_today}/${state.daily_limit} render attempts used today. Up to ${state.max_duration} seconds and ${state.max_scenes} scenes. Free hosting may take several minutes.`
      : state.message;
    const root = $('render-jobs');
    root.replaceChildren();
    if (playing && !state.jobs.some(job => job.id === playing && job.status === 'ready')) clearMovie();
    for (const job of state.jobs) {
      const item = document.createElement('div'); item.className = 'render-job';
      const title = document.createElement('h3'); title.textContent = job.title;
      const status = document.createElement('p'); status.textContent = job.message; status.setAttribute('role', 'status');
      item.append(title, status);
      const actions = document.createElement('div'); actions.className = 'toolbar';
      const action = (label, fn) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary';
        b.textContent = label; b.disabled = busy(); b.onclick = () => run(fn); actions.append(b);
      };
      if (['queued', 'running'].includes(job.status)) {
        const progress = document.createElement('progress'); progress.max = 100; progress.value = job.progress;
        progress.setAttribute('aria-label', 'Video render progress'); item.append(progress);
        action('Cancel render', async () => { await api(`/api/video-jobs/${job.id}/cancel`, {}); await refresh(); });
      } else {
        if (['failed', 'cancelled', 'interrupted'].includes(job.status)) {
          const retry = state.jobs.find(other => other.retry_of === job.id);
          if (retry) {
            const note = document.createElement('p');
            note.textContent = 'A retry is already in this list. Use that attempt to continue.';
            item.append(note);
          } else {
            action('Retry saved render', async () => {
              if (!confirm('Start a new render using the exact pictures, narration and ambience saved for this attempt? Later project edits are not included. This uses one render attempt today and starts from the beginning.')) return;
              try {
                await api(`/api/video-jobs/${job.id}/retry`, {});
              } catch (error) {
                // The server might have accepted the retry before the connection failed.
                try { await refresh(false); } catch (_) { /* Keep the original error. */ }
                throw error;
              }
              await refresh();
            });
          }
        }
        if (job.status === 'ready') {
          const review = document.createElement('p');
          review.textContent = 'Final review: ' + ({approved: 'Approved', needs_changes: 'Needs changes'}[job.review] || 'Not reviewed') + '. Applies to this saved movie only.';
          item.append(review);
          action('Play video', () => load(job));
          action('Download MP4', async () => {
            await load(job);
            const a = document.createElement('a'); a.href = movieURL; a.download = `wec-video-${job.id.slice(0, 8)}.mp4`;
            document.body.append(a); a.click(); a.remove();
          });
          action('Download video package', async () => {
            const response = await api(`/api/video-jobs/${job.id}/package`);
            const blob = await response.blob();
            if (blob.size > 40*1024*1024 + 20000000 + 65536) throw Error('This video package is too large to open here. Download the MP4 separately.');
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url;
            a.download = `wec-video-${job.id.slice(0, 8)}-package.zip`;
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          });
          if (job.review !== 'approved') action('Approve video', async () => {
            if (!confirm('Have you reviewed this movie’s narration, captions and pictures? Mark this saved movie approved? Nothing is published.')) return;
            await api(`/api/video-jobs/${job.id}/review`, {review: 'approved'});
            await refresh();
          });
          if (job.review !== 'needs_changes') action('Needs changes', async () => {
            await api(`/api/video-jobs/${job.id}/review`, {review: 'needs_changes'});
            await refresh();
          });
          if (job.review && job.review !== 'unreviewed') action('Clear review', async () => {
            await api(`/api/video-jobs/${job.id}/review`, {review: 'unreviewed'});
            await refresh();
          });
        }
        action('Remove server copy', async () => {
          if (!confirm('Remove this movie from the server? Download it first. Your saved project and pictures stay in place.')) return;
          await api(`/api/video-jobs/${job.id}/remove`, {});
          if (playing === job.id) clearMovie();
          await refresh();
        });
      }
      item.append(actions); root.append(item);
    }
    if (!state.jobs.length) root.textContent = 'No server renders yet. Open a video project and choose Render video.';
    if (state.jobs.some(job => ['queued', 'running'].includes(job.status))) schedule();
    return state;
  }
  function schedule() {
    timer = setTimeout(async () => {
      if (busy()) { schedule(); return; }
      try { await refresh(false); }
      catch (e) { $('render-availability').textContent = `${e.message} Use Refresh renders to reconnect. No new render was started.`; }
    }, 2500);
  }
  $('refresh-renders').onclick = () => run(() => refresh());
  window.addEventListener('pagehide', () => { clearTimeout(timer); clearMovie(); });
  return { refresh };
}
