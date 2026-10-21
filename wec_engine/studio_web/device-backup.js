/* Saved projects only: no tokens, draft edits, movies or generation requests. */
window.WECDeviceBackups = (() => {
  const DATABASE = 'wec-device-backups-v1';
  const STORE = 'snapshots';
  const MAX_BYTES = 40 * 1024 * 1024;

  async function scope(backend, accessToken) {
    if (!accessToken) return null;
    const bytes = new TextEncoder().encode(JSON.stringify([new URL(backend).href, accessToken]));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      let db, tx, result, settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (db) db.close();
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => {
        if (tx) { try { tx.abort(); } catch {} }
        finish(Error('Device storage did not respond.'));
      }, 8000);
      let opening;
      try { opening = indexedDB.open(DATABASE, 1); }
      catch (error) { finish(error); return; }
      opening.onupgradeneeded = () => opening.result.createObjectStore(STORE, {keyPath: 'scope'});
      opening.onerror = () => finish(opening.error || Error('Device storage is unavailable.'));
      opening.onblocked = () => finish(Error('Close other studio tabs and try device storage again.'));
      opening.onsuccess = () => {
        db = opening.result;
        if (settled) { db.close(); return; }
        db.onversionchange = () => db.close();
        try {
          tx = db.transaction(STORE, mode);
          tx.oncomplete = () => finish();
          tx.onabort = tx.onerror = () => finish(tx.error || Error('Device backup could not be saved.'));
          operation(tx.objectStore(STORE), value => { result = value; }, error => {
            try { tx.abort(); } catch {}
            finish(error);
          });
        } catch (error) { finish(error); }
      };
    });
  }

  function read(key) {
    return transaction('readonly', (store, done, fail) => {
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const record = request.result || null;
          if (record && !record.paused) {
            validate(record.backup);
            if (!Number.isFinite(Date.parse(record.savedAt))) throw Error('Invalid device backup date.');
          }
          done(record);
        } catch (error) { fail(error); }
      };
    });
  }

  function validate(backup) {
    if (backup?.schema_version !== 2 || !Array.isArray(backup.projects)) throw Error('Invalid device backup.');
    if (new TextEncoder().encode(JSON.stringify(backup)).length > MAX_BYTES) throw Error('Device backup exceeds 40 MB.');
    for (const project of backup.projects) {
      if (typeof project.id !== 'string' || typeof project.title !== 'string' || typeof project.story !== 'string'
          || !Array.isArray(project.scene_images)) throw Error('Invalid device project.');
    }
  }

  function save(key, backup, capturedAt, replace = false) {
    validate(backup);
    return transaction('readwrite', (store, done, fail) => {
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const previous = request.result || null;
          // Empty servers and stale responses must never erase the last good copy.
          if (!backup.projects.length || previous?.paused || previous?.capturedAt > capturedAt) {
            done({record: previous, conflict: false}); return;
          }
          const ids = new Set(backup.projects.map(project => project.id));
          if (!replace && previous?.backup?.projects.length && !previous.backup.projects.some(project => ids.has(project.id))) {
            done({record: previous, conflict: true}); return;
          }
          const record = {scope: key, savedAt: new Date().toISOString(), capturedAt, backup};
          store.put(record); done({record, conflict: false});
        } catch (error) { fail(error); }
      };
    });
  }

  function pause(key, paused) {
    return transaction('readwrite', (store, done) => {
      // Pausing removes the story/image data and persists only this preference.
      if (paused) store.put({scope: key, paused: true});
      else store.delete(key);
      done(paused ? {scope: key, paused: true} : null);
    });
  }
  return {scope, read, save, pause};
})();
