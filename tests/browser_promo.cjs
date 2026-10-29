/* Real local planning/render flow. Synthetic audio worker; no live AI. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wec-promo-')),token='test-only-promo-browser-token-32-characters';
 const server=spawn(process.env.PYTHON||'python',[path.join(__dirname,'browser_video_server.py'),String(port),directory,token],{cwd:os.tmpdir(),env:{...process.env,WEC_ENABLE_IMAGE_GENERATION:'0',WEC_ENABLE_TEXT_GENERATION:'0'},stdio:['ignore','pipe','pipe']});
 let logs='',browser;server.stderr.on('data',d=>logs+=d);const base=`http://127.0.0.1:${port}`;
 const ready=p=>p.waitForFunction(()=>!document.querySelector('#save').disabled);
 const download=async(p,id)=>{const w=p.waitForEvent('download');await p.locator(id).click();const bytes=fs.readFileSync(await(await w).path());await ready(p);return bytes;};
 try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(server.exitCode!==null||i===99)throw Error(logs||'Startup failed');await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}:{})});
  for(const width of [390,1440]){
   const context=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true});await context.addInitScript(t=>sessionStorage.setItem('wec_token',t),token);
   const p=await context.newPage();const errors=[];let accept=true,aiCalls=0;
   p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>accept?d.accept():d.dismiss());
   p.on('request',r=>{if(/\/api\/creative\/(image|draft)$/.test(r.url()))aiCalls++;});
   await p.goto(base);await p.locator('#status').filter({hasText:'Choose a format'}).waitFor();await ready(p);
   const source=await p.evaluate(async()=>{
    const s=await import('/studio/store.js');const canvas=document.createElement('canvas');canvas.width=100;canvas.height=100;const g=canvas.getContext('2d');g.fillStyle='purple';g.fillRect(0,0,100,100);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const asset={blob,name:'pip.png',width:100,height:100,extension:'png',source:'Original test art'};
    return s.save({app:'wec-creative-studio',schema_version:1,id:crypto.randomUUID(),revision:0,kind:'art',title:'Pip collection',author:'Test',characterName:'Pip',character:'Cloud',style:'Watercolor',reference:asset,cover:null,backText:'',narration:'',duration:35,sceneCount:7,pages:[0,1,2].map(i=>({id:crypto.randomUUID(),text:'',prompt:'Pip scene '+i,asset,review:i===1?'needs_changes':'approved'}))});
   });
   await p.reload();await p.locator('#library .library-item button').first().click();await ready(p);
   await p.getByText('Use this idea in another format',{exact:true}).click();
   await p.locator('#promo-video').click();await ready(p);assert.match(await p.locator('#status').innerText(),/script first/);
   await p.locator('#promo-script').fill('word '.repeat(101));await p.locator('#promo-video').click();await ready(p);assert.match(await p.locator('#status').innerText(),/100 words/);assert.equal(await p.locator('#library .library-item').count(),1);
   await p.locator('#promo-script').fill('Meet Pip. Discover a little magic.');await p.locator('#save').click();await ready(p);
   accept=false;await p.locator('#promo-video').click();await ready(p);accept=true;assert.equal(await p.locator('#library .library-item').count(),1);
   await p.evaluate(()=>{window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...rest){const result=window.originalPut.call(this,value,...rest);if(this.name==='projects'&&value.kind==='video'){const tx=this.transaction;queueMicrotask(()=>tx.abort());}return result;};});
   await p.locator('#promo-video').click();await ready(p);
   assert.equal(await p.locator('#title').inputValue(),'Pip collection');assert.equal(await p.locator('#library .library-item').count(),1);
   assert.equal(await p.evaluate(async()=>(await (await import('/studio/store.js')).all('projects')).length),1);
   await p.evaluate(()=>{IDBObjectStore.prototype.put=window.originalPut;});
   await p.locator('#promo-video').click();await ready(p);
   assert.match(await p.locator('#status').innerText(),/Promotional video draft saved/);
   const draft=JSON.parse(await download(p,'#backup'));assert.equal(draft.pages.length,2);assert.equal(draft.kind,'video');assert.equal(draft.pages[0].review,'unreviewed');
   assert.deepEqual(draft.pages.map(x=>x.sourceArtwork.pageNumber),[1,3]);assert.equal(draft.pages[0].sourceArtwork.projectId,source.id);
   assert.equal(draft.pages[0].asset.image_base64,draft.pages[1].asset.image_base64);
   await p.locator('#check-sources').click();await ready(p);assert.match(await p.locator('#source-status').innerText(),/still match/);
   await p.evaluate(async id=>{const s=await import('/studio/store.js'),v=await s.get(id);v.style='Changed style';await s.save(v);},source.id);
   await p.locator('#check-sources').click();await ready(p);assert.match(await p.locator('#source-status').innerText(),/reference has changed/);
   assert.equal(JSON.parse(await download(p,'#backup')).pages[0].asset.image_base64,draft.pages[0].asset.image_base64);
   await p.reload();await p.locator('#library .library-item').filter({hasText:'promotional video'}).getByRole('button',{name:'Open',exact:true}).click();await ready(p);
   assert.equal(JSON.parse(await download(p,'#backup')).pages[0].sourceArtwork.sha256,draft.pages[0].sourceArtwork.sha256);
   // Old source links remain explicit after importing a separate backup copy.
   await p.locator('#restore').setInputFiles({name:'promo.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(draft))});await ready(p);
   assert.equal(JSON.parse(await download(p,'#backup')).pages[0].sourceArtwork.pageId,draft.pages[0].sourceArtwork.pageId);
   for(const sel of await p.locator('select[aria-label="Artwork review"]').all()){await sel.selectOption('approved');await ready(p);}
   await p.locator('#video').click();await ready(p);
   const job=p.locator('.render-job');await job.getByRole('button',{name:'Play video'}).waitFor({timeout:60000});
   await job.getByRole('button',{name:'Play video'}).click();await p.waitForFunction(()=>document.querySelector('#render-movie').readyState>=1);
   const w=p.waitForEvent('download');await job.getByRole('button',{name:'Download MP4'}).click();const movie=await(await w).path();assert.ok(fs.statSync(movie).size>1000);fs.copyFileSync(movie,path.join(directory,`promo-${width}.mp4`));
   await job.getByRole('button',{name:'Remove server copy'}).click();await p.waitForFunction(()=>!document.querySelector('.render-job'));
   await p.evaluate(async id=>{const s=await import('/studio/store.js'),db=await s.database();await new Promise((resolve,reject)=>{const tx=db.transaction(['projects'],'readwrite');tx.objectStore('projects').delete(id);tx.oncomplete=resolve;tx.onerror=reject;});db.close();},source.id);
   await p.locator('#check-sources').click();await ready(p);assert.match(await p.locator('#source-status').innerText(),/source is unavailable/);
   assert.equal(aiCalls,0);assert.deepEqual(errors,[]);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await p.screenshot({path:path.join(directory,`promo-${width}.png`),fullPage:true});await context.close();
  }
  console.log(JSON.stringify({passed:true,viewports:[390,1440],checks:'approved-only mapping, script persistence, cancellation, failed-save isolation, provenance and source warnings, backup restore, reload, real fixture MP4 playback/download, no AI calls',evidence:directory}));
 }finally{if(browser)await browser.close();server.kill('SIGTERM');}
})().catch(e=>{console.error(e.stack||e);process.exit(1);});
