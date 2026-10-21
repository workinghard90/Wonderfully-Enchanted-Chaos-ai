/* One browser-local book. A revision guard prevents stale tabs overwriting it. */
import {LIMITS} from '/coloring/zip.js';
const DATABASE = 'wec-coloring-projects-v1', STORE = 'books', KEY = 'current';

export function validateSnapshot(book) {
  if (book?.schema_version !== 1 || typeof book.title !== 'string' || book.title.length > 150
      || typeof book.blank_backs !== 'boolean' || !Array.isArray(book.pages) || book.pages.length > LIMITS.pages) {
    throw Error('Invalid coloring project.');
  }
  let bytes = 0, pixels = 0;
  for (const page of book.pages) {
    if (!(page.file instanceof Blob) || !page.file.size || page.file.size > LIMITS.fileBytes
        || typeof page.name !== 'string' || !page.name.length || page.name.length > 512
        || !['png', 'jpg', 'webp'].includes(page.extension)
        || !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height)
        || page.width <= 0 || page.height <= 0 || page.width * page.height > LIMITS.imagePixels) {
      throw Error('Invalid artwork in coloring project.');
    }
    bytes += page.file.size; pixels += page.width * page.height;
  }
  if (bytes > LIMITS.totalBytes || pixels > LIMITS.totalPixels) throw Error('Saved coloring project exceeds the workspace limits.');
}

function transaction(mode, operation) {
  return new Promise((resolve, reject) => {
    let db, tx, result, settled = false;
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer); if (db) db.close();
      error ? reject(error) : resolve(result);
    }
    const timer = setTimeout(() => {
      if (tx) { try { tx.abort(); } catch {} }
      finish(Error('Device storage did not respond.'));
    }, 8000);
    let opening;
    try { opening = indexedDB.open(DATABASE, 1); }
    catch (error) { finish(error); return; }
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE, {keyPath: 'id'});
    opening.onerror = () => finish(opening.error || Error('Device storage is unavailable.'));
    opening.onblocked = () => finish(Error('Close other coloring tabs and retry.'));
    opening.onsuccess = () => {
      db = opening.result;
      if (settled) { db.close(); return; }
      db.onversionchange = () => db.close();
      try {
        tx = db.transaction(STORE, mode);
        tx.oncomplete = () => finish();
        tx.onabort = tx.onerror = () => finish(tx.error || Error('Device copy could not be saved.'));
        operation(tx.objectStore(STORE), value => { result = value; }, error => {
          try { tx.abort(); } catch {} finish(error);
        });
      } catch (error) { finish(error); }
    };
  });
}

export function readBook() {
  return transaction('readonly', (store, done) => {
    const request = store.get(KEY);
    request.onsuccess = () => done(request.result || null);
  });
}

export function writeBook(snapshot, expectedRevision, paused = false) {
  if (!paused) validateSnapshot(snapshot);
  return transaction('readwrite', (store, done, fail) => {
    const request = store.get(KEY);
    request.onsuccess = () => {
      try {
        const previous = request.result || null;
        if ((previous?.revision || null) !== expectedRevision) {
          const error = Error('Another tab changed the device copy. Download your current ZIP, then load the saved book.');
          error.name = 'ConflictError'; throw error;
        }
        const record = {id: KEY, revision: crypto.randomUUID(), savedAt: new Date().toISOString(), paused};
        if (!paused) record.snapshot = snapshot;
        store.put(record); done(record);
      } catch (error) { fail(error); }
    };
  });
}
