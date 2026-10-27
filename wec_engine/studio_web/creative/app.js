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
  const headers = { "X-WEC-Token": sessionStorage.getItem("wec_token") || "" };
  if (body) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let r;
  try {
    r = await fetch(path, {
      method: body ? "POST" : "GET", headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    throw Error(error.name === "AbortError"
      ? "The server did not respond within 90 seconds. No automatic retry was made. Check your connection and saved results before retrying."
      : "Cannot reach the studio server. Check your connection or wait for the server to wake, then use Connect / check AI.");
  } finally { clearTimeout(timer); }
  if (r.status === 401 && retry) {
    const value = prompt("Studio access token (kept in this browser tab):");
    if (value === null) throw Error("Authentication cancelled");
    sessionStorage.setItem("wec_token", value);
    return api(path, body, false);
  }
  if (r.status === 401) throw Error("Studio authentication is required or the access token is incorrect.");
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw Error(
      e.error || "Request failed. Your saved project is still on this device.",
    );
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
function render() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  $("video-workflow").hidden = project?.kind !== "video";
  $("book-review").hidden = !project || project.kind === "video";
  $("editor").hidden = !project;
  $("empty").hidden = !!project;
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
function download(blob, suffix) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download =
    (project.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 70) || "wec-project") +
    suffix;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function generate(page, useReference = false) {
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
  say("Generating one picture. Keep this page open; do not click again.");
  const body = { prompt, mode: useReference ? "reference" : "text" };
  if (useReference) body.reference_image_base64 = await encoded(project.reference.blob);
  let r;
  try { r = await api("/api/creative/image", body); }
  finally {
    try {
      generation = await (await api("/api/generation", undefined, false)).json();
      showGenerationStatus();
    } catch { /* Never retry a generation when status refresh fails. */ }
  }
  const asset = await inspect(
    new File([await r.blob()], "generated.png", {
      type: r.headers.get("Content-Type"),
    }),
    useReference ? "Cloudflare FLUX.2 klein 4B · reference-guided" : "Cloudflare generated",
  );
  checkAssets(asset, page);
  page.asset = asset;
  page.review = "unreviewed";
  dirty = true;
  try {
    await persist();
  } finally {
    render();
  }
  say(
    "Picture received. Review character consistency and actual resolution before using it.",
  );
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
$("backup").onclick = () =>
  run(async () => {
    readFields();
    const value = snapshot();
    delete value.revision;
    if (value.reference) {
      value.reference = { ...value.reference, image_base64: await encoded(value.reference.blob) };
      delete value.reference.blob;
    }
    if (value.cover) {
      value.cover = {
        ...value.cover,
        image_base64: await encoded(value.cover.blob),
      };
      delete value.cover.blob;
    }
    for (const p of value.pages) {
      if (p.asset) {
        p.asset = { ...p.asset, image_base64: await encoded(p.asset.blob) };
        delete p.asset.blob;
      }
    }
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
    const digest = await crypto.subtle.digest("SHA-256", await page.asset.blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
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
    candidate.reference = await inspect(new File([raw], typeof a.name === "string" ? a.name : "reference.png"), "Restored approved reference");
    total += candidate.reference.blob.size;
    pixels += candidate.reference.width * candidate.reference.height;
    if (total > MAX_BYTES || pixels > MAX_PIXELS) throw Error("Project exceeds its image budget");
  }
  return candidate;
}
$("restore").onchange = () =>
  run(async () => {
    const f = $("restore").files[0];
    $("restore").value = "";
    if (!f) return;
    if (dirty) throw Error("Save or download your edits before restoring.");
    const candidate = await restore(f);
    project = candidate;
    dirty = true;
    await persist();
    render();
    say("Backup restored as a new project. Existing projects were kept.");
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
