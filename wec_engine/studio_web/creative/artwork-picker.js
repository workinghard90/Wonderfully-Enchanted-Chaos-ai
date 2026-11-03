// Reuse only explicitly approved artwork from another saved project on this device.
// The original Blob is copied and its immediate source revision/checksum recorded.
// This is not a global or cross-device asset catalog.
async function sha256(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function referenceFingerprint(project) {
  const reference = project.reference?.blob
    ? await sha256(await project.reference.blob.arrayBuffer()) : null;
  return sha256(new TextEncoder().encode(JSON.stringify({
    character: project.character, style: project.style, reference,
  })));
}

export async function chooseSavedArtwork(storage, currentId) {
  const projects = (await storage.all()).filter(p => p.id !== currentId)
    .sort((a, b) => b.savedAt - a.savedAt);
  const dialog = document.createElement('dialog');
  dialog.className = 'artwork-picker';
  dialog.setAttribute('aria-label', 'Reuse saved artwork');
  const heading = document.createElement('h2');
  heading.textContent = 'Reuse approved artwork';
  const help = document.createElement('p');
  help.textContent = 'Only approved pictures from other projects are shown. The original stays unchanged. Reused pictures start unreviewed in this project, and changing source artwork or its reference triggers a warning. Colored pictures are not converted to coloring line art.';
  const label = document.createElement('label');
  label.textContent = 'Saved source project';
  const select = document.createElement('select');
  select.append(new Option('Choose a saved project', ''));
  for (const p of projects) select.add(new Option(p.title, p.id));
  label.append(select);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = projects.length
    ? 'Choose a project to see its approved page pictures.'
    : 'No other saved projects yet. Approve and save artwork in another project first.';
  const grid = document.createElement('div');
  grid.className = 'artwork-grid';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Cancel';
  dialog.append(heading, help, label, status, grid, close);
  const urls = [];
  const clear = () => {
    urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    grid.replaceChildren();
  };
  let request = 0, selected = null;
  document.body.append(dialog);
  return new Promise(resolve => {
    close.onclick = () => dialog.close();
    dialog.onclose = () => {
      request++;
      clear();
      dialog.remove();
      resolve(selected);
    };
    select.onchange = async () => {
      const version = ++request;
      clear();
      if (!select.value) {
        status.textContent = 'Choose a project to see its approved page pictures.';
        return;
      }
      status.textContent = 'Loading approved pictures…';
      try {
        const source = await storage.get(select.value);
        if (version !== request) return;
        if (!source) {
          status.textContent = 'This source project is unavailable.';
          return;
        }
        const pages = Array.isArray(source.pages) ? source.pages : [];
        const approved = pages.map((page, index) => ({page, index}))
          .filter(({page}) => page?.asset?.blob instanceof Blob && page.review === 'approved');
        status.textContent = approved.length
          ? approved.length + ' approved picture(s). Select one to copy as an unreviewed asset.'
          : 'This project has no approved page pictures. Approve its artwork before reuse.';
        for (const {page, index} of approved) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary';
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = URL.createObjectURL(page.asset.blob);
          urls.push(img.src);
          img.alt = page.asset.name;
          const text = document.createElement('span');
          text.textContent = 'Use page ' + (index + 1) + ' · ' + page.asset.name + ' (approved)';
          button.append(img, text);
          button.onclick = async () => {
            const chosenRequest = request;
            button.disabled = true;
            status.textContent = 'Verifying the approved source and saved version…';
            try {
              // An edited or revoked source must not be silently copied from
              // the earlier thumbnail, even if another WEC tab was editing.
              const current = await storage.get(source.id);
              if (chosenRequest !== request) return;
              const currentPage = current?.pages?.find(p => p.id === page.id);
              if (!current || current.revision !== source.revision ||
                  !currentPage || currentPage.review !== 'approved' ||
                  !(currentPage.asset?.blob instanceof Blob)) {
                status.textContent = 'The source changed or lost approval. Reopen the source and choose again.';
                return;
              }
              const hash = await sha256(await currentPage.asset.blob.arrayBuffer());
              const expected = await sha256(await page.asset.blob.arrayBuffer());
              if (chosenRequest !== request) return;
              if (hash !== expected) {
                status.textContent = 'The approved picture changed. Reopen the source before reuse.';
                return;
              }
              const fingerprint = await referenceFingerprint(current);
              if (chosenRequest !== request) return;
              selected = {
                asset: structuredClone(currentPage.asset),
                sourceArtwork: {
                  projectId: current.id,
                  projectTitle: current.title,
                  pageId: currentPage.id,
                  pageNumber: index + 1,
                  revision: current.revision,
                  sha256: hash,
                  referenceFingerprint: fingerprint,
                },
              };
              dialog.close();
            } catch {
              if (chosenRequest === request)
                status.textContent = 'Could not verify this approved picture. Your source and current project were kept.';
            } finally {
              button.disabled = false;
            }
          };
          grid.append(button);
        }
      } catch {
        if (version === request)
          status.textContent = 'Could not load approved artwork. Try another saved project or restore its backup.';
      }
    };
    dialog.showModal();
    select.focus();
  });
}
