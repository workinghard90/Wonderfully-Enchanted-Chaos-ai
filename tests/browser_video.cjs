/* Local synthetic movie workflow only. No image AI or voice downloads. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 const port=listener.address().port;await new Promise(r=>listener.close(r));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wec-video-browser-'));
 const token='local-browser-video-test-secret-32';
 const server=spawn(process.env.PYTHON||'python',[path.join(__dirname,'browser_video_server.py'),String(port),directory,token],{cwd:os.tmpdir(),stdio:['ignore','pipe','pipe']});
 const base=`http://127.0.0.1:${port}`;let logs='',browser;
 server.stderr.on('data',v=>{logs+=v});
 try{
  for(let i=0;i<100;i++){
   try{if((await fetch(base+'/api/health')).ok)break}catch{}
   if(server.exitCode!==null)throw Error('Fixture exited: '+logs);
   if(i===99)throw Error('Fixture timeout: '+logs);
   await new Promise(r=>setTimeout(r,100));
  }
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}: {})});
  for(const viewport of [{width:390,height:844},{width:1440,height:1000}]){
   const context=await browser.newContext({viewport,acceptDownloads:true});
   await context.addInitScript(value=>sessionStorage.setItem('wec_token',value),token);
   const page=await context.newPage(),errors=[],fileRequests=[];let accept=false,startCalls=0;
   page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>accept?d.accept():d.dismiss());
   page.on('request',r=>{if(r.url().endsWith('/file'))fileRequests.push(r);if(r.method()==='POST'&&r.url().endsWith('/video'))startCalls++});
   await page.goto(base);
   assert.equal(await page.locator('#render-video').isDisabled(),true);
   await page.locator('#title').fill('Browser video '+viewport.width);
   await page.locator('#story').fill('A little lantern glows.');await page.locator('#scenes').fill('1');await page.locator('#duration').fill('2');
   await page.locator('#save-top').click();await page.locator('#message').filter({hasText:'Project saved'}).waitFor();
   await page.locator('#render-video').click();await page.waitForFunction(()=>!document.querySelector('#save-top').disabled);
   assert.equal(startCalls,0);accept=true;
   await page.locator('#render-video').click();await page.locator('#message').filter({hasText:'Attach a picture'}).waitFor();
   await page.locator('#plan').click();await page.locator('#upload-scene-001').waitFor({state:'attached'});
   const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==','base64');
   await page.locator('#upload-scene-001').setInputFiles({name:'test.png',mimeType:'image/png',buffer:png});
   await page.locator('#message').filter({hasText:'Image attached'}).waitFor();
   await page.locator('#render-video').click();await page.locator('.video-job').getByText('Your movie is ready. Download it to keep it.').waitFor();
   await page.locator('.video-job').filter({hasText:'Browser video '+viewport.width}).getByRole('button',{name:'Play video'}).click();
   await page.waitForFunction(()=>document.querySelector('#movie').readyState>=1);
   assert.ok((await page.locator('#movie').getAttribute('src')).startsWith('blob:'));
   assert.equal(await page.locator('#movie').getAttribute('playsinline'),'');
   const download=page.waitForEvent('download');
   await page.locator('.video-job').filter({hasText:'Browser video '+viewport.width}).getByRole('button',{name:'Download video'}).click();
   const movie=await download;assert.ok(fs.statSync(await movie.path()).size>1000);
   await page.reload();await page.locator('.video-job').filter({hasText:'Browser video '+viewport.width}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   for(const r of fileRequests){assert.equal(new URL(r.url()).search,'');assert.equal(r.headers()['x-wec-token'],token)}
   assert.deepEqual(errors,[]);
   await page.locator('.video-job').filter({hasText:'Browser video '+viewport.width}).getByRole('button',{name:'Remove server copy'}).click();
   await page.waitForFunction(title=>![...document.querySelectorAll('.video-job')].some(x=>x.textContent.includes(title)),'Browser video '+viewport.width);
   console.log(`PASS video ${viewport.width}: consent, missing image, queued render, blob playback/download, reload, auth headers, cleanup`);
   await context.close();
  }
 }finally{
  if(browser)await browser.close();server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.rmSync(directory,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1});
