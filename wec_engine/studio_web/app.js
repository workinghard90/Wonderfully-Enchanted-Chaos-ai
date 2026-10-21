const $ = id => document.getElementById(id);
const msg = text => { $('message').textContent = text; };
const API_BASE = (window.WEC_API_BASE || '').replace(/\/$/, '');
const MAX_IMAGE_UPLOAD = 8 * 1024 * 1024;
const MAX_BACKUP_UPLOAD = 40 * 1024 * 1024;
let selected = null;
let loadedProject = null;
let dirty = false;
let busy = false;
const imageURLs = new Set();

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
    return request(path, options, false);
  }
  if (response.status === 401) {
    sessionStorage.removeItem('wec_token');
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
}
async function refresh() {
  const value = await api('/api/projects');
  const root = $('projects'); root.replaceChildren();
  if (!value.projects.length) { root.textContent = 'No projects yet.'; return; }
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
}
for (const key of ['title', 'story', 'duration', 'scenes']) {
  $(key).addEventListener('input', () => { dirty = true; clearPreview(); });
}
$('new').onclick = () => {
  if (busy || (dirty && !confirm('Discard unsaved edits and start a new project?'))) return;
  selected = null; loadedProject = null; dirty = false;
  $('title').value = ''; $('story').value = ''; $('duration').value = 35; $('scenes').value = 7;
  clearPreview(); msg('New project ready.'); $('title').focus();
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
      await showScenes(); await refresh();
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
        await showScenes(); await refresh(); msg('Scene image removed.');
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
        await showScenes(); await refresh();
        msg('Image generated and attached to ' + scene.id + '. Download a backup to keep it.');
      });
      actions.append(generate);
    }
    item.append(actions); root.append(item);
  }
}
$('plan').onclick = () => runAction(async () => { await showScenes(); msg('Scene plan ready. Upload an image for each scene below.'); });
$('dry').onclick = () => runAction(async () => {
  requireSaved();
  const result = await api('/api/projects/' + selected + '/dry-run');
  msg('Dry-run: ' + result.tasks.join(' → '));
});
$('backup').onclick = () => runAction(async () => {
  const data = await api('/api/backup');
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'wec-projects-backup.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
refresh().catch(error => msg(error.message));
