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
  // A guided run is a session-only navigation aid, not a durable job or proof
  // of completion. The existing editor remains responsible for all changes.
  let guided = null;
  const currentProject = () => document.getElementById("review-mode")?.dataset.projectId || "";
  const currentTitle = () => document.getElementById("editor-heading").textContent.trim();
  const currentKind = () => document.getElementById("kind-label").textContent.trim();
  function sameProject(run) {
    return Boolean(run && !document.getElementById("editor").hidden &&
      run.projectId && run.projectId === currentProject() &&
      run.title === currentTitle() && run.kind === currentKind());
  }
  function stopGuided(reason) {
    guided = null;
    renderGuided();
    if (reason) status.textContent = reason;
  }
  function startGuided(recipeKey) {
    const recipe = recipes[recipeKey];
    if (!recipe || !currentProject() || document.getElementById("editor").hidden) {
      status.textContent = "Open a project before starting a guided run.";
      return;
    }
    if (!collectInputs(recipeKey, currentKind()).compatible) {
      status.textContent = "Choose a recipe that matches the project format before starting.";
      return;
    }
    if (executing) {
      status.textContent = "Finish the current action before starting a guided run.";
      return;
    }
    // Replacing the current run is a deliberate action; never inherit
    // old completion claims or silently discard its session progress.
    if (guided && !window.confirm("Replace the active guided run? Its session-only progress will be cleared. Project content will remain unchanged.")) {
      status.textContent = "Existing guided run kept. No new run started.";
      return;
    }
    guided = {
      projectId:currentProject(), title:currentTitle(), kind:currentKind(),
      recipeKey, index:0, paused:false, states:recipe.stages.map(() => "pending")
    };
    renderGuided();
    status.textContent = "Guided run started. Open the current workspace or review this step. No action has run.";
  }
  function renderGuided() {
    const panel = root.querySelector("#automation-guided");
    if (!panel) return;
    panel.replaceChildren();
    if (!guided) {
      panel.textContent = "No guided run active. Preview a recipe and choose Start guided run.";
      return;
    }
    if (!sameProject(guided)) {
      guided = null;
      panel.textContent = "The project changed. Start a new guided run for this project.";
      return;
    }
    const recipe = recipes[guided.recipeKey];
    const done = guided.states.filter(state => state === "reviewed").length;
    const heading = document.createElement("h4");
    heading.textContent = "Guided run · " + recipe.name;
    const progress = document.createElement("p");
    progress.id = "automation-guided-progress";
    progress.setAttribute("role", "status");
    progress.textContent = done + " of " + recipe.stages.length +
      " steps reviewed · " + (guided.paused ? "Paused" : "Active") +
      " · Step " + (guided.index + 1) + ": " + stageNames[recipe.stages[guided.index]];
    panel.append(heading, progress);
    const list = document.createElement("ol");
    list.id = "automation-guided-steps";
    recipe.stages.forEach((stage, index) => {
      const row = document.createElement("li");
      row.textContent = stageNames[stage] + " — " + (guided.states[index] === "reviewed"
        ? "reviewed by user (not output approved)" : index === guided.index ? "current" : "pending");
      if (index === guided.index) row.setAttribute("aria-current", "step");
      list.append(row);
    });
    panel.append(list);
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Reviewing a step records only that you inspected its guidance; it does not approve content or run a task. Use Review and Export validators separately.";
    panel.append(note);
    const controls = document.createElement("div");
    controls.className = "toolbar";
    const control = (text, fn, disabled = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = text;
      button.disabled = disabled;
      button.addEventListener("click", fn);
      controls.append(button);
      return button;
    };
    control("Open current workspace", () => {
      if (!sameProject(guided) || guided.paused || executing) return;
      openStage(recipe.stages[guided.index]);
      status.textContent = "Opened " + stageNames[recipe.stages[guided.index]] +
        ". Return to Plan to continue the guided run.";
    }, guided.paused || executing);
    control("Mark step reviewed", () => {
      if (!sameProject(guided) || guided.paused || executing) return;
      guided.states[guided.index] = "reviewed";
      renderGuided();
      status.textContent = "Guidance marked reviewed. Content has not been approved or exported.";
    }, guided.paused || executing);
    control("Previous guided step", () => moveGuided(-1),
      guided.paused || executing || guided.index === 0);
    control("Next guided step", () => moveGuided(1),
      guided.paused || executing || guided.index === recipe.stages.length - 1);
    control(guided.paused ? "Resume guided run" : "Pause guided run", () => {
      if (!sameProject(guided) || executing) return;
      guided.paused = !guided.paused;
      renderGuided();
      status.textContent = guided.paused ? "Guided run paused. No actions will run." :
        "Guided run resumed. Verify current inputs before taking action.";
    }, executing);
    // Every actionable handoff is user initiated and goes through execute(),
    // which checks the project, inputs, consent and the original editor result.
    if (recipe.stages[guided.index] === 1 &&
        (guided.recipeKey === "plan" || guided.recipeKey === "book")) {
      control("Convert draft at this step (confirm)", () =>
        execute("convert", guided.title, guided.kind), guided.paused || executing);
    }
    control("Save project at this step (confirm)", () =>
      execute("save", guided.title, guided.kind), guided.paused || executing);
    control("Check inputs for current step", () => {
      if (!sameProject(guided) || guided.paused || executing) return;
      const {compatible, rows} = collectInputs(guided.recipeKey, guided.kind);
      if (!compatible) {
        guided.paused = true;
        status.textContent = "Project format mismatch. Guided run paused.";
      } else {
        status.textContent = "Current inputs: " + rows.join(" ") +
          " These checks are guidance, not output approval.";
      }
      renderGuided();
    }, guided.paused || executing);
    control("End guided run", () => {
      if (executing) return;
      stopGuided("Guided run ended. Project data and existing work are unchanged.");
    }, executing);
    panel.append(controls);
  }
  function moveGuided(delta) {
    if (!guided || !sameProject(guided) || guided.paused || executing) return;
    const next = guided.index + delta;
    if (next < 0 || next >= recipes[guided.recipeKey].stages.length) return;
    guided.index = next;
    renderGuided();
    status.textContent = "Now at " + stageNames[recipes[guided.recipeKey].stages[next]] +
      ". Steps are never automatically executed or approved.";
  }
  // Ephemeral, per-open-project receipts. Never persist claims of completion
  // or infer that a project is publication-ready from an action result.
  // Always located in the Plan workspace; no fixed overlay or new stage.
  const guidedPanel = document.createElement("section");
  guidedPanel.id = "automation-guided";
  guidedPanel.setAttribute("aria-label", "Guided recipe progress");
  root.append(guidedPanel);
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
  historyHint.textContent = "Only actions started through this panel appear here. For needs review, inspect your project and check recipe inputs before deciding whether to retry. No automatic retries. History resets when you change projects and is not a durable audit trail.";
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
    if (!action || executing ||
        (!chosen && !(guided && sameProject(guided)))) return;
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
    renderGuided();
    addReceipt(action.label, "running", "Waiting for the existing editor handler");
    const currentReceipt = historyList.firstElementChild;
    status.textContent = action.label + " requested. Checking result…";
    try {
      const result = await waitForResult(original, action.success);
      if (currentReceipt) currentReceipt.textContent = action.label + (result.ok ? " — completed" : " — needs review") + ": " + result.message;
      if (!result.ok && guided && sameProject(guided)) {
        guided.paused = true;
      }
      status.textContent = result.ok ? action.label + " completed. " + result.message :
        action.label + " needs review. Guided run paused if active. Check the saved project before deciding whether to retry: " + result.message;
      if (result.ok && key === "convert") {
        // A completed conversion changes the outline; refresh the preview
        // before another manual conversion, without abandoning the guided run.
        chosen = "";
        preview.replaceChildren();
      }
    } finally {
      executing = false;
      renderGuided();
    }
  }
  // Real execution of a bounded, local-only two-step recipe. The existing
  // editor owns persistence and the production workbench owns inventory checks.
  // No AI calls, renders, downloads, publication, or implicit approvals.
  async function runLocalPreparation(recipeKey, expectedTitle, expectedKind, expectedId) {
    if (executing || chosen !== recipeKey || !recipes[recipeKey]) return;
    const editor = document.getElementById("editor");
    const {compatible} = collectInputs(recipeKey, expectedKind);
    if (!compatible || editor.hidden || currentProject() !== expectedId ||
        currentTitle() !== expectedTitle || currentKind() !== expectedKind) {
      status.textContent = "Project or recipe changed. Preview the matching recipe again.";
      return;
    }
    const targets = {
      "Faceless video":"video", "Art collection":"artwork",
      "Coloring book":"print", "Storybook":"print"
    };
    // Plan-only still gets a safe backup inventory; other recipes get a
    // format-specific output assessment, never the actual export itself.
    const target = recipeKey === "plan" ? "backup" : targets[expectedKind];
    const save = document.getElementById("save");
    const prepare = document.getElementById("production-prepare");
    const selection = document.getElementById("production-target");
    const preparationStatus = document.getElementById("production-status");
    if (!target || !save || save.disabled || !prepare || !selection || !preparationStatus) {
      status.textContent = "Save or production preparation is unavailable. No run started.";
      return;
    }
    if (!window.confirm("Run two local steps for “" + expectedTitle +
        "”?\\n1. Save the current project on this device.\\n2. Inspect its " +
        target + " output inventory and warnings.\\n\\nNo AI generation, downloads, rendering, publishing or paid services.")) {
      addReceipt("Local preparation", "cancelled", "No action started");
      status.textContent = "Local preparation cancelled. No action started.";
      return;
    }
    if (editor.hidden || currentProject() !== expectedId ||
        currentTitle() !== expectedTitle || currentKind() !== expectedKind || save.disabled) {
      status.textContent = "Project changed or save became unavailable. No run started.";
      return;
    }
    executing = true;
    renderGuided();
    addReceipt("Local preparation", "running", "Step 1: saving");
    const receipt = historyList.firstElementChild;
    const finish = (outcome, message) => {
      if (receipt) receipt.textContent = "Local preparation — " + outcome + ": " + message;
      status.textContent = "Local preparation " + outcome + ". " + message;
    };
    try {
      status.textContent = "Local preparation: saving project…";
      const saved = await waitForResult(save, /Project saved on this device/);
      const saveStatus = document.getElementById("save-status")?.textContent || "";
      if (!saved.ok || !saveStatus.startsWith("Saved ")) {
        finish("needs review", "Save was not verified; output preparation was NOT run. " + saved.message);
        if (guided && sameProject(guided)) guided.paused = true;
        return;
      }
      if (editor.hidden || currentProject() !== expectedId ||
          currentTitle() !== expectedTitle || currentKind() !== expectedKind) {
        finish("stopped", "Project changed after save; no output check was started.");
        return;
      }
      // The workbench is read-only. Switch to the recipe's intended output,
      // then run its original inspection handler synchronously.
      selection.value = target;
      selection.dispatchEvent(new Event("change", {bubbles:true}));
      prepare.click();
      const message = preparationStatus.textContent.trim();
      if (!message.startsWith("Production inventory prepared.")) {
        finish("needs review", "Project was saved, but production preparation did not confirm success.");
        return;
      }
      const warnings = document.querySelectorAll("#production-issues li").length;
      const summary = document.getElementById("production-summary")?.textContent.trim() || "";
      finish("completed", "Project save verified and " + target +
        " inventory prepared. " + warnings + " guidance warning(s). " + summary +
        " Review the inventory in Export; outputs are NOT approved or generated.");
    } catch (error) {
      finish("needs review", "Unexpected preparation error. Check Save and Export before retrying.");
      if (guided && sameProject(guided)) guided.paused = true;
    } finally {
      executing = false;
      renderGuided();
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
    const start = document.createElement("button");
    start.type = "button";
    start.className = "secondary";
    start.textContent = "Start guided run";
    start.addEventListener("click", () => startGuided(select.value));
    preview.append(start);
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
    const bounded = document.createElement("div");
    const boundedTitle = document.createElement("h4");
    boundedTitle.textContent = "Run safe local preparation";
    const boundedInfo = document.createElement("p");
    boundedInfo.className = "muted";
    boundedInfo.textContent = "One confirmed run saves the current project, then inspects output inventory and warnings. It does not generate, render, download or publish anything.";
    const boundedButton = document.createElement("button");
    boundedButton.type = "button";
    boundedButton.className = "secondary";
    boundedButton.id = "automation-run-local";
    boundedButton.textContent = "Save + prepare output";
    const expectedId = currentProject();
    const recipeKey = select.value;
    boundedButton.addEventListener("click", () =>
      runLocalPreparation(recipeKey, expectedTitle, expectedKind, expectedId));
    bounded.append(boundedTitle, boundedInfo, boundedButton);
    preview.append(bounded);
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
  select.addEventListener("change", () => {
    clear();
    // A change of preview does not silently abandon an active guided run.
    if (guided) status.textContent = "Preview changed. The existing guided run stays active until ended or replaced.";
  });
  // Project changes reset stale previews, so a recipe never implies that
  // its tasks were performed on a different project.
  function projectChanged() {
    clear();
    resetHistory();
    stopGuided();
  }
  document.querySelectorAll("[data-kind]").forEach(button => button.addEventListener("click", projectChanged));
  document.getElementById("library")?.addEventListener("click", event => {
    if (event.target.closest("button")) projectChanged();
  });
  document.getElementById("restore")?.addEventListener("change", projectChanged);
  document.getElementById("import-zip")?.addEventListener("change", projectChanged);
  clear();
  renderGuided();
}
