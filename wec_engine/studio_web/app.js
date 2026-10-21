const $ = id => document.getElementById(id);
const msg = text => { $('message').textContent = text; };
const API_BASE = (window.WEC_API_BASE || '').replace(/\/$/, '');
let selected = null;
let dirty = false;

function token() { return sessionStorage.getItem('wec_token') || ''; }
async function api(path, options = {}, retry = true) {
  if (API_BASE && new URL(API_BASE).protocol !== 'https:') {
    throw Error('A separate backend must use HTTPS.');
  }
  const headers = {'X-WEC-Token': token(), ...(options.body ? {'Content-Type': 'application/json'} : {})};
  const response = await fetch(API_BASE + path, {...options, headers});
  if (response.status === 401 && retry) {
    const value = prompt('Studio access token (stored for this browser tab):');
    if (value === null) throw Error('Authentication cancelled');
    sessionStorage.setItem('wec_token', value);
    return api(path, options, false);
  }
  if (response.status === 401) {
    sessionStorage.removeItem('wec_token');
    throw Error('Access token rejected. Try the action again to enter a new token.');
  }
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'Request failed');
  return value;
}
function clearPreview() { $('preview').textContent = 'Save a story, then preview its scenes.'; }
function load(project) {
  selected = project.id;
  for (const key of ['title', 'story', 'duration', 'scenes']) $(key).value = project[key];
  dirty = false;
  clearPreview();
  msg('Editing ' + project.title);
}
async function refresh() {
  const value = await api('/api/projects');
  const root = $('projects');
  root.replaceChildren();
  if (!value.projects.length) { root.textContent = 'No projects yet.'; return; }
  for (const project of value.projects) {
    const item = document.createElement('div'); item.className = 'item';
    const title = document.createElement('strong'); title.textContent = project.title;
    const detail = document.createElement('p'); detail.textContent = `${project.scenes} scenes · ${project.duration}s`;
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Open';
    button.onclick = async () => {
      if (dirty && !confirm('Discard unsaved edits and open this project?')) return;
      try { load(await api('/api/projects/' + project.id)); } catch (error) { msg(error.message); }
    };
    item.append(title, detail, button); root.append(item);
  }
}
for (const key of ['title', 'story', 'duration', 'scenes']) {
  $(key).addEventListener('input', () => { dirty = true; clearPreview(); });
}
$('new').onclick = () => {
  if (dirty && !confirm('Discard unsaved edits and start a new project?')) return;
  selected = null; dirty = false;
  $('title').value = ''; $('story').value = ''; $('duration').value = 35; $('scenes').value = 7;
  clearPreview(); msg('New project ready.'); $('title').focus();
};
$('save').onclick = async () => {
  try {
    const payload = {title: $('title').value, story: $('story').value, duration: Number($('duration').value), scenes: Number($('scenes').value)};
    const project = await api(selected ? '/api/projects/' + selected : '/api/projects', {method: 'POST', body: JSON.stringify(payload)});
    selected = project.id; dirty = false;
    msg('Project saved on this studio server.'); await refresh();
  } catch (error) { msg(error.message); }
};
function requireSaved() {
  if (!selected || dirty) throw Error('Save your current edits first.');
}
$('plan').onclick = async () => {
  try {
    requireSaved();
    const plan = await api('/api/projects/' + selected + '/plan');
    const root = $('preview'); root.replaceChildren();
    for (const scene of plan.scenes) {
      const item = document.createElement('div'); item.className = 'scene';
      const title = document.createElement('strong'); title.textContent = `${scene.id} · ${scene.start}s–${(scene.start + scene.duration).toFixed(1)}s`;
      const text = document.createElement('p'); text.textContent = scene.narration || '(No narration assigned)';
      item.append(title, text); root.append(item);
    }
    msg('Scene plan ready.');
  } catch (error) { msg(error.message); }
};
$('dry').onclick = async () => {
  try {
    requireSaved();
    const result = await api('/api/projects/' + selected + '/dry-run');
    msg('Dry-run: ' + result.tasks.join(' → '));
  } catch (error) { msg(error.message); }
};
$('backup').onclick = async () => {
  try {
    const data = await api('/api/backup');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'wec-projects-backup.json';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); msg('Backup downloaded. Store it somewhere safe.');
  } catch (error) { msg(error.message); }
};
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
refresh().catch(error => msg(error.message));
