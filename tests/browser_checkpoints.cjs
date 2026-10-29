/* Real IndexedDB migration, atomic checkpoints and recovery copies; no AI calls. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wec-checkpoints-'));
  const token='test-only-checkpoint-token-32-characters';
  const server=spawn(process.env.PYTHON||'python',['-m','wec_engine.studio','--port',String(port),'--data-dir',directory],{cwd:os.tmpdir(),env:{...process.env,WEC_STUDIO_TOKEN:token,WEC_ENABLE_IMAGE_GENERATION:'0'},stdio:['ignore','pipe','pipe']});
  const base=`http://127.0.0.1:${port}`;
  const png='iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==';
  let browser,logs='';server.stderr.on('data',d=>logs+=d);
  const ready=p=>p.waitForFunction(()=>!document.querySelector('#save').disabled);
  async function backup(p){const wait=p.waitForEvent('download');await p.locator('#backup').click();const b=JSON.parse(fs.readFileSync(await (await wait).path(),'utf8'));await ready(p);return b;}
  async function info(p,id){return p.evaluate(async id=>(await import('/studio/store.js')).checkpointInfo(id),id);}
  try{
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(server.exitCode!==null||i===99)throw Error(logs||'Startup failed');await new Promise(r=>setTimeout(r,100));}
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}:{})});
    for(const width of [390,1440]){
      const context=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true});
      await context.addInitScript(t=>sessionStorage.setItem('wec_token',t),token);
      const p=await context.newPage(),errors=[];let accept=true;
      p.on('dialog',d=>accept?d.accept():d.dismiss());p.on('pageerror',e=>errors.push(e.message));
      await p.goto(base+'/api/health');
      // Build the actual previous schema before loading the new app.
      const sourceId=await p.evaluate(async encoded=>{
        const blob=new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'});
        const asset={blob,name:'original.png',extension:'png',width:40,height:30,source:'Saved original'};
        const value={schema_version:1,app:'wec-creative-studio',id:crypto.randomUUID(),revision:1,kind:'art',title:'Original project',author:'Test author',characterName:'Cloud',character:'Lavender cloud',style:'Watercolor',backText:'Back text',reference:asset,cover:asset,narration:'',duration:35,sceneCount:7,savedAt:Date.now(),pages:[{id:crypto.randomUUID(),text:'Original text',prompt:'Original prompt',asset,review:'approved',pendingGeneration:{id:'a'.repeat(32),mode:'text'}}]};
        await new Promise((resolve,reject)=>{const r=indexedDB.open('wec-creative-studio-v1',1);r.onupgradeneeded=()=>{for(const n of ['projects','summaries','profiles'])r.result.createObjectStore(n,{keyPath:'id'});};r.onerror=reject;r.onsuccess=()=>{const db=r.result,tx=db.transaction(['projects','summaries','profiles'],'readwrite');tx.objectStore('projects').put(value);tx.objectStore('summaries').put({id:value.id,title:value.title,kind:value.kind,count:1,savedAt:value.savedAt});tx.objectStore('profiles').put({id:'old-profile',name:'Old character',character:value.character,style:value.style,reference:asset});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};});
        return value.id;
      },png);
      await p.goto(base);await p.locator('#status').filter({hasText:'Choose a format'}).waitFor();
      await p.locator('#library .library-item button').first().click();await ready(p);
      const migrated=await backup(p);
      assert.equal(migrated.pages[0].asset.image_base64,png);assert.equal(migrated.reference.image_base64,png);
      assert.equal(await p.evaluate(async()=>{const s=await import('/studio/store.js'),db=await s.database();const version=db.version;db.close();return version;}),2);
      assert.equal(await p.evaluate(async()=>(await (await import('/studio/store.js')).all('profiles')).length),1);
      await p.locator('#checkpoint-panel summary').click();
      await p.locator('#checkpoint-status').filter({hasText:'No checkpoint'}).waitFor();
      await p.locator('#checkpoint-save').click();await ready(p);
      const originalCheckpoint=await info(p,sourceId);assert.ok(originalCheckpoint.checkpointId);
      await p.locator('#title').fill('Modified original');await p.locator('.page textarea').last().fill('Changed prompt');
      await p.locator('#save').click();await ready(p);
      const changedPNG=Buffer.from(await p.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=40;const g=c.getContext('2d');g.fillStyle='green';g.fillRect(0,0,40,40);return c.toDataURL().split(',')[1];}),'base64');
      await p.locator('.page input[type=file]').setInputFiles({name:'changed.png',mimeType:'image/png',buffer:changedPNG});await ready(p);
      accept=false;await p.locator('#checkpoint-save').click();await ready(p);accept=true;
      assert.equal((await info(p,sourceId)).checkpointId,originalCheckpoint.checkpointId);
      await p.locator('#checkpoint-open').click();await ready(p);
      const copy=await backup(p);
      assert.notEqual(copy.id,sourceId);assert.equal(copy.pages[0].asset.image_base64,png);
      assert.equal(copy.pages[0].prompt,'Original prompt');assert.equal(copy.pages[0].review,'approved');
      assert.equal(copy.cover.image_base64,png);assert.equal(copy.reference.image_base64,png);
      assert.equal(copy.pages[0].pendingGeneration.id,'a'.repeat(32));
      assert.equal(await info(p,copy.id),null);
      assert.equal(await p.evaluate(async id=>(await (await import('/studio/store.js')).get(id)).title,sourceId),'Modified original');
      assert.equal(await p.locator('#library .library-item').count(),2);
      await p.locator('#library .library-item').filter({hasText:'Modified original'}).getByRole('button',{name:'Open',exact:true}).click();await ready(p);
      assert.equal((await backup(p)).pages[0].asset.image_base64,changedPNG.toString('base64'));
      // Simulate a quota failure while replacing the checkpoint; preserve the old one.
      await p.evaluate(()=>{window.oldPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='checkpoints')throw new DOMException('Full','QuotaExceededError');return window.oldPut.apply(this,args);};});
      await p.locator('#checkpoint-save').click();await ready(p);
      assert.match(await p.locator('#status').innerText(),/previous checkpoint was kept/);
      await p.evaluate(()=>{IDBObjectStore.prototype.put=window.oldPut;});
      assert.equal((await info(p,sourceId)).checkpointId,originalCheckpoint.checkpointId);
      // Fail the second write of recovery: no orphan project and no editor switch.
      await p.evaluate(()=>{window.oldAdd=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(...args){if(this.name==='summaries')throw new DOMException('Full','QuotaExceededError');return window.oldAdd.apply(this,args);};});
      await p.locator('#checkpoint-open').click();await ready(p);
      assert.match(await p.locator('#status').innerText(),/could not be saved/);
      await p.evaluate(()=>{IDBObjectStore.prototype.add=window.oldAdd;});
      assert.equal((await backup(p)).id,sourceId);
      const counts=await p.evaluate(async()=>{const s=await import('/studio/store.js');return[(await s.all('projects')).length,(await s.all()).length];});
      assert.deepEqual(counts,[2,2]);
      // Stale tabs cannot capture a newer revision or replace/remove a newer checkpoint.
      const conflicts=await p.evaluate(async id=>{
        const s=await import('/studio/store.js'),old=await s.get(id),previous=await s.checkpointInfo(id);
        const newer=await s.save({...old,author:'Changed in another tab'});
        const errors=[];
        try{await s.saveCheckpoint(old,previous.checkpointId);}catch(e){errors.push(e.message);}
        const current=await s.saveCheckpoint(newer,previous.checkpointId);
        for(const operation of [()=>s.saveCheckpoint(newer,previous.checkpointId),()=>s.openCheckpointCopy(id,previous.checkpointId),()=>s.removeCheckpoint(id,previous.checkpointId)]){
          try{await operation();}catch(e){errors.push(e.message);}
        }
        return {errors,current,count:(await s.all('checkpoints')).length};
      },sourceId);
      assert.equal(conflicts.errors.length,4);assert.equal(conflicts.count,1);
      assert.notEqual(conflicts.current.checkpointId,originalCheckpoint.checkpointId);
      await p.reload();await p.locator('#status').filter({hasText:'Choose a format'}).waitFor();
      await p.locator('#library .library-item').filter({hasText:'Modified original'}).getByRole('button',{name:'Open',exact:true}).click();await ready(p);
      await p.locator('#checkpoint-panel summary').click();
      await p.locator('#checkpoint-status').filter({hasText:'Checkpoint saved'}).waitFor();
      accept=false;await p.locator('#checkpoint-remove').click();await ready(p);accept=true;
      assert.ok(await info(p,sourceId));
      await p.locator('#checkpoint-remove').click();await ready(p);assert.equal(await info(p,sourceId),null);
      assert.equal(await p.locator('#library .library-item').count(),2);
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
      // Portable recovery survives a clean browser, with both versions and original bytes.
      await p.locator('#checkpoint-save').click();await ready(p);
      await p.locator('#title').fill('Latest portable version');
      await p.locator('#save').click();await ready(p);
      const downloaded=p.waitForEvent('download');
      await p.locator('#recovery-package').click();
      const packageBytes=fs.readFileSync(await (await downloaded).path());await ready(p);
      const envelope=JSON.parse(packageBytes),payload=JSON.parse(envelope.payload);
      assert.equal(envelope.package_version,1);
      assert.equal(payload.project.title,'Latest portable version');
      assert.equal(payload.checkpoint.project.title,'Modified original');
      assert.equal(payload.project.pages[0].asset.image_base64,changedPNG.toString('base64'));
      const before=(await backup(p)).id;
      const corrupt={...envelope,payload:envelope.payload.replace('Latest portable version','Corrupt portable version')};
      await p.locator('#restore').setInputFiles({name:'corrupt.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(corrupt))});await ready(p);
      assert.match(await p.locator('#status').innerText(),/checksum does not match/);
      assert.equal((await backup(p)).id,before);
      const badContent=JSON.parse(envelope.payload);
      badContent.checkpoint.project.id='unrelated-project';
      const badPayload=JSON.stringify(badContent);
      const badRelation={...envelope,payload:badPayload,sha256:require('node:crypto').createHash('sha256').update(badPayload).digest('hex')};
      await p.locator('#restore').setInputFiles({name:'relationship.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(badRelation))});await ready(p);
      assert.match(await p.locator('#status').innerText(),/checkpoint relationship/);
      const future={...envelope,package_version:99};
      await p.locator('#restore').setInputFiles({name:'future.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(future))});await ready(p);
      assert.match(await p.locator('#status').innerText(),/Unsupported recovery package/);
      const stale=await p.evaluate(async id=>{const s=await import('/studio/store.js');try{await s.recoverySnapshot(id,-1);return false;}catch(e){return e.message.includes('changed in another tab');}},before);
      assert.equal(stale,true);
      // Failure on the final checkpoint write rolls back the project and summary.
      await p.evaluate(()=>{window.oldAdd=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(...args){if(this.name==='checkpoints')throw new DOMException('Full','QuotaExceededError');return window.oldAdd.apply(this,args);};});
      await p.locator('#restore').setInputFiles({name:'recovery.json',mimeType:'application/json',buffer:packageBytes});await ready(p);
      assert.match(await p.locator('#status').innerText(),/could not be saved/);
      await p.evaluate(()=>{IDBObjectStore.prototype.add=window.oldAdd;});
      assert.equal((await backup(p)).id,before);
      assert.deepEqual(await p.evaluate(async()=>{const s=await import('/studio/store.js');return[(await s.all('projects')).length,(await s.all()).length];}),[2,2]);
      const clean=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true});
      const q=await clean.newPage();q.on('dialog',d=>d.accept());
      await q.goto(base);await q.locator('#status').filter({hasText:'Choose a format'}).waitFor();await ready(q);
      await q.locator('#restore').setInputFiles({name:'recovery.json',mimeType:'application/json',buffer:packageBytes});await ready(q);
      assert.match(await q.locator('#status').innerText(),/with its checkpoint/);
      const restored=await backup(q);assert.notEqual(restored.id,before);
      assert.equal(restored.title,'Latest portable version');
      assert.equal(restored.pages[0].asset.image_base64,changedPNG.toString('base64'));
      assert.equal(restored.pages[0].pendingGeneration.id,'a'.repeat(32));
      await q.locator('#checkpoint-panel summary').click();
      await q.locator('#checkpoint-open').click();await ready(q);
      assert.equal((await backup(q)).title,'Modified original — checkpoint');
      // A package without a checkpoint also restores, with no synthetic checkpoint.
      const noCheckpoint=q.waitForEvent('download');await q.locator('#recovery-package').click();
      const plain=fs.readFileSync(await (await noCheckpoint).path());await ready(q);
      assert.equal(JSON.parse(JSON.parse(plain).payload).checkpoint,null);
      await q.locator('#restore').setInputFiles({name:'plain.json',mimeType:'application/json',buffer:plain});await ready(q);
      assert.equal(await info(q,(await backup(q)).id),null);
      await clean.close();
      await p.screenshot({path:path.join(directory,`checkpoint-${width}.png`),fullPage:true});
      await context.close();
    }
    // An old tab holding the database receives actionable guidance, then upgrade recovers.
    const blocked=await browser.newContext(),p=await blocked.newPage();await p.goto(base+'/api/health');
    const blockedResult=await p.evaluate(async()=>{
      window.held=await new Promise(resolve=>{const r=indexedDB.open('wec-creative-studio-v1',1);r.onupgradeneeded=()=>{for(const n of ['projects','summaries','profiles'])r.result.createObjectStore(n,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);});
      const s=await import('/studio/store.js');let message='';try{await s.database();}catch(e){message=e.message;}
      window.held.close();const upgraded=await s.database();const version=upgraded.version;
      // New code closes its handle on a future versionchange rather than blocking other tabs.
      await new Promise((resolve,reject)=>{const r=indexedDB.open('wec-creative-studio-v1',3);r.onsuccess=()=>{r.result.close();resolve();};r.onerror=reject;});
      let refresh='';try{await s.database();}catch(e){refresh=e.message;}
      return {message,version,refresh};
    });
    assert.match(blockedResult.message,/Close other WEC tabs/);assert.equal(blockedResult.version,2);assert.match(blockedResult.refresh,/Refresh this WEC tab/);await blocked.close();
    console.log(JSON.stringify({passed:true,viewports:[390,1440],checks:'v1 migration preserves originals and profiles, checkpoint isolation, backup fields and receipt preservation, confirmation, reload, atomic quota rollback, revision and checkpoint conflicts, removal, blocked upgrade and versionchange handling; portable current/checkpoint package, clean-browser restore, payload integrity, invalid relationships/versions, failed final-write rollback, no-checkpoint import',evidence:directory}));
  }finally{if(browser)await browser.close();server.kill('SIGTERM');}
})().catch(e=>{console.error(e);process.exitCode=1;});
