/* Chromium against a local server. No remote services or generation. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const assert=require('node:assert/strict'), net=require('node:net');
(async()=>{
  const listener=net.createServer();
  await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;
  await new Promise(r=>listener.close(r));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wec-browser-'));
  const token='browser-test-only-secret-32-characters';
  const server=spawn(process.env.PYTHON||'python',['-m','wec_engine.studio','--port',String(port),'--data-dir',directory],{cwd:os.tmpdir(),env:{...process.env,WEC_STUDIO_TOKEN:token},stdio:['ignore','pipe','pipe']});
  const base=`http://127.0.0.1:${port}`;let browser,logs='';
  server.stderr.on('data',chunk=>{logs+=chunk});
  try {
    for(let i=0;i<100;i++){
      try{if((await fetch(base+'/api/health')).ok)break}catch{}
      if(server.exitCode!==null)throw Error('Studio exited: '+logs);
      if(i===99)throw Error('Startup timeout: '+logs);
      await new Promise(r=>setTimeout(r,100));
    }
    browser=await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']} : {})});
    for(const viewport of [{width:390,height:844},{width:1440,height:1000}]){
      const context=await browser.newContext({viewport,acceptDownloads:true});
      await context.addInitScript(value=>sessionStorage.setItem('wec_token',value),token);
      const page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(base);
      await page.locator('#title').fill('Lantern '+viewport.width);
      await page.locator('#story').fill('The lantern flew through the clouds. It found its way home.');
      await page.locator('#save').click();
      await page.locator('#message').filter({hasText:'Project saved'}).waitFor();
      await page.locator('#plan').click();
      await page.locator('#preview .scene').first().waitFor();
      assert.equal(await page.locator('#preview .scene').count(),7);
      await page.locator('#dry').click();
      await page.locator('#message').filter({hasText:'Dry-run:'}).waitFor();
      const download=page.waitForEvent('download');await page.locator('#backup').click();
      const file=await download;
      const backup=JSON.parse(fs.readFileSync(await file.path(),'utf8'));
      assert.ok(backup.projects.some(item=>item.title==='Lantern '+viewport.width));
      await page.locator('#new').click();assert.equal(await page.locator('#title').inputValue(),'');
      await page.locator('#title').fill('Second '+viewport.width);
      await page.locator('#story').fill('A second story.');
      await page.locator('#save').click();
      await page.locator('#message').filter({hasText:'Project saved'}).waitFor();
      await page.reload();await page.locator('#projects .item').first().waitFor();
      assert.ok((await page.locator('#projects').innerText()).includes('Lantern '+viewport.width));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
      if(process.env.WEC_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.WEC_SCREENSHOT_DIR,`studio-${viewport.width}.png`),fullPage:true});
      console.log(`PASS browser ${viewport.width}x${viewport.height}: save, plan, dry-run, backup, new project, persistence, no overflow/errors`);
      await context.close();
    }
    const context=await browser.newContext();
    await context.addInitScript(()=>sessionStorage.setItem('wec_token','wrong'));
    const page=await context.newPage();let prompts=0;
    page.on('dialog',async dialog=>{prompts++;await dialog.accept('still-wrong')});
    await page.goto(base);
    await page.locator('#message').filter({hasText:'Access token rejected'}).waitFor();
    assert.equal(prompts,1);await context.close();
    console.log('PASS authentication retry is bounded');
  }finally{
    if(browser)await browser.close();server.kill();
    await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
