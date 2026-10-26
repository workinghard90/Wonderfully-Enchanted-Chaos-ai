/* Only a local synthetic provider. This is not evidence of real AI generation. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 const port=listener.address().port;await new Promise(r=>listener.close(r));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wec-generation-'));
 const token='local-browser-generation-test-secret';
 const server=spawn(process.env.PYTHON||'python',[path.join(__dirname,'browser_generation_server.py'),String(port),directory,token],{cwd:os.tmpdir(),stdio:['ignore','pipe','pipe']});
 let logs='',browser;server.stderr.on('data',value=>{logs+=value});
 const base=`http://127.0.0.1:${port}`;
 try{
  for(let i=0;i<100;i++){
   try{if((await fetch(base+'/api/health')).ok)break}catch{}
   if(server.exitCode!==null)throw Error('Fixture exited: '+logs);
   if(i===99)throw Error('Fixture startup timed out: '+logs);
   await new Promise(r=>setTimeout(r,100));
  }
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}: {})});
  for(const viewport of [{width:390,height:844},{width:1440,height:1000}]){
   const context=await browser.newContext({viewport,acceptDownloads:true});
   await context.addInitScript(value=>sessionStorage.setItem('wec_token',value),token);
   const page=await context.newPage(),errors=[];let consent=false,calls=0;
   page.on('dialog',d=>consent?d.accept():d.dismiss());
   page.on('pageerror',error=>errors.push(error.message));
   page.on('request',r=>{if(r.url().endsWith('/generate'))calls++});
   await page.goto(base + "/video/");
   await page.locator('#title').fill('Synthetic generation '+viewport.width);
   await page.locator('#story').fill('A lantern helps a fox.');await page.locator('#scenes').fill('2');
   await page.locator('#save-top').click();await page.locator('#message').filter({hasText:'Project saved'}).waitFor();
   await page.locator('#plan').click();await page.locator('#prompt-scene-001').waitFor();
   await page.locator('[data-scene="scene-001"] .generate').click();
   await page.waitForFunction(()=>!document.querySelector('#save-top').disabled);assert.equal(calls,0);
   consent=true;
   await page.locator('#prompt-scene-001').fill('A lantern above a storybook gate');
   await page.locator('[data-scene="scene-001"] .generate').click();
   await page.locator('#message').filter({hasText:'Image generated and attached'}).waitFor();
   await page.waitForFunction(()=>document.querySelector('.scene-image')?.naturalWidth>0);
   assert.equal(calls,1);assert.equal(await page.locator('[data-scene="scene-001"] .generate').count(),0);
   assert.ok((await page.locator('#generation-status').innerText()).includes('Cloudflare'));
   const download=page.waitForEvent('download');await page.locator('#backup').click();
   const backup=JSON.parse(fs.readFileSync(await (await download).path(),'utf8'));
   const project=backup.projects.find(p=>p.title==='Synthetic generation '+viewport.width);
   assert.equal(project.scene_images.length,1);
   await page.locator('#prompt-scene-002').fill('simulate provider failure');
   await page.locator('[data-scene="scene-002"] .generate').click();
   await page.locator('#message').filter({hasText:'Simulated provider failure'}).waitFor();
   await page.waitForFunction(()=>!document.querySelector('#save-top').disabled);
   assert.equal(await page.locator('.scene-image').count(),1);assert.equal(calls,2);
   await page.locator('#prompt-scene-002').fill('A friendly fox under a tree');
   await page.locator('[data-scene="scene-002"] .generate').click();
   await page.locator('#message').filter({hasText:'Image generated and attached to scene-002'}).waitFor();
   assert.equal(await page.locator('.scene-image').count(),2);assert.equal(calls,3);
   await page.reload();await page.locator(`[data-project="${project.id}"]`).getByRole('button',{name:'Open',exact:true}).click();
   await page.locator('#message').filter({hasText:'Editing'}).waitFor();
   await page.waitForFunction(()=>document.querySelectorAll('.scene-image').length===2 && [...document.querySelectorAll('.scene-image')].every(image=>image.naturalWidth>0));
   assert.equal(await page.locator('.scene-image').count(),2);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.deepEqual(errors,[]);
   console.log(`PASS mocked generation ${viewport.width}: consent, editable prompt, one image per click, backup, failure/retry, reload, preserved pictures, no overflow/errors`);
   await context.close();
  }
 }finally{
  if(browser)await browser.close();server.kill();
  await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.rmSync(directory,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1});
