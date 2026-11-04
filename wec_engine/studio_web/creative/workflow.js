// Full-page stage navigation. Existing editor nodes keep their IDs and event handlers.
// This module only changes presentation; project saving, generation and export stay in app.js.
const editor = document.getElementById("editor");
const nav = editor.querySelector(".project-steps");
const steps = ["Setup", "Plan", "Create", "Review", "Export"];
const descriptions = [
  "Name your project, choose a character and set your creative direction.",
  "Turn your idea into a page-by-page plan. Your existing work is preserved.",
  "Build and revise individual pages, images and recovery checkpoints.",
  "Check content, artwork and print readiness before exporting.",
  "Download and hand off your approved project to its destination."
];
nav.replaceChildren();
nav.setAttribute("aria-label", "Project workflow stages");
const heading = document.createElement("span");
heading.textContent = "Build your project · step by step";
nav.append(heading);
const buttons = steps.map((name, index) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary workflow-tab";
  button.textContent = `${index + 1}. ${name}`;
  button.addEventListener("click", () => { if (index <= unlocked) show(index); });
  nav.append(button);
  return button;
});
const screens = steps.map((name, index) => {
  const screen = document.createElement("section");
  screen.className = "workflow-screen";
  screen.dataset.workflowStage = String(index);
  screen.id = `workflow-screen-${index + 1}`;
  screen.setAttribute("aria-label", `${name} workspace`);
  const title = document.createElement("h2");
  title.textContent = name;
  const description = document.createElement("p");
  description.className = "muted workflow-description";
  description.textContent = descriptions[index];
  screen.append(title, description);
  return screen;
});
// Physical stage containers are inserted together in the editor, after navigation.
// Moving existing nodes preserves listeners and element identity; no data is recreated.
nav.after(...screens);
function move(selector, step) {
  editor.querySelectorAll(selector).forEach(node => screens[step].append(node));
}
move("#video-workflow, label[for=title], #title, label[for=author], #author, details.character, #video-settings", 0);
move("#book-planner", 1);
move("#generation-status, #page-help, #check-sources, #source-status, #pages, #checkpoint-panel", 2);
move("#book-review, #cover-settings, .delivery > h3, #readiness", 3);
move("#export-actions, #export-note", 4);
// Save belongs to the project header and remains accessible from every screen.
// Page creation, uploads and format conversion belong to Create.
const toolbar = editor.querySelector("#save")?.closest(".toolbar");
const save = editor.querySelector("#save");
if (save) {
  const saveArea = document.createElement("div");
  saveArea.className = "workflow-save";
  saveArea.append(save);
  editor.querySelector(".section-heading")?.append(saveArea);
}
if (toolbar) screens[2].prepend(toolbar);
const variant = editor.querySelector("#variant")?.closest("details");
if (variant) screens[2].append(variant);
const footer = document.createElement("div");
footer.className = "workflow-footer";
const previous = document.createElement("button");
previous.type = "button";
previous.className = "secondary";
previous.textContent = "Previous step";
const next = document.createElement("button");
next.type = "button";
next.textContent = "Continue to Plan";
const progress = document.createElement("p");
progress.setAttribute("role", "status");
progress.className = "muted";
footer.append(previous, progress, next);
screens[4].after(footer);
let active = 0;
let unlocked = 0;
// A new project begins at Setup. Continue unlocks exactly the next stage;
// already visited stages stay accessible for corrections.
function show(index, advance = false) {
  if (Number.isInteger(index)) {
    const requested = Math.max(0, Math.min(4, index));
    if (advance && requested === active + 1) unlocked = Math.max(unlocked, requested);
    if (requested > unlocked) return;
    active = requested;
  }
  editor.dataset.workflowStep = String(active);
  screens.forEach((screen, i) => {
    screen.classList.toggle("workflow-inactive", i !== active);
    screen.setAttribute("aria-hidden", String(i !== active));
  });
  buttons.forEach((button, i) => {
    button.setAttribute("aria-current", i === active ? "step" : "false");
    button.setAttribute("aria-controls", screens[i].id);
    button.disabled = i > unlocked;
    button.title = i > unlocked ? "Complete the previous stage using Continue" : `Open ${steps[i]} stage`;
  });
  previous.disabled = active === 0;
  next.disabled = active === 4;
  next.textContent = active === 4 ? "Ready to export" : `Continue to ${steps[active + 1]}`;
  progress.textContent = `Step ${active + 1} of 5 · ${steps[active]}. Only this stage is shown. Use Continue to unlock the next stage.`;
  if (index !== undefined && !editor.hidden) {
    // A new stage starts at the top of its screen instead of a point mid-page.
    nav.scrollIntoView({block: "start", behavior: "instant"});
  }
}
// Existing video guidance can focus a scene or render control in a different stage.
const videoContinue = editor.querySelector("#workflow-next");
videoContinue?.addEventListener("click", () => {
  const label = videoContinue.textContent || "";
  if (/Add picture for scene/.test(label)) {
    // Video guidance may jump focus, but each stage is still unlocked in order.
    unlocked = Math.max(unlocked, 2);
    show(2);
  } else if (/Review and render video/.test(label)) {
    unlocked = Math.max(unlocked, 4);
    show(4);
  } else show(0);
}, {capture: true});
// Starting or reopening projects resets the stage, not the project's content.
document.querySelectorAll("[data-kind]").forEach(button =>
  button.addEventListener("click", () => reset()));
document.getElementById("library")?.addEventListener("click", event => {
  if (event.target.closest("button")) reset();
});
for (const id of ["restore", "import-zip"]) {
  document.getElementById(id)?.addEventListener("change", () => reset());
}
function reset() {
  active = 0;
  unlocked = 0;
  show(0);
}
previous.addEventListener("click", () => show(active - 1));
next.addEventListener("click", () => show(active + 1, true));
show();
