// Separate project records keep opening the library from decoding all artwork.
const NAME = "wec-creative-studio-v1";
export async function database() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const r = indexedDB.open(NAME, 2);
    r.onupgradeneeded = () => {
      for (const n of ["projects", "summaries", "profiles", "checkpoints"])
        if (!r.result.objectStoreNames.contains(n))
          r.result.createObjectStore(n, { keyPath: "id" });
    };
    r.onblocked = () => {
      settled = true;
      reject(Error("Close other WEC tabs, then reload to finish the device storage update. Existing projects are kept."));
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      if (settled) db.close();
      else { settled = true; resolve(db); }
    };
    r.onerror = () => {
      settled = true;
      reject(Error(r.error?.name === "VersionError"
        ? "Refresh this WEC tab to use the updated device storage."
        : "Device storage is unavailable. Download a backup before leaving."));
    };
  });
}
async function transaction(stores, mode, action) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () =>
        reject(
          failure || Error("Device save failed. Download a backup; storage may be full."),
        );
      tx.onabort = () =>
        reject(
          failure || Error(
            "This project changed in another tab. Download your edits as a backup, then reopen the saved project.",
          ),
        );
      action(tx, (value) => {
        result = value;
      }, (message) => {
        failure = Error(message);
        tx.abort();
      });
    });
  } finally {
    db.close();
  }
}
export function all(store = "summaries") {
  return transaction([store], "readonly", (tx, done) => {
    tx.objectStore(store).getAll().onsuccess = (e) => done(e.target.result);
  });
}
export function get(id) {
  return transaction(["projects"], "readonly", (tx, done) => {
    tx.objectStore("projects").get(id).onsuccess = (e) =>
      done(e.target.result || null);
  });
}
export function save(project) {
  return transaction(["projects", "summaries"], "readwrite", (tx, done) => {
    const records = tx.objectStore("projects");
    records.get(project.id).onsuccess = (e) => {
      const old = e.target.result;
      if ((old?.revision || 0) !== (project.revision || 0)) {
        tx.abort();
        return;
      }
      const value = {
        ...project,
        revision: (project.revision || 0) + 1,
        savedAt: Date.now(),
      };
      records.put(value);
      tx.objectStore("summaries").put({
        id: value.id,
        title: value.title,
        kind: value.kind,
        count: value.pages.length,
        savedAt: value.savedAt,
      });
      done(value);
    };
  });
}
export function profile(value) {
  return transaction(["profiles"], "readwrite", (tx, done) => {
    tx.objectStore("profiles").put(value);
    done(value);
  });
}

// Read the current saved project and its checkpoint in one consistent transaction.
export function recoverySnapshot(id, revision) {
  return transaction(["projects", "checkpoints"], "readonly", (tx, done, fail) => {
    const request = tx.objectStore("projects").get(id);
    request.onsuccess = () => {
      const project = request.result;
      if (!project || project.revision !== revision) {
        fail("This project changed in another tab. Reopen it before downloading its recovery package."); return;
      }
      const checkpoint = tx.objectStore("checkpoints").get(id);
      checkpoint.onsuccess = () => done({project, checkpoint: checkpoint.result || null});
    };
  });
}

// Validated imports get new identities; all writes commit before the editor switches.
export function restoreRecovery(project, checkpoint) {
  return transaction(["projects", "summaries", "checkpoints"], "readwrite", (tx, done, fail) => {
    try {
      const saved = {...project, revision: 1, savedAt: Date.now()};
      tx.objectStore("projects").add(saved);
      tx.objectStore("summaries").add({id: saved.id, title: saved.title, kind: saved.kind,
        count: saved.pages.length, savedAt: saved.savedAt});
      if (checkpoint) tx.objectStore("checkpoints").add({id: saved.id,
        checkpointId: crypto.randomUUID(), createdAt: checkpoint.createdAt,
        project: {...checkpoint.project, id: saved.id, revision: 1}});
      done(saved);
    } catch {
      fail("Recovery package could not be saved. Existing projects were kept; device storage may be full.");
    }
  });
}

// One explicit snapshot per source project. These are device-local copies, not cloud backups.
export function checkpointInfo(id) {
  return transaction(["checkpoints"], "readonly", (tx, done) => {
    tx.objectStore("checkpoints").get(id).onsuccess = e => {
      const value = e.target.result;
      done(value ? {id: value.id, checkpointId: value.checkpointId, createdAt: value.createdAt} : null);
    };
  });
}
export function saveCheckpoint(project, previousId = null) {
  return transaction(["projects", "checkpoints"], "readwrite", (tx, done, fail) => {
    tx.objectStore("projects").get(project.id).onsuccess = e => {
      const saved = e.target.result;
      if (!saved || saved.revision !== project.revision) {
        fail("This project changed in another tab. Reopen the saved project before making a checkpoint."); return;
      }
      const checkpoints = tx.objectStore("checkpoints");
      checkpoints.get(project.id).onsuccess = e => {
        if ((e.target.result?.checkpointId || null) !== previousId) {
          fail("The checkpoint changed in another tab. Review it before replacing it."); return;
        }
        try {
          const value = {id: saved.id, checkpointId: crypto.randomUUID(), createdAt: Date.now(), project: saved};
          checkpoints.put(value);
          done({id: value.id, checkpointId: value.checkpointId, createdAt: value.createdAt});
        } catch {
          fail("Checkpoint save failed. The previous checkpoint was kept; device storage may be full.");
        }
      };
    };
  });
}
export function openCheckpointCopy(id, checkpointId) {
  return transaction(["projects", "summaries", "checkpoints"], "readwrite", (tx, done, fail) => {
    tx.objectStore("checkpoints").get(id).onsuccess = e => {
      const checkpoint = e.target.result;
      if (!checkpoint || checkpoint.checkpointId !== checkpointId) {
        fail("The checkpoint changed or was removed. Check it again before opening a copy."); return;
      }
      try {
        const value = {...checkpoint.project, id: crypto.randomUUID(), revision: 1, savedAt: Date.now(),
          title: (checkpoint.project.title.slice(0, 130) + " — checkpoint").slice(0, 150),
          restoredFrom: {projectId: id, checkpointId, createdAt: checkpoint.createdAt}};
        tx.objectStore("projects").add(value);
        tx.objectStore("summaries").add({id: value.id, title: value.title, kind: value.kind,
          count: value.pages.length, savedAt: value.savedAt});
        done(value);
      } catch {
        fail("Checkpoint copy could not be saved. Your current project and checkpoint were kept; device storage may be full.");
      }
    };
  });
}
export function removeCheckpoint(id, checkpointId) {
  return transaction(["checkpoints"], "readwrite", (tx, done, fail) => {
    const checkpoints = tx.objectStore("checkpoints");
    checkpoints.get(id).onsuccess = e => {
      if (!e.target.result || e.target.result.checkpointId !== checkpointId) {
        fail("The checkpoint changed or was removed. Check it again before removing it."); return;
      }
      checkpoints.delete(id);
      done(true);
    };
  });
}
