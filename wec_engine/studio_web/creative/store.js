// Separate project records keep opening the library from decoding all artwork.
const NAME = "wec-creative-studio-v1";
export async function database() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      for (const n of ["projects", "summaries", "profiles"])
        r.result.createObjectStore(n, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () =>
      reject(
        Error(
          "Device storage is unavailable. Download a backup before leaving.",
        ),
      );
  });
}
async function transaction(stores, mode, action) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () =>
        reject(
          Error("Device save failed. Download a backup; storage may be full."),
        );
      tx.onabort = () =>
        reject(
          Error(
            "This project changed in another tab. Download your edits as a backup, then reopen the saved project.",
          ),
        );
      action(tx, (value) => {
        result = value;
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
