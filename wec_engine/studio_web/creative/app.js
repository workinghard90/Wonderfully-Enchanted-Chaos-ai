import { videoPanel } from "/studio/video.js";
import { chooseSavedArtwork } from "/studio/artwork-picker.js";
import * as storage from "/studio/store.js";
import { makeZip, readZip } from "/coloring/zip.js";
const $ = (id) => document.getElementById(id),
  labels = {
    video: "Faceless video",
    art: "Art collection",
    coloring: "Coloring book",
    storybook: "Storybook",
  };
const MAX_BYTES = 30 * 1024 * 1024,
  MAX_PIXELS = 320e6;
let project = null,
  busy = false,
  dirty = false,
  saveTimer,
  profiles = [],
  generation = null,
  textReady = false,
  urls = [];
const say = (s) => {
  $("status").textContent = s;
};
function button(label, action, disabled = false) {
  const b = document.createElement("button");
  b.textContent = label;
  b.type = "button";
  b.className = "secondary";
  b.disabled = disabled;
  b.onclick = () => run(action);
  return b;
}
function fresh(kind) {
  return {
    schema_version: 1,
    app: "wec-creative-studio",
    id: crypto.randomUUID(),
    revision: 0,
    kind,
    title: "Untitled " + labels[kind].toLowerCase(),
    author: "",
    reference: null,
    characterName: "",
    character: "",
    style: "",
    backText: "",
    cover: null,
    narration: "",
    duration: 35,
    sceneCount: 7,
    pages: [],
  };
}
function emptyPage() {
  return { id: crypto.randomUUID(), text: "", prompt: "", asset: null, review: "unreviewed" };
}
function limit() {
  return project.kind === "video" ? 7 : 80;
}
function readFields() {
  if (!project) return;
  for (const [id, key] of [
    ["title", "title"],
    ["author", "author"],
    ["character-name", "characterName"],
    ["character", "character"],
    ["style", "style"],
    ["narration", "narration"],
    ["back-text", "backText"],
  ])
    project[key] = $(id).value;
  project.duration = Number($("duration").value);
  project.sceneCount = Number($("scene-count").value);
}
function changed() {
  readFields();
  dirty = true;
  $("save-status").textContent = "Unsaved changes";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!busy) run(persist);
  }, 900);
  document.querySelectorAll(".prompt-preview[data-page]").forEach(node => {
    const page = project.pages.find(p => p.id === node.dataset.page);
    if (page) node.textContent = promptFor(page, node.dataset.reference === "true");
  });
  readiness();
}
function canGenerate(reference = false) {
  const configured = reference ? generation?.reference_ready : (generation?.creative_ready ?? generation?.ready);
  return Boolean(configured && (!reference || project?.reference) &&
    !(generation.attempts_today >= generation.daily_limit));
}
function showGenerationStatus() {
  const ready = generation?.creative_ready ?? generation?.ready;
  const message = generation?.message || (ready ? "AI image generation configured." : "AI image generation needs owner setup.");
  const usage = generation ? ` ${generation.attempts_today}/${generation.daily_limit} image attempts today (text and reference combined).` : "";
  const limit = generation && generation.attempts_today >= generation.daily_limit ? " Daily limit reached; it resets at 00:00 UTC." : "";
  $("generation-status").textContent = message + usage + limit;
  $("ai-connection-status").textContent = message + usage + limit;
}
async function refreshAI(interactive = false) {
  generation = null;
  textReady = false;
  try {
    generation = await (await api("/api/generation", undefined, interactive)).json();
    showGenerationStatus();
  } catch (error) {
    const message = `${error.message} Saving projects on this device works separately from AI. Use Connect / check AI to reconnect.`;
    $("generation-status").textContent = message;
    $("ai-connection-status").textContent = message;
    $("draft-status").textContent = "Connect to check AI drafting.";
    return;
  }
  try {
    const t = await (await api("/api/creative/text", undefined, false)).json();
    textReady = t.ready;
    $("draft-status").textContent = t.ready
      ? "AI drafting configured · up to five confirmed requests per day."
      : "AI drafting is disabled or needs owner setup (WEC_ENABLE_TEXT_GENERATION). You can write or paste text.";
  } catch (error) {
    $("draft-status").textContent = `AI drafting unavailable: ${error.message}`;
  }
}
function lock(value) {
  busy = value;
  document
    .querySelectorAll("button,input,textarea,select")
    .forEach((n) => (n.disabled = value));
  if (!value) {
    document
      .querySelectorAll("[data-generate]")
      .forEach((n) => (n.disabled = !canGenerate()));
    document.querySelectorAll('[data-reference-generate]').forEach(n =>
      n.disabled = !canGenerate(true));
    $("draft").disabled = !textReady;
  }
}
async function run(action) {
  if (busy) return;
  clearTimeout(saveTimer);
  lock(true);
  try {
    await action();
  } catch (e) {
    say(e.message || String(e));
  } finally {
    lock(false);
    if (dirty)
      $("save-status").textContent =
        "Unsaved changes — save or download a backup";
  }
}
async function persist() {
  if (!project) return;
  project = await storage.save(project);
  dirty = false;
  $("save-status").textContent =
    "Saved " + new Date(project.savedAt).toLocaleTimeString();
  await library();
}
function snapshot() {
  return structuredClone(project);
}
async function api(path, body, retry = true) {
  const accessToken = (sessionStorage.getItem("wec_token") || "").trim();
  const headers = { "X-WEC-Token": accessToken };
  if (body) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let r;
  try {
    r = await fetch(path, {
      method: body ? "POST" : "GET", headers,
      body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    throw Error(error.name === "AbortError"
      ? "The server did not respond within 90 seconds. No automatic retry was made. Check your connection and saved results before retrying."
      : "Cannot reach the studio server. Check your connection or wait for the server to wake, then use Connect / check AI.");
  } finally { clearTimeout(timer); }
  if (r.status === 401) {
    // Discard only the rejected value, not a newer sign-in from another request.
    if ((sessionStorage.getItem("wec_token") || "").trim() === accessToken)
      sessionStorage.removeItem("wec_token");
    if (retry) {
      const value = prompt("Sign in to WEC with your existing studio access token (kept in this tab):");
      if (value === null) throw Error("Sign-in cancelled.");
      if (!value.trim()) throw Error("Sign-in was not completed. Enter your existing studio access token to connect.");
      sessionStorage.setItem("wec_token", value.trim());
      return api(path, body, false);
    }
    throw Error(accessToken
      ? "This tab's saved sign-in was not accepted. Reconnect with your current studio access token."
      : "This tab is not signed in to the studio server. Connect to use AI, video renders and online snapshots.");
  }
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const error = Error(e.error || "Request failed. Your saved project is still on this device.");
    error.requestState = e.request_state;
    throw error;
  }
  return r;
}
async function library() {
  const values = (await storage.all()).sort((a, b) => b.savedAt - a.savedAt);
  $("library").replaceChildren();
  if (!values.length)
    $("library").textContent = "Your saved projects will appear here.";
  for (const v of values) {
    const row = document.createElement("div");
    row.className = "library-item";
    const title = document.createElement("strong");
    title.textContent = v.title;
    const detail = document.createElement("p");
    detail.textContent = `${labels[v.kind]} · ${v.count} pages · ${new Date(v.savedAt).toLocaleDateString()}`;
    row.append(
      title,
      detail,
      button("Open", async () => {
        if (dirty)
          throw Error(
            "Save or download your current changes before opening another project.",
          );
        project = await storage.get(v.id);
        if (!project) throw Error("Project no longer exists");
        dirty = false;
        render();
        say("Opened " + project.title);
      }),
    );
    $("library").append(row);
  }
}
function fillProfiles() {
  const select = $("profile");
  select.replaceChildren(new Option("Choose a character", ""));
  for (const p of profiles) select.add(new Option(p.name, p.id));
}
let checkpointRead = 0;
async function refreshCheckpointInfo() {
  const sequence = ++checkpointRead, id = project?.id;
  $("checkpoint-status").textContent = "";
  if (!id || !$("checkpoint-panel").open) return;
  try {
    const info = await storage.checkpointInfo(id);
    if (sequence === checkpointRead && project?.id === id)
      $("checkpoint-status").textContent = info
        ? "Checkpoint saved " + new Date(info.createdAt).toLocaleString()
        : "No checkpoint saved for this project yet.";
  } catch (error) {
    if (sequence === checkpointRead && project?.id === id)
      $("checkpoint-status").textContent = error.message;
  }
}
$("checkpoint-panel").ontoggle = refreshCheckpointInfo;
$("checkpoint-save").onclick = () => run(async () => {
  readFields();
  await persist();
  const previous = await storage.checkpointInfo(project.id);
  if (previous && !confirm("Replace the checkpoint saved " + new Date(previous.createdAt).toLocaleString() + " with the current project? Download a backup or open its copy first to keep the older version.")) return;
  await storage.saveCheckpoint(project, previous?.checkpointId || null);
  await refreshCheckpointInfo();
  say("Checkpoint saved on this device. You can keep editing and open the checkpoint as a separate project later.");
});
$("checkpoint-open").onclick = () => run(async () => {
  if (dirty) throw Error("Save or download your current edits before opening a checkpoint copy.");
  const info = await storage.checkpointInfo(project.id);
  if (!info) throw Error("No checkpoint saved for this project yet.");
  const saved = await storage.openCheckpointCopy(project.id, info.checkpointId);
  project = saved; dirty = false;
  $("save-status").textContent = "Saved " + new Date(project.savedAt).toLocaleTimeString();
  render();
  await library();
  say("Opened a separate checkpoint copy. The original project and its checkpoint were kept.");
});
$("checkpoint-remove").onclick = () => run(async () => {
  const info = await storage.checkpointInfo(project.id);
  if (!info) throw Error("No checkpoint saved for this project yet.");
  if (!confirm("Remove this project's saved checkpoint? Current projects and downloaded backups stay in place.")) return;
  await storage.removeCheckpoint(project.id, info.checkpointId);
  await refreshCheckpointInfo();
  say("Checkpoint removed. Current projects were kept.");
});
function render() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  $("video-workflow").hidden = project?.kind !== "video";
  $("book-review").hidden = !project || project.kind === "video";
  $("editor").hidden = !project;
  $("empty").hidden = !!project;
  refreshCheckpointInfo();
  if (!project) return;
  $("promo-script").value = project.promoScript || "";
  $("source-status").textContent = project.pages.some(p => p.sourceArtwork)
    ? "This project contains reused artwork. Check its sources before final review." : "";
  for (const [id, key] of [
    ["title", "title"],
    ["author", "author"],
    ["character-name", "characterName"],
    ["character", "character"],
    ["style", "style"],
    ["narration", "narration"],
    ["back-text", "backText"],
  ])
    $(id).value = project[key];
  $("duration").value = project.duration;
  $("scene-count").value = project.sceneCount;
  $("cover-settings").hidden = project.kind === "video";
  $("cover-info").textContent = project.cover
    ? `${project.cover.name} · ${project.cover.width} × ${project.cover.height}`
    : "No separate cover picture. The first page will be used.";
  const reference = $("reference-preview");
  reference.replaceChildren();
  let referenceURL = null;
  if (project.reference) {
    referenceURL = URL.createObjectURL(project.reference.blob);
    urls.push(referenceURL);
    const img = document.createElement("img");
    img.src = referenceURL; img.alt = "Approved character reference";
    reference.append(img);
    const name = document.createElement("p"); name.textContent = project.reference.name;
    reference.append(name);
  } else reference.textContent = "No approved reference selected.";
  $("remove-reference").hidden = !project.reference;
  $("kind-label").textContent = labels[project.kind];
  $("video-settings").hidden = project.kind !== "video";
  $("book-planner").hidden = project.kind === "video";
  $("video").hidden = project.kind !== "video";
  $("pdf").hidden = project.kind === "video";
  $("page-help").textContent =
    project.kind === "video"
      ? "Split your finished narration first, then attach one picture per scene. Render video builds a movie here from a saved copy of your scenes."
      : "Up to 80 pages, 10 MiB / 12 megapixels per image, 30 MiB / 320 megapixels across a project. Your original image bytes are kept.";
  $("export-note").textContent =
    project.kind === "coloring"
      ? "PDF: Letter 8.5 × 11 in, grayscale, no bleed, ¾-inch margins. Two opening pages, then one illustration and a blank back. The cover template uses black ink on white paper. Inspect both PDFs in KDP and order a proof."
      : project.kind === "video"
        ? "Movies use the existing server renderer and its limits. It can be slow on free hosting; download finished movies. The device project keeps original images, while the video copy uses optimized images."
        : "PDF: Letter 8.5 × 11 in, color, no bleed, ¾-inch margins. Two opening pages; pictures and story text share a page. A final blank is added when needed. The cover template requires premium color on white paper. Check KDP minimum pages and printing cost before publishing.";
  $("save-status").textContent = project.savedAt
    ? "Saved " + new Date(project.savedAt).toLocaleTimeString()
    : "Not saved yet";
  $("pages").replaceChildren();
  for (const [i, page] of project.pages.entries()) {
    const card = document.createElement("li");
    card.className = "page";
    card.dataset.page = page.id;
    const title = document.createElement("h3");
    title.textContent = `${project.kind === "video" ? "Scene" : "Page"} ${i + 1}`;
    card.append(title);
    const grid = document.createElement("div");
    grid.className = "two";
    const visual = document.createElement("div"),
      words = document.createElement("div");
    if (page.asset) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(page.asset.blob);
      urls.push(img.src);
      img.alt = page.asset.name;
      img.loading = "lazy";
      visual.append(img);
      const info = document.createElement("p");
      info.className = "muted";
      info.textContent = `${page.asset.width} × ${page.asset.height} · ${page.asset.source} · ${ppi(page)} PPI at planned size`;
      visual.append(info);
      if (page.sourceArtwork) {
        const provenance = document.createElement("p"); provenance.className = "muted";
        provenance.textContent = `Copied from ${page.sourceArtwork.projectTitle}, page ${page.sourceArtwork.pageNumber}, saved revision ${page.sourceArtwork.revision}. The source is not changed by edits here.`;
        visual.append(provenance);
      }
      const reviewLabel = document.createElement("label"); reviewLabel.textContent = "Artwork review";
      const review = document.createElement("select");
      review.setAttribute("aria-label", "Artwork review");
      for (const [value, text] of [["unreviewed", "Not reviewed"], ["approved", "Approved"], ["needs_changes", "Needs changes"]])
        review.add(new Option(text, value));
      review.value = ["approved", "needs_changes"].includes(page.review) ? page.review : "unreviewed";
      review.onchange = () => run(async () => {
        page.review = review.value; dirty = true; await persist(); render();
        say("Artwork review saved. This records your review, not publishing approval.");
      });
      reviewLabel.append(review); visual.append(reviewLabel);

      visual.append(button("Use as approved reference", async () => {
        if (!confirm("Use this picture as the approved character reference for this project? Save the character profile to reuse it elsewhere.")) return;
        checkAssets(page.asset, project.reference);
        project.reference = structuredClone(page.asset);
        dirty = true; await persist(); render();
        say("Approved reference saved. Save the character profile to reuse it in other projects.");
      }));
      if (referenceURL) {
        const comparison = document.createElement("details");
        const summary = document.createElement("summary"); summary.textContent = "Compare with approved reference";
        const ref = document.createElement("img"); ref.src = referenceURL;
        ref.alt = "Approved reference for comparison"; ref.loading = "lazy";
        comparison.append(summary, ref); visual.append(comparison);
      }
    } else {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent =
        "Add a picture or generate one after reviewing its prompt.";
      visual.append(p);
    }
    const fileLabel = document.createElement("label");
    fileLabel.textContent = "Attach / replace picture";
    const upload = document.createElement("input");
    upload.type = "file";
    upload.accept = "image/png,image/jpeg,image/webp";
    upload.onchange = () =>
      run(async () => {
        const f = upload.files[0];
        if (!f) return;
        const asset = await inspect(f, "Uploaded original");
        checkAssets(asset, page);
        page.asset = asset;
        page.review = "unreviewed";
        dirty = true;
        await persist();
        render();
        say("Picture attached and saved.");
      });
    fileLabel.append(upload);
    visual.append(fileLabel);
    visual.append(button("Reuse saved artwork", async () => {
      const chosen = await chooseSavedArtwork(storage, project.id);
      if (!chosen) return;
      if (page.asset && !confirm("Replace this page's picture with the selected saved artwork? The source project stays unchanged.")) return;
      const asset = await inspect(new File([chosen.blob], chosen.name, { type: chosen.blob.type }), "Reused saved original");
      checkAssets(asset, page);
      page.asset = asset;
      page.review = "unreviewed";
      dirty = true;
      await persist();
      render();
      say("Saved artwork copied to this page. Review its suitability for this project before exporting.");
    }));
    if (project.kind === "storybook" || project.kind === "video") {
      const l = document.createElement("label");
      l.textContent =
        project.kind === "video"
          ? "Narration (use Split narration to change)"
          : "Story text";
      const t = document.createElement("textarea");
      t.rows = 4;
      t.maxLength = 1800;
      t.value = page.text;
      t.readOnly = project.kind === "video";
      t.oninput = () => {
        page.text = t.value;
        changed();
      };
      l.append(t);
      words.append(l);
    }
    const l = document.createElement("label");
    l.textContent = "Scene / image prompt";
    const promptBox = document.createElement("textarea");
    promptBox.rows = 3;
    promptBox.maxLength = 700;
    promptBox.value = page.prompt;
    promptBox.oninput = () => {
      page.prompt = promptBox.value;
      preview.textContent = promptFor(page);
      refPreview.textContent = promptFor(page, true);
      changed();
    };
    l.append(promptBox);
    words.append(l);
    const detail = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Full generation prompt";
    const preview = document.createElement("p");
    preview.className = "prompt-preview";
    preview.dataset.page = page.id;
    preview.textContent = promptFor(page);
    detail.append(summary, preview);
    words.append(detail);
    const gen = button(
      "Generate this picture",
      () => generate(page),
      !canGenerate(),
    );
    gen.dataset.generate = "true";
    words.append(gen);
    const refGen = button("Generate using reference", () => generate(page, true),
      !canGenerate(true));
    refGen.dataset.referenceGenerate = "true";
    words.append(refGen);
    if (page.pendingGeneration) {
      const note = document.createElement("p");
      note.textContent = "A generation receipt is saved for this page. Check its result before generating again. Recovery keeps the latest five pictures for up to 24 hours while server storage survives.";
      note.setAttribute("role", "status"); words.append(note);
      words.append(button("Check generated picture", () => recoverPicture(page)));
      words.append(button("Dismiss generation receipt", async () => {
        if (!confirm("Dismiss this recovery link? This does not cancel a provider request or refund an attempt. Check the result first; starting a new generation may spend another attempt.")) return;
        const candidate = snapshot();
        delete candidate.pages.find(p => p.id === page.id).pendingGeneration;
        await commitGeneration(candidate);
        say("Generation receipt dismissed. Existing picture kept.");
      }));
    }

    const refDetail = document.createElement("details");
    const refSummary = document.createElement("summary"); refSummary.textContent = "Reference generation prompt";
    const refPreview = document.createElement("p"); refPreview.textContent = promptFor(page, true);
    refPreview.className = "prompt-preview";
    refPreview.dataset.page = page.id; refPreview.dataset.reference = "true";
    refDetail.append(refSummary, refPreview); words.append(refDetail);
    grid.append(visual, words);
    card.append(grid);
    const actions = document.createElement("div");
    actions.className = "toolbar";
    if (project.kind !== "video")
      for (const [label, delta] of [
        ["Move earlier", -1],
        ["Move later", 1],
      ])
        if (project.pages[i + delta])
          actions.append(
            button(label, async () => {
              [project.pages[i], project.pages[i + delta]] = [
                project.pages[i + delta],
                project.pages[i],
              ];
              dirty = true;
              await persist();
              render();
            }),
          );
    if (project.kind !== "video")
      actions.append(
        button("Remove page", async () => {
          if (
            !confirm(
              "Remove this page from the saved project? Download a backup first to keep it.",
            )
          )
            return;
          project.pages.splice(i, 1);
          dirty = true;
          await persist();
          render();
        }),
      );
    card.append(actions);
    $("pages").append(card);
  }
  readiness();
}
function promptFor(page, useReference = false) {
  const format =
    project.kind === "coloring"
      ? "Children's coloring page, black outlines on pure white, closed clear shapes, no shading, no gray, no text, no border."
      : project.kind === "video"
        ? "Portrait 9:16 illustration for a faceless narrated video."
        : "Portrait children's book illustration, no lettering or captions.";
  return [useReference ? "Use the character in image 0 as the reference. Preserve its defining features while following the scene and style below." : "", project.character, project.style, format, page.prompt || page.text]
    .filter(Boolean)
    .join("\n");
}
function ppi(page) {
  const a = page.asset;
  if (!a) return 0;
  const h = 9.5;
  return Math.floor(Math.max(a.width / 6.5, a.height / h));
}
function readiness() {
  if (!project) return;
  $("book-review-status").textContent = "Check the current pages before printing. Export checks them again automatically.";
  $("book-review-issues").replaceChildren();
  if (project.kind === "video") {
    const hasScript = Boolean(project.narration.trim());
    const arranged = hasScript && project.pages.length > 0 && !videoSceneIssue();
    const missing = project.pages.findIndex(p => !p.asset);
    const illustrated = arranged && missing < 0;
    const steps = [
      [hasScript, "Write or draft your narration"],
      [arranged, "Split and review the current scenes"],
      [illustrated, `Add scene pictures (${project.pages.filter(p => p.asset).length}/${project.pages.length})`],
      [false, "Review, render and download your movie"],
    ];
    $("workflow-steps").replaceChildren(...steps.map(([done, text]) => {
      const li = document.createElement("li"); li.textContent = `${done ? "Done: " : "Next: "}${text}`; return li;
    }));
    const next = !hasScript ? "Write narration" : !arranged ? "Review and split narration" : !illustrated ? `Add picture for scene ${missing + 1}` : "Review and render video";
    $("workflow-next").textContent = next;
    $("workflow-status").textContent = illustrated
      ? "Scene inputs are complete. Review the pictures, then render. Server availability and actual narration duration are checked during rendering."
      : "Continue from your saved work. Existing pictures are kept until you choose to replace them.";
    $("workflow-next").onclick = () => {
      const target = !hasScript ? $("narration") : !arranged ? $("split") : !illustrated ? $("pages").children[missing] : $("video");
      target.scrollIntoView({block:"center", behavior:"smooth"});
      if (target.tagName === "LI") { target.tabIndex = -1; }
      target.focus({preventScroll:true});
    };
  }
  const n = project.pages.length,
    complete = project.pages.filter((p) => p.asset).length,
    low = project.pages.filter((p) => p.asset && ppi(p) < 300).length;
  const count = project.kind === "coloring" ? 2 + n * 2 : 2 + n + (n % 2);
  $("readiness").textContent =
    `${complete}/${n} pictures ready · ${project.pages.filter(p => p.asset && p.review === "approved").length}/${complete} pictures approved${project.kind === "video" ? "" : ` · ${count} PDF pages`}${low ? ` · ${low} image(s) below the 300 PPI print target` : ""}. ${project.kind === "storybook" ? "Every picture needs its own story text." : ""}`;
  if (project.kind === "video" && videoSceneIssue())
    $("readiness").textContent += " " + videoSceneIssue();
}
function videoSceneIssue() {
  const normalized = (value) => value.trim().replace(/\s+/g, " ");
  if (project.sceneCount !== project.pages.length ||
      normalized(project.narration) !== normalized(project.pages.map((p) => p.text).join(" ")))
    return "Narration or scene count changed. Use Split narration and review the pictures before opening Video Studio.";
  return "";
}
async function inspect(file, source) {
  if (!file.size || file.size > 10 * 1024 * 1024)
    throw Error("Choose a nonempty image up to 10 MiB.");
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  let extension;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    extension = "png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    extension = "jpg";
  else if (
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  )
    extension = "webp";
  else throw Error("Choose a PNG, JPG or WebP. SVG and HEIC are unsupported.");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || img.naturalWidth * img.naturalHeight > 12e6)
      throw Error("Choose an image up to 12 megapixels.");
    return {
      blob: file,
      name: (file.name || "generated." + extension).slice(0, 512),
      extension,
      width: img.naturalWidth,
      height: img.naturalHeight,
      source,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
function checkAssets(asset, replaced = null) {
  const rest = project.pages
    .filter((p) => p !== replaced && p.asset)
    .map((p) => p.asset);
  if (project.cover && project.cover !== replaced) rest.push(project.cover);
  if (project.reference && project.reference !== replaced) rest.push(project.reference);
  if (
    rest.reduce((n, a) => n + a.blob.size, asset.blob.size) > MAX_BYTES ||
    rest.reduce((n, a) => n + a.width * a.height, asset.width * asset.height) >
      MAX_PIXELS
  )
    throw Error(
      "Project exceeds 30 MiB or 320 megapixels. Split it into smaller projects.",
    );
}
async function encoded(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(Error("Could not read image"));
    r.readAsDataURL(blob);
  });
}
async function imageHash(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
async function referenceFingerprint(value) {
  return imageHash(new TextEncoder().encode(JSON.stringify({character: value.character,
    style: value.style, reference: value.reference ? await imageHash(await value.reference.blob.arrayBuffer()) : null})));
}
async function checkSources() {
  const messages = [], cache = new Map();
  for (const [index, page] of project.pages.entries()) {
    const origin = page.sourceArtwork;
    if (!origin) continue;
    if (!cache.has(origin.projectId)) cache.set(origin.projectId, await storage.get(origin.projectId));
    const source = cache.get(origin.projectId), sourcePage = source?.pages.find(p => p.id === origin.pageId);
    let issue = "";
    if (!page.asset || await imageHash(await page.asset.blob.arrayBuffer()) !== origin.sha256)
      issue = "picture changed in this draft since it was copied";
    else if (!sourcePage?.asset) issue = "source is unavailable on this device; the copied picture is still kept";
    else if (await imageHash(await sourcePage.asset.blob.arrayBuffer()) !== origin.sha256)
      issue = "source picture has changed; this draft keeps the earlier copy";
    else if (sourcePage.review !== "approved") issue = "source artwork is no longer approved";
    else if (await referenceFingerprint(source) !== origin.referenceFingerprint)
      issue = "source character, style or reference has changed; review this earlier copy";
    if (issue) messages.push(`Scene/page ${index + 1}: ${issue}.`);
  }
  $("source-status").textContent = messages.length ? messages.join(" ")
    : project.pages.some(p => p.sourceArtwork) ? "Reused pictures and source references still match the recorded versions." : "No recorded source links in this project.";
  return messages;
}
$("check-sources").onclick = () => run(checkSources);
$("promo-script").oninput = () => { project.promoScript = $("promo-script").value; changed(); };
$("promo-video").onclick = () => run(async () => {
  readFields();
  const selected = project.pages.map((page, index) => ({page,index})).filter(({page}) => page.asset && page.review === "approved");
  if (!selected.length || selected.length > 7) throw Error("Approve 1–7 pictures for this video. No pictures are silently truncated.");
  const script = (project.promoScript || "").trim();
  if (!script) throw Error("Write a promotional video script first. It is saved with this project.");
  if (!confirm(`Create a separate video draft using approved pages ${selected.map(p => p.index + 1).join(", ")} in that order? Review each scene and picture before rendering. No images or narration audio are generated now.`)) return;
  await persist();
  const source = snapshot();
  const planned = await (await api("/api/creative/plan", {story: script, scenes: selected.length, duration: 35})).json();
  if (planned.scenes.length !== selected.length) throw Error("Scene count does not match approved pictures. Adjust the script and try again.");
  const fingerprint = await referenceFingerprint(source);
  const candidate = {...fresh("video"), title: (source.title + " - promotional video").slice(0,150),
    author: source.author, characterName: source.characterName, character: source.character,
    style: source.style, reference: source.reference, narration: script, sceneCount: selected.length};
  candidate.pages = await Promise.all(planned.scenes.map(async (scene,i) => {
    const {page,index} = selected[i];
    return {...emptyPage(), text: scene.narration, prompt: page.prompt, asset: structuredClone(page.asset),
      review: "unreviewed", sourceArtwork: {projectId: source.id, projectTitle: source.title,
        pageId: page.id, pageNumber: index + 1, revision: source.revision,
        sha256: await imageHash(await page.asset.blob.arrayBuffer()), referenceFingerprint: fingerprint}};
  }));
  const saved = await storage.save(candidate);
  project = saved; dirty = false; render(); await library();
  $("save-status").textContent = "Saved " + new Date(saved.savedAt).toLocaleTimeString();
  say("Promotional video draft saved with your approved original pictures. Review their match to each scene, then render below. Your source project is unchanged.");
});
async function backupAsset(asset) {
  const value = { ...asset, image_base64: await encoded(asset.blob),
    sha256: await imageHash(await asset.blob.arrayBuffer()) };
  delete value.blob;
  return value;
}
async function verifyBackupImage(asset, raw, version, label) {
  if (version !== 2) return;
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      await imageHash(raw) !== asset.sha256)
    throw Error(`${label}: picture checksum does not match. The backup may be damaged or edited. Existing projects were kept.`);
}
async function payload() {
  readFields();
  const value = snapshot();
  delete value.reference; // Visual review only; never sent to text-only generation/export APIs.
  for (const page of value.pages) {
    if (!page.asset) throw Error("Every page needs a picture before export.");
    page.image_base64 = await encoded(page.asset.blob);
    delete page.asset;
  }
  if (value.cover) {
    value.cover_image_base64 = await encoded(value.cover.blob);
    delete value.cover;
  }
  value.back_text = value.backText;
  return value;
}
function download(blob, suffix, title = project?.title || "wec-project") {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download =
    (title.replace(/[^a-z0-9]+/gi, "-").slice(0, 70) || "wec-project") +
    suffix;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function commitGeneration(candidate) {
  project = await storage.save(candidate);
  dirty = false;
  $("save-status").textContent = "Saved " + new Date(project.savedAt).toLocaleTimeString();
  render();
  lock(busy);
  await library();
  lock(busy);
}
async function receivePicture(pageId, response, mode) {
  if (response.status === 202) {
    const state = await response.json();
    say(state.error || "Still generating. Check generated picture shortly.");
    return;
  }
  const asset = await inspect(new File([await response.blob()], "generated.png", {
    type: response.headers.get("Content-Type"),
  }), mode === "reference" ? "Cloudflare FLUX.2 klein 4B · reference-guided" : "Cloudflare generated");
  const current = project.pages.find(p => p.id === pageId);
  if (!current) throw Error("The destination page is unavailable. Keep the generation receipt to recover the picture.");
  checkAssets(asset, current);
  const candidate = snapshot(), page = candidate.pages.find(p => p.id === pageId);
  page.asset = asset; page.review = "unreviewed";
  delete page.pendingGeneration;
  await commitGeneration(candidate);
  say("Picture received and saved. Review character consistency and actual resolution before using it.");
}
async function recoverPicture(page) {
  const receipt = page.pendingGeneration;
  if (!receipt) return;
  const response = await api(`/api/creative/image-requests/${receipt.id}`);
  if (response.status !== 202 && page.asset &&
      !confirm("Use the saved generated picture in place of this page's current picture? Download a backup first to keep both. Review it against any prompt or reference edits.")) return;
  await receivePicture(page.id, response, receipt.mode);
}
async function generate(page, useReference = false) {
  if (page.pendingGeneration)
    throw Error("Check generated picture before starting another attempt. You can dismiss its receipt after reviewing the result.");
  if (!canGenerate(useReference))
    throw Error("Image generation is unavailable or the daily limit is reached. Check AI connection status and your approved reference.");
  if (useReference && (!project.reference || !generation?.reference_ready))
    throw Error("Choose an approved reference and connect reference generation first.");
  if (project.kind === "video" && videoSceneIssue())
    throw Error(videoSceneIssue());
  const prompt = promptFor(page, useReference);
  if (prompt.length > 2048)
    throw Error(
      "Shorten the character, style or scene description to fit 2048 characters.",
    );
  if (
    !confirm(
      (useReference ? `Send a resized copy of ${project.reference.name} to Cloudflare FLUX.2 klein 4B with this prompt? Original stays on your device. Estimated list price about $0.0012 before free allowance; actual billing depends on your account. ` : "") +
      "Generate ONE picture with your configured Cloudflare account? This uses provider allowance and may incur charges under your account settings. No automatic retries. Existing artwork is kept unless the new image is saved.",
    )
  )
    return;
  if (
    project.pages.some((p) => p.asset) &&
    page.asset &&
    !confirm(
      "Replace this page’s picture after generation? Download a project backup first to keep its original.",
    )
  )
    return;
  readFields();
  const receipt = { id: crypto.randomUUID().replaceAll("-", ""), mode: useReference ? "reference" : "text" };
  const candidate = snapshot();
  candidate.pages.find(p => p.id === page.id).pendingGeneration = receipt;
  // Save the receipt first. A device-save failure must never submit a billable call.
  await commitGeneration(candidate);
  say("Generating one picture. If the connection drops, reopen this project and use Check generated picture. No automatic retries.");
  const body = { prompt, mode: receipt.mode, request_id: receipt.id };
  if (useReference) body.reference_image_base64 = await encoded(project.reference.blob);
  try {
    const response = await api("/api/creative/image", body);
    await receivePicture(page.id, response, receipt.mode);
  } catch (error) {
    if (["failed", "not_started"].includes(error.requestState)) {
      const candidate = snapshot();
      delete candidate.pages.find(p => p.id === page.id).pendingGeneration;
      await commitGeneration(candidate);
    }
    throw error;
  } finally {
    try {
      generation = await (await api("/api/generation", undefined, false)).json();
      showGenerationStatus();
    } catch { /* Never retry a generation when status refresh fails. */ }
  }
}

for (const id of [
  "title",
  "author",
  "character-name",
  "character",
  "style",
  "narration",
  "duration",
  "scene-count",
  "back-text",
])
  $(id).addEventListener("input", changed);
document.querySelectorAll("[data-kind]").forEach(
  (b) =>
    (b.onclick = () =>
      run(async () => {
        if (dirty)
          throw Error(
            "Save or download your current changes before starting another project.",
          );
        project = fresh(b.dataset.kind);
        dirty = true;
        await persist();
        render();
        say("Created " + labels[project.kind] + ".");
        $("editor").scrollIntoView({ block: "start", behavior: "smooth" });
      })),
);
$("save").onclick = () =>
  run(async () => {
    await persist();
    say("Project saved on this device.");
  });
$("add").onclick = () =>
  run(async () => {
    if (project.kind === "video")
      throw Error("Use Split narration to create matching video scenes.");
    if (project.pages.length >= limit())
      throw Error("This project has reached its page limit.");
    project.pages.push(emptyPage());
    dirty = true;
    await persist();
    render();
  });
$("plan-pages").onclick = () =>
  run(async () => {
    const value = $("outline").value.trim();
    if (!value) throw Error("Add your ideas or story text first.");
    const segments = value
      .split(project.kind === "storybook" ? /\n\s*\n/ : /\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (project.pages.length + segments.length > limit())
      throw Error("Too many pages; shorten the outline.");
    if (
      segments.some(
        (s) => s.length > (project.kind === "storybook" ? 1800 : 700),
      )
    )
      throw Error("A page is too long. Split the text into smaller sections.");
    for (const segment of segments) {
      const p = emptyPage();
      if (project.kind === "storybook") p.text = segment;
      else p.prompt = segment;
      project.pages.push(p);
    }
    dirty = true;
    await persist();
    $("outline").value = "";
    render();
    say("Pages created from your text. Add prompts and pictures next.");
  });
$("split").onclick = () =>
  run(async () => {
    readFields();
    if (
      project.pages.length &&
      !confirm(
        "Rebuild scenes from this narration? Pictures and prompts are kept only for uniquely matching unchanged scenes. Changed or repeated scenes need review and new picture attachments. Download a backup first.",
      )
    )
      return;
    const value = await (
      await api("/api/creative/plan", {
        story: project.narration,
        scenes: project.sceneCount,
        duration: project.duration,
      })
    ).json();
    const normalize = text => text.trim().replace(/\s+/g, " ");
    const oldPages = project.pages;
    project.pages = value.scenes.map(s => {
      const key = normalize(s.narration);
      const matches = oldPages.filter(p => normalize(p.text) === key);
      const unique = value.scenes.filter(other => normalize(other.narration) === key).length === 1;
      if (matches.length === 1 && unique)
        return {...matches[0], text:s.narration};
      return {...emptyPage(), text:s.narration, prompt:s.narration};
    });
    dirty = true;
    await persist();
    render();
    say(`Narration arranged. Kept ${project.pages.filter(p => p.asset).length} unchanged scene picture(s). Review the scene text before attaching pictures.`);
  });
$("pictures").onchange = () =>
  run(async () => {
    const files = Array.from($("pictures").files || []);
    let added = 0;
    try {
      for (const f of files) {
        let page = project.pages.find((p) => !p.asset);
        if (!page && project.kind === "video")
          throw Error("Split your narration before adding video pictures.");
        if (!page && project.pages.length >= limit())
          throw Error("Page limit reached.");
        const asset = await inspect(f, "Uploaded original");
        checkAssets(asset, page);
        if (!page) {
          page = emptyPage();
          project.pages.push(page);
        }
        page.asset = asset;
        page.review = "unreviewed";
        dirty = true;
        added++;
      }
      await persist();
    } finally {
      $("pictures").value = "";
      render();
    }
    say(`${added} picture(s) added and saved. Review page order and text.`);
  });
$("reference-picture").onchange = () => run(async () => {
  const file = $("reference-picture").files[0];
  $("reference-picture").value = "";
  if (!file) return;
  const asset = await inspect(file, "Approved reference");
  checkAssets(asset, project.reference);
  if (project.reference && !confirm("Replace this project's approved reference? Saved profiles and other projects stay unchanged.")) return;
  project.reference = asset; dirty = true;
  await persist(); render();
  say("Approved reference saved. Save the character profile to reuse it elsewhere.");
});
$("remove-reference").onclick = () => run(async () => {
  if (!confirm("Remove the reference from this project? Saved character profiles stay unchanged.")) return;
  project.reference = null; dirty = true; await persist(); render();
});
$("save-profile").onclick = () =>
  run(async () => {
    readFields();
    if (!project.characterName.trim() || !project.character.trim())
      throw Error("Add a character name and description first.");
    const old = profiles.find((p) => p.name === project.characterName);
    if (old && !confirm("Update this saved character profile, including its reference and style? Existing projects keep their copies.")) return;
    await storage.profile({
      id: old?.id || crypto.randomUUID(),
      reference: project.reference ? structuredClone(project.reference) : null,
      name: project.characterName,
      character: project.character,
      style: project.style,
    });
    profiles = await storage.all("profiles");
    fillProfiles();
    await persist();
    say("Character profile saved with its style and approved reference for reuse in other projects.");
  });
$("profile").onchange = () =>
  run(async () => {
    const p = profiles.find((p) => p.id === $("profile").value);
    if (!p) return;
    if ((project.character || project.style || project.reference) &&
        !confirm("Apply this character profile and replace this project's character, style and reference? Page artwork stays unchanged.")) return;
    if (p.reference) checkAssets(p.reference, project.reference);
    project.reference = p.reference ? structuredClone(p.reference) : null;
    project.characterName = p.name;
    project.character = p.character;
    project.style = p.style;
    dirty = true;
    render();
    await persist();
  });
async function encodeBackup(source) {
  const value = structuredClone(source);
  delete value.revision;
  value.backup_version = 2;
  if (value.reference) value.reference = await backupAsset(value.reference);
  if (value.cover) value.cover = await backupAsset(value.cover);
  for (const p of value.pages) if (p.asset) p.asset = await backupAsset(p.asset);
  return value;
}
async function recoveryPackage() {
  readFields();
  await persist();
  const state = await storage.recoverySnapshot(project.id, project.revision);
  const content = {project: await encodeBackup(state.project), checkpoint: state.checkpoint
    ? {createdAt: state.checkpoint.createdAt, project: await encodeBackup(state.checkpoint.project)} : null};
  const payload = JSON.stringify(content);
  const value = {app: "wec-recovery-package", package_version: 1, payload,
    sha256: await imageHash(new TextEncoder().encode(payload))};
  const blob = new Blob([JSON.stringify(value)], {type: "application/json"});
  if (blob.size > 90 * 1024 * 1024) throw Error("Recovery package is too large. Download each version as a project backup instead.");
  return blob;
}
$("recovery-package").onclick = () => run(async () => {
  download(await recoveryPackage(), "-recovery.json");
  say("Recovery package download opened. Save it outside this browser, such as Files or your cloud drive. It includes the project and any saved checkpoint; rendered movies and other projects are not included.");
});
$("backup").onclick = () =>
  run(async () => {
    readFields();
    const value = await encodeBackup(snapshot());
    download(
      new Blob([JSON.stringify(value)], { type: "application/json" }),
      "-project.json",
    );
    say(
      "Project backup download opened. Save it to Files, including drafts and original pictures.",
    );
  });
$("zip").onclick = () =>
  run(async () => {
    const entries = [],
      pages = [];
    if (!project.pages.length || project.pages.some((p) => !p.asset))
      throw Error(
        "Every page needs a picture for the artwork ZIP. Use project backup to keep an unfinished draft.",
      );
    for (const [i, p] of project.pages.entries()) {
      const file = `page-${String(i + 1).padStart(3, "0")}.${p.asset.extension}`;
      entries.push({
        name: file,
        bytes: new Uint8Array(await p.asset.blob.arrayBuffer()),
      });
      pages.push({
        page: i + 1,
        file,
        original: p.asset.name,
        width: p.asset.width,
        height: p.asset.height,
        text: p.text,
        prompt: p.prompt,
      });
    }
    const manifest = {
      schema_version: 1,
      title: project.title,
      blank_backs: project.kind === "coloring",
      paper: "Letter",
      artwork_box_inches: [7.5, 10],
      pages,
      notice:
        "Original artwork only. This is not the print PDF. Use the project JSON backup to keep all editing settings.",
    };
    entries.push({
      name: "manifest.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    });
    download(makeZip(entries), "-artwork.zip");
    say(
      "Original artwork ZIP download opened. Project JSON keeps your full editable workspace.",
    );
  });
async function checkBook() {
  readFields();
  const issues = [], hashes = new Map();
  if (!project.pages.length) issues.push({error:true, text:"Add at least one page."});
  for (const [i, page] of project.pages.entries()) {
    if (!page.asset) issues.push({error:true, index:i, text:`Page ${i + 1}: missing picture.`});
    if (project.kind === "storybook" && !page.text.trim())
      issues.push({error:true, index:i, text:`Page ${i + 1}: missing story text.`});
    if (!page.asset) continue;
    if (page.review !== "approved") issues.push({index:i, text:`Page ${i + 1}: artwork ${page.review === "needs_changes" ? "needs changes" : "has not been reviewed"}.`});
    if (ppi(page) < 300) issues.push({index:i, text:`Page ${i + 1}: below the 300 PPI interior target (${ppi(page)} PPI).`});
    const hash = await imageHash(await page.asset.blob.arrayBuffer());
    if (!hashes.has(hash)) hashes.set(hash, []);
    hashes.get(hash).push(i);
  }
  for (const pages of hashes.values()) {
    if (pages.length > 1) issues.push({index:pages[1], text:`Exact duplicate artwork on pages ${pages.map(i => i + 1).join(", ")}. Keep only if the repetition is intentional.`});
  }
  $("book-review-issues").replaceChildren(...issues.map(issue => {
    const li = document.createElement("li"); li.textContent = issue.text + " ";
    if (issue.index !== undefined) li.append(button("Go to page " + (issue.index + 1), () => {
      const card = $("pages").children[issue.index];
      card.tabIndex = -1; card.scrollIntoView({block:"center", behavior:"smooth"}); card.focus({preventScroll:true});
    }));
    return li;
  }));
  const errors = issues.filter(i => i.error).length;
  $("book-review-status").textContent = issues.length
    ? `${errors} blocking issue(s), ${issues.length - errors} review warning(s).`
    : "Basic checks passed. Inspect the exported PDF for text layout, margins and artwork quality.";
  return {issues, errors};
}
$("check-book").onclick = () => run(async () => {
  await checkBook();
  $("book-review").scrollIntoView({block:"center", behavior:"smooth"});
});
async function approveBookExport() {
  const result = await checkBook();
  if (result.errors) {
    $("book-review").scrollIntoView({block:"center", behavior:"smooth"});
    throw Error("Fix the missing book content listed in Review before printing. Project backup still keeps unfinished work.");
  }
  return !result.issues.length || confirm(result.issues.map(i => i.text).join("\n") + "\nExport a review PDF anyway? No artwork is changed or removed.");
}
$("pdf").onclick = () =>
  run(async () => {
    if (!(await approveBookExport())) return;
    await persist();
    say("Building your book PDF. Keep this page open.");
    const r = await api("/api/creative/pdf", await payload());
    download(await r.blob(), "-interior.pdf");
    say(
      "PDF download opened. Review page count, linework and margins before publishing. A cover is separate.",
    );
  });
const renders = videoPanel({ api, run, busy: () => busy });
$("video").onclick = () =>
  run(async () => {
    readFields();
    if (videoSceneIssue()) throw Error(videoSceneIssue());
    if (!project.pages.length || project.pages.some(page => !page.asset))
      throw Error("Attach a picture to every scene before rendering.");
    const awaitingReview = project.pages.filter(p => p.review !== "approved").length;
    const sourceWarnings = await checkSources();
    if (sourceWarnings.length && !confirm(sourceWarnings.join("\n") + "\nContinue with the pictures currently saved in this draft? No sources will be replaced.")) return;
    if (!confirm(`${awaitingReview} picture(s) are not approved. Review them before publishing. ` + "Build a narrated movie from this project and its pictures? This uses one local render attempt, saves a server copy, and does not generate new images.")) return;
    const state = await renders.refresh();
    if (!state.ready) throw Error(state.message || "Video rendering is unavailable.");
    if (state.jobs.some(job => ["queued", "running"].includes(job.status)))
      throw Error("A video is already rendering. Follow its progress below.");
    if (state.attempts_today >= state.daily_limit)
      throw Error("Today's render limit has been reached. Download an existing movie or try another day.");
    if (state.jobs.length >= state.max_saved_videos)
      throw Error("Server movie storage is full. Download and remove an older render first.");
    await persist();
    say("Preparing a saved copy of these scenes…");
    const value = await (
      await api("/api/creative/video", await payload())
    ).json();
    try {
      await api(`/api/projects/${value.projects[0].id}/video`, { ambience: true });
    } catch (error) {
      throw Error(`Render could not be confirmed: ${error.message} Refresh renders before trying again. Your prepared copy is available in Video renders & saved stories.`);
    }
    say("Movie rendering started. Follow its progress in Video renders below. You can keep editing; this render uses the saved version.");
    await renders.refresh();
    $("renders").scrollIntoView({ block: "start", behavior: "smooth" });
  });
async function restore(file) {
  if (file.size > MAX_BYTES * 1.4 + 1024 * 1024)
    throw Error("Project backup is too large.");
  const v = JSON.parse(await file.text());
  if (
    v?.app !== "wec-creative-studio" ||
    v.schema_version !== 1 ||
    !labels[v.kind] ||
    !Array.isArray(v.pages) ||
    v.pages.length > (v.kind === "video" ? 7 : 80)
  )
    throw Error("Choose a WEC Creative Studio project JSON.");
  if (v.backup_version !== undefined && v.backup_version !== 2)
    throw Error("Unsupported backup version. Open this backup with a compatible WEC version.");
  for (const [k, max] of Object.entries({
    title: 150,
    author: 100,
    characterName: 80,
    character: 700,
    style: 300,
    narration: 30000,
  }))
    if (typeof v[k] !== "string" || v[k].length > max)
      throw Error("Invalid project " + k);
  if (
    !Number.isFinite(v.duration) ||
    v.duration < 1 ||
    v.duration > 35 ||
    !Number.isInteger(v.sceneCount) ||
    v.sceneCount < 1 ||
    v.sceneCount > 7
  )
    throw Error("Invalid video settings");
  if (
    v.backText !== undefined &&
    (typeof v.backText !== "string" || v.backText.length > 800)
  )
    throw Error("Invalid back cover text");
  const candidate = {
    ...fresh(v.kind),
    backText: v.backText || "",
    title: v.title,
    author: v.author,
    characterName: v.characterName,
    character: v.character,
    style: v.style,
    narration: v.narration,
    duration: v.duration,
    sceneCount: v.sceneCount,
    pages: [],
  };
  if (v.promoScript !== undefined) {
    if (typeof v.promoScript !== "string" || v.promoScript.length > 1000) throw Error("Invalid promotional script");
    candidate.promoScript = v.promoScript;
  }
  let total = 0,
    pixels = 0;
  for (const p of v.pages) {
    if (
      !p ||
      typeof p.text !== "string" ||
      p.text.length > 1800 ||
      typeof p.prompt !== "string" ||
      p.prompt.length > 700
    )
      throw Error("Invalid page text");
    const page = { ...emptyPage(), text: p.text, prompt: p.prompt };
    if (p.asset) {
      const a = p.asset;
      if (
        typeof a.image_base64 !== "string" ||
        a.image_base64.length > 14 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(a.image_base64)
      )
        throw Error("Invalid backup image");
      const raw = Uint8Array.from(atob(a.image_base64), (c) => c.charCodeAt(0));
      await verifyBackupImage(a, raw, v.backup_version, `Page ${candidate.pages.length + 1}`);
      const asset = await inspect(
        new File([raw], typeof a.name === "string" ? a.name : "restored.png"),
        "Restored original",
      );
      total += asset.blob.size;
      pixels += asset.width * asset.height;
      if (total > MAX_BYTES || pixels > MAX_PIXELS)
        throw Error("Project exceeds its image budget");
      page.asset = asset;
      page.review = "unreviewed";
    }
    if (page.asset && ["approved", "needs_changes"].includes(p.review)) page.review = p.review;
    if (p.sourceArtwork !== undefined) {
      const o = p.sourceArtwork;
      if (!o || ![o.projectId, o.pageId].every(s => typeof s === "string" && s.length > 0 && s.length <= 100) ||
          typeof o.projectTitle !== "string" || o.projectTitle.length > 150 ||
          !Number.isSafeInteger(o.pageNumber) || o.pageNumber < 1 || o.pageNumber > 80 ||
          !Number.isSafeInteger(o.revision) || o.revision < 1 ||
          ![o.sha256, o.referenceFingerprint].every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s)))
        throw Error("Invalid artwork source record");
      page.sourceArtwork = {projectId:o.projectId, projectTitle:o.projectTitle, pageId:o.pageId,
        pageNumber:o.pageNumber, revision:o.revision, sha256:o.sha256, referenceFingerprint:o.referenceFingerprint};
    }
    if (p.pendingGeneration && /^[a-f0-9]{32}$/.test(p.pendingGeneration.id) &&
        ["text", "reference"].includes(p.pendingGeneration.mode))
      page.pendingGeneration = {id: p.pendingGeneration.id, mode: p.pendingGeneration.mode};
    candidate.pages.push(page);
  }
  if (v.cover) {
    const a = v.cover;
    if (
      typeof a.image_base64 !== "string" ||
      a.image_base64.length > 14 * 1024 * 1024
    )
      throw Error("Invalid cover image");
    const raw = Uint8Array.from(atob(a.image_base64), (c) => c.charCodeAt(0));
    await verifyBackupImage(a, raw, v.backup_version, "Cover");
    candidate.cover = await inspect(
      new File([raw], typeof a.name === "string" ? a.name : "cover.png"),
      "Restored cover",
    );
    total += candidate.cover.blob.size;
    pixels += candidate.cover.width * candidate.cover.height;
    if (total > MAX_BYTES || pixels > MAX_PIXELS)
      throw Error("Project exceeds its image budget");
  }
  if (v.reference) {
    const a = v.reference;
    if (typeof a.image_base64 !== "string" || a.image_base64.length > 14 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(a.image_base64)) throw Error("Invalid reference image");
    const raw = Uint8Array.from(atob(a.image_base64), c => c.charCodeAt(0));
    await verifyBackupImage(a, raw, v.backup_version, "Reference");
    candidate.reference = await inspect(new File([raw], typeof a.name === "string" ? a.name : "reference.png"), "Restored approved reference");
    total += candidate.reference.blob.size;
    pixels += candidate.reference.width * candidate.reference.height;
    if (total > MAX_BYTES || pixels > MAX_PIXELS) throw Error("Project exceeds its image budget");
  }
  return { candidate, verified: v.backup_version === 2 };
}
$("restore").onchange = () => run(async () => {
  const f = $("restore").files[0];
  $("restore").value = "";
  if (f) await openRecovery(f);
});
async function openRecovery(f) {
  if (dirty) throw Error("Save or download your edits before restoring.");
  let candidate, verified, checkpoint = null, packaged = false;
  if (f.size > 90 * 1024 * 1024) throw Error("Backup exceeds the 90 MiB recovery package limit.");
  const envelope = JSON.parse(await f.text());
  if (envelope?.app === "wec-recovery-package") {
    packaged = true;
    if (envelope.package_version !== 1 || typeof envelope.payload !== "string")
      throw Error("Unsupported recovery package version or content.");
    if (await imageHash(new TextEncoder().encode(envelope.payload)) !== envelope.sha256)
      throw Error("Recovery package checksum does not match. Existing projects were kept.");
    const content = JSON.parse(envelope.payload);
    const parseProject = async value => {
      if (value?.backup_version !== 2) throw Error("Recovery package requires verified project backups.");
      return restore(new Blob([JSON.stringify(value)], {type: "application/json"}));
    };
    ({candidate, verified} = await parseProject(content.project));
    if (content.checkpoint !== null) {
      const cp = content.checkpoint;
      if (!cp || !Number.isSafeInteger(cp.createdAt) || cp.createdAt < 0 ||
          cp.project?.kind !== content.project.kind || cp.project?.id !== content.project.id)
        throw Error("Invalid recovery checkpoint relationship.");
      checkpoint = {createdAt: cp.createdAt, project: (await parseProject(cp.project)).candidate};
    }
  } else ({candidate, verified} = await restore(f));
  // Commit before replacing the editor so a failed write preserves current work.
  const saved = packaged ? await storage.restoreRecovery(candidate, checkpoint) : await storage.save(candidate);
  project = saved;
  dirty = false;
  $("save-status").textContent = "Saved " + new Date(project.savedAt).toLocaleTimeString();
  await library();
  render();
  say((packaged ? "Recovery package restored as a new project" + (checkpoint ? " with its checkpoint" : "") + ". Existing projects were kept." : "Backup restored as a new project. Existing projects were kept.") +
    (verified ? " Picture checksums verified." : " Older backup: no picture checksums available."));

}

async function onlinePackage(item) {
  const blob = await (await api(`/api/creative/snapshots/${item.id}`)).blob();
  if (await imageHash(await blob.arrayBuffer()) !== item.id)
    throw Error("Online snapshot checksum failed. Your local projects were kept.");
  return blob;
}
async function onlineLibrary() {
  const state = await (await api("/api/creative/snapshots")).json();
  const list = $("online-library");
  list.replaceChildren();
  $("online-status").textContent = state.enabled
    ? `${state.snapshots.length}/${state.max_snapshots} snapshots · ${(state.used_bytes / 1048576).toFixed(1)} MiB of ${(state.max_bytes / 1048576).toFixed(0)} MiB used. Earlier snapshots stay until you remove them.`
    : state.reason;
  if (!state.enabled) return false;
  for (const item of state.snapshots) {
    const row = document.createElement("div");
    row.className = "library-item";
    const title = document.createElement("strong");
    title.textContent = item.title || "Untitled project";
    const detail = document.createElement("p");
    detail.textContent = `${labels[item.kind]} · ${new Date(item.created_at).toLocaleString()} · ${(item.bytes / 1048576).toFixed(1)} MiB${item.checkpoint ? " · includes checkpoint" : ""}`;
    row.append(title, detail,
      button("Open local copy", async () => {
        if (dirty) throw Error("Save or download your edits before opening an online snapshot.");
        await openRecovery(await onlinePackage(item));
      }),
      button("Download snapshot", async () => {
        download(await onlinePackage(item), "-recovery.json", item.title);
        say("Snapshot download opened. Keep this file in Files or an independent cloud drive for recovery if the server is lost.");
      }),
      button("Remove online snapshot", async () => {
        if (!confirm(`Remove this online snapshot of “${item.title}”? Download a backup first. This cannot be undone. Other snapshots and local projects will stay.`)) return;
        await api(`/api/creative/snapshots/${item.id}/remove`, {confirm: item.id});
        await onlineLibrary();
        say("Online snapshot removed. Other snapshots and local projects were kept.");
      }));
    list.append(row);
  }
  return true;
}
$("online-refresh").onclick = () => run(onlineLibrary);
$("online-save").onclick = () => run(async () => {
  if (!project) throw Error("Open a project first.");
  if (!await onlineLibrary()) throw Error($("online-status").textContent);
  const blob = await recoveryPackage();
  const item = await (await api("/api/creative/snapshots", blob)).json();
  // Read back and verify actual committed bytes before reporting success.
  await onlinePackage(item);
  await onlineLibrary();
  $("online-status").textContent = "Saved online and read-back checksum verified. " + $("online-status").textContent;
  say("Online snapshot saved and verified. Your local project stays editable. Future edits need another Save online snapshot; download an independent backup too.");
});

$("import-zip").onchange = () =>
  run(async () => {
    const f = $("import-zip").files[0];
    $("import-zip").value = "";
    if (!f) return;
    if (dirty) throw Error("Save or download your edits first.");
    const book = await readZip(f),
      candidate = fresh("coloring");
    candidate.title = book.title;
    for (const p of book.pages) {
      if (candidate.pages.length >= 80)
        throw Error(
          "Split this book into projects of at most 80 illustrations.",
        );
      candidate.pages.push({
        ...emptyPage(),
        asset: await inspect(new File([p.file], p.name), "Imported original"),
      });
    }
    if (candidate.pages.reduce((n, p) => n + p.asset.blob.size, 0) > MAX_BYTES)
      throw Error("Book exceeds the 30 MiB project limit.");
    project = candidate;
    dirty = true;
    await persist();
    render();
    say(
      "Coloring ZIP imported as a new project. Review the new PDF layout before publishing.",
    );
  });
$("server-refresh").onclick = () =>
  run(async () => {
    const value = await (await api("/api/projects")).json();
    $("server-projects").replaceChildren();
    for (const p of value.projects) {
      const row = document.createElement("p"),
        a = document.createElement("a");
      a.textContent = p.title;
      a.href = "/?project=" + encodeURIComponent(p.id);
      row.append(a);
      $("server-projects").append(row);
    }
    if (!value.projects.length)
      $("server-projects").textContent =
        "No server stories yet. Open the Video Studio to recover a device backup.";
  });

$("cover-picture").onchange = () =>
  run(async () => {
    const file = $("cover-picture").files[0];
    $("cover-picture").value = "";
    if (!file) return;
    const asset = await inspect(file, "Uploaded cover");
    checkAssets(asset, project.cover);
    project.cover = asset;
    dirty = true;
    await persist();
    render();
    say("Cover picture saved with the project.");
  });
$("cover").onclick = () =>
  run(async () => {
    if (!(await approveBookExport())) return;
    if (!project.backText.trim())
      throw Error("Add a back-cover description first.");
    await persist();
    const r = await api("/api/creative/cover", await payload());
    download(await r.blob(), "-cover.pdf");
    say(
      "Cover PDF download opened. Match the paper, ink and page count shown here in KDP.",
    );
  });

$("variant").onclick = () =>
  run(async () => {
    await persist();
    const source = snapshot(),
      kind = $("variant-kind").value,
      candidate = {
        ...fresh(kind),
        title: (source.title + " - " + labels[kind]).slice(0, 150),
        author: source.author,
        reference: source.reference ? structuredClone(source.reference) : null,
        characterName: source.characterName,
        character: source.character,
        style: source.style,
      };
    if (kind === "video") {
      const narration =
        source.pages
          .map((p) => p.text)
          .filter(Boolean)
          .join(" ") || source.narration;
      if (!narration.trim())
        throw Error("Add story text before creating a video variant.");
      const count = Math.min(7, source.pages.length || 1);
      const planned = await (
        await api("/api/creative/plan", {
          story: narration,
          scenes: count,
          duration: 35,
        })
      ).json();
      candidate.narration = narration;
      candidate.sceneCount = count;
      candidate.pages = planned.scenes.map((scene, i) => ({
        ...emptyPage(),
        text: scene.narration,
        prompt: scene.narration,
        asset:
          source.pages.length === count &&
          source.pages[i]?.text.trim().replace(/\s+/g, " ") === scene.narration
            ? source.pages[i].asset
            : null,
      }));
    } else
      candidate.pages = source.pages.map((p) => ({
        ...emptyPage(),
        text: kind === "storybook" ? p.text : "",
        prompt: p.prompt || p.text,
        asset:
          kind === "coloring" && source.kind !== "coloring" ? null : p.asset,
      }));
    project = candidate;
    dirty = true;
    await persist();
    render();
    say(
      "Created a separate " +
        labels[kind] +
        " project. Review text, prompts and missing pictures before exporting.",
    );
  });

$("draft").onclick = () =>
  run(async () => {
    readFields();
    const count = Number($("draft-count").value);
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > (project.kind === "video" ? 7 : 12)
    )
      throw Error("Choose 1–7 video scenes or 1–12 book/art pages.");
    if (project.kind !== "video" && project.pages.length + count > limit())
      throw Error("This draft would exceed the page limit.");
    if (!$("idea").value.trim()) throw Error("Add your idea first.");
    if (
      !confirm(
        "Request ONE text draft from your configured Cloudflare account? Provider allowance or charges may apply. No pictures or automatic retries.",
      )
    )
      return;
    if (
      project.kind === "video" &&
      project.pages.length &&
      !confirm(
        "Replace this video draft and its scene pictures? Download a backup first.",
      )
    )
      return;
    say(
      "Drafting your idea. Existing pages stay in place until a valid draft arrives.",
    );
    const result = await (
      await api("/api/creative/draft", {
        kind: project.kind,
        count,
        idea: $("idea").value,
        character: project.character,
        style: project.style,
      })
    ).json();
    if (project.kind === "video") {
      const planned = await (
        await api("/api/creative/plan", {
          story: result.narration,
          scenes: count,
          duration: project.duration,
        })
      ).json();
      project.narration = result.narration;
      project.sceneCount = count;
      project.pages = planned.scenes.map((s) => ({
        ...emptyPage(),
        text: s.narration,
        prompt: s.narration,
      }));
    } else
      project.pages.push(
        ...result.pages.map((p) => ({
          ...emptyPage(),
          text: p.text,
          prompt: p.prompt,
        })),
      );
    if (project.title.startsWith("Untitled ")) project.title = result.title;
    dirty = true;
    await persist();
    render();
    say(
      "AI draft saved. Review the writing and page prompts before generating pictures.",
    );
  });

window.addEventListener("beforeunload", (e) => {
  if (dirty || busy) {
    e.preventDefault();
    e.returnValue = "";
  }
});
run(async () => {
  await library();
  profiles = await storage.all("profiles");
  fillProfiles();
  say("Choose a format or open a saved project.");
  await refreshAI(false);
});
$("check-ai").onclick = () => run(() => refreshAI(true));
