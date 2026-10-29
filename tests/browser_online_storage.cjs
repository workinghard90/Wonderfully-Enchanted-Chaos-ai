/* Real disk-backed HTTP, independent browser contexts, originals and checkpoints. No AI calls. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 const port=listener.address().port;await new Promise(r=>listener.close(r));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wec-online-'));
 const token='test-only-online-token-at-least-32-characters',base=`http://127.0.0.1:${port}`;
 const server=spawn(process.env.PYTHON||'python',['-m','wec_engine.studio','--port',String(port),'--data-dir',directory],{cwd:os.tmpdir(),env:{...process.env,RENDER:'',WEC_STUDIO_TOKEN:token,WEC_ENABLE_ONLINE_STORAGE:'1',WEC_ENABLE_IMAGE_GENERATION:'0'},stdio:['ignore','pipe','pipe']});
 let browser,logs='';server.stderr.on('data',d=>logs+=d);
 const ready=p=>p.waitForFunction(()=>!document.querySelector('#save').disabled);
 const png='iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==';
 try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(server.exitCode!==null||i===99)throw Error(logs||'Startup failed');await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}:{})});
  for(const width of [390,1440]){
   const context=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true});
   await context.addInitScript(t=>sessionStorage.setItem('wec_token',t),token);
   const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
   await p.goto(base);await p.locator('#status').filter({hasText:'Choose a format'}).waitFor();
   const id=await p.evaluate(async ({png,width})=>{
    const s=await import('/studio/store.js');
    const blob=new Blob([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],{type:'image/png'});
    const asset={blob,name:'original.png',extension:'png',width:40,height:30,source:'Original'};
    const value={schema_version:1,app:'wec-creative-studio',id:crypto.randomUUID(),revision:0,kind:'art',title:'Online '+width,author:'Test',characterName:'Cloud',character:'Lavender cloud',style:'Watercolor',backText:'',reference:asset,cover:asset,narration:'',duration:35,sceneCount:7,pages:[{id:crypto.randomUUID(),text:'Original text',prompt:'Current prompt',asset,review:'approved',pendingGeneration:{id:'a'.repeat(32),mode:'text'}}]};
    const cp=structuredClone(value);cp.pages[0].prompt='Checkpoint prompt';
    return (await s.restoreRecovery(value,{createdAt:123,project:cp})).id;
   },{png,width});
   await p.reload();await p.locator('#library .library-item button').first().click();await ready(p);
   await p.locator('#online-panel summary').click();
   await p.locator('#online-save').click();await ready(p);
   await p.locator('#status').filter({hasText:'Online snapshot saved and verified'}).waitFor();
   const row=p.locator('#online-library .library-item').filter({hasText:'Online '+width});
   assert.equal(await row.count(),1);
   const wait=p.waitForEvent('download');await row.getByRole('button',{name:'Download snapshot',exact:true}).click();
   const downloaded=fs.readFileSync(await (await wait).path());await ready(p);
   const content=JSON.parse(JSON.parse(downloaded).payload);
   assert.equal(content.project.pages[0].asset.image_base64,png);
   assert.equal(content.checkpoint.project.pages[0].prompt,'Checkpoint prompt');
   // A different browser/device has no IndexedDB records at all.
   const other=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true});
   await other.addInitScript(t=>sessionStorage.setItem('wec_token',t),token);
   const q=await other.newPage();q.on('pageerror',e=>errors.push(e.message));q.on('dialog',d=>d.accept());
   await q.goto(base);await q.locator('#status').filter({hasText:'Choose a format'}).waitFor();
   assert.equal(await q.locator('#library .library-item').count(),0);
   await q.locator('#online-panel summary').click();await q.locator('#online-refresh').click();await ready(q);
   await q.locator('#online-library .library-item').filter({hasText:'Online '+width}).getByRole('button',{name:'Open local copy',exact:true}).click();await ready(q);
   await q.locator('#status').filter({hasText:'Recovery package restored'}).waitFor();
   const restored=await q.evaluate(async()=>{
    const s=await import('/studio/store.js'),items=await s.all(),v=await s.get(items[0].id);
    const cp=await s.recoverySnapshot(v.id,v.revision);
    return {id:v.id,review:v.pages[0].review,bytes:Array.from(new Uint8Array(await v.pages[0].asset.blob.arrayBuffer())),checkpoint:cp.checkpoint.project.pages[0].prompt,receipt:v.pages[0].pendingGeneration.id};
   });
   assert.notEqual(restored.id,id);assert.equal(restored.review,'approved');assert.deepEqual(Buffer.from(restored.bytes),Buffer.from(png,'base64'));
   assert.equal(restored.checkpoint,'Checkpoint prompt');assert.equal(restored.receipt,'a'.repeat(32));
   // Failed upload leaves both local work and the prior remote snapshot usable.
   await q.route('**/api/creative/snapshots',route=>route.request().method()==='POST'?route.fulfill({status:507,contentType:'application/json',body:JSON.stringify({error:'Test disk full; prior snapshots kept'})}):route.continue());
   await q.locator('#online-save').click();await ready(q);await q.locator('#status').filter({hasText:'Test disk full'}).waitFor();
   assert.equal(await q.locator('#library .library-item').count(),1);
   await q.unroute('**/api/creative/snapshots');
   await row.getByRole('button',{name:'Remove online snapshot',exact:true}).click();await ready(p);
   assert.equal(await p.locator('#online-library .library-item').filter({hasText:'Online '+width}).count(),0);
   assert.equal(await p.locator('#library .library-item').count(),1);
   assert.ok(await q.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.deepEqual(errors,[]);
   await context.close();await other.close();console.log(`Online snapshots passed at ${width}px`);
  }
 }finally{if(browser)await browser.close();server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.rmSync(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
