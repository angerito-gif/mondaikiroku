// IndexedDB の薄いラッパー
const DB_NAME = 'mondaikiroku';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('problems')) db.createObjectStore('problems', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getAllProblems = () => tx('problems', 'readonly', (s) => s.getAll());
export const putProblem = (p) => tx('problems', 'readwrite', (s) => { s.put(p); });
export const putProblems = (ps) => tx('problems', 'readwrite', (s) => { ps.forEach((p) => s.put(p)); });
export const deleteProblem = (id) => tx('problems', 'readwrite', (s) => { s.delete(id); });
export const deleteProblems = (ids) => tx('problems', 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); });
export const replaceAllProblems = (ps) =>
  tx('problems', 'readwrite', (s) => { s.clear(); ps.forEach((p) => s.put(p)); });

export const getMeta = (key) => tx('meta', 'readonly', (s) => s.get(key)).then((r) => r?.value);
export const setMeta = (key, value) => tx('meta', 'readwrite', (s) => { s.put({ key, value }); });
export const getAllMeta = () =>
  tx('meta', 'readonly', (s) => s.getAll()).then((rows) => Object.fromEntries((rows || []).map((r) => [r.key, r.value])));
