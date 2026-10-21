const $ = id => document.getElementById(id);
const msg = text => { $('message').textContent = text; };
const API_BASE = (window.WEC_API_BASE || '').replace(/\/$/, '');
const MAX_IMAGE_UPLOAD = 8 * 1024 * 1024;
const MAX_BACKUP_UPLOAD = 40 * 1024 * 1024;
let selected = null;
let loadedProject = null;
let dirty = false;
let busy = false;
let videoState = null;
let videoTimer = null;
let videoURL = null;
let playingJob = null;
const imageURLs = new Set();
let deviceScope = null;
let deviceRecord = null;
let deviceError = false;
let deviceReadable = false;
let deviceConflict = false;
let serverEmpty = null;
let deviceQueue = Promise.resolve();

function token() { return sessionStorage.getItem('wec_token') || ''; }
async function request(path, options = {}, retry = true) {
  if (API_BASE && new URL(API_BASE).protocol !== 'https:') throw Error('A separate backend must use HTTPS.');
  const headers = {
    'X-WEC-Token': token(),
    ...(options.body ? {'Content-Type': 'application/json'} : {}),
    ...options.headers,
  };
  const response = await fetch(API_BASE + path, {...options, headers});
  if (response.status === 401 && retry) {
    const value = prompt('Studio access token (stored for this browser tab):');
    if (value === null) throw Error('Authentication cancelled');
    sessionStorage.setItem('wec_token', value);
    resetDeviceView();
    return request(path, options, false);
  }
  if (response.status === 401) {
    sessionStorage.removeItem('wec_token');
    resetDeviceView();
    throw Error('Access token rejected. Try the action again to enter a new token.');
  }
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw Error(value.error || 'Request failed. Try again.');
  }
  return response;
}
async function api(path, options) { return (await request(path, options)).json(); }
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button, #editor input, #editor textarea, #preview input, #preview textarea').forEach(item => { item.disabled = value || item.dataset.generationReady === 'false'; });
  $('editor').setAttribute('aria-busy', String(value));
  updateVideoButton();
  updateDeviceView();
}
async function runAction(action) {
  if (busy) return;
  setBusy(true);
  try { await action(); } catch (error) { msg(error.message); }
  finally { setBusy(false); }
}
function clearPreview() {
  for (const url of imageURLs) URL.revokeObjectURL(url);
  imageURLs.clear();
  $('preview').textContent = 'Save a story, then preview its scenes.';
}
function load(project) {
  selected = project.id;
  loadedProject = project;
  for (const key of ['title', 'story', 'duration', 'scenes']) $(key).value = project[key];
  dirty = false;
  clearPreview();
  msg('Editing ' + project.title);
  updateVideoButton();
}
async function refresh() {
  const value = await api('/api/projects');
  const root = $('projects'); root.replaceChildren();
  if (!value.projects.length) root.textContent = 'No projects yet.';
  for (const project of value.projects) {
    const item = document.createElement('div'); item.className = 'item'; item.dataset.project = project.id;
    const title = document.createElement('strong'); title.textContent = project.title;
    const detail = document.createElement('p'); detail.textContent = `${project.scenes} scenes · ${project.duration}s · ${project.image_count || 0} images`;
    const button = document.createElement('button'); button.className = 'secondary'; button.type = 'button'; button.textContent = 'Open'; button.disabled = busy;
    button.onclick = () => runAction(async () => {
      if (dirty && !confirm('Discard unsaved edits and open this project?')) return;
      load(await api('/api/projects/' + project.id));
      await showScenes();
      msg('Editing ' + project.title);
    });
    item.append(title, detail, button); root.append(item);
  }
  await syncDevice(value.projects.length);
}

