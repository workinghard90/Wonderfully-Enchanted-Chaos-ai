import {makeZip} from '/coloring/zip.js';

const images = [];
const $ = id => document.getElementById(id);
const upload = $('upload'), gallery = $('pages'), printPages = $('printPages'), status = $('status');
const MiB = 1024 * 1024;
const limits = {pages: 100, fileBytes: 10 * MiB, totalBytes: 80 * MiB, imagePixels: 24e6, totalPixels: 100e6};
let busy = false;

function summary() {
  const count = images.length * ($('blank').checked ? 2 : 1);
  return `${images.length} illustration(s), ${count} printable pages. Pages are kept only in this tab.`;
}

function updateControls() {
  for (const id of ['upload', 'title', 'blank']) $(id).disabled = busy;
  for (const id of ['zip', 'print', 'clear']) $(id).disabled = busy || !images.length;
  document.querySelectorAll('.page-actions button').forEach(button => {
    button.disabled = busy || button.dataset.atBoundary === 'true';
  });
  $('pages').setAttribute('aria-busy', String(busy));
}

function resolution(item) {
  // Contain-fit preserves aspect ratio. The limiting dimension determines PPI.
  return Math.floor(Math.max(item.width / 7.5, item.height / 10));
}

function render() {
  gallery.replaceChildren();
  printPages.replaceChildren();
  images.forEach((item, i) => {
    const card = document.createElement('li');
    card.className = 'page';
    const img = document.createElement('img');
    img.src = item.url; img.alt = item.name; img.loading = 'lazy';
    card.append(img);
    const info = document.createElement('p');
    info.textContent = `${i + 1}. ${item.name} (${item.width} × ${item.height})`;
    card.append(info);
    const ppi = resolution(item), quality = document.createElement('p');
    quality.textContent = `Approx. ${ppi} PPI at fitted size — ${ppi >= 300 ? '300 PPI target met' : 'Below 300 PPI target'}`;
    quality.className = ppi >= 300 ? 'quality-met' : 'quality-low';
    card.append(quality);
    const actions = document.createElement('div');
    actions.className = 'page-actions';
    for (const [text, delta] of [['Move earlier', -1], ['Move later', 1]]) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = text;
      button.setAttribute('aria-label', `${text}: page ${i + 1}`);
      button.dataset.atBoundary = String(i + delta < 0 || i + delta >= images.length);
      button.onclick = () => {
        if (busy) return;
        [images[i + delta], images[i]] = [images[i], images[i + delta]];
        render();
      };
      actions.append(button);
    }
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = 'Remove'; remove.className = 'secondary';
    remove.setAttribute('aria-label', `Remove page ${i + 1}`);
    remove.onclick = () => {
      if (busy) return;
      URL.revokeObjectURL(item.url); images.splice(i, 1); render();
    };
    actions.append(remove); card.append(actions); gallery.append(card);
    const sheet = document.createElement('div'); sheet.className = 'print-page';
    const art = document.createElement('img'); art.src = item.url; art.alt = '';
    sheet.append(art); printPages.append(sheet);
    if ($('blank').checked) {
      const back = document.createElement('div'); back.className = 'print-page';
      printPages.append(back);
    }
  });
  status.textContent = summary();
  updateControls();
}

async function detectFormat(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if ([137,80,78,71,13,10,26,10].every((v, i) => head[i] === v)) return 'png';
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'jpg';
  const ascii = new TextDecoder('ascii').decode(head);
  if (ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'WEBP') return 'webp';
  throw Error('Choose a readable PNG, JPG or WebP image. HEIC and SVG are unsupported.');
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => finish(Error('Image took too long to load.')), 15000);
    function finish(error) {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      if (error) { image.src = ''; reject(error); } else resolve(image);
    }
    image.onload = () => image.naturalWidth && image.naturalHeight
      ? finish() : finish(Error('Image has no readable dimensions.'));
    image.onerror = () => finish(Error('Could not decode image.'));
    image.src = url;
  });
}

