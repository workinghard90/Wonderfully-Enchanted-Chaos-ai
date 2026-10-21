/* Bounded WEC artwork ZIPs only: stored entries, no extraction or network calls. */
export const LIMITS = Object.freeze({pages: 100, fileBytes: 10 * 1024 * 1024,
  totalBytes: 80 * 1024 * 1024, imagePixels: 24e6, totalPixels: 100e6});
const table = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ table[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
export function makeZip(entries) {
  if (!entries.length || entries.length > 101) throw Error('Invalid artwork archive size.');
  const encoder = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  const u16 = n => [n & 255, (n >>> 8) & 255];
  const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const entry of entries) {
    const name = encoder.encode(entry.name), data = entry.bytes;
    if (name.length > 65535 || offset + data.length > 0xffffffff) throw Error('Artwork archive is too large.');
    const crc = crc32(data);
    // UTF-8 flag, stored bytes and a fixed 1980-01-01 DOS date.
    const local = new Uint8Array([80,75,3,4,20,0,0,8,0,0,0,0,33,0,
      ...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),0,0,...name]);
    chunks.push(local, data);
    central.push(new Uint8Array([80,75,1,2,20,0,20,0,0,8,0,0,0,0,33,0,
      ...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),
      0,0,0,0,0,0,0,0,0,0,0,0,...u32(offset),...name]));
    offset += local.length + data.length;
  }
  const start = offset;
  for (const item of central) { chunks.push(item); offset += item.length; }
  chunks.push(new Uint8Array([80,75,5,6,0,0,0,0,...u16(entries.length),...u16(entries.length),
    ...u32(offset - start),...u32(start),0,0]));
  return new Blob(chunks, {type: 'application/zip'});
}


export async function readZip(file) {
  const invalid = () => Error('Choose an unmodified WEC artwork ZIP. Compressed, encrypted and ZIP64 archives are unsupported.');
  if (!file.size || file.size > LIMITS.totalBytes + 1024 * 1024) throw Error('WEC ZIP must be at most 81 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer()), view = new DataView(bytes.buffer);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);
  const check = (ok) => { if (!ok) throw invalid(); };
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) { end = i; break; }
  }
  check(end >= 0);
  const count = u16(end + 10), start = u32(end + 16), length = u32(end + 12);
  check(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === count);
  check(count >= 2 && count <= LIMITS.pages + 1 && start + length === end);
  const entries = new Map();
  let cursor = start, nextLocal = 0, total = 0;
  for (let i = 0; i < count; i++) {
    check(cursor + 46 <= end && u32(cursor) === 0x02014b50);
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
    const size = u32(cursor + 24), nameLength = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32);
    const local = u32(cursor + 42), nameStart = cursor + 46;
    check((flags & ~0x800) === 0 && method === 0 && u32(cursor + 20) === size);
    check(u16(cursor + 34) === 0 && nameLength > 0 && nameLength <= 128 && extra === 0);
    check(nameStart + nameLength + comment <= end && local === nextLocal);
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    check(name === 'manifest.json' || /^page-[0-9]{2,3}\.(png|jpg|jpeg|webp)$/.test(name));
    check(!entries.has(name));
    check(size > 0 && size <= (name === 'manifest.json' ? 256 * 1024 : LIMITS.fileBytes));
    check(local + 30 <= start && u32(local) === 0x04034b50);
    check(u16(local + 6) === flags && u16(local + 8) === method && u32(local + 14) === crc);
    check(u32(local + 18) === size && u32(local + 22) === size && u16(local + 26) === nameLength && u16(local + 28) === 0);
    const dataStart = local + 30 + nameLength;
    check(dataStart + size <= start);
    check(decoder.decode(bytes.subarray(local + 30, dataStart)) === name);
    const data = bytes.subarray(dataStart, dataStart + size);
    check(crc32(data) === crc);
    entries.set(name, data);
    if (name !== 'manifest.json') total += size;
    check(total <= LIMITS.totalBytes);
    nextLocal = dataStart + size;
    cursor = nameStart + nameLength + comment;
  }
  check(cursor === end && nextLocal === start && entries.has('manifest.json'));
  let manifest;
  try { manifest = JSON.parse(decoder.decode(entries.get('manifest.json'))); }
  catch { throw Error('The ZIP has an invalid WEC manifest.'); }
  check(manifest?.schema_version === 1 && typeof manifest.title === 'string' && manifest.title.length <= 150);
  check(typeof manifest.blank_backs === 'boolean' && manifest.paper === 'Letter');
  check(Array.isArray(manifest.artwork_box_inches) && manifest.artwork_box_inches.length === 2
    && manifest.artwork_box_inches[0] === 7.5 && manifest.artwork_box_inches[1] === 10);
  check(Array.isArray(manifest.pages) && manifest.pages.length === count - 1);
  const used = new Set(), pages = [];
  let pixels = 0;
  for (const [index, page] of manifest.pages.entries()) {
    check(page?.page === index + 1 && typeof page.file === 'string' && page.file !== 'manifest.json');
    check(!used.has(page.file) && entries.has(page.file)); used.add(page.file);
    check(typeof page.original === 'string' && page.original.length > 0 && page.original.length <= 512);
    check(Number.isSafeInteger(page.width) && Number.isSafeInteger(page.height) && page.width > 0 && page.height > 0);
    check(page.width * page.height <= LIMITS.imagePixels); pixels += page.width * page.height;
    check(pixels <= LIMITS.totalPixels);
    const extension = page.file.split('.').pop().replace('jpeg', 'jpg');
    const type = extension === 'jpg' ? 'image/jpeg' : 'image/' + extension;
    pages.push({name: page.original, file: new Blob([entries.get(page.file)], {type}),
      width: page.width, height: page.height, extension});
  }
  return {schema_version: 1, title: manifest.title, blank_backs: manifest.blank_backs, pages};
}
