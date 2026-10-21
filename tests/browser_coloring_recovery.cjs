/* Real IndexedDB + portable ZIP recovery. No backend artwork or inference calls. */
const {chromium}=require('playwright');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
 const python=process.env.PYTHON||'python', root=fs.mkdtempSync(path.join(os.tmpdir(),'wec-coloring-recovery-'));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==','base64');
 const fixture=spawnSync(python,['-c',`
import zipfile,json,sys,base64
from pathlib import Path
root=Path(sys.argv[1]); png=base64.b64decode(sys.argv[2])
for name,bad_data,width in [('invalid-image',True,40),('wrong-size',False,50)]:
 m={'schema_version':1,'title':'Broken book','blank_backs':True,'paper':'Letter','artwork_box_inches':[7.5,10],'pages':[
 {'page':1,'file':'page-001.png','original':'good.png','width':40,'height':30},
 {'page':2,'file':'page-002.png','original':'bad.png','width':width,'height':30}]}
 with zipfile.ZipFile(root/(name+'.zip'),'w') as z:
  z.writestr('page-001.png',png);z.writestr('page-002.png',b'\\x89PNG\\r\\n\\x1a\\ncorrupt' if bad_data else png)
  z.writestr('manifest.json',json.dumps(m))
`,root,png.toString('base64')],{encoding:'utf8'});assert.equal(fixture.status,0,fixture.stderr);
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const server=spawn(python,['-m','wec_engine.studio','--port',String(port),'--data-dir',root],{cwd:os.tmpdir(),env:{...process.env,WEC_STUDIO_TOKEN:'coloring-recovery-test-only-secret-32',WEC_ENABLE_IMAGE_GENERATION:'0',WEC_ENABLE_VIDEO_RENDER:'0'},stdio:['ignore','pipe','pipe']});
 const base=`http://127.0.0.1:${port}`;let browser,logs='';server.stderr.on('data',c=>{logs+=c});
 async function idle(page){await page.waitForFunction(()=>!document.querySelector('#upload')?.disabled)}
 async function saved(page){await page.locator('#device-status').filter({hasText:'Saved on this device:'}).waitFor()}
 async function record(page){return page.evaluate(async()=>{
  const {readBook}=await import('/coloring/project-store.js');const r=await readBook();
  if(!r?.snapshot)return r;
  return {...r,snapshot:{...r.snapshot,pages:await Promise.all(r.snapshot.pages.map(async p=>({...p,file:Array.from(new Uint8Array(await p.file.arrayBuffer()))})))}};
 })}
 async function download(page, name){const event=page.waitForEvent('download');await page.locator('#zip').click();const d=await event;const p=path.join(root,name);await d.saveAs(p);return p}
 try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break}catch{}if(server.exitCode!==null||i===99)throw Error(logs);await new Promise(r=>setTimeout(r,100))}
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}:{})});
  for(const viewport of [{width:390,height:844},{width:1440,height:1000}]){
   const context=await browser.newContext({viewport,acceptDownloads:true});const page=await context.newPage(),errors=[],api=[];let accept=true;
   page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>accept?d.accept():d.dismiss());page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))api.push(r.url())});
   await page.goto(base+'/coloring/');await idle(page);
   await page.locator('#upload').setInputFiles([{name:'first.png',mimeType:'image/png',buffer:png},{name:'second.png',mimeType:'image/png',buffer:png}]);
   await page.locator('#status').filter({hasText:'2 illustration(s)'}).waitFor();
   await page.locator('#title').fill('Saved book '+viewport.width);await page.locator('#blank').uncheck();
   await page.getByRole('button',{name:'Move later: page 1',exact:true}).click();await saved(page);
   const original=await record(page);assert.equal(original.snapshot.title,'Saved book '+viewport.width);assert.equal(original.snapshot.blank_backs,false);assert.equal(original.snapshot.pages[0].name,'second.png');
   assert.deepEqual(original.snapshot.pages[0].file,Array.from(png));
   const backup=await download(page,'book-'+viewport.width+'.zip');
   await page.reload();await idle(page);await saved(page);
   assert.equal(await page.locator('#title').inputValue(),original.snapshot.title);assert.ok(!(await page.locator('#blank').isChecked()));assert.equal(await page.locator('.page').count(),2);
   assert.deepEqual(await record(page),original); // Startup must not rewrite the saved version.
   if(process.env.WEC_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.WEC_SCREENSHOT_DIR,'coloring-recovery-'+viewport.width+'.png'),fullPage:true});
   // A second tab wins a save. The old tab must never silently overwrite it.
   const other=await context.newPage();await other.goto(base+'/coloring/');await idle(other);await other.locator('#title').fill('Another tab book');await saved(other);
   const newer=await record(page);assert.notEqual(newer.revision,original.revision);
   await page.locator('#blank').check();await page.locator('#device-status').filter({hasText:'Another tab changed'}).waitFor();
   assert.deepEqual(await record(page),newer);assert.ok(await page.locator('#device-save').isDisabled());
   accept=false;await page.locator('#device-load').click();assert.equal(await page.locator('#title').inputValue(),original.snapshot.title);
   accept=true;await page.locator('#device-load').click();await idle(page);assert.equal(await page.locator('#title').inputValue(),'Another tab book');await other.close();
   // A failed transaction retains the previous copy, while ZIP export still works.
   await page.evaluate(()=>{window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=()=>{throw new DOMException('Synthetic full storage','QuotaExceededError')}});
   await page.locator('#title').fill('Recover after quota');await page.locator('#device-status').filter({hasText:'could not be updated'}).waitFor();
   assert.deepEqual(await record(page),newer);await download(page,'quota-'+viewport.width+'.zip');
   await page.evaluate(()=>{IDBObjectStore.prototype.put=window.originalPut});await page.locator('#device-save').click();await saved(page);
   await page.reload();await idle(page);assert.equal(await page.locator('#title').inputValue(),'Recover after quota');
   // Pause removes only the stored copy and leaves open artwork exportable.
   accept=false;const beforePause=await record(page);await page.locator('#device-toggle').click();assert.deepEqual(await record(page),beforePause);
   accept=true;await page.locator('#device-toggle').click();await idle(page);assert.equal((await record(page)).paused,true);assert.equal((await record(page)).snapshot,undefined);assert.equal(await page.locator('.page').count(),2);
   await page.reload();await idle(page);assert.equal(await page.locator('.page').count(),0);
   await page.locator('#open-book').setInputFiles(backup);await page.locator('#status').filter({hasText:'Opened book ZIP'}).waitFor();await idle(page);
   assert.equal(await page.locator('#title').inputValue(),original.snapshot.title);assert.equal(await page.locator('.page').count(),2);assert.ok(!(await page.locator('#blank').isChecked()));assert.equal((await record(page)).paused,true);
   await page.locator('#device-toggle').click();await idle(page);await saved(page);
   // Cancellation, damaged bytes, bad images and lying dimensions keep the entire open book and saved copy.
   const beforeInvalid=await record(page);
   accept=false;await page.locator('#open-book').setInputFiles(backup);await idle(page);assert.deepEqual(await record(page),beforeInvalid);accept=true;
   const damaged=Buffer.from(fs.readFileSync(backup));damaged[42]^=1;
   for(const file of [{name:'damaged.zip',mimeType:'application/zip',buffer:damaged},path.join(root,'invalid-image.zip'),path.join(root,'wrong-size.zip')]){
    await page.locator('#open-book').setInputFiles(file);await page.locator('#status').filter({hasText:'Current pages were kept.'}).waitFor();await idle(page);
    assert.deepEqual(await record(page),beforeInvalid);assert.equal(await page.locator('.page').count(),2);assert.equal(await page.locator('#title').inputValue(),original.snapshot.title);
   }
   // A corrupt stored image is retained and must not partially auto-restore or get replaced at startup.
   await page.evaluate(async()=>{
    const {readBook,writeBook}=await import('/coloring/project-store.js');const r=await readBook();
    r.snapshot.pages[1].file=new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0])],{type:'image/png'});
    await writeBook(r.snapshot,r.revision);
   });
   const corrupt=await record(page);await page.reload();await idle(page);await page.locator('#device-status').filter({hasText:'could not be read'}).waitFor();
   assert.equal(await page.locator('.page').count(),0);assert.deepEqual(await record(page),corrupt);assert.ok(await page.locator('#device-save').isDisabled());
   await page.locator('#open-book').setInputFiles(backup);await page.locator('#status').filter({hasText:'Opened book ZIP'}).waitFor();await idle(page);assert.deepEqual(await record(page),corrupt);
   await page.locator('#device-toggle').click();await idle(page);await page.locator('#device-toggle').click();await idle(page);await saved(page);
   // Explicit clearing is remembered, so a refresh cannot unexpectedly bring deleted pages back.
   await page.locator('#clear').click();await saved(page);await page.reload();await idle(page);assert.equal(await page.locator('.page').count(),0);assert.equal((await record(page)).snapshot.pages.length,0);
   assert.deepEqual(api,[]);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   console.log(`PASS coloring recovery ${viewport.width}: auto-save/reload, original ZIP order/settings, atomic bad imports, corrupt saved image, cross-tab guard, quota retry, pause/resume, clear, no API/errors/overflow`);
   await context.close();
  }
  if(process.env.WEC_COLORING_SAMPLE_ZIP){
   const source=process.env.WEC_COLORING_SAMPLE_ZIP;
   const expected=spawnSync(python,['-c',`import zipfile,json,hashlib,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 m=json.loads(z.read('manifest.json'));print(json.dumps({'title':m['title'],'blank':m['blank_backs'],'pages':[{'name':p['original'],'sha':hashlib.sha256(z.read(p['file'])).hexdigest()} for p in m['pages']]}))
`,source],{encoding:'utf8'});assert.equal(expected.status,0,expected.stderr);const book=JSON.parse(expected.stdout);
   const context=await browser.newContext({acceptDownloads:true,viewport:{width:390,height:844}}),page=await context.newPage();
   await page.goto(base+'/coloring/');await idle(page);await page.locator('#open-book').setInputFiles(source);await page.locator('#status').filter({hasText:'Opened book ZIP'}).waitFor();await idle(page);await saved(page);
   const copied=await record(page),{createHash}=require('node:crypto');assert.equal(copied.snapshot.title,book.title);assert.equal(copied.snapshot.blank_backs,book.blank);
   assert.deepEqual(copied.snapshot.pages.map(p=>({name:p.name,sha:createHash('sha256').update(Buffer.from(p.file)).digest('hex')})),book.pages);
   const output=await download(page,'actual-pip-roundtrip.zip');
   const roundtrip=spawnSync(python,['-c',`import zipfile,json,hashlib,sys
with zipfile.ZipFile(sys.argv[1]) as a,zipfile.ZipFile(sys.argv[2]) as b:
 ma=json.loads(a.read('manifest.json'));mb=json.loads(b.read('manifest.json'))
 assert ma['title']==mb['title'] and ma['blank_backs']==mb['blank_backs']
 assert [hashlib.sha256(a.read(p['file'])).hexdigest() for p in ma['pages']]==[hashlib.sha256(b.read(p['file'])).hexdigest() for p in mb['pages']]
 assert b.testzip() is None
`,source,output],{encoding:'utf8'});assert.equal(roundtrip.status,0,roundtrip.stderr);
   await page.reload();await idle(page);assert.equal(await page.locator('.page').count(),book.pages.length);
   if(process.env.WEC_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.WEC_SCREENSHOT_DIR,'actual-pip-recovery.png'),fullPage:true});
   console.log('PASS supplied Pip ZIP: original title/order/settings and all image SHA-256 values survive import, device reload and ZIP re-export');await context.close();
  }
  const context=await browser.newContext({acceptDownloads:true});await context.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Synthetic blocked storage','SecurityError')}}));
  const page=await context.newPage();await page.goto(base+'/coloring/');await idle(page);await page.locator('#device-status').filter({hasText:'storage is unavailable'}).waitFor();
  await page.locator('#open-book').setInputFiles(path.join(root,'book-390.zip'));await page.locator('#status').filter({hasText:'Opened book ZIP'}).waitFor();await idle(page);assert.equal(await page.locator('.page').count(),2);await download(page,'no-storage.zip');
  console.log('PASS blocked device storage still permits ZIP import/edit/export');await context.close();
 }finally{if(browser)await browser.close();server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
