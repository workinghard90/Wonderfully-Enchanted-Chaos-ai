/* Real auth and browser persistence; provider/network fixtures never call AI. */
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
(async () => {
  const listener = net.createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wec-ai-connection-'));
  const token = 'test-only-ai-connection-token-32-characters';
  const server = spawn(process.env.PYTHON || 'python', ['-m','wec_engine.studio','--port',String(port),'--data-dir',directory], {
    cwd: os.tmpdir(), env: {...process.env, WEC_STUDIO_TOKEN:token, WEC_ENABLE_IMAGE_GENERATION:'0', WEC_ENABLE_TEXT_GENERATION:'0'}, stdio:['ignore','pipe','pipe']});
  const base = `http://127.0.0.1:${port}`;
  let browser, logs = '';
  server.stderr.on('data', x => logs += x);
  const ready = p => p.waitForFunction(() => !document.querySelector('#check-ai').disabled);
  try {
    for (let i=0;i<100;i++) {
      try { if ((await fetch(base+'/api/health')).ok) break; } catch {}
      if (server.exitCode !== null || i === 99) throw Error(logs || 'Server startup failed');
      await new Promise(r => setTimeout(r,100));
    }
    browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']} : {})});
    for (const width of [390,1440]) {
      const context = await browser.newContext({viewport:{width,height:1000}});
      const p = await context.newPage();
      let answer = null, dialogs = 0, calls = 0, used = 0;
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      p.on('dialog', d => { dialogs++; return d.type() === 'prompt' ? (answer === null ? d.dismiss() : d.accept(answer)) : d.accept(); });
      await p.goto(base); await ready(p);
      assert.equal(dialogs,0);
      assert.match(await p.locator('#ai-connection-status').innerText(), /not signed in/);
      await p.locator('[data-kind=art]').click(); await ready(p);
      await p.locator('#add').click(); await ready(p);
      assert.equal(await p.locator('.page').count(),1);
      assert.equal(await p.locator('[data-generate]').isDisabled(),true);
      await p.locator('#check-ai').click(); await ready(p);
      assert.equal(dialogs,1);
      assert.match(await p.locator('#ai-connection-status').innerText(), /cancelled/);
      answer = '   ';
      await p.locator('#check-ai').click(); await ready(p);
      assert.match(await p.locator('#ai-connection-status').innerText(), /not completed/);
      assert.equal(await p.evaluate(()=>sessionStorage.getItem('wec_token')),null);
      answer = 'wrong';
      await p.locator('#check-ai').click(); await ready(p);
      assert.match(await p.locator('#ai-connection-status').innerText(), /sign-in was not accepted/);
      assert.equal(await p.evaluate(()=>sessionStorage.getItem('wec_token')),null);
      // A stale tab must explain the rejected sign-in without a startup prompt.
      await p.evaluate(()=>sessionStorage.setItem('wec_token','old-tab-token'));
      const beforeReload=dialogs;
      await p.reload(); await ready(p);
      assert.equal(dialogs,beforeReload);
      assert.match(await p.locator('#ai-connection-status').innerText(), /sign-in was not accepted/);
      assert.equal(await p.evaluate(()=>sessionStorage.getItem('wec_token')),null);
      await p.locator('#library .library-item button').first().click(); await ready(p);
      answer = '  '+token+'  ';
      await p.locator('#check-ai').click(); await ready(p);
      assert.match(await p.locator('#ai-connection-status').innerText(), /WEC_ENABLE_IMAGE_GENERATION/);
      assert.equal(await p.evaluate(()=>sessionStorage.getItem('wec_token')),token);
      assert.equal(await p.locator('.page').count(),1);
      await p.route('**/api/generation', r => r.fulfill({json:{ready:true,creative_ready:true,reference_ready:true,attempts_today:used,daily_limit:20,message:'Fixture configured'}}));
      await p.locator('#check-ai').click(); await ready(p);
      assert.equal(await p.locator('[data-generate]').isDisabled(),false);
      // Prompt previews must reflect character/style edits made after page creation.
      await p.locator('.character').first().locator('summary').click();
      await p.locator('#character').fill('A lavender cloud with a curl');
      await p.locator('#style').fill('Watercolor');
      assert.match(await p.locator('.prompt-preview').first().textContent(), /lavender cloud/);
      assert.match(await p.locator('.prompt-preview').nth(1).textContent(), /Watercolor/);
      await p.route('**/api/creative/image', r => {calls++; return r.abort('failed');});
      await p.locator('[data-generate]').click(); await ready(p);
      assert.equal(calls,1);
      assert.match(await p.locator('#status').innerText(), /Cannot reach/);
      const box = await p.locator('#status').boundingBox();
      assert.ok(box.y >= 0 && box.y < 1000, 'Error stays visible on mobile');
      assert.equal(await p.locator('#save').isDisabled(), false);
      await p.locator('[data-generate]').click(); await ready(p);
      assert.equal(calls,1, 'An unresolved receipt blocks another billable request');
      await p.getByRole('button', {name:'Dismiss generation receipt',exact:true}).click(); await ready(p);
      // A stalled server must release UI controls without replaying a paid request.
      await p.unroute('**/api/creative/image');
      await p.clock.install();
      await p.route('**/api/creative/image', () => {calls++;});
      const sent = p.waitForRequest('**/api/creative/image');
      await p.locator('[data-generate]').click(); await sent;
      assert.equal(await p.locator('.page textarea').first().isDisabled(),true, 'Rebuilt fields stay locked during generation');
      await p.clock.fastForward(90001); await ready(p);
      assert.equal(calls,2);
      assert.match(await p.locator('#status').innerText(), /90 seconds/);
      used = 20;
      await p.locator('#check-ai').click(); await ready(p);
      assert.equal(await p.locator('[data-generate]').isDisabled(),true);
      assert.match(await p.locator('#ai-connection-status').innerText(), /Daily limit reached/);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      assert.deepEqual(errors,[]);
      await p.screenshot({path:path.join(directory,`connection-${width}.png`),fullPage:true});
      console.log(`PASS AI connection ${width}: local save without auth, cancellation, wrong token, reconnect, setup reason, prompt preview, network error, bounded timeout, quota guard`);
      await context.close();
    }
    console.log('Evidence: '+directory);
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(r => server.exitCode !== null ? r() : server.once('exit',r));
  }
})().catch(e => {console.error(e);process.exitCode=1;});
