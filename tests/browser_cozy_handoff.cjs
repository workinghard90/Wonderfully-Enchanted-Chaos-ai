/* Real backend + browser storage/exports. AI responses are intercepted fixtures. */
const { chromium } = require("playwright");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  net = require("node:net");
const assert = require("node:assert/strict");
(async () => {
  const listener = net.createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wec-creative-")),
    token = "test-only-creative-browser-32-characters";
  const server = spawn(
    process.env.PYTHON || "python",
    [path.join(__dirname, "browser_video_server.py"), String(port), directory, token],
    {
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        WEC_STUDIO_TOKEN: token,
        WEC_ENABLE_IMAGE_GENERATION: "0",
        WEC_ENABLE_TEXT_GENERATION: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  let browser,
    logs = "";
  server.stderr.on("data", (x) => (logs += x));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==",
    "base64",
  );
  const fixture = { name: "original.png", mimeType: "image/png", buffer: png };
  const ready = (page) =>
    page.waitForFunction(() => !document.querySelector("#save").disabled);
  const saved = (page) =>
    page.locator("#save-status").filter({ hasText: "Saved" }).waitFor();
  async function download(page, id) {
    const wait = page.waitForEvent("download");
    await page.locator(id).click();
    const value = await wait;
    return fs.readFileSync(await value.path());
  }
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/api/health")).ok) break;
      } catch {}
      if (server.exitCode !== null) throw Error(logs);
      if (i === 99) throw Error("Server startup timeout");
      await new Promise((r) => setTimeout(r, 100));
    }
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE_PATH
        ? {
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
          }
        : {}),
    });
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 1000 },
    ]) {
      const context = await browser.newContext({
        viewport,
        acceptDownloads: true,
      });
      await context.addInitScript(
        (t) => sessionStorage.setItem("wec_token", t),
        token,
      );

      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      let approve = true, downloads = 0;
      page.on("download", () => downloads++);
      page.on("dialog", d => d.type() === "prompt" ? d.accept("Synthetic handoff description") : approve ? d.accept() : d.dismiss());
      await page.goto(base + "/");
      await page.locator("[data-kind=coloring]").click();
      await ready(page);
      await page.locator("#title").fill("Synthetic handoff");
      await page.locator("#author").fill("Fixture Author");
      await page.locator("#outline").fill("A synthetic scene.");
      await page.locator("#plan-pages").click(); await ready(page);
      await page.locator("#pictures").setInputFiles(fixture);
      await page.locator("#status").filter({hasText:"1 picture(s) added and saved"}).waitFor();
      await page.getByLabel("Artwork review", {exact:true}).first().selectOption("approved"); await ready(page);
      await page.locator("#save").click(); await ready(page);
      // Preserve a synthetic baseline in a separate IndexedDB record, never user data.
      await page.evaluate(async () => {
        const storage = await import("/studio/store.js");
        const summaries = await storage.all();
        const p = await storage.get(summaries[0].id);
        const db = await storage.database();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("projects", "readwrite");
          tx.objectStore("projects").put({...p, id:"fixture-baseline", originalId:p.id});
          tx.oncomplete=resolve; tx.onerror=reject;
        }); db.close();
      });
      async function fingerprint() {
        return page.evaluate(async () => {
          const storage = await import("/studio/store.js");
          const p = await storage.get((await storage.all())[0].id);
          const record = structuredClone(p);
          for (const entry of record.pages) if (entry.asset?.blob) {
            entry.asset.digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await entry.asset.blob.arrayBuffer()))).join(",");
            delete entry.asset.blob;
          }
          return JSON.stringify(record);
        });
      }
      async function setCase(kind) {
        await page.evaluate(async kind => {
          const storage = await import("/studio/store.js");
          const p = await storage.get("fixture-baseline");
          p.id=p.originalId; delete p.originalId;
          if(kind === "missing") p.pages[0].asset=null;
          if(kind === "unapproved") p.pages[0].review="unreviewed";
          if(kind === "unsupported") p.pages[0].asset.extension="svg";
          if(kind === "fake") p.pages[0].asset.blob=new Blob(["fake"]);
          if(kind === "oversized") p.pages[0].asset.blob=new Blob([new Uint8Array(42*1024*1024+1)]);
          if(kind === "aggregate") p.pages=Array.from({length:10},(_,i)=>({...structuredClone(p.pages[0]),id:"fixture-"+i,asset:{...p.pages[0].asset,blob:new Blob([new Uint8Array(10*1024*1024)])}}));
          if(kind === "forty" || kind === "fortyone") p.pages=Array.from({length:kind==="forty"?40:41},(_,i)=>({...structuredClone(p.pages[0]),id:"fixture-"+i}));
          const db=await storage.database();
          await new Promise((resolve,reject)=>{
            const tx=db.transaction("projects","readwrite");
            tx.objectStore("projects").put(p); tx.oncomplete=resolve;tx.onerror=reject;
          });db.close();
        },kind);
        await page.reload();
        await page.locator("#library").getByRole("button",{name:"Open",exact:true}).first().click();
        await ready(page);
      }
      for (const kind of ["valid","forty"]) {
        await setCase(kind);
        const before=await fingerprint();
        const bytes=await download(page,"#cozy-export"); await ready(page);
        const file=path.join(directory,kind+"-"+viewport.width+".zip");
        fs.writeFileSync(file,bytes);
        const report=JSON.parse(execFileSync(process.env.PYTHON||"python",[
          path.join(__dirname,"check_cozy_download.py"),file,
          path.resolve(process.env.COZY_HANDOFF_DIR||".handoff-cozy"),kind==="forty"?"40":"1"
        ],{encoding:"utf8",cwd:path.resolve(__dirname,"..")}));
        assert.equal(report.passed,true);
        assert.equal(await fingerprint(),before);
      }
      await setCase("valid"); approve=false;
      const beforeCancel=await fingerprint(), beforeDownloads=downloads;
      await page.locator("#cozy-export").click();await ready(page);
      assert.equal(downloads,beforeDownloads);assert.equal(await fingerprint(),beforeCancel);
      approve=true;
      for(const [kind,pattern] of [
        ["missing",/Approve every page/],["unapproved",/Approve every page/],
        ["unsupported",/file type/],["fake",/PNG, JPG or WebP/],
        ["oversized",/42 MiB/],["aggregate",/90 MiB/],["fortyone",/40 preview/]
      ]) {
        await setCase(kind);
        const before=await fingerprint(), count=downloads;
        await page.locator("#cozy-export").click(); await ready(page);
        assert.match(await page.locator("#status").innerText(),pattern);
        assert.equal(downloads,count); assert.equal(await fingerprint(),before);
      }
      assert.deepEqual(errors,[]);
      await context.close();
      console.log(JSON.stringify({viewport:viewport.width,passed:true,cases:10}));
    }
  } finally {
    if(browser) await browser.close();
    server.kill("SIGTERM");
    await new Promise(r=>server.exitCode!==null?r():server.once("exit",r));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