function resetDeviceView() {
  deviceScope = null; deviceRecord = null; deviceConflict = false; deviceError = false; deviceReadable = false; serverEmpty = null;
  updateDeviceView();
}
function updateDeviceView() {
  const projects = deviceRecord?.backup?.projects || [];
  const hasCopy = Boolean(projects.length);
  let text = hasCopy
    ? `Saved on this device: ${new Date(deviceRecord.savedAt).toLocaleString()} · ${projects.length} project(s) · ${projects.reduce((n, p) => n + p.scene_images.length, 0)} picture(s). Saved changes only.`
    : 'No saved copy in this browser yet. Save a project to begin.';
  if (!deviceScope) text = 'Device backup needs your studio access token and available browser storage.';
  if (deviceRecord?.paused) text = 'Automatic device backup is off. The device copy was removed. Download backups to keep your work.';
  if (deviceConflict) text = 'The server has different projects. Your earlier device copy was kept. Download it before choosing to use the current server projects. ' + text;
  if (deviceError) text = 'Device backup could not be updated. Browser storage may be unavailable or full, or the connection failed. Download a backup for recent changes. ' + (hasCopy ? text : 'No device copy is confirmed.');
  $('device-status').textContent = text;
  $('device-recover').hidden = !(hasCopy && serverEmpty === true);
  $('device-recover').disabled = busy || !hasCopy || serverEmpty !== true;
  $('device-download').disabled = busy || !hasCopy;
  $('device-toggle').disabled = busy || !deviceScope || !deviceReadable;
  $('device-toggle').textContent = deviceRecord?.paused ? 'Enable device backup' : 'Turn off & remove device copy';
  $('device-replace').hidden = !deviceConflict;
  $('device-replace').disabled = busy || !deviceConflict || serverEmpty !== false;
}
function deviceTask(action) {
  deviceQueue = deviceQueue.then(action).catch(() => { deviceError = true; }).finally(updateDeviceView);
  return deviceQueue;
}
async function readDevice() {
  const accessToken = token();
  const key = await WECDeviceBackups.scope(API_BASE || location.origin, accessToken);
  if (accessToken !== token()) return;
  if (key !== deviceScope) { deviceRecord = null; deviceConflict = false; deviceError = false; }
  deviceScope = key;
  deviceReadable = false;
  const record = key ? await WECDeviceBackups.read(key) : null;
  if (accessToken !== token() || key !== deviceScope) return;
  deviceRecord = record;
  deviceReadable = Boolean(key);
}
async function captureDevice(replace = false, backup = null) {
  const key = deviceScope, accessToken = token();
  if (!key || deviceRecord?.paused) return;
  const capturedAt = Date.now();
  if (!backup) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try { backup = await (await request('/api/backup', {signal: controller.signal}, false)).json(); }
    finally { clearTimeout(timer); }
  }
  if (key !== deviceScope || accessToken !== token()) return;
  const result = await WECDeviceBackups.save(key, backup, capturedAt, replace);
  if (key !== deviceScope || accessToken !== token()) return;
  deviceRecord = result.record; deviceConflict = result.conflict; deviceError = false;
}
function syncDevice(projectCount) {
  serverEmpty = projectCount === 0;
  if (serverEmpty) deviceConflict = false;
  return deviceTask(async () => {
    await readDevice();
    if (projectCount) await captureDevice();
  });
}
function downloadBackup(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('device-download').onclick = () => runAction(async () => {
  await deviceTask(readDevice);
  if (!deviceRecord?.backup?.projects.length) throw Error('No device backup is available.');
  downloadBackup(deviceRecord.backup, 'wec-device-backup.json');
  msg('Device backup download opened. Save it outside this browser. Movies and unsaved edits are not included.');
});
$('device-toggle').onclick = () => runAction(async () => {
  await deviceTask(readDevice);
  if (!deviceScope || !deviceReadable) throw Error('Device storage is unavailable. Keep a downloaded backup.');
  const paused = !deviceRecord?.paused;
  if (paused && !confirm('Turn off automatic device backup and remove its stories and pictures from this browser? Server projects and downloaded files stay in place.')) return;
  await deviceTask(async () => {
    deviceRecord = await WECDeviceBackups.pause(deviceScope, paused);
    deviceConflict = false; deviceError = false;
  });
  if (!paused) await refresh();
});
$('device-replace').onclick = () => runAction(async () => {
  if (!confirm('Replace the earlier device backup with the current server projects? Download the earlier copy first if you want to keep it.')) return;
  await deviceTask(async () => { await readDevice(); await captureDevice(true); });
});
$('device-recover').onclick = () => runAction(async () => {
  await deviceTask(readDevice);
  const backup = deviceRecord?.backup, key = deviceScope;
  if (!backup?.projects.length || !deviceReadable) throw Error('No readable device backup is available. Use a downloaded backup.');
  const current = await api('/api/projects');
  if (current.projects.length) {
    await refresh();
    throw Error('Server projects already exist. Nothing was restored. Download the device backup to review it separately.');
  }
  const warning = dirty ? 'This replaces the unsaved edits in your editor. ' : '';
  if (!confirm(`${warning}Recover ${backup.projects.length} saved project(s) and their pictures to this empty server? Movies are not included.`)) return;
  if (key !== deviceScope) throw Error('Studio access changed. Reload before recovering.');
  const result = await api('/api/restore', {method: 'POST', body: JSON.stringify({...backup, only_if_empty: true})});
  load(await api('/api/projects/' + result.projects[0].id));
  await deviceTask(() => captureDevice(true));
  await refresh(); await showScenes();
  msg(`Recovered ${result.restored} project(s) and their attached pictures from this device. Download a separate backup to keep them.`);
});
for (const key of ['title', 'story', 'duration', 'scenes']) {
  $(key).addEventListener('input', () => { dirty = true; clearPreview(); updateVideoButton(); });
}
$('new').onclick = () => {
  if (busy || (dirty && !confirm('Discard unsaved edits and start a new project?'))) return;
  selected = null; loadedProject = null; dirty = false;
  $('title').value = ''; $('story').value = ''; $('duration').value = 35; $('scenes').value = 7;
  clearPreview(); msg('New project ready.'); $('title').focus();
  updateVideoButton();
};
async function saveCurrent() {
  const payload = {title: $('title').value, story: $('story').value, duration: Number($('duration').value), scenes: Number($('scenes').value)};
  if (loadedProject?.image_count && (payload.story.trim() !== loadedProject.story || payload.scenes !== loadedProject.scenes)) {
    if (!confirm('Changing the story or scene count clears its attached images. Download a backup first if you want to keep this version. Continue?')) return;
    payload.reset_images = true;
  }
  const project = await api(selected ? '/api/projects/' + selected : '/api/projects', {method: 'POST', body: JSON.stringify(payload)});
  selected = project.id; loadedProject = project; dirty = false;
  msg('Project saved on this studio server. Download a backup to keep a separate copy.');
  await refresh();
  await refreshVideos();
}
$('save').onclick = $('save-top').onclick = () => runAction(saveCurrent);
function requireSaved() {
  if (!selected || dirty) throw Error('Save your current edits first.');
}
async function showScenes() {
  requireSaved();
  const pid = selected;
  const plan = await api('/api/projects/' + pid + '/plan');
  const generation = await api('/api/generation');
  $('generation-status').textContent = generation.ready
    ? `Generate one image at a time with ${generation.model}. Your prompt is sent to Cloudflare. ${generation.attempts_today}/${generation.daily_limit} attempts used today. Existing pictures are kept. Prompt edits apply to this request only.`
    : 'AI image generation needs owner setup. You can upload pictures now.';
  clearPreview();
  const root = $('preview'); root.replaceChildren();
  for (const scene of plan.scenes) {
    const item = document.createElement('div'); item.className = 'scene'; item.dataset.scene = scene.id;
    const title = document.createElement('strong'); title.textContent = `${scene.id} · ${scene.start}s–${(scene.start + scene.duration).toFixed(1)}s`;
    const text = document.createElement('p'); text.textContent = scene.narration || '(No narration assigned)';
    item.append(title, text);
    if (scene.image_asset) {
      // Fetch with a header, then use a local blob URL. Tokens never appear in image URLs.
      const response = await request(`/api/projects/${pid}/scenes/${scene.id}/image`);
      const url = URL.createObjectURL(await response.blob()); imageURLs.add(url);
      const image = document.createElement('img'); image.className = 'scene-image'; image.src = url;
      image.alt = `Attached image for ${scene.id}`; item.append(image);
    } else {
      const empty = document.createElement('p'); empty.className = 'image-empty'; empty.textContent = 'No image attached yet.'; item.append(empty);
    }
    const actions = document.createElement('div'); actions.className = 'actions';
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.hidden = true;
    input.id = 'upload-' + scene.id;
    const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'secondary'; choose.textContent = scene.image_asset ? 'Replace image' : 'Upload image'; choose.disabled = busy;
    choose.onclick = () => { if (!busy) input.click(); };
    input.onchange = () => runAction(async () => {
      const file = input.files[0]; input.value = ''; if (!file) return;
      requireSaved();
      if (file.size > MAX_IMAGE_UPLOAD) throw Error('Choose an image smaller than 8 MB.');
      if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw Error('Choose a JPG, PNG or WebP image.');
      msg('Uploading image…');
      await api(`/api/projects/${pid}/scenes/${scene.id}/image`, {method: 'POST', headers: {'Content-Type': file.type || 'application/octet-stream'}, body: file});
      loadedProject = await api('/api/projects/' + pid);
      await refresh(); await showScenes();
      msg('Image attached to ' + scene.id + '. Download a backup to keep it.');
    });
    actions.append(choose, input);
    if (scene.image_asset) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remove image'; remove.disabled = busy;
      remove.onclick = () => runAction(async () => {
        requireSaved();
        if (!confirm('Remove the image from ' + scene.id + '?')) return;
        await api(`/api/projects/${pid}/scenes/${scene.id}/image/remove`, {method: 'POST'});
        loadedProject = await api('/api/projects/' + pid);
        await refresh(); await showScenes(); msg('Scene image removed.');
      });
      actions.append(remove);
    }
    if (!scene.image_asset) {
      let promptInput;
      if (generation.ready) {
        const label = document.createElement('label'); label.htmlFor = 'prompt-' + scene.id; label.textContent = 'Image prompt';
        promptInput = document.createElement('textarea'); promptInput.id = label.htmlFor; promptInput.rows = 3;
        promptInput.maxLength = 2048; promptInput.value = scene.prompt; promptInput.disabled = busy;
        item.append(label, promptInput);
      }
      const generate = document.createElement('button'); generate.type = 'button'; generate.className = 'generate';
      generate.textContent = 'Generate image'; generate.disabled = busy || !generation.ready;
      generate.dataset.generationReady = generation.ready ? 'true' : 'false';
      if (!generation.ready) generate.title = 'Owner setup is required before generating images.';
      generate.onclick = () => runAction(async () => {
        requireSaved();
        const prompt = promptInput.value.trim();
        if (!prompt || prompt.length > 2048) throw Error('Enter an image prompt between 1 and 2048 characters.');
        if (!confirm('Send this prompt to Cloudflare to generate one image? This uses your Workers AI allowance.')) return;
        msg('Generating one image… Keep this page open. If the connection drops, reopen the project before trying again.');
        await api(`/api/projects/${pid}/scenes/${scene.id}/generate`, {method: 'POST', body: JSON.stringify({prompt})});
        loadedProject = await api('/api/projects/' + pid);
        await refresh(); await showScenes();
        msg('Image generated and attached to ' + scene.id + '. Download a backup to keep it.');
      });
      actions.append(generate);
    }
    item.append(actions); root.append(item);
  }
  await refreshVideos();
}
$('plan').onclick = () => runAction(async () => { await showScenes(); msg('Scene plan ready. Upload an image for each scene below.'); });
$('dry').onclick = () => runAction(async () => {
  requireSaved();
  const result = await api('/api/projects/' + selected + '/dry-run');
  msg('Dry-run: ' + result.tasks.join(' → '));
});
$('backup').onclick = () => runAction(async () => {
  const data = await api('/api/backup');
  downloadBackup(data, 'wec-projects-backup.json');
  await deviceTask(async () => { await readDevice(); await captureDevice(false, data); });
  msg('Backup downloaded with your stories and attached images. Store it somewhere safe.');
});
$('restore').onclick = () => { if (!busy) $('restore-file').click(); };
$('restore-file').onchange = () => runAction(async () => {
  const file = $('restore-file').files[0]; if (!file) return;
  $('restore-file').value = '';
  if (file.size > MAX_BACKUP_UPLOAD) throw Error('Choose a WEC backup smaller than 40 MB.');
  const text = await file.text();
  let backup;
  try { backup = JSON.parse(text); } catch { throw Error('This file is not valid JSON. Choose a downloaded WEC backup.'); }
  if (!Array.isArray(backup?.projects) || !backup.projects.length || ![1, 2].includes(backup.schema_version)) throw Error('Choose a WEC project backup.');
  const warning = dirty ? 'This replaces the unsaved edits in your editor. ' : '';
  if (!confirm(`${warning}Restore ${backup.projects.length} project(s) as new copies? Existing saved projects will stay in place.`)) return;
  msg('Restoring backup…');
  const result = await api('/api/restore', {method: 'POST', body: text});
  load(await api('/api/projects/' + result.projects[0].id));
  await refresh(); await showScenes();
  msg(`Restored ${result.restored} project(s) as new copies, with their attached images. Existing projects were kept.`);
});
function updateVideoButton() {
  const active = videoState?.jobs.some(job => ['queued', 'running'].includes(job.status));
  const ready = Boolean(selected && !dirty && videoState?.ready && !active && videoState.attempts_today < videoState.daily_limit);
  $('render-video').dataset.generationReady = String(ready);
  $('render-video').disabled = busy || !ready;
}
async function loadMovie(job) {
  if (playingJob !== job.id) {
    const response = await request(`/api/video-jobs/${job.id}/file`);
    const blob = await response.blob();
    if (blob.size > 20000000) throw Error('This movie is too large to open here.');
    const next = URL.createObjectURL(blob);
    $('movie').pause();
    $('movie').src = next;
    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = next; playingJob = job.id;
  }
  $('video-player-title').textContent = job.title + ' — saved version used for this render';
  $('video-player').hidden = false;
}
async function refreshVideos() {
  clearTimeout(videoTimer);
  videoState = await api('/api/video');
  $('video-availability').textContent = videoState.ready
    ? `Render up to ${videoState.max_duration} seconds and ${videoState.max_scenes} scenes from your attached pictures. ${videoState.attempts_today}/${videoState.daily_limit} render attempts used today. No image AI requests are made. Free hosting may take several minutes.`
    : videoState.message;
  const root = $('video-jobs'); root.replaceChildren();
  for (const job of videoState.jobs) {
    const item = document.createElement('div'); item.className = 'video-job'; item.dataset.job = job.id;
    const heading = document.createElement('strong'); heading.textContent = job.title;
    const status = document.createElement('p'); status.textContent = job.message; status.setAttribute('role', 'status');
    item.append(heading, status);
    const actions = document.createElement('div'); actions.className = 'actions';
    function button(name, action) {
      const control = document.createElement('button'); control.type = 'button'; control.className = 'secondary';
      control.textContent = name; control.disabled = busy; control.onclick = () => runAction(action);
      actions.append(control);
    }
    if (['queued', 'running'].includes(job.status)) {
      const progress = document.createElement('progress'); progress.max = 100; progress.value = job.progress;
      progress.setAttribute('aria-label', 'Video render progress'); item.append(progress);
      button('Cancel render', async () => {
        await api(`/api/video-jobs/${job.id}/cancel`, {method: 'POST'}); await refreshVideos();
      });
    } else {
      if (job.status === 'ready') {
        button('Play video', async () => { await loadMovie(job); $('video-player').scrollIntoView({block: 'center', behavior: 'smooth'}); });
        button('Download video', async () => {
          await loadMovie(job);
          const link = document.createElement('a'); link.href = videoURL; link.download = `wec-video-${job.id.slice(0,8)}.mp4`;
          document.body.append(link); link.click(); link.remove();
          msg('Movie download opened. Save it to your device to keep it.');
        });
      }
      button('Remove server copy', async () => {
        if (!confirm('Remove this movie from the server? Download it first. Your saved story and scene pictures stay in place.')) return;
        await api(`/api/video-jobs/${job.id}/remove`, {method: 'POST'});
        if (playingJob === job.id) {
          $('movie').pause(); $('movie').removeAttribute('src'); $('movie').load(); $('video-player').hidden = true;
          URL.revokeObjectURL(videoURL); videoURL = null; playingJob = null;
        }
        await refreshVideos();
      });
    }
    item.append(actions); root.append(item);
  }
  updateVideoButton();
  if (videoState.jobs.some(job => ['queued', 'running'].includes(job.status))) {
    videoTimer = setTimeout(() => refreshVideos().catch(error => { msg(error.message); }), 2500);
  }
}
$('render-video').onclick = () => runAction(async () => {
  requireSaved();
  if (!confirm('Build a narrated movie from this saved story and its attached pictures? This uses one local render attempt and does not generate new images.')) return;
  await api(`/api/projects/${selected}/video`, {method: 'POST', body: JSON.stringify({ambience: true})});
  await refreshVideos();
  msg('Movie rendering started. You can follow its progress below.');
});
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
runAction(async () => { await deviceTask(readDevice); await refresh(); await refreshVideos(); });
