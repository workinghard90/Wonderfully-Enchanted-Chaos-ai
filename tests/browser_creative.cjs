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
      const page = await context.newPage(),
        errors = [], fileRequests = [];
      page.on('request', r => { if (r.url().includes('/api/video-jobs/') && r.url().endsWith('/file')) fileRequests.push(r); });
      page.on("pageerror", (e) => errors.push(e.message));
      let accept = true;
      page.on("dialog", (d) => accept ? d.accept() : d.dismiss());
      await page.goto(base + "/");
      await page.locator('a[href="/video/"]').click();
      await page.locator('#story').waitFor();
      await page.getByRole('link', {name: 'All studios'}).click();
      await page.locator('a[href="/coloring/"]').click();
      await page.locator('#open-book').waitFor();
      await page.getByRole('link', {name: 'All studios'}).click();
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
      await page.locator('#reference-picture').setInputFiles(fixture);
      await ready(page);
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
      await page.locator('.page').first().getByLabel('Artwork review', {exact:true}).selectOption('approved'); await ready(page);
      await page.locator('.page').nth(1).getByLabel('Artwork review', {exact:true}).selectOption('needs_changes'); await ready(page);
      const backup = JSON.parse(
        (await download(page, "#backup")).toString("utf8"),
      );
      assert.equal(backup.reference.image_base64, png.toString('base64'));
      assert.equal(backup.backup_version, 2);
      const expectedHash = require('node:crypto').createHash('sha256').update(png).digest('hex');
      assert.equal(backup.reference.sha256, expectedHash);
      assert.equal(backup.pages[0].asset.sha256, expectedHash);
      assert.equal(backup.pages[0].review, 'approved');
      assert.equal(backup.pages[1].review, 'needs_changes');
      await page.locator('.page').first().locator('input[type=file]').setInputFiles(fixture);
      await page.locator('#status').filter({hasText:'Picture attached and saved'}).waitFor();
      assert.equal(await page.locator('.page').first().getByLabel('Artwork review', {exact:true}).inputValue(), 'unreviewed');
      await page.locator('.page').first().getByLabel('Artwork review', {exact:true}).selectOption('approved'); await ready(page);

      assert.equal(backup.pages.length, 2);
      await page.getByText('Compare with approved reference', {exact:true}).first().click();
      await page.locator('.character').first().screenshot({path:path.join(directory, `reference-${viewport.width}.png`)});
      assert.equal(backup.pages[0].asset.image_base64, png.toString("base64"));
      assert.match(backup.character, /lavender/);
      assert.equal(backup.pages[1].text, "Together they found their way home.");
      let bookRequests = 0;
      page.on('request', r => { if (r.url().endsWith('/api/creative/pdf')) bookRequests++; });
      await page.locator('#check-book').click(); await ready(page);
      assert.match(await page.locator('#book-review-issues').innerText(), /Exact duplicate artwork on pages 1, 2/);
      assert.match(await page.locator('#book-review-status').innerText(), /0 blocking/);
      assert.match(await page.locator('#book-review-issues').innerText(), /below the 300 PPI/);
      accept = false;
      await page.locator('#pdf').click(); await ready(page);
      assert.equal(bookRequests, 0);
      accept = true;
      const storyBox = page.locator('.page').first().getByLabel('Story text', {exact:true});
      const storyBefore = await storyBox.inputValue();
      await storyBox.fill('');
      await page.locator('#pdf').click(); await ready(page);
      assert.equal(bookRequests, 0);
      assert.match(await page.locator('#book-review-issues').innerText(), /Page 1: missing story text/);
      await storyBox.fill(storyBefore);
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
      assert.equal(await page.locator(".page img:not([alt=\"Approved reference for comparison\"])").count(), 2);
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
      const restoredReference = JSON.parse((await download(page, '#backup')).toString());
      assert.equal(restoredReference.pages[0].review, 'approved');
      assert.equal(restoredReference.pages[1].review, 'needs_changes');
      assert.equal(restoredReference.reference.image_base64, png.toString('base64'));
      const invalidReference = {...backup, reference:{name:'bad.png', image_base64:'not-an-image'}};
      await page.locator('#restore').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalidReference))});
      await ready(page);
      assert.match(await page.locator('#status').innerText(), /Invalid reference image/);
      assert.equal(await page.locator('#library .library-item').count(), 2);
      // Valid images with wrong/missing checksums cannot replace the open project.
      for (const target of ['page', 'reference', 'cover', 'missing', 'future']) {
        const broken = structuredClone(backup);
        const asset = {...broken.pages[0].asset, sha256:'0'.repeat(64)};
        if (target === 'page') broken.pages[0].asset = asset;
        else if (target === 'missing') delete broken.pages[0].asset.sha256;
        else if (target === 'future') broken.backup_version = 99;
        else broken[target] = asset;
        await page.locator('#restore').setInputFiles({name:'damaged.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(broken))});
        await ready(page);
        assert.match(await page.locator('#status').innerText(), target === 'future' ? /Unsupported backup version/ : /checksum does not match/);
        assert.equal(await page.locator('#library .library-item').count(), 2);
        assert.equal(JSON.parse((await download(page, '#backup')).toString()).id, restoredReference.id);
      }
      // Fail the device write after restore validation to test editor preservation.
      await page.evaluate(() => {
        window.originalTransaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
          if (mode === 'readwrite') throw new DOMException('Device storage full', 'QuotaExceededError');
          return window.originalTransaction.call(this, stores, mode, ...rest);
        };
      });
      await page.locator('#restore').setInputFiles({name:'quota.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
      await ready(page);
      assert.match(await page.locator('#status').innerText(), /Device storage full/);
      assert.equal(JSON.parse((await download(page, '#backup')).toString()).id, restoredReference.id);
      await page.evaluate(() => { IDBDatabase.prototype.transaction = window.originalTransaction; });
      assert.equal(await page.locator('#library .library-item').count(), 2);
      const legacyPage = await context.newPage();
      await legacyPage.goto(base + '/studio/');
      await legacyPage.locator('#status').filter({hasText:'Choose a format'}).waitFor();
      const legacy = structuredClone(backup);
      delete legacy.backup_version;
      for (const p of legacy.pages) if (p.asset) delete p.asset.sha256;
      delete legacy.reference.sha256;
      await legacyPage.locator('#restore').setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});
      await legacyPage.locator('#status').filter({hasText:'Older backup: no picture checksums'}).waitFor();
      await ready(legacyPage);
      const legacyRestored = JSON.parse((await download(legacyPage, '#backup')).toString());
      assert.equal(legacyRestored.pages[0].asset.image_base64, png.toString('base64'));
      // Remove this additional fixture so later library ordering stays unchanged.
      await legacyPage.evaluate(async id => {
        const {database} = await import('/studio/store.js');
        const db = await database();
        await new Promise((resolve,reject) => {
          const tx = db.transaction(['projects','summaries'],'readwrite');
          tx.objectStore('projects').delete(id); tx.objectStore('summaries').delete(id);
          tx.oncomplete = resolve; tx.onerror = reject;
        });
        db.close();
      }, legacyRestored.id);
      await legacyPage.close();
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
      await page.locator('.character').first().locator('summary').click();
      await page.locator('#profile').selectOption({label:'Pip'});
      await ready(page);
      const reused = JSON.parse((await download(page, '#backup')).toString());
      assert.equal(reused.reference.image_base64, png.toString('base64'));
      assert.equal(reused.character, backup.character);
      assert.equal(reused.style, backup.style);
      await page.locator('#remove-reference').click(); await ready(page);
      assert.equal(JSON.parse((await download(page, '#backup')).toString()).reference, null);
      const sourceReference = await page.evaluate(async id => {
        const store = await import('/studio/store.js');
        return (await store.get(id)).reference.blob.size;
      }, backup.id);
      assert.equal(sourceReference, png.length);

      assert.equal(
        await page.locator("#title").inputValue(),
        "Untitled coloring book",
      );
      await page.locator("#pictures").setInputFiles(fixture);
      await page
        .locator("#status")
        .filter({ hasText: "1 picture(s) added and saved" })
        .waitFor();
      // Reuse a saved storybook original in a coloring page, independently.
      const reuseButton = () => page.getByRole('button', {name:'Reuse saved artwork', exact:true}).first();
      await reuseButton().click();
      const picker = page.getByRole('dialog', {name:'Reuse saved artwork'});
      await picker.getByLabel('Saved source project').selectOption(backup.id);
      await picker.getByRole('button', {name:/Use page 1/}).waitFor();
      await picker.screenshot({path:path.join(directory, `artwork-picker-${viewport.width}.png`)});
      assert.equal(await picker.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await picker.getByRole('button', {name:'Cancel', exact:true}).click(); await ready(page);
      assert.equal(await picker.count(), 0);
      await reuseButton().click();
      await picker.getByLabel('Saved source project').selectOption(backup.id);
      accept = false;
      await picker.getByRole('button', {name:/Use page 1/}).click(); await ready(page);
      accept = true;
      assert.notEqual(JSON.parse((await download(page, '#backup')).toString()).pages[0].asset.source, 'Reused saved original');
      await reuseButton().click();
      await picker.getByLabel('Saved source project').selectOption(backup.id);
      await picker.getByRole('button', {name:/Use page 1/}).click();
      await page.locator('#status').filter({hasText:'Saved artwork copied'}).waitFor();
      const copied = JSON.parse((await download(page, '#backup')).toString());
      assert.equal(copied.pages[0].asset.image_base64, png.toString('base64'));
      assert.equal(copied.pages[0].asset.source, 'Reused saved original');
      assert.equal(copied.pages[0].review, 'unreviewed');
      const sourceAsset = await page.evaluate(async id => {
        const store = await import('/studio/store.js');
        return (await store.get(id)).pages[0].asset.source;
      }, backup.id);
      assert.equal(sourceAsset, backup.pages[0].asset.source);
      const extraSources = await page.evaluate(async () => {
        const store = await import('/studio/store.js');
        const emptyId = crypto.randomUUID(), badId = crypto.randomUUID();
        await store.save({id:emptyId, title:'Empty source', kind:'art', pages:[]});
        await store.save({id:badId, title:'Broken image source', kind:'art', pages:[{asset:{name:'broken.png', blob:new Blob(['bad image']), width:40, height:30}}]});
        return {emptyId, badId};
      });
      await reuseButton().click();
      await picker.getByLabel('Saved source project').selectOption(extraSources.emptyId);
      await picker.getByRole('status').filter({hasText:'no saved page pictures'}).waitFor();
      assert.equal(await picker.getByRole('button', {name:/Use page/}).count(), 0);
      await picker.getByLabel('Saved source project').selectOption(extraSources.badId);
      await picker.getByRole('button', {name:/Use page 1/}).click(); await ready(page);
      assert.match(await page.locator('#status').innerText(), /Choose a PNG, JPG or WebP/);
      assert.equal(JSON.parse((await download(page, '#backup')).toString()).pages[0].asset.image_base64, png.toString('base64'));
      await reuseButton().click();
      await picker.waitFor({state:'visible'});
      await page.keyboard.press('Escape'); await ready(page);
      assert.equal(await picker.count(), 0);
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
      assert.equal(await page.locator(".page img:not([alt=\"Approved reference for comparison\"])").count(), 1);
      await page.locator("[data-kind=art]").click();
      await ready(page);
      if (await page.locator('.character').first().getAttribute('open') === null)
        await page.locator('.character').first().locator('summary').click();
      await page.locator('#profile').selectOption({label:'Pip'}); await ready(page);
      assert.equal(JSON.parse((await download(page, '#backup')).toString()).reference.image_base64, png.toString('base64'));

      await page
        .locator("#outline")
        .fill("A floating island\nA moonlit garden");
      await page.locator("#plan-pages").click();
      await ready(page);
      await page.locator('#check-book').click(); await ready(page);
      assert.match(await page.locator('#book-review-status').innerText(), /2 blocking/);
      assert.match(await page.locator('#book-review-issues').innerText(), /Page 1: missing picture/);
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
      if (await page.locator('.character').first().getAttribute('open') === null)
        await page.locator('.character').first().locator('summary').click();
      await page.locator('#profile').selectOption({label:'Pip'}); await ready(page);
      assert.equal(JSON.parse((await download(page, '#backup')).toString()).reference.image_base64, png.toString('base64'));

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
      assert.equal(await page.locator('#video-workflow').isVisible(), true);
      assert.equal(await page.locator('#workflow-next').innerText(), 'Review and render video');
      await page.locator('.page').first().getByLabel('Artwork review', {exact:true}).selectOption('approved'); await ready(page);
      const beforeResplit = JSON.parse((await download(page, '#backup')).toString());
      await page.locator('#split').click(); await ready(page);
      const afterResplit = JSON.parse((await download(page, '#backup')).toString());
      assert.deepEqual(afterResplit.pages, beforeResplit.pages);
      await page.locator('#narration').fill('A cloud found a little star. The star danced in the sky.');
      assert.equal(await page.locator('#workflow-next').innerText(), 'Review and split narration');
      await page.locator('#split').click(); await ready(page);
      const revisedScenes = JSON.parse((await download(page, '#backup')).toString());
      assert.equal(revisedScenes.pages[0].asset.image_base64, png.toString('base64'));
      assert.equal(revisedScenes.pages[1].asset, null);
      assert.equal(revisedScenes.pages[0].review, 'approved');
      assert.equal(revisedScenes.pages[1].review, 'unreviewed');
      assert.equal(await page.locator('#workflow-next').innerText(), 'Add picture for scene 2');
      await page.locator('#workflow-next').click();
      assert.equal(await page.locator('.page').nth(1).evaluate(el => el === document.activeElement), true);
      await page.locator('#narration').fill(beforeResplit.narration);
      await page.locator('#split').click(); await ready(page);
      await page.locator('.page').nth(1).locator('input[type=file]').setInputFiles(fixture);
      await ready(page);
      await page.locator('#status').filter({hasText:'Picture attached and saved'}).waitFor();
      // Later narration/count edits must never hand off older scenes or erase art.
      let handoffs = 0;
      page.on("request", (request) => {
        if (request.url() === base + "/api/creative/video") handoffs++;
      });
      const originalNarration = await page.locator("#narration").inputValue();
      await page.locator("#narration").fill("A newly edited script.");
      await page.locator("#video").click();
      await ready(page);
      assert.match(await page.locator("#status").innerText(), /Use Split narration/);
      assert.equal(handoffs, 0);
      assert.equal(await page.locator(".page img:not([alt=\"Approved reference for comparison\"])").count(), 2);
      await page.locator("#narration").fill(originalNarration);
      await page.locator("#scene-count").fill("3");
      await page.locator("#video").click();
      await ready(page);
      assert.match(await page.locator("#status").innerText(), /Use Split narration/);
      assert.equal(handoffs, 0);
      await page.locator("#narration").fill("word ".repeat(101));
      await page.locator("#split").click();
      await ready(page);
      assert.match(await page.locator("#status").innerText(), /100 words/);
      assert.equal(await page.locator(".page img:not([alt=\"Approved reference for comparison\"])").count(), 2);
      await page.locator("#narration").fill(originalNarration);
      await page.locator("#scene-count").fill("2");
      // Admission failures must not create server copies or consume attempts.
      for (const [state, message] of [
        [{ready:false, message:'Owner setup required', jobs:[]}, /Owner setup required/],
        [{ready:true, jobs:[{id:'busy', title:'Other render', status:'running', progress:10, message:'Working'}]}, /already rendering/],
        [{ready:true, jobs:[], attempts_today:2, daily_limit:2}, /render limit/],
        [{ready:true, jobs:[{id:'full', title:'Old movie', status:'failed', message:'Failed'}], max_saved_videos:1}, /storage is full/],
      ]) {
        await page.route('**/api/video', r => r.fulfill({json:state}));
        await page.locator('#video').click(); await ready(page);
        assert.match(await page.locator('#status').innerText(), message);
        assert.equal(handoffs, 0);
        await page.unroute('**/api/video');
      }
      accept = false;
      await page.locator("#video").click();
      await ready(page);
      assert.equal(handoffs, 0);
      accept = true;
      let failedStarts = 0;
      await page.route('**/api/projects/*/video', r => {
        failedStarts++; return r.fulfill({status:503, json:{error:'Worker unavailable'}});
      });
      await page.locator('#video').click(); await ready(page);
      assert.match(await page.locator('#status').innerText(), /Refresh renders before trying again/);
      assert.equal(failedStarts, 1);
      await page.unroute('**/api/projects/*/video');
      await page.locator("#video").click();
      await ready(page);
      assert.equal(new URL(page.url()).pathname, "/");
      assert.equal(handoffs, 2);
      const job = page.locator('.render-job');
      await job.getByRole('button', {name: 'Play video'}).waitFor();
      await job.getByRole('button', {name: 'Play video'}).click();
      await page.waitForFunction(() => document.querySelector('#render-movie').readyState >= 1);
      assert.ok((await page.locator('#render-movie').getAttribute('src')).startsWith('blob:'));
      assert.equal(await page.locator('#render-movie').getAttribute('playsinline'), '');
      await page.locator('#renders').screenshot({path:path.join(directory, `renders-${viewport.width}.png`)});
      const movieDownload = page.waitForEvent('download');
      await job.getByRole('button', {name: 'Download MP4'}).click();
      const movie = await movieDownload;
      assert.ok(fs.statSync(await movie.path()).size > 1000);
      await page.reload();
      await page.locator('#refresh-renders').click();
      await job.getByRole('button', {name: 'Play video'}).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await job.getByRole('button', {name: 'Remove server copy'}).click();
      await page.waitForFunction(() => !document.querySelector('.render-job'));
      for (const request of fileRequests) {
        assert.equal(new URL(request.url()).search, '');
        assert.equal(request.headers()['x-wec-token'], token);
      }
      assert.equal(errors.length, 0, errors.join("\n"));
      await context.close();
    }
    const queueContext = await browser.newContext();
    await queueContext.addInitScript(t => sessionStorage.setItem('wec_token', t), token);
    let queueState = 'running', cancels = 0, polling = 0, dialogs = 0;
    await queueContext.route('**/api/video', r => {
      polling++;
      if (queueState === 'offline') return r.fulfill({status:401, json:{error:'Session expired'}});
      return r.fulfill({json:{ready:true, attempts_today:1, daily_limit:2, jobs:[{id:'fixture-job', title:'Queued movie', status:queueState, message:queueState, progress:30}]}});
    });
    await queueContext.route('**/api/video-jobs/fixture-job/cancel', r => {
      cancels++; queueState = 'cancelled'; return r.fulfill({json:{}});
    });
    const queuePage = await queueContext.newPage();
    queuePage.on('dialog', d => {dialogs++; d.dismiss();});
    await queuePage.goto(base);
    await queuePage.locator('#refresh-renders').click();
    await queuePage.getByRole('button', {name:'Cancel render', exact:true}).click();
    await queuePage.locator('.render-job').getByText('cancelled', {exact:true}).waitFor();
    assert.equal(cancels, 1);
    queueState = 'running';
    await queuePage.locator('#refresh-renders').click();
    await queuePage.locator('progress').waitFor();
    queueState = 'offline';
    await queuePage.locator('#render-availability').filter({hasText:'Use Refresh renders to reconnect'}).waitFor();
    const stoppedAt = polling;
    await queuePage.waitForTimeout(2800);
    assert.equal(polling, stoppedAt);
    assert.equal(dialogs, 0);
    await queueContext.close();
    // Provider failure makes one request and preserves the attached original.
    const c = await browser.newContext({ acceptDownloads: true });
    await c.addInitScript((t) => sessionStorage.setItem("wec_token", t), token);
    await c.route("**/api/generation", (r) =>
      r.fulfill({
        json: {
          ready: true,
          reference_ready: true,
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
    let calls = 0, sent = [];
    await c.route("**/api/creative/image", (r) => {
      calls++;
      sent.push(r.request().postDataJSON());
      return r.fulfill({
        status: 502,
        json: { error: "Fixture provider failure" },
      });
    });
    const p = await c.newPage();
    let acceptGeneration = true;
    p.on("dialog", (d) => acceptGeneration ? d.accept() : d.dismiss());
    await p.goto(base + "/studio/");
    await p.locator("#status").filter({ hasText: "Choose a format" }).waitFor();
    await p.locator("[data-kind=art]").click();
    await ready(p);
    await p.locator("#pictures").setInputFiles(fixture);
    await p
      .locator("#status")
      .filter({ hasText: "1 picture(s) added and saved" })
      .waitFor();
    assert.equal(await p.locator('[data-reference-generate]').isDisabled(), true);
    await p.getByRole('button', {name:'Use as approved reference',exact:true}).click();
    await ready(p);
    await p.locator("[data-generate]").click();
    await p
      .locator("#status")
      .filter({ hasText: "Fixture provider failure" })
      .waitFor();
    assert.equal(calls, 1);
    const preserved = JSON.parse((await download(p, "#backup")).toString());
    assert.equal(preserved.pages[0].asset.image_base64, png.toString("base64"));
    assert.equal(preserved.reference.image_base64, png.toString("base64"));
    assert.equal(sent[0].mode, 'text');
    assert.equal(sent[0].reference_image_base64, undefined);
    acceptGeneration = false;
    await p.locator('[data-reference-generate]').click(); await ready(p);
    assert.equal(calls, 1);
    acceptGeneration = true;
    await p.locator('[data-reference-generate]').click(); await ready(p);
    assert.equal(calls, 2);
    assert.equal(sent[1].mode, 'reference');
    assert.equal(sent[1].reference_image_base64, png.toString('base64'));
    assert.match(sent[1].prompt, /character in image 0/);
    const afterFailure = JSON.parse((await download(p, '#backup')).toString());
    assert.equal(afterFailure.pages[0].asset.image_base64, png.toString('base64'));
    assert.equal(afterFailure.reference.image_base64, png.toString('base64'));
    await c.unroute('**/api/creative/image');
    await c.route('**/api/creative/image', r => {
      calls++; return r.fulfill({contentType:'image/png', body:png});
    });
    await p.locator('[data-reference-generate]').click(); await ready(p);
    assert.equal(calls, 3);
    const generated = JSON.parse((await download(p, '#backup')).toString());
    assert.match(generated.pages[0].asset.source, /reference-guided/);
    assert.equal(generated.reference.image_base64, png.toString('base64'));

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
    await p.locator('.character').first().locator('summary').click();
    await p.locator('#reference-picture').setInputFiles(fixture); await ready(p);
    await p.locator("#variant-kind").selectOption("coloring");
    await p.locator("#variant").click();
    await p
      .locator("#status")
      .filter({ hasText: "Created a separate Coloring book" })
      .waitFor();
    assert.equal(await p.locator(".page").count(), 2);
    assert.equal(await p.locator(".page img:not([alt=\"Approved reference for comparison\"])").count(), 0);
    assert.equal(JSON.parse((await download(p, '#backup')).toString()).reference.image_base64, png.toString('base64'));
    await c.close();
    console.log(
      JSON.stringify({
        passed: true,
        viewports: [390, 1440],
        checks:
          "saved-artwork picker: original copies, source isolation, cancel/Escape, rejected replacement, empty/corrupt sources, phone layout; four formats, PDF/ZIP, original bytes, drafts, profiles with original references across four formats, reference backup/restore/isolation/variants, refresh, restore, conflict protection, inline render consent/progress/playback/MP4/reload/removal, no-retry image failure",
        evidence: directory,
      }),
    );
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await new Promise((r) => server.exitCode !== null ? r() : server.once("exit", r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
