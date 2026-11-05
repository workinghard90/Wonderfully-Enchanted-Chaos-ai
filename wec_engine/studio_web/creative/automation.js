// Manual automation: preview suggested paths and explicitly execute safe local actions.
// No schedules, provider requests, generation, rendering, or publishing.
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
  let executing = false;
  // Ephemeral, per-open-project receipts. Never persist claims of completion
  // or infer that a project is publication-ready from an action result.
  const history = document.createElement("section");
  history.id = "automation-history";
  history.setAttribute("aria-label", "Recent recipe actions");
  history.setAttribute("role", "region");
  const historyTitle = document.createElement("h4");
  historyTitle.textContent = "Recent recipe actions (this session)";
  const historyList = document.createElement("ol");
  historyList.id = "automation-history-list";
  const historyHint = document.createElement("p");
  historyHint.className = "muted";
  historyHint.textContent = "Only actions started through this panel appear here. Recheck saved work before retrying; this is not a durable audit trail.";
  history.append(historyTitle, historyHint, historyList);
  root.append(history);
  function addReceipt(label, outcome, detail) {
    const item = document.createElement("li");
    // No source content is retained in this history, only a short outcome.
    item.textContent = label + " — " + outcome + (detail ? ": " + detail : "");
    historyList.prepend(item);
    while (historyList.children.length > 10) historyList.lastElementChild.remove();
  }
  function resetHistory() {
    historyList.replaceChildren();
  }
  const actions = {
    save: {
      label: "Save current project",
      button: "save",
      description: "Save the current project on this device using the existing Save control.",
      success: /Project saved on this device/,
    },
    convert: {
      label: "Convert planning draft to pages",
      button: "plan-pages",
      description: "Append pages from your planning text. Existing pages remain; the draft clears only after a successful save.",
      success: /Pages created/,
    },
  };
  // Observe the app's existing status rather than claiming success from a click.
  // The original handlers remain responsible for saving and validation.
  function waitForResult(button, success) {
    const message = document.getElementById("status");
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        const text = message.textContent.trim();
        if (success.test(text)) finish({ok: true, message: text});
        else if (text) finish({ok: false, message: text});
      });
      observer.observe(message, {childList:true, characterData:true, subtree:true});
      const timeout = setTimeout(() => finish({ok:false, message:"The action's result was not confirmed. Check the project and Save status before retrying."}), 12000);
      button.click();
    });
  }
  async function execute(key, expectedTitle, expectedKind) {
    const action = actions[key];
    if (!action || executing || !chosen) return;
    const editor = document.getElementById("editor");
    const title = () => document.getElementById("editor-heading").textContent.trim();
    const kind = () => document.getElementById("kind-label").textContent.trim();
    if (editor.hidden || title() !== expectedTitle || kind() !== expectedKind) {
      status.textContent = "Project changed. Preview this recipe again before taking action.";
      return;
    }
    const original = document.getElementById(action.button);
    if (!original || original.disabled) {
      status.textContent = "This action is not available while another operation is running.";
      return;
    }
    if (key === "convert") {
      if (expectedKind === "Faceless video") {
        status.textContent = "Use the existing Split narration control for video projects.";
        return;
      }
      if (!document.getElementById("outline").value.trim()) {
        status.textContent = "Add planning text before converting it into pages.";
        return;
      }
    }
    // Only a direct user click can approve a mutation. No auto-chaining.
    if (!window.confirm(action.description + "\n\nContinue for “" + expectedTitle + "”?")) {
      status.textContent = "Cancelled. No automation action was started.";
      addReceipt(action.label, "cancelled", "No action started");
      return;
    }
    if (editor.hidden || title() !== expectedTitle || kind() !== expectedKind || original.disabled) {
      status.textContent = "Project changed or busy. No action was started.";
      return;
    }
    executing = true;
    addReceipt(action.label, "running", "Waiting for the existing editor handler");
    const currentReceipt = historyList.firstElementChild;
    status.textContent = action.label + " requested. Checking result…";
    try {
      const result = await waitForResult(original, action.success);
      if (currentReceipt) currentReceipt.textContent = action.label + (result.ok ? " — completed" : " — needs review") + ": " + result.message;
      status.textContent = result.ok ? action.label + " completed. " + result.message : action.label + " not confirmed: " + result.message;
      if (result.ok && key === "convert") {
        chosen = "";
        preview.replaceChildren();
      }
    } finally {
      executing = false;
    }
  }
  // Read-only preflight: descriptive checks, not an export/print certification.
  // Never infer approval from an uploaded image or bypass the existing validators.
  // One source for both on-screen input guidance and the downloaded run sheet.
  function collectInputs(recipeKey, kind) {
    const compatible = recipeKey === "video" ? kind === "Faceless video"
      : recipeKey === "artwork" ? kind === "Art collection"
      : recipeKey === "book" ? kind === "Coloring book" || kind === "Storybook"
      : true;
    const draft = document.getElementById("outline")?.value.trim() || "";
    const pages = document.querySelectorAll("#pages .page").length;
    const narration = document.getElementById("narration")?.value.trim() || "";
    const rows = [];
    if (!compatible) rows.push("Choose a matching project format for this recipe. Existing project content is unchanged.");
    else {
      if (recipeKey === "plan") rows.push(draft ? "Planning text is present and can be downloaded." : "Planning text is empty. Add an outline in Plan to use this recipe.");
      if (recipeKey === "book") {
        rows.push(draft ? "Planning text is available (optional)." : "No planning text; you can still create pages independently.");
        rows.push(pages ? pages + " page slot(s) available for artwork and review." : "No pages yet. Create pages in Create or convert a Plan draft.");
      }
      if (recipeKey === "artwork") rows.push(pages ? pages + " artwork slot(s) in this project." : "No artwork slots. Add artwork in Create.");
      if (recipeKey === "video") rows.push(narration ? "Narration text is present." : "Narration is missing. Add it in Setup.");
      if (recipeKey !== "plan") rows.push("Use the existing Review and Export checks for actual asset, print, or render readiness.");
    }
    return {compatible, rows};
  }
  function preflight(recipeKey, expectedTitle, expectedKind, output) {
    const editor = document.getElementById("editor");
    const title = document.getElementById("editor-heading").textContent.trim();
    const kind = document.getElementById("kind-label").textContent.trim();
    output.replaceChildren();
    if (editor.hidden || title !== expectedTitle || kind !== expectedKind) {
      status.textContent = "Project changed. Preview the recipe again to check readiness.";
      return;
    }
    const {compatible, rows} = collectInputs(recipeKey, kind);
    const list = document.createElement("ul");
    for (const message of rows) {
      const row = document.createElement("li");
      row.textContent = message;
      list.append(row);
    }
    output.append(list);
    status.textContent = compatible ? "Recipe inputs checked. This is guidance, not an approval or export validation."
      : "This recipe does not match this project's format. Choose another recipe or project.";
  }
  // A portable, read-only checklist. It does not assert that any stage ran.
  // Recalculate warnings when clicked so edits after preview are reflected.
  function downloadRunSheet(recipeKey, expectedTitle, expectedKind) {
    const editor = document.getElementById("editor");
    const title = document.getElementById("editor-heading").textContent.trim();
    const kind = document.getElementById("kind-label").textContent.trim();
    if (!recipes[recipeKey] || editor.hidden || title !== expectedTitle || kind !== expectedKind) {
      status.textContent = "Project changed. Preview the recipe again before downloading its checklist.";
      return;
    }
    const recipe = recipes[recipeKey];
    const {compatible, rows} = collectInputs(recipeKey, kind);
    const lines = [
      "WEC Creative Automation — Recipe Run Sheet",
      "Project: " + title,
      "Format: " + kind,
      "Recipe: " + recipe.name,
      "",
      "Manual steps (mark complete yourself; no steps are automatically run):",
      ...recipe.stages.map((step, index) => "[ ] " + (index + 1) + ". " + stageNames[step]),
      "",
      "Current input snapshot (guidance only):",
      ...rows.map(row => "- " + row),
      "",
      compatible ? "Matching format: Yes" : "Matching format: No — choose another recipe or format.",
      "Before exports, use the existing Review and Export validators.",
      "Any AI generation, rendering, publishing or sharing requires a separate deliberate action.",
      "This sheet is not a record of successful execution, approval or print readiness.",
      ""
    ];
    const blob = new Blob([lines.join("\n")], {type:"text/plain;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "wec-recipe-run-sheet.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = "Recipe run sheet downloaded. No project action was started.";
  }
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
    const actionList = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = "Optional actions (one at a time)";
    actionList.append(title);
    const expectedTitle = document.getElementById("editor-heading").textContent.trim();
    const expectedKind = document.getElementById("kind-label").textContent.trim();
    const available = select.value === "plan" || select.value === "book" ? ["save", "convert"] : ["save"];
    for (const key of available) {
      const action = actions[key];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = action.label;
      button.addEventListener("click", () => execute(key, expectedTitle, expectedKind));
      actionList.append(button);
    }
    preview.append(actionList);
    const readiness = document.createElement("div");
    const check = document.createElement("button");
    check.type = "button";
    check.className = "secondary";
    check.textContent = "Check recipe inputs";
    const report = document.createElement("div");
    report.setAttribute("role", "status");
    report.setAttribute("aria-label", "Recipe input check");
    check.addEventListener("click", () => preflight(chosen, expectedTitle, expectedKind, report));
    readiness.append(check, report);
    preview.append(readiness);
    const sheet = document.createElement("button");
    sheet.type = "button";
    sheet.className = "secondary";
    sheet.textContent = "Download recipe run sheet";
    sheet.addEventListener("click", () => downloadRunSheet(chosen, expectedTitle, expectedKind));
    preview.append(sheet);
    status.textContent = recipe.name + " preview ready. Each action remains your choice; no steps have run.";
  });
  root.querySelector("#automation-clear-button").addEventListener("click", clear);
  select.addEventListener("change", clear);
  // Project changes reset stale previews, so a recipe never implies that
  // its tasks were performed on a different project.
  function projectChanged() {
    clear();
    resetHistory();
  }
  document.querySelectorAll("[data-kind]").forEach(button => button.addEventListener("click", projectChanged));
  document.getElementById("library")?.addEventListener("click", event => {
    if (event.target.closest("button")) projectChanged();
  });
  document.getElementById("restore")?.addEventListener("change", projectChanged);
  document.getElementById("import-zip")?.addEventListener("change", projectChanged);
  clear();
}
