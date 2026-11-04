// Presentation-only guide: never changes project data, saves, requests, or exports.
const editor = document.getElementById("editor");
const nav = editor.querySelector(".project-steps");
const steps = ["Setup", "Plan", "Create", "Review", "Export"];
nav.replaceChildren();
const heading = document.createElement("span");
heading.textContent = "Creative workflow";
nav.append(heading);
const buttons = steps.map((name, index) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary workflow-tab";
  button.textContent = `${index + 1}. ${name}`;
  button.addEventListener("click", () => show(index));
  nav.append(button);
  return button;
});
const footer = document.createElement("div");
footer.className = "workflow-footer";
const previous = document.createElement("button");
previous.type = "button";
previous.className = "secondary";
previous.textContent = "Previous step";
const next = document.createElement("button");
next.type = "button";
next.textContent = "Continue to next step";
const progress = document.createElement("p");
progress.setAttribute("role", "status");
progress.className = "muted";
footer.append(previous, progress, next);
nav.after(footer);
let active = 0;
const assign = (selector, stage) => {
  editor.querySelectorAll(selector).forEach(node => { node.dataset.workflowStage = String(stage); });
};
// Hide only presentation sections, not the editor itself or global status/connection controls.
assign("#video-workflow, label[for=title], #title, label[for=author], #author, details.character, #video-settings", 0);
assign("#book-planner", 1);
assign("#generation-status, #page-help, #check-sources, #source-status, #pages, #checkpoint-panel", 2);
assign("#book-review, #cover-settings, .delivery > h3, #readiness", 3);
assign("#export-actions, #export-note", 4);
const toolbar = editor.querySelector("#save")?.closest(".toolbar");
// Save and add-page controls stay available throughout the workflow.
const variant = editor.querySelector("#variant")?.closest("details");
if (variant) variant.dataset.workflowStage = "2";
function show(index) {
  if (Number.isInteger(index)) active = Math.max(0, Math.min(4, index));
  editor.dataset.workflowStep = String(active);
  editor.querySelectorAll("[data-workflow-stage]").forEach(node => {
    // Use hidden on stage sections only; retain native hidden semantics on nested features.
    node.classList.toggle("workflow-inactive", Number(node.dataset.workflowStage) !== active);
  });
  buttons.forEach((button, i) => {
    button.setAttribute("aria-current", i === active ? "step" : "false");
  });
  previous.disabled = active === 0;
  next.disabled = active === 4;
  progress.textContent = `Step ${active + 1} of 5: ${steps[active]}. Your project remains editable and saved using the existing controls.`;
  if (index !== undefined && editor.hidden === false) nav.scrollIntoView({block: "nearest", behavior: "auto"});
}
previous.addEventListener("click", () => show(active - 1));
next.addEventListener("click", () => show(active + 1));
show();
