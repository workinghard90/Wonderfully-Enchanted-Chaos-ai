/* Small stored-entry ZIP writer. No dependencies or network requests. */
export function makeZip(entries) {
  if (!entries.length || entries.length > 101) throw Error('Invalid artwork archive size.');
  const encoder = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  const u16 = n => [n & 255, (n >>> 8) & 255];
  const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
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
