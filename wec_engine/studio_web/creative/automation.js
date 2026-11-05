// First automation milestone: read-only, explicit recipe previews.
// No stored schedules, provider requests, generation, rendering, or publishing.
const root = document.getElementById("automation-recipes");
if (root) {
  const select = root.querySelector("#automation-recipe");
  const preview = root.querySelector("#automation-preview");
  const status = root.querySelector("#automation-status");
  const recipes = {
    plan: {name: "Plan only", stages: [1], description: "Write and download an outline without creating pages."},
    artwork: {name: "Artwork collection", stages: [2, 3, 4], description: "Attach or create artwork, review originals, and export selected pictures."},
    book: {name: "Printable book", stages: [1, 2, 3, 4], description: "Plan optional pages, add artwork, check the printed interior, then export."},
    video: {name: "Faceless video", stages: [0, 2, 3, 4], description: "Prepare narration and scenes, review required media, then choose rendering."},
  };
  const stageNames = ["Setup", "Plan", "Create", "Review", "Export"];
  const projectKinds = {
    "Faceless video": "video",
    "Art collection": "art",
    "Coloring book": "coloring",
    "Storybook": "storybook",
  };
  let chosen = "";
  function clear() {
    chosen = "";
    preview.replaceChildren();
    status.textContent = "Choose a recipe and select Preview. No action runs automatically.";
  }
  function openStage(stage) {
    const tab = document.querySelectorAll("#editor .workflow-tab")[stage];
    if (tab && !document.getElementById("editor").hidden) tab.click();
  }
  root.querySelector("#automation-preview-button").addEventListener("click", () => {
    const recipe = recipes[select.value];
    if (!recipe) return clear();
    const kind = projectKinds[document.getElementById("kind-label").textContent.trim()];
    if (!kind) {
      clear();
      status.textContent = "Open or create a project before previewing a recipe.";
      return;
    }
    chosen = select.value;
    preview.replaceChildren();
    const intro = document.createElement("p");
    intro.textContent = recipe.description;
    preview.append(intro);
    const list = document.createElement("ol");
    for (const step of recipe.stages) {
      const item = document.createElement("li");
      const title = document.createElement("span");
      title.textContent = stageNames[step] + " — ";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = "Open " + stageNames[step];
      button.addEventListener("click", () => openStage(step));
      item.append(title, button);
      list.append(item);
    }
    preview.append(list);
    status.textContent = recipe.name + " preview ready. Each action remains your choice; no steps have run.";
  });
  root.querySelector("#automation-clear-button").addEventListener("click", clear);
  select.addEventListener("change", clear);
  // Project changes reset stale previews, so a recipe never implies that
  // its tasks were performed on a different project.
  document.querySelectorAll("[data-kind]").forEach(button => button.addEventListener("click", clear));
  document.getElementById("library")?.addEventListener("click", event => {
    if (event.target.closest("button")) clear();
  });
  document.getElementById("restore")?.addEventListener("change", clear);
  document.getElementById("import-zip")?.addEventListener("change", clear);
  clear();
}
