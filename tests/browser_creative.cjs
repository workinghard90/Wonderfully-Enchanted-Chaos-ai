/* Real backend + browser storage/exports. AI responses are intercepted fixtures. */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
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
    [
      "-m",
      "wec_engine.studio",
      "--port",
      String(port),
      "--data-dir",
      directory,
    ],
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
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("dialog", (d) => d.accept());
      await page.goto(base + "/studio/");
      await page
        .locator("#status")
        .filter({ hasText: "Choose a format" })
        .waitFor();
      await page.locator("[data-kind=storybook]").click();
      await ready(page);
      await page.locator("#title").fill("Pip story " + viewport.width);
      await page.locator("#author").fill("Melody Autumn Hall");
      await page.locator(".character").first().locator("summary").click();
      await page.locator("#character-name").fill("Pip");
      await page
        .locator("#character")
        .fill("A round lavender cloud with a curl and tiny arms.");
      await page.locator("#style").fill("Soft watercolor on cream.");
      await page.locator("#save-profile").click();
      await ready(page);
      await page
        .locator("#outline")
        .fill(
          "Pip found a little star.\n\nTogether they found their way home.",
        );
      await page.locator("#plan-pages").click();
      await ready(page);
      assert.equal(await page.locator(".page").count(), 2);
      await page
        .locator("#pictures")
        .setInputFiles([fixture, { ...fixture, name: "second.png" }]);
      await page
        .locator("#status")
        .filter({ hasText: "2 picture(s) added and saved" })
        .waitFor();
      const backup = JSON.parse(
        (await download(page, "#backup")).toString("utf8"),
      );
      assert.equal(backup.pages.length, 2);
      assert.equal(backup.pages[0].asset.image_base64, png.toString("base64"));
      assert.match(backup.character, /lavender/);
      assert.equal(backup.pages[1].text, "Together they found their way home.");
      const pdf = await download(page, "#pdf");
      assert.ok(pdf.subarray(0, 5).equals(Buffer.from("%PDF-")));
      fs.writeFileSync(path.join(directory, "storybook.pdf"), pdf);
      await page.reload();
      await page
        .locator("#status")
        .filter({ hasText: "Choose a format" })
        .waitFor();
      await page.locator("#library .library-item button").first().click();
      await ready(page);
      assert.equal(await page.locator(".page img").count(), 2);
      assert.equal(
        await page.locator("#title").inputValue(),
        "Pip story " + viewport.width,
      );
      await page
        .locator("#restore")
        .setInputFiles({
          name: "backup.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(backup)),
        });
      await page
        .locator("#status")
        .filter({ hasText: "Backup restored" })
        .waitFor();
      assert.equal(await page.locator("#library .library-item").count(), 2);
      // Cross-tab conflict: don't overwrite a newer saved project.
      const other = await context.newPage();
      other.on("dialog", (d) => d.accept());
      await other.goto(base + "/studio/");
      await other
        .locator("#status")
        .filter({ hasText: "Choose a format" })
        .waitFor();
      await other.locator("#library .library-item button").first().click();
      await ready(other);
      await page.locator("#title").fill("Latest saved title");
      await page.locator("#save").click();
      await ready(page);
      await other.locator("#title").fill("Conflicting title");
      await other.locator("#save").click();
      await other
        .locator("#status")
        .filter({ hasText: "changed in another tab" })
        .waitFor();
      const conflict = JSON.parse(
        (await download(other, "#backup")).toString(),
      );
      assert.equal(conflict.title, "Conflicting title");
      await other.close();
      await page.locator("[data-kind=coloring]").click();
      await ready(page);
      assert.equal(
        await page.locator("#title").inputValue(),
        "Untitled coloring book",
      );
      await page.locator("#pictures").setInputFiles(fixture);
      await page
        .locator("#status")
        .filter({ hasText: "1 picture(s) added and saved" })
        .waitFor();
      const colorPdf = await download(page, "#pdf");
      assert.equal(
        (colorPdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length,
        4,
      );
      await page.locator("#cover-settings summary").click();
      await page
        .locator("#back-text")
        .fill("A cozy cloud world full of little adventures.");
      await page.locator("#save").click();
      await ready(page);
      const wrap = await download(page, "#cover");
      assert.equal(
        (wrap.toString("latin1").match(/\/Type \/Page\b/g) || []).length,
        1,
      );
      const zip = await download(page, "#zip");
      assert.ok(zip.includes(png));
      await page
        .locator("#import-zip")
        .setInputFiles({
          name: "wec.zip",
          mimeType: "application/zip",
          buffer: zip,
        });
      await page
        .locator("#status")
        .filter({ hasText: "Coloring ZIP imported" })
        .waitFor();
      assert.equal(await page.locator(".page img").count(), 1);
      await page.locator("[data-kind=art]").click();
      await ready(page);
      await page
        .locator("#outline")
        .fill("A floating island\nA moonlit garden");
      await page.locator("#plan-pages").click();
      await ready(page);
      assert.equal(await page.locator(".page").count(), 2);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: path.join(directory, `studio-${viewport.width}.png`),
        fullPage: true,
      });
      await page.locator("[data-kind=video]").click();
      await ready(page);
      await page
        .locator("#narration")
        .fill("A cloud found a little star. The star shone bright at home.");
      await page.locator("#scene-count").fill("2");
      await page.locator("#duration").fill("10");
      await page.locator("#split").click();
      await ready(page);
      await page
        .locator("#pictures")
        .setInputFiles([fixture, { ...fixture, name: "second.png" }]);
      await page
        .locator("#status")
        .filter({ hasText: "2 picture(s) added and saved" })
        .waitFor();
      await page.locator("#video").click();
      await page.waitForURL(/\?project=/);
      await page.locator("#preview .scene").first().waitFor();
      assert.equal(await page.locator(".scene-image").count(), 2);
      assert.equal(errors.length, 0, errors.join("\n"));
      await context.close();
    }
    // Provider failure makes one request and preserves the attached original.
    const c = await browser.newContext({ acceptDownloads: true });
    await c.addInitScript((t) => sessionStorage.setItem("wec_token", t), token);
    await c.route("**/api/generation", (r) =>
      r.fulfill({
        json: {
          ready: true,
          provider: "Fixture",
          model: "fixture",
          attempts_today: 0,
          daily_limit: 20,
        },
      }),
    );
    await c.route("**/api/creative/text", (r) =>
      r.fulfill({ json: { ready: true } }),
    );
    let calls = 0;
    await c.route("**/api/creative/image", (r) => {
      calls++;
      return r.fulfill({
        status: 502,
        json: { error: "Fixture provider failure" },
      });
    });
    const p = await c.newPage();
    p.on("dialog", (d) => d.accept());
    await p.goto(base + "/studio/");
    await p.locator("#status").filter({ hasText: "Choose a format" }).waitFor();
    await p.locator("[data-kind=art]").click();
    await ready(p);
    await p.locator("#pictures").setInputFiles(fixture);
    await p
      .locator("#status")
      .filter({ hasText: "1 picture(s) added and saved" })
      .waitFor();
    await p.locator("[data-generate]").click();
    await p
      .locator("#status")
      .filter({ hasText: "Fixture provider failure" })
      .waitFor();
    assert.equal(calls, 1);
    const preserved = JSON.parse((await download(p, "#backup")).toString());
    assert.equal(preserved.pages[0].asset.image_base64, png.toString("base64"));
    await p.locator("[data-kind=storybook]").click();
    await ready(p);
    await c.route("**/api/creative/draft", (r) =>
      r.fulfill({
        json: {
          title: "A cloud story",
          pages: [
            { text: "Pip found a star.", prompt: "Pip near a tiny star" },
            { text: "They went home.", prompt: "Pip carries the star home" },
          ],
        },
      }),
    );
    await p
      .locator("details")
      .filter({ has: p.locator("#idea") })
      .locator("summary")
      .click();
    await p.locator("#idea").fill("A cloud helps a star");
    await p.locator("#draft-count").fill("2");
    await p.locator("#draft").click();
    await p.locator("#status").filter({ hasText: "AI draft saved" }).waitFor();
    assert.equal(await p.locator(".page").count(), 2);
    await p
      .locator("details")
      .filter({ has: p.locator("#variant-kind") })
      .locator("summary")
      .click();
    await p.locator("#variant-kind").selectOption("coloring");
    await p.locator("#variant").click();
    await p
      .locator("#status")
      .filter({ hasText: "Created a separate Coloring book" })
      .waitFor();
    assert.equal(await p.locator(".page").count(), 2);
    assert.equal(await p.locator(".page img").count(), 0);
    await c.close();
    console.log(
      JSON.stringify({
        passed: true,
        viewports: [390, 1440],
        checks:
          "four formats, PDF/ZIP, original bytes, drafts, profiles, refresh, restore, conflict protection, video handoff, no-retry image failure",
        evidence: directory,
      }),
    );
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
