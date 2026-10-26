/* Real packaged HTTP app, local fixtures only. Never calls an AI provider. */
const {chromium} = require('playwright');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), net = require('node:net');
(async () => {
  const python = process.env.PYTHON || 'python';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wec-coloring-'));
  const fixtures = spawnSync(python, ['-c', `
from PIL import Image
from pathlib import Path
p=Path(__import__('sys').argv[1])
Image.new('RGB',(3000,1000),'#8b59e8').save(p/'wide.png')
Image.new('RGB',(300,600),'#167c8b').save(p/'tall.jpg')
`, directory], {encoding: 'utf8'});
  assert.equal(fixtures.status, 0, fixtures.stderr);
  const wide = fs.readFileSync(path.join(directory, 'wide.png'));
  const tall = fs.readFileSync(path.join(directory, 'tall.jpg'));
  const listener = net.createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const server = spawn(python, ['-m', 'wec_engine.studio', '--port', String(port), '--data-dir', directory], {
    cwd: os.tmpdir(), env: {...process.env, WEC_STUDIO_TOKEN: 'coloring-test-only-secret-32-characters',
      WEC_ENABLE_IMAGE_GENERATION: '0', WEC_ENABLE_VIDEO_RENDER: '0'}, stdio: ['ignore', 'pipe', 'pipe']});
  const base = `http://127.0.0.1:${port}`;
  let browser, logs = '';
  server.stderr.on('data', data => { logs += data; });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
      if (server.exitCode !== null || i === 99) throw Error('Startup failed: ' + logs);
      await new Promise(r => setTimeout(r, 100));
    }
    browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? {
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage']} : {})});
    for (const viewport of [{width: 390, height: 844}, {width: 1440, height: 1000}]) {
      const context = await browser.newContext({viewport, acceptDownloads: true});
      const page = await context.newPage(), errors = [], traffic = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', req => { if (req.url().startsWith('http')) traffic.push(req); });
      let acceptClear = false;
      page.on('dialog', dialog => acceptClear ? dialog.accept() : dialog.dismiss());
      await page.goto(base + '/coloring');
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('0 illustration'));
      await page.waitForFunction(() => !document.querySelector('#upload').disabled);
      assert.equal(await page.locator('header a').getAttribute('href'), '/');
      assert.equal(await page.locator('header a').getAttribute('target'), null);
      assert.match(await page.locator('header a').innerText(), /All studios/);
      assert.ok(await page.locator('#zip').isDisabled());
      assert.ok(await page.locator('#print-report').isDisabled());
      const loadedTraffic = traffic.length;
      await page.locator('#upload').setInputFiles([
        {name: 'wide-unknown-mime.png', mimeType: '', buffer: wide},
        {name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image')},
        {name: 'tall.jpg', mimeType: 'image/jpeg', buffer: tall},
      ]);
      await page.locator('#status').filter({hasText: '2 illustration(s), 4 printable pages'}).waitFor();
      assert.match(await page.locator('#status').innerText(), /broken.png.*Failed|Failed: broken.png/);
      assert.equal(await page.locator('.page').count(), 2);
      assert.match(await page.locator('.page').first().innerText(), /400 PPI.*target met/);
      assert.equal(await page.locator('#printPages .print-page').count(), 4);
      await page.getByRole('button', {name: 'Move later: page 1', exact: true}).click();
      assert.match(await page.locator('.page').first().innerText(), /tall.jpg/);
      await page.locator('#title').fill('My Test Book');
      assert.match(await page.locator('#print-check-status').innerText(), /needs work/);
      assert.match(await page.locator('#print-checks').innerText(), /4 exported pages/);
      assert.match(await page.locator('#print-problems').innerText(), /tall.jpg/);
      const reportDownload = page.waitForEvent('download');
      await page.locator('#print-report').click();
      const reportPath = path.join(directory, 'print-check.json');
      await (await reportDownload).saveAs(reportPath);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert.equal(report.title, 'My Test Book');
      assert.equal(report.exported_pages, 4);
      assert.equal(report.basic_checks_pass, false);
      assert.equal(report.pdf_file_inspected, false);
      assert.equal(report.pages[0].name, 'tall.jpg');
      assert.equal(report.pages[1].effective_ppi, 400);
      const downloaded = page.waitForEvent('download');
      await page.locator('#zip').click();
      const archive = await downloaded;
      assert.equal(archive.suggestedFilename(), 'My-Test-Book-artwork.zip');
      const zipPath = path.join(directory, `book-${viewport.width}.zip`);
      await archive.saveAs(zipPath);
      const inspected = spawnSync(python, ['-c', `
import json,zipfile,sys
from pathlib import Path
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert z.namelist()==['page-001.jpg','page-002.png','manifest.json']
 assert z.read('page-001.jpg')==Path(sys.argv[2],'tall.jpg').read_bytes()
 assert z.read('page-002.png')==Path(sys.argv[2],'wide.png').read_bytes()
 m=json.loads(z.read('manifest.json'))
 assert m['title']=='My Test Book' and m['blank_backs'] is True
 assert m['pages'][0]['original']=='tall.jpg'
 assert m['pages'][1]['ppi_at_fitted_size']==400
`, zipPath, directory], {encoding: 'utf8'});
      assert.equal(inspected.status, 0, inspected.stderr);
      // Print waits for image readiness. Capture print invocation, then produce the actual layout PDF.
      await page.evaluate(() => { window.print = () => { window.printCalls = (window.printCalls || 0) + 1; }; });
      await page.locator('#print').click();
      await page.waitForFunction(() => window.printCalls === 1);
      assert.equal(await page.title(), 'My Test Book');
      const pdf = await page.pdf({preferCSSPageSize: true, printBackground: true});
      const proofPath = path.join(directory, `proof-${viewport.width}.pdf`);
      fs.writeFileSync(proofPath, pdf);
      const inspection = spawnSync(python, [path.join(__dirname, 'inspect_coloring_pdf.py'), proofPath], {encoding: 'utf8'});
      assert.equal(inspection.status, 0, inspection.stdout + inspection.stderr);
      const text = pdf.toString('latin1');
      assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 4);
      assert.match(text, /\/MediaBox\s*\[0 0 612 792\]/);
      if (process.env.WEC_SCREENSHOT_DIR) {
        fs.writeFileSync(path.join(process.env.WEC_SCREENSHOT_DIR, `coloring-${viewport.width}.pdf`), pdf);
        await page.screenshot({path: path.join(process.env.WEC_SCREENSHOT_DIR, `coloring-${viewport.width}.png`), fullPage: true});
      }
      await page.locator('#blank').uncheck();
      assert.equal(await page.locator('#printPages .print-page').count(), 2);
      assert.match(await page.locator('#print-checks').innerText(), /2 exported pages/);
      await page.locator('#clear').click(); // Cancel: original workspace remains.
      assert.equal(await page.locator('.page').count(), 2);
      // Slow a real import to verify controls can't race a clear/export against it.
      await page.evaluate(() => {
        const original = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = async function () {
          await new Promise(r => setTimeout(r, 500)); return original.call(this);
        };
      });
      await page.locator('#upload').setInputFiles({name: 'third.png', mimeType: 'image/png', buffer: wide});
      await page.locator('#status').filter({hasText: 'Loading file'}).waitFor();
      assert.ok(await page.locator('#clear').isDisabled());
      assert.ok(await page.locator('#zip').isDisabled());
      assert.ok(await page.getByRole('button', {name: 'Move later: page 1', exact: true}).isDisabled());
      await page.locator('#status').filter({hasText: '3 illustration(s), 3 printable pages'}).waitFor();
      assert.ok(await page.locator('#print-odd-count').isVisible());
      await page.getByRole('button', {name: 'Remove page 3', exact: true}).click();
      assert.ok(await page.locator('#print-odd-count').isHidden());
      assert.equal(await page.locator('.page').count(), 2);
      await page.locator('#upload').setInputFiles({name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1)});
      await page.locator('#status').filter({hasText: '10 MiB'}).waitFor();
      assert.equal(await page.locator('.page').count(), 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(traffic.length, loadedTraffic, 'Artwork operations must not call the backend or external servers.');
      assert.deepEqual(errors, []);
      acceptClear = true;
      await page.locator('#clear').click();
      assert.equal(await page.locator('.page').count(), 0);
      assert.ok(await page.locator('#zip').isDisabled());
      console.log(`PASS coloring ${viewport.width}: import/errors, PPI, ordering, byte-exact ZIP+CRC, four-page PDF, exclusion, limits, clear, no artwork traffic/overflow/errors`);
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill(); await new Promise(r => server.exitCode !== null ? r() : server.once('exit', r));
    fs.rmSync(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exit(1); });
