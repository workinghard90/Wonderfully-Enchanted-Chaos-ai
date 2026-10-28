/* Real device storage and HTTP shell; all AI calls are intercepted fixtures. */
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
(async () => {
  const listener = net.createServer();
  await new Promise(r => listener.listen(0,'127.0.0.1',r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'wec-image-recovery-'));
  const token = 'test-only-image-recovery-token-32-characters';
  const server = spawn(process.env.PYTHON || 'python', ['-m','wec_engine.studio','--port',String(port),'--data-dir',directory], {
    cwd:os.tmpdir(), env:{...process.env,WEC_STUDIO_TOKEN:token,WEC_ENABLE_IMAGE_GENERATION:'0'}, stdio:['ignore','pipe','pipe']});
  const base = `http://127.0.0.1:${port}`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQEAAAQAMPSvIScVfJ6twHI6XtRPKxaLxWKxWCwWi8XiiwX6KQHghAeRJQAAAABJRU5ErkJggg==','base64');
  let browser, logs=''; server.stderr.on('data',d=>logs+=d);
  const ready = p => p.waitForFunction(()=>!document.querySelector('#save').disabled);
  async function backup(p) {
    const downloaded=p.waitForEvent('download'); await p.locator('#backup').click();
    return JSON.parse(fs.readFileSync(await (await downloaded).path(),'utf8'));
  }
  async function fullStorage(p, fail) {
    await p.evaluate(fail=>{
      if (fail) {
        window.originalTransaction=IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction=function(stores,mode,...rest) {
          if(mode==='readwrite') throw new DOMException('Device storage full','QuotaExceededError');
          return window.originalTransaction.call(this,stores,mode,...rest);
        };
      } else IDBDatabase.prototype.transaction=window.originalTransaction;
    },fail);
  }
  try {
    for(let i=0;i<100;i++) {
      try {if((await fetch(base+'/api/health')).ok) break;} catch {}
      if(server.exitCode!==null || i===99) throw Error(logs || 'Server startup failed');
      await new Promise(r=>setTimeout(r,100));
    }
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']} : {})});
    for(const width of [390,1440]) {
      const context=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true});
      await context.addInitScript(t=>sessionStorage.setItem('wec_token',t),token);
      let calls=0,checks=0,used=0,state='running',accept=true,request;
      await context.route('**/api/generation',r=>r.fulfill({json:{ready:true,creative_ready:true,attempts_today:used,daily_limit:20}}));
      await context.route('**/api/creative/image',r=>{calls++;request=r.request().postDataJSON();return r.abort('failed');});
      let generated;
      await context.route('**/api/creative/image-requests/*',r=>{
        checks++; assert.ok(r.request().url().endsWith(request.request_id));
        return state==='ready' ? r.fulfill({contentType:'image/png',body:generated}) :
          r.fulfill({status:state==='running'?202:404,json:{error:state==='running'?'Still generating.':'No saved result was found.',request_state:state}});
      });
      const p=await context.newPage(), errors=[];
      p.on('pageerror',e=>errors.push(e.message));
      p.on('dialog',d=>accept?d.accept():d.dismiss());
      await p.goto(base); await p.locator('#status').filter({hasText:'Choose a format'}).waitFor();
      generated=Buffer.from(await p.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=40;const g=c.getContext('2d');g.fillStyle='green';g.fillRect(0,0,40,40);return c.toDataURL('image/png').split(',')[1];}),'base64');
      await p.locator('[data-kind=art]').click();await ready(p);
      await p.locator('#pictures').setInputFiles({name:'original.png',mimeType:'image/png',buffer:png});
      await p.locator('#status').filter({hasText:'1 picture(s) added and saved'}).waitFor();
      await fullStorage(p,true);
      await p.locator('[data-generate]').click();await ready(p);
      assert.match(await p.locator('#status').innerText(),/Device storage full/);
      assert.equal(calls,0,'Failed receipt save must not contact the provider');
      await fullStorage(p,false);
      await p.locator('[data-generate]').click();await ready(p);
      assert.equal(calls,1);assert.match(request.request_id,/^[a-f0-9]{32}$/);
      const pending=await backup(p);
      assert.equal(pending.pages[0].pendingGeneration.id,request.request_id);
      assert.equal(pending.pages[0].asset.image_base64,png.toString('base64'));
      await p.reload();await p.locator('#status').filter({hasText:'Choose a format'}).waitFor();
      await p.locator('#library .library-item button').first().click();await ready(p);
      await p.locator('[data-generate]').click();await ready(p);
      assert.equal(calls,1,'Reload must not resubmit or allow unresolved generation');
      // JSON recovery preserves the receipt too; restored projects still require explicit attachment.
      await p.locator('#restore').setInputFiles({name:'pending.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pending))});
      await p.locator('#status').filter({hasText:'Backup restored'}).waitFor();
      used=20;await p.locator('#check-ai').click();await ready(p);
      assert.equal(await p.locator('[data-generate]').isDisabled(),true);
      await p.getByRole('button',{name:'Check generated picture',exact:true}).click();await ready(p);
      assert.match(await p.locator('#status').innerText(),/Still generating/);
      assert.equal(calls,1);
      state='ready';accept=false;
      await p.getByRole('button',{name:'Check generated picture',exact:true}).click();await ready(p);
      assert.equal((await backup(p)).pages[0].asset.image_base64,png.toString('base64'));
      accept=true;await fullStorage(p,true);
      await p.getByRole('button',{name:'Check generated picture',exact:true}).click();await ready(p);
      assert.match(await p.locator('#status').innerText(),/Device storage full/);
      const failedSave=await backup(p);
      assert.equal(failedSave.pages[0].asset.image_base64,png.toString('base64'));
      assert.equal(failedSave.pages[0].pendingGeneration.id,request.request_id);
      await fullStorage(p,false);
      await p.getByRole('button',{name:'Check generated picture',exact:true}).click();await ready(p);
      const recovered=await backup(p);
      assert.equal(recovered.pages[0].asset.image_base64,generated.toString('base64'));
      assert.equal(recovered.pages[0].review,'unreviewed');
      assert.equal(recovered.pages[0].pendingGeneration,undefined);
      assert.equal(calls,1);assert.equal(checks,4);
      assert.equal(await p.getByRole('button',{name:'Check generated picture',exact:true}).count(),0);
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
      await p.screenshot({path:path.join(directory,`recovery-${width}.png`),fullPage:true});
      await context.close();
    }
    console.log(JSON.stringify({passed:true,viewports:[390,1440],checks:'receipt saved before submission, network loss, reload and backup restore, no duplicate calls, running recovery, recovery after daily quota, replacement consent, failed device save preservation, original-byte recovery',evidence:directory}));
  } finally {if(browser) await browser.close();server.kill('SIGTERM');}
})().catch(e=>{console.error(e);process.exitCode=1;});
