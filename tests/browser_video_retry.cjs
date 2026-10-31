/* Retry a saved failed render through the real HTTP controller and FFmpeg fixture. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}:{})});
 try { for(const width of [390,1440]){
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wec-retry-')),token='local-retry-fixture-token-32-characters';
  const server=spawn(process.env.PYTHON||'python',[path.join(__dirname,'browser_video_server.py'),String(port),dir,token],{cwd:os.tmpdir(),stdio:['ignore','pipe','pipe']});
  let logs='';server.stderr.on('data',d=>logs+=d);
  const base=`http://127.0.0.1:${port}`,headers={'X-WEC-Token':token,'Content-Type':'application/json'};
  const post=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers,body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  const context=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true});
  try {
   for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(server.exitCode!==null||i===99)throw Error(logs||'Startup failed');await new Promise(r=>setTimeout(r,100));}
   const project=await post('/api/projects',{title:'RETRY saved original',story:'A little lantern glows.',duration:2,scenes:1});
   const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==','base64');
   assert.ok((await fetch(base+`/api/projects/${project.id}/scenes/scene-001/image`,{method:'POST',headers,body:png})).ok);
   const original=await post(`/api/projects/${project.id}/video`,{ambience:false});
   await post(`/api/projects/${project.id}`,{title:'Edited project',story:'Different narration.',duration:2,scenes:1,reset_images:true});
   await context.addInitScript(t=>sessionStorage.setItem('wec_token',t),token);
   const p=await context.newPage();let accept=false,retries=0,aiCalls=0;const errors=[];
   p.on('dialog',d=>accept?d.accept():d.dismiss());p.on('pageerror',e=>errors.push(e.message));
   p.on('request',r=>{if(r.url().endsWith('/retry'))retries++;if(/\/api\/creative\/(image|draft)$/.test(r.url()))aiCalls++;});
   await p.goto(base);await p.locator('#status').filter({hasText:'Choose a format'}).waitFor();
   await p.locator('#refresh-renders').click();
   const retry=p.getByRole('button',{name:'Retry saved render',exact:true});await retry.waitFor({timeout:30000});
   await retry.click();assert.equal(retries,0);accept=true;
   // Lose the response after the server accepted the retry. Refresh must recover it.
   await p.route('**/api/video-jobs/*/retry',async route=>{await route.fetch();await route.abort('failed');});
   await retry.click();
   await p.getByText('A retry is already in this list. Use that attempt to continue.').waitFor();
   await p.reload();await p.locator('#refresh-renders').click();
   const play=p.getByRole('button',{name:'Play video',exact:true});await play.waitFor({timeout:30000});
   assert.equal(await p.getByRole('button',{name:'Retry saved render',exact:true}).count(),0);
   await play.click();await p.waitForFunction(()=>document.querySelector('#render-movie').readyState>=1);
   const download=p.waitForEvent('download');await p.getByRole('button',{name:'Download MP4',exact:true}).click();
   assert.ok(fs.statSync(await(await download).path()).size>1000);
   const state=await(await fetch(base+'/api/video',{headers})).json();assert.equal(state.attempts_today,2);assert.equal(state.jobs.length,2);
   const child=state.jobs.find(j=>j.retry_of===original.id);assert.equal(child.title,'RETRY saved original');assert.equal(child.status,'ready');
   assert.equal(retries,1);assert.equal(aiCalls,0);assert.deepEqual(errors,[]);
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   console.log(`PASS retry ${width}: consent, original inputs, lost response recovery, reload, MP4 playback/download, quota, no AI`);
  } finally {await context.close();server.kill('SIGTERM');}
 }} finally {await browser.close();}
})().catch(e=>{console.error(e.stack||e);process.exit(1);});
