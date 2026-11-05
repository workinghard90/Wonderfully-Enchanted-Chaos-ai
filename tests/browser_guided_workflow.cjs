const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const {mkdtempSync, readFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
(async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const server = spawn(process.env.PYTHON || 'python',
    ['-m', 'wec_engine.studio', '--port', String(port), '--data-dir', mkdtempSync(join(tmpdir(), 'wec-workflow-'))],
    {env: {...process.env, WEC_STUDIO_TOKEN:'test-only-workflow-token-32-characters'}, stdio:'ignore'});
  let browser;
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i=0; i<100; i++) {
      try {if ((await fetch(base+'/api/health')).ok) break;} catch {}
      if (i===99 || server.exitCode!==null) throw Error('Studio did not start');
      await new Promise(r=>setTimeout(r,100));
    }
    browser = await chromium.launch({headless:true});
    for (const width of [390,1440]) {
      const context = await browser.newContext({viewport:{width,height:1000}});
      const page = await context.newPage();
      const errors=[];
      page.on('pageerror', e=>errors.push(e.message));
      await page.goto(base);
      await page.locator('[data-kind=art]').click();
      await page.locator('#title').fill('Workflow regression');
      const tabs=page.locator('.workflow-tab');
      assert.equal(await tabs.count(),5);
      const screens = page.locator('#editor > .workflow-screen');
      assert.equal(await screens.count(),5);
      assert.equal(await screens.filter({visible:true}).count(),1);
      assert.equal(await page.locator('#workflow-screen-1 #title').count(),1);
      assert.equal(await page.locator('#workflow-screen-2 #outline').count(),1);
      assert.equal(await page.locator('#workflow-screen-3 #pages').count(),1);
      assert.equal(await page.locator('#workflow-screen-4 #book-review').count(),1);
      assert.equal(await page.locator('#workflow-screen-5 #cozy-export').count(),1);
      assert.ok(await page.locator('#editor').evaluate(el => el.getBoundingClientRect().width > 0));
      assert.equal(await page.locator('#title').isVisible(),true);
      // Plan-only work must remain usable without visiting Create/Review/Export.
      await tabs.nth(1).click();
      const outline = 'Independent story idea\nSecond scene to consider';
      await page.locator('#outline').fill(outline);
      const [textFile] = await Promise.all([
        page.waitForEvent('download'), page.locator('#download-plan').click()
      ]);
      assert.equal(readFileSync(await textFile.path(),'utf8'),outline+'\n');
      await page.waitForFunction(() => !document.querySelector('#save').disabled);
      await page.reload();
      await page.locator('#library button').first().click();
      await tabs.nth(4).click();
      const [exportText] = await Promise.all([
        page.waitForEvent('download'), page.locator('#export-plan').click()
      ]);
      assert.equal(readFileSync(await exportText.path(),'utf8'),outline+'\n');
      assert.equal(await page.locator('#outline').inputValue(),outline);
      assert.equal(await page.locator('.page').count(),0);
      const [backupFile] = await Promise.all([
        page.waitForEvent('download'), page.locator('#backup').click()
      ]);
      const backupPath = await backupFile.path();
      const backup = JSON.parse(readFileSync(backupPath,'utf8'));
      assert.equal(backup.planDraft,outline);
      assert.equal(backup.pages.length,0);
      await page.locator('#restore').setInputFiles(backupPath);
      await page.locator('#status').filter({hasText:'Backup restored'}).waitFor();
      await tabs.nth(1).click();
      assert.equal(await page.locator('#outline').inputValue(),outline);
      await page.evaluate(() => {
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(stores, mode, ...options) {
          if (mode === 'readwrite') {
            IDBDatabase.prototype.transaction = transaction;
            throw new DOMException('Device storage full','QuotaExceededError');
          }
          return transaction.call(this, stores, mode, ...options);
        };
      });
      await page.locator('#plan-pages').click();
      await page.locator('#status').filter({hasText:'Device storage full'}).waitFor();
      assert.equal(await page.locator('#outline').inputValue(),outline);
      await page.locator('#plan-pages').click();
      await page.locator('#status').filter({hasText:'Pages created'}).waitFor();
      await tabs.nth(2).click();
      assert.deepEqual(await page.getByLabel('Scene / image prompt').evaluateAll(
        inputs => inputs.map(input => input.value)),outline.split('\n'));
      // Start a separate artwork project and go directly to Create.
      await page.locator('[data-kind=art]').click();
      await tabs.nth(2).click();
      await page.getByRole('button',{name:'Add artwork',exact:true}).click();
      await page.locator('.page input[type=file]').waitFor();
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==','base64');
      await page.locator('.page input[type=file]').setInputFiles({name:'original.png',mimeType:'image/png',buffer:png});
      const original = page.getByRole('link',{name:'Download original image'});
      await original.waitFor();
      await page.getByLabel('Scene / image prompt').fill('Evening clouds');
      await page.locator('#save').click();
      await page.locator('#status').filter({hasText:'Project saved on this device'}).waitFor();
      await page.reload();
      await page.locator('#library button').first().click();
      await tabs.nth(2).click();
      assert.equal(await page.getByLabel('Scene / image prompt').inputValue(),'Evening clouds');
      assert.equal(await page.locator('.page').getByLabel('Artwork review').inputValue(),'unreviewed');
      await page.locator('#add').click();
      const [artFile] = await Promise.all([page.waitForEvent('download'),original.click()]);
      assert.equal(artFile.suggestedFilename(),'artwork-1.png');
      assert.deepEqual(readFileSync(await artFile.path()),png);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await tabs.nth(0).click();
      await page.reload();
      await page.locator('#library button').first().click();
      await tabs.nth(4).click();
      await page.locator('#export-originals summary').click();
      const images = page.locator('#export-image-list a');
      assert.equal(await images.count(),1);
      const [standalone] = await Promise.all([page.waitForEvent('download'),images.first().click()]);
      assert.equal(standalone.suggestedFilename(),'artwork-1.png');
      assert.deepEqual(readFileSync(await standalone.path()),png);
      await page.locator('#zip').click();
      await page.locator('#status').filter({hasText:'Every page needs a picture'}).waitFor();
      await page.locator('#pdf').click();
      await page.locator('#export-error').filter({hasText:'Page 2: missing picture'}).waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      // A failed PDF check selects print review so the creator can inspect the findings.
      await tabs.nth(3).click();
      await page.getByLabel('Review output').selectOption('art');
      // Each workspace is directly accessible, regardless of which stages were used.
      for (const tab of await tabs.all()) assert.equal(await tab.isEnabled(), true);
      await tabs.nth(4).click();
      assert.equal(await page.locator('#cozy-export').isVisible(), true);
      assert.equal(await screens.filter({visible:true}).count(),1);
      await tabs.nth(1).click();
      assert.equal(await page.locator('#book-planner').isVisible(),true);
      assert.equal(await page.locator('#title').isVisible(),false);
      const continueButton = page.locator('.workflow-footer button').last();
      assert.equal(await continueButton.innerText(),'Continue to Create');
      await continueButton.click();
      assert.equal(await tabs.nth(2).getAttribute('aria-current'),'step');
      assert.equal(await page.locator('#workflow-screen-3').isVisible(),true);
      await page.locator('#add').click();
      await page.waitForFunction(() => !document.querySelector('#save').disabled);
      assert.equal(await page.locator('.page').count(),3);
      assert.equal(await page.locator('#pages').isVisible(),true);
      assert.equal(await page.locator('#save').isVisible(),true);
      await continueButton.click();
      assert.equal(await page.locator('#book-review').isVisible(),false);
      assert.equal(await page.locator('#cover-settings').isVisible(),false);
      assert.equal(await page.locator('#asset-review img').count(),1);
      await page.getByLabel('Artwork 1 approval').selectOption('approved');
      await page.locator('#readiness').filter({hasText:'1 of 1 attached pictures approved'}).waitFor();
      assert.equal(await page.locator('#asset-review-list li').count(),3);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.reload();
      await page.locator('#library button').first().click();
      await tabs.nth(3).click();
      assert.equal(await page.getByLabel('Artwork 1 approval').inputValue(),'approved');
      await page.getByLabel('Review output').selectOption('print');
      await page.locator('#check-book').click();
      await page.getByRole('button',{name:'Go to page 2'}).click();
      assert.equal(await tabs.nth(2).getAttribute('aria-current'),'step');
      assert.equal(await page.locator('.page').nth(1).evaluate(el=>el===document.activeElement),true);
      await tabs.nth(3).click();
      assert.equal(await tabs.nth(4).isEnabled(),true);
      await continueButton.click();
      assert.equal(await page.locator('#cozy-export').isVisible(),true);
      assert.equal(await screens.filter({visible:true}).count(),1);
      assert.equal(await page.locator('#editor').evaluate(el => el.getBoundingClientRect().width > innerWidth*.8),true);
      await tabs.nth(0).click();
      assert.equal(await page.locator('#title').inputValue(),(await page.locator('#library strong').first().innerText()));
      await tabs.nth(4).click();
      await page.locator('[data-kind=coloring]').click();
      assert.equal(await tabs.nth(0).getAttribute('aria-current'),'step');
      assert.equal(await tabs.nth(1).isEnabled(),true);
      assert.equal(await page.locator('#title').isVisible(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await tabs.nth(3).click();
      assert.equal(await page.locator('#book-review').isVisible(),true);
      assert.equal(await page.locator('#asset-review').isVisible(),false);
      await page.locator('[data-kind=video]').click();
      await tabs.nth(3).click();
      assert.match(await page.locator('#readiness').innerText(), /Add narration/);
      assert.equal(await page.locator('#cover-settings').isVisible(),false);
      assert.equal(await page.locator('#book-review').isVisible(),false);
      assert.equal(await page.locator('#asset-review-heading').innerText(),'Scene review');
      await tabs.nth(4).click();
      for (const id of ['pdf','cozy-export','export-plan']) assert.equal(await page.locator('#'+id).isVisible(),false);
      assert.equal(await page.locator('#video').isVisible(),true);
      assert.equal(await page.locator('#export-image-list a').count(),0);
      assert.deepEqual(errors,[]);
      await context.close();
      console.log(`PASS guided workflow ${width}px`);
    }
  } finally {
    if(browser) await browser.close();
    server.kill();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
