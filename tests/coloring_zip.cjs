/* ZIP parser regression: bounded structural checks plus independent Python ZIP fixtures. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../wec_engine/studio_web/coloring/zip.js'), 'utf8');
  const {makeZip, readZip} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const art = Uint8Array.from([137,80,78,71,13,10,26,10,0,1,2,3]);
  const page = {page: 1, file: 'page-001.png', original: 'my drawing.png', width: 40, height: 30};
  const manifest = {schema_version: 1, title: 'A book', blank_backs: true, paper: 'Letter', artwork_box_inches: [7.5,10], pages: [page]};
  const encode = value => new TextEncoder().encode(JSON.stringify(value));
  const zip = (m = manifest, data = art) => makeZip([{name: 'page-001.png', bytes: data}, {name: 'manifest.json', bytes: encode(m)}]);
  const opened = await readZip(zip());
  assert.equal(opened.title, 'A book'); assert.equal(opened.pages[0].name, 'my drawing.png');
  assert.deepEqual(new Uint8Array(await opened.pages[0].file.arrayBuffer()), art);
  const data = new Uint8Array(await zip().arrayBuffer()); data[42] ^= 1;
  await assert.rejects(readZip(new Blob([data]))); // Original CRC must reject altered artwork.
  await assert.rejects(readZip(new Blob([new Uint8Array([1,2,3])])));
  await assert.rejects(readZip({size: 82 * 1024 * 1024, arrayBuffer() { throw Error('Must not allocate oversized input'); }}), /81 MiB/);
  for (const bad of [
    {...manifest, schema_version: 99}, {...manifest, pages: []},
    {...manifest, pages: [{...page, file: '../page-001.png'}]},
    {...manifest, pages: [{...page, width: 10000000}]},
    {...manifest, pages: [{...page, width: 1.1}]},
    {...manifest, title: 'x'.repeat(151)}, {...manifest, blank_backs: 'true'},
    {...manifest, pages: [page, {...page, page: 2}]},
  ]) await assert.rejects(readZip(zip(bad)));
  const py = spawnSync(process.env.PYTHON || 'python', ['-c', `
import io,zipfile,json,base64,sys
m=json.loads(sys.stdin.read()); out={}
for name, method, duplicate, filename in [('stored',0,False,'page-001.png'),('deflated',8,False,'page-001.png'),('duplicate',0,True,'page-001.png'),('traversal',0,False,'../page-001.png')]:
 b=io.BytesIO()
 with zipfile.ZipFile(b,'w',compression=method) as z:
  z.writestr(filename,b'art')
  if duplicate:z.writestr(filename,b'art')
  z.writestr('manifest.json',json.dumps(m))
 out[name]=base64.b64encode(b.getvalue()).decode()
print(json.dumps(out))
`], {input: JSON.stringify(manifest), encoding: 'utf8'});
  assert.equal(py.status, 0, py.stderr);
  const fixtures = JSON.parse(py.stdout);
  assert.equal((await readZip(new Blob([Buffer.from(fixtures.stored, 'base64')]))).pages.length, 1);
  for (const key of ['deflated', 'duplicate', 'traversal']) {
    await assert.rejects(readZip(new Blob([Buffer.from(fixtures[key], 'base64')])));
  }
  console.log('PASS coloring ZIP: original bytes, CRC damage, truncation, bounds, schema, duplicate/missing paths, dimensions, independent stored ZIP and unsupported compression');
})().catch(error => {console.error(error); process.exit(1);});
