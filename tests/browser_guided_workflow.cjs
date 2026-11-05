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
    for (const width of [320,390,1440]) {
      const context = await browser.newContext({viewport:{width,height:width===320?680:1000}});
      const page = await context.newPage();
      const errors=[];
      page.on('pageerror', e=>errors.push(e.message));
      await page.goto(base);
      const moduleResponse = await page.request.get(base + '/studio/automation.js');
      assert.equal(moduleResponse.status(),200,'Automation JS must be served by the WEC backend');
      assert.match(moduleResponse.headers()['content-type'],/javascript/);
      const productionModule = await page.request.get(base + '/studio/production.js');
      assert.equal(productionModule.status(),200,'Production JS must be served by WEC');
      assert.match(productionModule.headers()['content-type'],/javascript/);
      await page.locator('[data-kind=art]').click();
      const longTitle = 'W'.repeat(150);
      await page.locator('#title').fill(longTitle);
      assert.equal(await page.locator('#editor-heading').innerText(),longTitle);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('#save').click();
      // #status is a transient, shared announcement: another asynchronous
      // message can replace the save notice before a CI runner reads it.
      // Verify the durable saved state and the library entry instead.
      try {
        await page.waitForFunction(expected => {
          const save = document.querySelector('#save');
          const saved = document.querySelector('#save-status')?.textContent || '';
          const titles = [...document.querySelectorAll('#library strong')].map(n => n.textContent);
          return !save.disabled && saved.startsWith('Saved ') && titles.includes(expected);
        }, longTitle, {timeout:15000});
      } catch (error) {
        const evidence = await page.evaluate(() => ({
          status:document.querySelector('#status')?.textContent,
          saveStatus:document.querySelector('#save-status')?.textContent,
          saveDisabled:document.querySelector('#save')?.disabled,
          library:[...document.querySelectorAll('#library strong')].map(n=>n.textContent),
        }));
        throw new Error('Initial project persistence was not verified: '+JSON.stringify(evidence),{cause:error});
      }
      // Changing the non-durable notice cannot erase saved project evidence.
      await page.locator('#status').evaluate(node => {node.textContent = 'Background status refreshed.';});
      assert.match(await page.locator('#save-status').innerText(),/^Saved /);
      assert.equal(await page.locator('.workflow-footer button').first().isDisabled(),true);
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
      assert.equal(await page.locator('#workflow-screen-5 #production-workbench').count(),1);
      assert.ok(await page.locator('#editor').evaluate(el => el.getBoundingClientRect().width > 0));
      assert.equal(await page.locator('#title').isVisible(),true);
      // Manual automation recipes preview navigation only. No pages or AI requests.
      await tabs.nth(1).click();
      assert.equal(await page.locator('#automation-recipes').isVisible(),true);
      let automationCalls = 0;
      await page.route('**/api/creative/image', route => {automationCalls++; return route.abort();});
      await page.locator('#automation-recipe').selectOption('artwork');
      await page.locator('#automation-preview-button').click();
      assert.match(await page.locator('#automation-status').innerText(),/Each action remains your choice/);
      assert.equal(await page.locator('#automation-preview li').count(),3);
      await page.getByRole('button',{name:'Check recipe inputs'}).click();
      assert.match(await page.getByRole('status',{name:'Recipe input check'}).innerText(),/No artwork slots/);
      assert.equal(await page.locator('.page').count(),0);
      // Phase 6: optional guided sequence, with no implicit work.
      await page.getByRole('button',{name:'Start guided run'}).click();
      const guided = page.locator('#automation-guided');
      await guided.getByRole('status').filter({hasText:'0 of 3 steps reviewed'}).waitFor();
      assert.match(await guided.innerText(),/Create — current/);
      await guided.getByRole('button',{name:'Mark step reviewed'}).click();
      assert.match(await guided.getByRole('status').innerText(),/1 of 3 steps reviewed/);
      assert.match(await guided.innerText(),/not output approved/);
      await guided.getByRole('button',{name:'Next guided step'}).click();
      assert.match(await guided.getByRole('status').innerText(),/Step 2: Review/);
      await guided.getByRole('button',{name:'Pause guided run'}).click();
      assert.match(await guided.getByRole('status').innerText(),/Paused/);
      assert.equal(await guided.getByRole('button',{name:'Next guided step'}).isDisabled(),true);
      assert.equal(await guided.getByRole('button',{name:'Open current workspace'}).isDisabled(),true);
      await guided.getByRole('button',{name:'Resume guided run'}).click();
      await guided.getByRole('button',{name:'Check inputs for current step'}).click();
      assert.match(await page.locator('#automation-status').innerText(),/No artwork slots/);
      await guided.getByRole('button',{name:'Open current workspace'}).click();
      assert.equal(await tabs.nth(3).getAttribute('aria-current'),'step');
      await tabs.nth(1).click();
      await guided.getByRole('button',{name:'Previous guided step'}).click();
      assert.match(await guided.getByRole('status').innerText(),/Step 1: Create/);
      page.once('dialog', dialog => dialog.dismiss());
      await page.getByRole('button',{name:'Start guided run'}).click();
      assert.match(await guided.getByRole('status').innerText(),/1 of 3 steps reviewed/);
      await guided.getByRole('button',{name:'End guided run'}).click();
      assert.match(await guided.innerText(),/No guided run active/);
      assert.equal(await page.locator('.page').count(),0);
      assert.equal(automationCalls,0);
      // Phase 7: prepare a production manifest without initiating any export.
      await tabs.nth(4).click();
      await page.locator('#production-target').selectOption('artwork');
      await page.locator('#production-prepare').click();
      assert.match(await page.locator('#production-summary').innerText(),/0 ordered page/);
      assert.match(await page.locator('#production-issues').innerText(),/Create at least one page/);
      const [preparation] = await Promise.all([
        page.waitForEvent('download'),page.locator('#production-download').click()
      ]);
      assert.equal(preparation.suggestedFilename(),'wec-production-preparation.json');
      const report = JSON.parse(readFileSync(await preparation.path(),'utf8'));
      assert.equal(report.schema_version,1);
      assert.equal(report.project_format,'Art collection');
      assert.equal(report.selected_output,'artwork');
      assert.deepEqual(report.inventory,[]);
      assert.match(report.notes.join(' '),/No original artwork/);
      assert.equal(await page.locator('.page').count(),0);
      await page.locator('#production-handoff').click();
      assert.equal(await page.locator('#zip').evaluate(e=>e===document.activeElement),true);
      assert.match(await page.locator('#production-status').innerText(),/no export started/);
      // Re-check target changes instead of using an old manifest authorization.
      await page.locator('#production-target').selectOption('cozy');
      assert.match(await page.locator('#production-status').innerText(),/Prepare again/);
      await tabs.nth(1).click();
      assert.equal(automationCalls,0);
      const [artRunSheet] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button',{name:'Download recipe run sheet'}).click()
      ]);
      assert.equal(artRunSheet.suggestedFilename(),'wec-recipe-run-sheet.txt');
      const artSheetText = readFileSync(await artRunSheet.path(),'utf8');
      assert.match(artSheetText,/Recipe: Artwork collection/);
      assert.match(artSheetText,/No artwork slots/);
      assert.match(artSheetText,/\[ \] 1\. Create/);
      assert.match(artSheetText,/not a record of successful execution/);
      assert.equal(await page.locator('.page').count(),0);
      await page.locator('#automation-preview').getByRole('button',{name:'Open Review'}).click();
      assert.equal(await tabs.nth(3).getAttribute('aria-current'),'step');
      assert.equal(await page.locator('.page').count(),0);
      assert.equal(automationCalls,0);
      await tabs.nth(1).click();
      await page.locator('#automation-clear-button').click();
      assert.equal(await page.locator('#automation-preview li').count(),0);
      // Plan-only work must remain usable without visiting Create/Review/Export.
      await tabs.nth(1).click();
      const outline = 'Independent story idea\nSecond scene to consider';
      await page.locator('#outline').fill(outline);
      await page.locator('#automation-recipe').selectOption('plan');
      await page.locator('#automation-preview-button').click();
      await page.getByRole('button',{name:'Check recipe inputs'}).click();
      assert.match(await page.getByRole('status',{name:'Recipe input check'}).innerText(),/Planning text is present/);
      const [planRunSheet] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button',{name:'Download recipe run sheet'}).click()
      ]);
      const planSheetText = readFileSync(await planRunSheet.path(),'utf8');
      assert.match(planSheetText,/Recipe: Plan only/);
      assert.match(planSheetText,/Planning text is present/);
      assert.match(planSheetText,/\[ \] 1\. Plan/);
      assert.equal(await page.locator('.page').count(),0);
      await page.getByRole('button',{name:'Start guided run'}).click();
      assert.match(await page.locator('#automation-guided-progress').innerText(),/0 of 1 steps reviewed/);
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#automation-guided').getByRole('button',{name:'Save project at this step (confirm)'}).click();
      await page.locator('#automation-status').filter({hasText:'Save current project completed'}).waitFor();
      assert.match(await page.locator('#automation-guided-progress').innerText(),/0 of 1 steps reviewed/);
      // Confirmed actions are opt-in; cancellation must not create pages.
      page.once('dialog', dialog => dialog.dismiss());
      await page.locator('#automation-preview').getByRole('button',{name:'Convert planning draft to pages'}).click();
      assert.match(await page.locator('#automation-status').innerText(),/Cancelled/);
      assert.match(await page.locator('#automation-history-list').innerText(),/Convert planning draft to pages — cancelled/);
      assert.equal(await page.locator('.page').count(),0);
      // Save is a separate explicit action using the existing persistence handler.
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#automation-preview').getByRole('button',{name:'Save current project'}).click();
      await page.locator('#automation-status').filter({hasText:'Save current project completed'}).waitFor();
      assert.match(await page.locator('#automation-history-list').innerText(),/Save current project — completed/);
      assert.match(await page.locator('#automation-guided-progress').innerText(),/0 of 1 steps reviewed/);
      assert.equal(await page.locator('.page').count(),0);
      const [textFile] = await Promise.all([
        page.waitForEvent('download'), page.locator('#download-plan').click()
      ]);
      assert.equal(readFileSync(await textFile.path(),'utf8'),outline+'\n');
      await page.waitForFunction(() => !document.querySelector('#save').disabled);
      await page.reload();
      await page.locator('#library button').first().click();
      await tabs.nth(4).click();
      assert.equal(await page.locator('#editor-heading').innerText(),'Workflow regression');
      await page.locator('#save').click();
      await page.waitForFunction(()=>!document.querySelector('#save').disabled);
      assert.equal(await page.locator('.workflow-footer button').last().isDisabled(),true);
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
      assert.equal(await page.locator('#plan-handoff button').count(),0);
      assert.equal(await page.locator('#outline').inputValue(),outline);
      // An uncertain result stops the guided run; no automatic retry follows.
      await page.locator('#automation-recipe').selectOption('plan');
      await page.locator('#automation-preview-button').click();
      await page.getByRole('button',{name:'Start guided run'}).click();
      await page.evaluate(() => {
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(stores, mode, ...options) {
          if (mode === 'readwrite') {
            IDBDatabase.prototype.transaction = original;
            throw new DOMException('Device storage full','QuotaExceededError');
          }
          return original.call(this, stores, mode, ...options);
        };
      });
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#automation-guided').getByRole('button',{name:'Convert draft at this step (confirm)'}).click();
      await page.locator('#automation-status').filter({hasText:'needs review'}).waitFor();
      assert.match(await page.locator('#automation-guided-progress').innerText(),/Paused/);
      assert.equal(await page.locator('.page').count(),0);
      assert.equal(await page.locator('#outline').inputValue(),outline);
      await page.locator('#automation-guided').getByRole('button',{name:'Resume guided run'}).click();
      assert.match(await page.locator('#automation-guided-progress').innerText(),/Active/);
      await page.locator('#automation-recipe').selectOption('plan');
      await page.locator('#automation-preview-button').click();
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#automation-preview').getByRole('button',{name:'Convert planning draft to pages'}).click();
      await page.locator('#automation-status').filter({hasText:'Convert planning draft to pages completed'}).waitFor();
      assert.match(await page.locator('#automation-history-list').innerText(),/Convert planning draft to pages — completed/);
      assert.equal(await page.locator('.page').count(),2);
      assert.equal(await tabs.nth(1).getAttribute('aria-current'),'step');
      await page.getByRole('button',{name:'Open new pages in Create'}).click();
      assert.equal(await page.locator('.page').first().evaluate(el=>el===document.activeElement),true);
      assert.deepEqual(await page.getByLabel('Scene / image prompt').evaluateAll(
        inputs => inputs.map(input => input.value)),outline.split('\n'));
      // Start a separate artwork project and go directly to Create.
      await page.locator('[data-kind=art]').click();
      assert.equal(await page.locator('#automation-history-list li').count(),0);
      assert.match(await page.locator('#automation-guided').innerText(),/No guided run active/);
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
      await page.locator('#asset-review-list li').last().evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
      assert.equal(await page.locator('#save').evaluate(button=>{
        const box=button.getBoundingClientRect();
        return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===button;
      }),true);
      const reviewItems = page.locator('#asset-review-list li');
      await reviewItems.nth(2).getByRole('button',{name:'Edit in Create'}).click();
      assert.equal(await page.locator('.page').nth(2).evaluate(el=>el===document.activeElement),true);
      // Use the third slot while leaving the second empty.
      await page.locator('.page').nth(2).locator('input[type=file]').setInputFiles({
        name:'third.png',mimeType:'image/png',buffer:png
      });
      await page.locator('.page').nth(2).getByRole('button',{name:'Open in Review'}).click();
      assert.equal(await reviewItems.nth(2).evaluate(el=>el===document.activeElement),true);
      assert.equal(await reviewItems.nth(1).getByRole('button',{name:'Open original in Export'}).count(),0);
      const downloads = [];
      page.on('download', file=>downloads.push(file.suggestedFilename()));
      await reviewItems.nth(2).getByRole('button',{name:'Open original in Export'}).click();
      const third = page.locator('#export-image-list a').last();
      assert.equal(await third.evaluate(el=>el===document.activeElement),true);
      assert.deepEqual(downloads,[]);
      const [thirdFile] = await Promise.all([page.waitForEvent('download'),third.click()]);
      assert.equal(thirdFile.suggestedFilename(),'artwork-3.png');
      assert.deepEqual(readFileSync(await thirdFile.path()),png);
      await tabs.nth(3).click();
      await page.getByLabel('Artwork 1 approval').selectOption('approved');
      await page.locator('#readiness').filter({hasText:'1 of 2 attached pictures approved'}).waitFor();
      await tabs.nth(4).click();
      await page.locator('#production-target').selectOption('artwork');
      await page.locator('#production-prepare').click();
      assert.match(await page.locator('#production-summary').innerText(),/3 ordered page/);
      assert.match(await page.locator('#production-summary').innerText(),/1 approved image/);
      assert.equal(await page.locator('#production-inventory li').count(),3);
      assert.match(await page.locator('#production-inventory li').nth(0).innerText(),/approved/);
      await page.locator('#production-inventory li').nth(1).getByRole('button',{name:'Edit slot 2'}).click();
      assert.equal(await tabs.nth(2).getAttribute('aria-current'),'step');
      await tabs.nth(3).click();
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
      await tabs.nth(1).click();
      await page.locator('#automation-recipe').selectOption('artwork');
      await page.locator('#automation-preview-button').click();
      await page.getByRole('button',{name:'Start guided run'}).click();
      assert.match(await page.locator('#automation-status').innerText(),/matches the project format/);
      assert.match(await page.locator('#automation-guided').innerText(),/No guided run active/);
      assert.deepEqual(errors,[]);
      await context.close();
      console.log(`PASS guided workflow ${width}px`);
    }
  } finally {
    if(browser) await browser.close();
    server.kill();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
