// Load one saved project at a time; originals stay in the existing project store.
export async function chooseSavedArtwork(storage, currentId) {
  const projects = (await storage.all()).filter(p => p.id !== currentId)
    .sort((a, b) => b.savedAt - a.savedAt);
  const dialog = document.createElement("dialog");
  dialog.className = "artwork-picker";
  dialog.setAttribute("aria-label", "Reuse saved artwork");
  const heading = document.createElement("h2"); heading.textContent = "Reuse saved artwork";
  const help = document.createElement("p");
  help.textContent = "Choose a saved project on this device, then a picture. Original bytes are copied; the source stays unchanged. Colored artwork is not converted to coloring line art.";
  const label = document.createElement("label"); label.textContent = "Saved source project";
  const select = document.createElement("select");
  select.append(new Option("Choose a saved project", ""));
  for (const p of projects) select.add(new Option(p.title, p.id));
  label.append(select);
  const status = document.createElement("p"); status.setAttribute("role", "status");
  status.textContent = projects.length ? "Choose a project to see its page pictures." : "No other saved projects yet. Save artwork in another project first.";
  const grid = document.createElement("div"); grid.className = "artwork-grid";
  const close = document.createElement("button"); close.type = "button"; close.textContent = "Cancel";
  dialog.append(heading, help, label, status, grid, close);
  const urls = [];
  const clear = () => { urls.splice(0).forEach(u => URL.revokeObjectURL(u)); grid.replaceChildren(); };
  let request = 0;
  document.body.append(dialog);
  return new Promise(resolve => {
    let selected = null;
    close.onclick = () => dialog.close();
    dialog.onclose = () => { request++; clear(); dialog.remove(); resolve(selected); };
    select.onchange = async () => {
      const version = ++request;
      clear();
      if (!select.value) { status.textContent = "Choose a project to see its page pictures."; return; }
      status.textContent = "Loading saved pictures…";
      try {
        const source = await storage.get(select.value);
        if (version !== request) return;
        if (!source) { status.textContent = "This project is no longer available."; return; }
        const pages = source.pages.filter(p => p.asset);
        status.textContent = pages.length ? `${pages.length} saved picture(s). Choose one to copy.` : "This project has no saved page pictures.";
        for (const [index, page] of source.pages.entries()) {
          if (!page.asset) continue;
          const b = document.createElement("button"); b.type = "button";
          b.className = "secondary";
          const img = document.createElement("img"); img.loading = "lazy";
          img.src = URL.createObjectURL(page.asset.blob); urls.push(img.src);
          img.alt = page.asset.name;
          const text = document.createElement("span");
          text.textContent = `Use page ${index + 1} · ${page.asset.name}`;
          b.append(img, text);
          b.onclick = () => { selected = structuredClone(page.asset); dialog.close(); };
          grid.append(b);
        }
      } catch { if (version === request) status.textContent = "Could not load this project's artwork. Try another project or restore its backup."; }
    };
    dialog.showModal();
    select.focus();
  });
}
