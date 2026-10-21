/* Real local HTTP + IndexedDB recovery. No generation, voice, movies or paid APIs. */
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const net = require('node:net'), assert = require('node:assert/strict');
(async () => {
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wec-recovery-'));
  const token = 'device-backup-browser-test-secret-32';
  const base = `http://127.0.0.1:${port}`;
  let server, browser, logs = '', sequence = 0;
  async function stop() {
    if (!server) return;
    server.kill(); await new Promise(r => server.exitCode !== null ? r() : server.once('exit', r));
  }
  async function freshServer() {
    await stop();
    server = spawn(process.env.PYTHON || 'python', ['-m', 'wec_engine.studio', '--port', String(port), '--data-dir', path.join(directory, String(sequence++))], {
      cwd: os.tmpdir(), env: {...process.env, WEC_STUDIO_TOKEN: token, WEC_ENABLE_IMAGE_GENERATION: '0', WEC_ENABLE_VIDEO_RENDER: '0'}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', chunk => { logs += chunk; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
      if (server.exitCode !== null || i === 99) throw Error('Server startup failed: ' + logs.slice(-2000));
      await new Promise(r => setTimeout(r, 100));
    }
  }
  const headers = {'X-WEC-Token': token, 'Content-Type': 'application/json'};
  async function serverBackup() { return (await fetch(base + '/api/backup', {headers})).json(); }
  async function record(page) {
    return page.evaluate(async () => WECDeviceBackups.read(await WECDeviceBackups.scope(location.origin, sessionStorage.getItem('wec_token'))));
  }
  async function idle(page) { await page.waitForFunction(() => !document.querySelector('#save-top').disabled); }
  async function downloadDevice(page) {
    const pending = page.waitForEvent('download'); await page.locator('#device-download').click();
    const download = await pending; await idle(page);
    return JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  }
  try {
    browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? {executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage']} : {})});
    for (const viewport of [{width: 390, height: 844}, {width: 1440, height: 1000}]) {
      await freshServer();
      const context = await browser.newContext({viewport, acceptDownloads: true});
      await context.addInitScript(value => sessionStorage.setItem('wec_token', value), token);
      const page = await context.newPage(), errors = [], requests = []; let accept = true;
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
      page.on('request', request => requests.push(request));
      await page.goto(base); await idle(page);
      await page.locator('#title').fill('Device lantern ' + viewport.width);
      await page.locator('#story').fill('A lantern helps a little fox.');
      await page.locator('#scenes').fill('1'); await page.locator('#duration').fill('5');
      await page.locator('#save-top').click(); await idle(page);
      await page.locator('#device-status').filter({hasText: 'Saved on this device:'}).waitFor();
      await page.locator('#plan').click(); await idle(page);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==', 'base64');
      await page.locator('#upload-scene-001').setInputFiles({name: 'fixture.png', mimeType: 'image/png', buffer: png});
      await page.locator('#message').filter({hasText: 'Image attached'}).waitFor(); await idle(page);
      const original = await serverBackup();
      assert.deepEqual((await record(page)).backup, original);
      assert.equal(JSON.stringify(await record(page)).includes(token), false);
      await page.reload(); await idle(page);
      assert.deepEqual((await record(page)).backup, original);
      // Scope boundaries and validation never reveal another backend/credential's copy.
      const boundaries = await page.evaluate(async () => {
        const a = await WECDeviceBackups.scope(location.origin, sessionStorage.getItem('wec_token'));
        const b = await WECDeviceBackups.scope(location.origin, 'different-studio-owner');
        const c = await WECDeviceBackups.scope('https://another-studio.example', sessionStorage.getItem('wec_token'));
        const existing = await WECDeviceBackups.read(a);
        const stale = await WECDeviceBackups.save(a, {schema_version: 2, projects: []}, 0);
        const older = structuredClone(existing.backup); older.projects[0].title = 'Stale response';
        const ignored = await WECDeviceBackups.save(a, older, 0);
        let rejected = false;
        try { await WECDeviceBackups.save(a, {schema_version: 99, projects: []}, Date.now()); } catch { rejected = true; }
        return {distinct: new Set([a, b, c]).size === 3, other: await WECDeviceBackups.read(b), rejected,
          unchanged: JSON.stringify(existing) === JSON.stringify(stale.record) && JSON.stringify(existing) === JSON.stringify(ignored.record)};
      });
      assert.deepEqual(boundaries, {distinct: true, other: null, rejected: true, unchanged: true});
      // Device downloads remain available when the API is unreachable.
      await page.route('**/api/**', route => route.abort());
      await page.reload(); await idle(page);
      assert.deepEqual(await downloadDevice(page), original);
      await page.unroute('**/api/**');
      // Restart on a fresh filesystem at the same origin, keeping this browser.
      await freshServer(); await page.reload(); await idle(page);
      assert.deepEqual((await record(page)).backup, original);
      await page.locator('#device-recover').waitFor({state: 'visible'});
      accept = false; await page.locator('#device-recover').click(); await idle(page);
      assert.equal((await serverBackup()).projects.length, 0);
      accept = true; await page.locator('#device-recover').click();
      await page.locator('#message').filter({hasText: 'Recovered 1 project(s)'}).waitFor(); await idle(page);
      const restored = await serverBackup();
      assert.equal(restored.projects.length, 1);
      assert.notEqual(restored.projects[0].id, original.projects[0].id);
      assert.equal(restored.projects[0].story, original.projects[0].story);
      assert.deepEqual(restored.projects[0].scene_images, original.projects[0].scene_images);
      assert.deepEqual((await record(page)).backup, restored);
      // Unsaved drafts do not masquerade as saved backups.
      await page.locator('#story').fill('UNSAVED draft should stay out of the backup.');
      assert.equal((await downloadDevice(page)).projects[0].story, original.projects[0].story);
      await page.reload(); await idle(page);
      // Simulate a second device creating work just before recovery is clicked.
      await freshServer(); await page.reload(); await idle(page);
      const newProject = await (await fetch(base + '/api/projects', {method: 'POST', headers, body: JSON.stringify({title: 'Another device', story: 'Different work.', scenes: 1, duration: 5})})).json();
      await page.locator('#device-recover').click(); await idle(page);
      assert.equal((await serverBackup()).projects.length, 1);
      assert.equal((await serverBackup()).projects[0].id, newProject.id);
      assert.deepEqual(await downloadDevice(page), restored);
      await page.locator('#device-replace').waitFor({state: 'visible'});
      accept = false; await page.locator('#device-replace').click(); await idle(page);
      assert.deepEqual((await record(page)).backup, restored);
      accept = true; await page.locator('#device-replace').click(); await idle(page);
      assert.equal((await record(page)).backup.projects[0].id, newProject.id);
      // Pausing removes content and survives reload without fetching a backup.
      await page.locator('#device-toggle').click(); await idle(page);
      assert.equal((await record(page)).paused, true); assert.equal((await record(page)).backup, undefined);
      const backupGets = () => requests.filter(r => new URL(r.url()).pathname === '/api/backup').length;
      const beforePausedReload = backupGets();
      await page.reload(); await idle(page); assert.equal(backupGets(), beforePausedReload);
      assert.equal(await page.locator('#device-download').isDisabled(), true);
      await page.locator('#device-toggle').click(); await idle(page);
      const beforeQuota = await record(page);
      // Storage failure must preserve the previous copy and the successful server save.
      await page.evaluate(() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Synthetic full storage', 'QuotaExceededError'); }; });
      await page.locator(`[data-project="${newProject.id}"]`).getByRole('button', {name: 'Open', exact: true}).click(); await idle(page);
      await page.locator('#title').fill('Saved despite full device storage');
      await page.locator('#save-top').click(); await idle(page);
      await page.locator('#device-status').filter({hasText: 'could not be updated'}).waitFor();
      assert.equal((await serverBackup()).projects[0].title, 'Saved despite full device storage');
      assert.deepEqual(await record(page), beforeQuota);
      assert.deepEqual(await downloadDevice(page), beforeQuota.backup);
      assert.ok((await page.locator('#device-status').innerText()).includes('could not be updated'));
      await page.reload(); await idle(page);
      assert.equal((await record(page)).backup.projects[0].title, 'Saved despite full device storage');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      for (const request of requests.filter(r => new URL(r.url()).pathname.startsWith('/api/'))) {
        assert.equal(new URL(request.url()).search, '');
        assert.equal(request.headers()['x-wec-token'], token);
        assert.equal(/\/generate$|\/video$/.test(new URL(request.url()).pathname) && request.method() === 'POST', false);
      }
      if (process.env.WEC_SCREENSHOT_DIR) await page.screenshot({path: path.join(process.env.WEC_SCREENSHOT_DIR, `recovery-${viewport.width}.png`), fullPage: true});
      console.log(`PASS device recovery ${viewport.width}: save/images/reload, scope separation, offline download, reset/cancel/recover, drafts excluded, conflict protection, pause/resume, quota failure, no AI calls`);
      await context.close();
    }
    const context = await browser.newContext();
    await context.addInitScript(value => {
      sessionStorage.setItem('wec_token', value);
      Object.defineProperty(window, 'indexedDB', {get() { throw new DOMException('Synthetic blocked storage', 'SecurityError'); }});
    }, token);
    const page = await context.newPage(); await page.goto(base); await idle(page);
    await page.locator('#title').fill('Storage unavailable'); await page.locator('#story').fill('Server saving still works.');
    await page.locator('#save-top').click(); await idle(page);
    assert.ok((await page.locator('#message').innerText()).includes('Project saved'));
    assert.ok((await page.locator('#device-status').innerText()).includes('could not be updated'));
    assert.equal(await page.locator('#device-toggle').isDisabled(), true);
    await context.close(); console.log('PASS unavailable device storage preserves server save workflow');
  } finally {
    if (browser) await browser.close(); await stop(); fs.rmSync(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
