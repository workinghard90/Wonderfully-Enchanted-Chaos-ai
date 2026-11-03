/* Verify a WEC video production ZIP entirely on the owner's device.
 * Deliberately supports only the four stored entries written by VideoJobs.
 * No upload, extraction, external libraries, generation or server mutation.
 */
import { crc32 } from '/coloring/zip.js';

const MAX_ARCHIVE = 65 * 1024 * 1024;
const MAX_BYTES = {
  'movie.mp4': 20_000_000,
  'render-inputs.json': 40 * 1024 * 1024,
  'manifest.json': 64 * 1024,
  'README.txt': 8 * 1024,
};
const allowed = Object.keys(MAX_BYTES);
const invalid = () => Error('This video package is incomplete, modified, or unsupported. Keep the server copy and try downloading a fresh package.');
const assert = condition => { if (!condition) throw invalid(); };

export async function verifyVideoPackage(file, { includeRecovery = false } = {}) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 256 || file.size > MAX_ARCHIVE) {
    throw Error('Choose a WEC video production ZIP no larger than 65 MiB.');
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const u16 = pos => view.getUint16(pos, true);
  const u32 = pos => view.getUint32(pos, true);
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  assert(end >= 0);
  const count = u16(end + 10);
  const start = u32(end + 16), centralSize = u32(end + 12);
  assert(u16(end + 4) === 0 && u16(end + 6) === 0 &&
         u16(end + 8) === count && count === allowed.length);
  assert(start + centralSize === end);

  const entries = new Map();
  let cursor = start, nextLocal = 0;
  for (let i = 0; i < count; i++) {
    assert(cursor + 46 <= end && u32(cursor) === 0x02014b50);
    const flags = u16(cursor + 8), method = u16(cursor + 10);
    const crc = u32(cursor + 16), size = u32(cursor + 24);
    const nameLen = u16(cursor + 28), extraLen = u16(cursor + 30),
          commentLen = u16(cursor + 32), local = u32(cursor + 42);
    assert((flags & ~0x800) === 0 && method === 0 && u32(cursor + 20) === size);
    assert(u16(cursor + 34) === 0 && nameLen > 0 && nameLen <= 32 &&
           extraLen === 0 && commentLen === 0);
    assert(cursor + 46 + nameLen === end || cursor + 46 + nameLen < end);
    assert(local === nextLocal && local + 30 <= start && u32(local) === 0x04034b50);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    assert(allowed.includes(name) && !entries.has(name) &&
           size > 0 && size <= MAX_BYTES[name]);
    assert(u16(local + 6) === flags && u16(local + 8) === method &&
           u32(local + 14) === crc && u32(local + 18) === size &&
           u32(local + 22) === size && u16(local + 26) === nameLen &&
           u16(local + 28) === 0);
    const dataStart = local + 30 + nameLen;
    assert(dataStart + size <= start);
    assert(decoder.decode(bytes.subarray(local + 30, dataStart)) === name);
    const entry = bytes.subarray(dataStart, dataStart + size);
    assert(crc32(entry) === crc);
    entries.set(name, entry);
    cursor += 46 + nameLen;
    nextLocal = dataStart + size;
  }
  assert(cursor === end && nextLocal === start &&
         entries.size === allowed.length);

  let manifest;
  try { manifest = JSON.parse(decoder.decode(entries.get('manifest.json'))); }
  catch { throw invalid(); }
  assert(manifest?.app === 'wec-video-package' &&
         manifest.package_version === 1 &&
         /^[a-f0-9]{32}$/.test(manifest.job?.id ?? '') &&
         manifest.job?.status === 'ready');
  assert(manifest.files && typeof manifest.files === 'object' &&
         Object.keys(manifest.files).length === 2);

  const sha256 = async data => Array.from(new Uint8Array(
    await crypto.subtle.digest('SHA-256', data)
  ), byte => byte.toString(16).padStart(2, '0')).join('');
  for (const name of ['movie.mp4', 'render-inputs.json']) {
    const info = manifest.files[name], data = entries.get(name);
    assert(info && Number.isSafeInteger(info.bytes) &&
           info.bytes === data.length &&
           /^[a-f0-9]{64}$/.test(info.sha256));
    assert(await sha256(data) === info.sha256);
  }
  // Recovery content is only exposed when explicitly requested, after the
  // structural, CRC-32 and SHA-256 checks have all passed.
  let recoveryBackup;
  if (includeRecovery) {
    try { recoveryBackup = JSON.parse(decoder.decode(entries.get('render-inputs.json'))); }
    catch { throw invalid(); }
    assert(recoveryBackup?.schema_version === 2 &&
           Array.isArray(recoveryBackup.projects) &&
           recoveryBackup.projects.length === 1);
    const source = recoveryBackup.projects[0];
    assert(source && typeof source === 'object' &&
           source.id === manifest.job.project_id &&
           source.title === manifest.job.title &&
           Array.isArray(source.scene_images));
    // The server independently validates every story and image before its
    // atomic copy-only restore. Never use the job ID as the new project ID.
  }
  // This proves exact consistency with the downloaded, unsigned manifest,
  // not that the media is authentic or visually acceptable.
  return {
    jobId: manifest.job.id,
    movieBytes: entries.get('movie.mp4').length,
    inputsBytes: entries.get('render-inputs.json').length,
    recordedReview: ['approved', 'needs_changes', 'unreviewed'].includes(manifest.job.review)
      ? manifest.job.review : 'unreviewed',
    note: 'Checks ZIP structure, per-file CRC and SHA-256 manifest hashes. It is not a signature or publication approval.',
    ...(includeRecovery ? { recoveryBackup } : {}),
  };
}