upload.addEventListener('change', async () => {
  if (busy) return;
  const selected = Array.from(upload.files || []), errors = [];
  if (!selected.length) return;
  busy = true; updateControls();
  try {
    let bytes = images.reduce((n, item) => n + item.file.size, 0);
    let pixels = images.reduce((n, item) => n + item.width * item.height, 0);
    for (let i = 0; i < selected.length; i++) {
      const file = selected[i];
      status.textContent = `Loading file ${i + 1} of ${selected.length}…`;
      let url;
      try {
        if (images.length >= limits.pages) throw Error('The 100-illustration limit has been reached.');
        if (!file.size || file.size > limits.fileBytes) throw Error('Choose a nonempty file up to 10 MiB.');
        if (bytes + file.size > limits.totalBytes) throw Error('Artwork would exceed the 80 MiB total limit.');
        const extension = await detectFormat(file);
        url = URL.createObjectURL(file);
        const image = await loadImage(url);
        const count = image.naturalWidth * image.naturalHeight;
        if (count > limits.imagePixels) throw Error('Reduce this image below 24 megapixels.');
        if (pixels + count > limits.totalPixels) throw Error('Artwork would exceed the 100-megapixel total limit.');
        images.push({url, file, extension, name: file.name, width: image.naturalWidth, height: image.naturalHeight});
        bytes += file.size; pixels += count;
      } catch (error) {
        if (url) URL.revokeObjectURL(url);
        errors.push(`${file.name}: ${error.message || String(error)}`);
      }
    }
  } finally {
    upload.value = ''; busy = false; render();
    if (errors.length) status.textContent += ' Failed: ' + errors.join('; ');
  }
});

$('blank').addEventListener('change', () => { if (!busy) render(); });
$('clear').onclick = () => {
  if (busy || !images.length || !confirm('Clear all pages from this tab? Keep your originals or download an artwork ZIP first.')) return;
  images.forEach(item => URL.revokeObjectURL(item.url)); images.length = 0; render();
};

$('print').onclick = async () => {
  if (busy || !images.length) return;
  busy = true; updateControls(); status.textContent = 'Preparing print images…';
  try {
    document.title = $('title').value.trim() || 'WEC Coloring Book';
    // Decode the actual print nodes before opening the print dialog.
    await Promise.all(Array.from(printPages.querySelectorAll('img'), image => new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(Error('A print image is not ready. Try again.')), 15000);
      function finish(error) {
        clearTimeout(timer); image.onload = null; image.onerror = null;
        if (error) reject(error); else resolve();
      }
      image.onload = () => finish();
      image.onerror = () => finish(Error('A print image failed to load.'));
      if (image.complete) finish(image.naturalWidth ? undefined : Error('A print image failed to load.'));
    })));
    window.print(); status.textContent = summary();
  } catch (error) { status.textContent = 'Print failed: ' + error.message; }
  finally { busy = false; updateControls(); }
};

$('zip').onclick = async () => {
  if (busy || !images.length) return;
  busy = true; updateControls(); status.textContent = 'Preparing artwork ZIP locally…';
  try {
    const entries = [], pages = [];
    for (const [i, item] of images.entries()) {
      const name = `page-${String(i + 1).padStart(3, '0')}.${item.extension}`;
      entries.push({name, bytes: new Uint8Array(await item.file.arrayBuffer())});
      pages.push({page: i + 1, file: name, original: item.name, width: item.width, height: item.height,
        ppi_at_fitted_size: resolution(item)});
    }
    const title = $('title').value.trim() || 'WEC Coloring Book';
    const manifest = {schema_version: 1, title, pages, blank_backs: $('blank').checked,
      paper: 'Letter', artwork_box_inches: [7.5, 10],
      notice: 'Artwork archive only. Blank backs are print-only. PDF and cover require independent KDP verification.'};
    entries.push({name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2))});
    const url = URL.createObjectURL(makeZip(entries)), link = document.createElement('a');
    const slug = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'wec-coloring-book';
    link.href = url; link.download = slug + '-artwork.zip';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = 'Artwork ZIP download requested. Save it to Files or Downloads. ' + summary();
  } catch (error) { status.textContent = 'ZIP failed: ' + error.message; }
  finally { busy = false; updateControls(); }
};

window.addEventListener('beforeunload', event => {
  if (images.length) { event.preventDefault(); event.returnValue = ''; }
});
render();
