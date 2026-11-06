// End-to-end checks for the separate, linkable Create/Library/Studio/Renders pages.
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const {mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const server=spawn(process.env.PYTHON || 'python',
    ['-m','wec_engine.studio','--port',String(port),'--data-dir',mkdtempSync(join(tmpdir(),'wec-pages-'))],
    {env:{...process.env,WEC_STUDIO_TOKEN:'test-only-pages-token-32-characters'},stdio:'ignore'});
  let browser;
  try{
    const base='http://127.0.0.1:'+port;
    for(let i=0;i<100;i++){
      try{if((await fetch(base+'/api/health')).ok)break;}catch{}
      if(i===99||server.exitCode!==null)throw Error('Studio did not start');
      await new Promise(r=>setTimeout(r,100));
    }
    browser=await chromium.launch({headless:true});
    for(const width of [320,390,1440]){
      const context=await browser.newContext({viewport:{width,height:width===320?680:900}});
      const page=await context.newPage();
      const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(base);
      // Guest pages must remain browsable while protected server APIs
      // require owner authentication; the inline sign-in replaces prompts.
      assert.equal(await page.locator('#wec-owner-state').textContent(), 'Owner features locked');
      assert.equal(await page.request.get(base+'/api/automation/jobs').then(r=>r.status()),401);
      await page.locator('#wec-owner-open').click();
      await page.locator('#wec-owner-token').fill('wrong-owner-password-32-characters');
      await page.locator('#wec-owner-form button[type="submit"]').click();
      await page.locator('#wec-owner-message').getByText('Incorrect owner password/token.').waitFor();
      await page.locator('#wec-owner-token').fill('test-only-pages-token-32-characters');
      await page.locator('#wec-owner-form button[type="submit"]').click();
      await page.locator('#wec-owner-state').getByText('Owner features unlocked for this tab').waitFor();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('wec_token')), 'test-only-pages-token-32-characters');
      assert.equal(await page.locator('#wec-owner-token').inputValue(), '');
      // A user-triggered failure must appear inside the current viewport,
      // not solely in the status paragraph near the top of the page.
      await page.route('**/api/generation', route=>route.fulfill({
        status:503,contentType:'application/json',
        body:JSON.stringify({error:'Test-only unavailable provider'})
      }));
      await page.locator('#check-ai').click();
      const notice=page.locator('#wec-visible-error');
      await notice.waitFor({state:'visible'});
      assert.match(await notice.innerText(),/Test-only unavailable provider/);
      const bounds=await notice.boundingBox();
      assert.ok(bounds && bounds.y>=0 && bounds.y+bounds.height<=page.viewportSize().height,
        'error must be visible without scrolling');
      await notice.getByRole('button',{name:'Dismiss error message'}).click();
      assert.equal(await notice.isVisible(),false);
      await page.unroute('**/api/generation');
      await page.locator('#wec-owner-logout').click();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('wec_token')), null);
      assert.equal(await page.locator('#wec-owner-state').textContent(), 'Owner features locked');
      assert.equal(await page.request.get(base+'/studio/pages.js').then(r=>r.status()),200);
      await page.locator('#wec-page-navigation').waitFor();
      assert.equal(new URL(page.url()).hash,'#/home');
      assert.equal(await page.locator('#wec-page-home').isVisible(),true);
      assert.equal(await page.locator('#wec-page-library').isVisible(),false);
      await page.locator('[data-page-link="library"]').click();
      assert.equal(await page.locator('#wec-page-library').isVisible(),true);
      assert.equal(await page.locator('#wec-page-home').isVisible(),false);
      await page.reload();
      assert.equal(await page.locator('#wec-page-library').isVisible(),true);
      await page.locator('[data-page-link="home"]').click();
      await page.locator('[data-kind=art]').click();
      await page.locator('#wec-page-studio').waitFor({state:'visible'});
      assert.equal(await page.locator('#wec-page-home').isVisible(),false);
      await page.locator('#title').fill('Separate page test '+width);
      await page.locator('#save').click();
      await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent.startsWith('Saved ') && !document.querySelector('#save').disabled);
      await page.locator('[data-page-link="renders"]').click();
      assert.equal(await page.locator('#wec-page-renders').isVisible(),true);
      await page.goBack();
      assert.equal(await page.locator('#wec-page-studio').isVisible(),true);
      assert.equal(await page.locator('#title').inputValue(),'Separate page test '+width);
      await page.locator('[data-page-link="library"]').click();
      await page.locator('#library .library-item').filter({hasText:'Separate page test '+width}).getByRole('button',{name:'Open',exact:true}).click();
      await page.locator('#wec-page-studio').waitFor({state:'visible'});
      assert.equal(await page.locator('#title').inputValue(),'Separate page test '+width);
      await page.reload();
      await page.locator('[data-page-link="library"]').click();
      await page.locator('#library .library-item').filter({hasText:'Separate page test '+width}).getByRole('button',{name:'Open',exact:true}).click();
      await page.locator('#wec-page-studio').waitFor({state:'visible'});
      await page.locator('.workflow-tab').nth(1).click();
      assert.equal(await page.locator('#automation-recipes').isVisible(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
      console.log('PASS separate pages '+width+'px: deep links, reload, back, save, library reopen, studio steps, no overflow');
      await context.close();
    }
  } finally{
    if(browser)await browser.close();
    server.kill('SIGTERM');
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
