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
  const server=spawn(process.env.PYTHON||'python',['-m','wec_engine.studio','--port',String(port),'--data-dir',directory],{cwd:os.tmpdir(),env:{...process.env,WEC_STUDIO_TOKEN:token,WEC_ENABLE_IMAGE_GENERATION:'0'},stdio:['ignore','pipe','pipe']});
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
      let acceptDialogs=true;
      page.on('dialog',dialog=>acceptDialogs ? dialog.accept() : dialog.dismiss());
      const imageRequests=[];
      page.on('request',request=>{if(request.url().includes('/image'))imageRequests.push(request)});
      await page.goto(base);
      const title='Lantern '+viewport.width;
      await page.locator('#title').fill(title);
      await page.locator('#story').fill('The lantern flew through the clouds. It found its way home.');
      await page.locator('#save-top').click();
      await page.locator('#message').filter({hasText:'Project saved'}).waitFor();
      await page.locator('#plan').click();
      await page.locator('#preview .scene').first().waitFor();
      assert.equal(await page.locator('#preview .scene').count(),7);
      await page.waitForFunction(()=>!document.querySelector('#save-top').disabled);
      assert.equal(await page.locator('.generate:enabled').count(),0);
      assert.ok((await page.locator('#generation-status').innerText()).includes('owner setup'));
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==','base64');
      const chooserPromise=page.waitForEvent('filechooser');
      await page.locator('[data-scene="scene-001"]').getByRole('button',{name:'Upload image'}).click();
      await (await chooserPromise).setFiles({name:'lantern.png',mimeType:'image/png',buffer:png});
      await page.locator('#message').filter({hasText:'Image attached'}).waitFor();
      await page.waitForFunction(()=>document.querySelector('.scene-image')?.naturalWidth>0);
      assert.ok((await page.locator('.scene-image').getAttribute('src')).startsWith('blob:'));
      await page.locator('#dry').click();
      await page.locator('#message').filter({hasText:'Dry-run:'}).waitFor();
      const download=page.waitForEvent('download');await page.locator('#backup').click();
      const file=await download;
      const backup=JSON.parse(fs.readFileSync(await file.path(),'utf8'));
      assert.equal(backup.schema_version,2);
      const original=backup.projects.find(item=>item.title===title);
      assert.equal(original.scene_images.length,1);
      const count=await page.locator('#projects .item').count();
      const restoreResponse=page.waitForResponse(response=>response.url()===base+'/api/restore');
      const restoreChooser=page.waitForEvent('filechooser');await page.locator('#restore').click();
      await (await restoreChooser).setFiles(await file.path());
      const restored=await (await restoreResponse).json();
      await page.locator('#message').filter({hasText:'Restored '+backup.projects.length+' project(s)'}).waitFor();
      assert.equal(await page.locator('#projects .item').count(),count+backup.projects.length);
      const copy=restored.projects.find(item=>item.title===title);
      assert.notEqual(copy.id,original.id);
      await page.locator(`[data-project="${copy.id}"]`).getByRole('button',{name:'Open',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.scene-image')?.naturalWidth>0);
      await page.reload();await page.locator('#projects .item').first().waitFor();
      await page.locator(`[data-project="${copy.id}"]`).getByRole('button',{name:'Open',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.scene-image')?.naturalWidth>0);
      assert.equal(await page.locator('#story').inputValue(),original.story);
      await page.locator('#save-top').waitFor({state:'visible'});
      await page.locator('#save-top').click(); // Waits for open/load action to finish.
      await page.locator('#message').filter({hasText:'Project saved'}).waitFor();
      await page.locator('[data-scene="scene-001"]').getByRole('button',{name:'Remove image'}).click();
      await page.locator('#message').filter({hasText:'Scene image removed'}).waitFor();
      assert.equal(await page.locator('.scene-image').count(),0);
      await page.locator(`[data-project="${original.id}"]`).getByRole('button',{name:'Open',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.scene-image')?.naturalWidth>0);
      // Cancel a story edit that would clear attached images.
      await page.locator('#story').fill('Changed story');acceptDialogs=false;
      await page.locator('#save-top').click();
      await page.waitForFunction(()=>document.querySelector('#save-top').disabled===false);
      acceptDialogs=true;
      const unchanged=await context.request.get(base+'/api/projects/'+original.id,{headers:{'X-WEC-Token':token}});
      const unchangedProject=await unchanged.json();
      assert.equal(unchangedProject.story,original.story);assert.equal(unchangedProject.image_count,1);
      await page.locator(`[data-project="${original.id}"]`).getByRole('button',{name:'Open',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.scene-image')?.naturalWidth>0);
      const beforeInvalid=await page.locator('#projects .item').count();
      await page.locator('#restore-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{')});
      await page.locator('#message').filter({hasText:'not valid JSON'}).waitFor();
      assert.equal(await page.locator('#projects .item').count(),beforeInvalid);
      await page.locator('#new').click();assert.equal(await page.locator('#title').inputValue(),'');
      await page.locator('#title').fill('Second '+viewport.width);
      await page.locator('#story').fill('A second story.');
      await page.locator('#save').click();
      await page.locator('#message').filter({hasText:'Project saved'}).waitFor();
      await page.reload();await page.locator('#projects .item').first().waitFor();
      assert.ok((await page.locator('#projects').innerText()).includes(title));
      await page.locator(`[data-project="${original.id}"]`).getByRole('button',{name:'Open',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.scene-image')?.naturalWidth>0);
      await page.locator('#save-top').click();
      await page.locator('#message').filter({hasText:'Project saved'}).waitFor();
      await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));
      const sticky=await page.locator('#save-top').boundingBox();
      assert.ok(sticky.y>=0 && sticky.y+sticky.height<=viewport.height);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
      assert.ok(imageRequests.length>0);
      for(const request of imageRequests){
        assert.equal(new URL(request.url()).search,'');
        assert.equal(request.headers()['x-wec-token'],token);
      }
      if(process.env.WEC_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.WEC_SCREENSHOT_DIR,`studio-${viewport.width}.png`),fullPage:true});
      console.log(`PASS browser ${viewport.width}x${viewport.height}: save, image upload/preview, dry-run, image backup/restore, reload, remove, cancel reset, invalid backup, sticky save, persistence, no overflow/errors`);
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
