// Battle replays for the combat log, kept in the browser's IndexedDB so old battles can be
// watched after a reload (they're far too big for localStorage). Every call is safe: if IndexedDB
// is unavailable (private window, blocked storage) replays live in memory for the session.
// On the server this becomes replay files on disk; the page will fetch them instead.

const DB = 'lsb-galaxy', STORE = 'replays', KEEP = 80;

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
function run(mode, fn) {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(STORE, mode), st = tx.objectStore(STORE);
      const req = fn(st);
      tx.oncomplete = () => resolve(req?.result ?? true);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}

export class ReplayStore {
  constructor() { this.mem = new Map(); this.ids = new Set(); }
  /** Load the list of stored replay ids. */
  async init() {
    const keys = await run('readonly', (st) => st.getAllKeys());
    if (Array.isArray(keys)) for (const k of keys) this.ids.add(k);
  }
  has(id) { return this.ids.has(id) || this.mem.has(id); }
  /** rec: { id, t, bytes: Uint8Array, sides, title, computeMs } */
  async put(rec) {
    this.mem.set(rec.id, rec); this.ids.add(rec.id);
    const ok = await run('readwrite', (st) => st.put(rec));
    if (ok) {
      // Stored: keep only a few in memory, and only the newest KEEP on disk.
      while (this.mem.size > 4) this.mem.delete(this.mem.keys().next().value);
      if (this.ids.size > KEEP) {
        const all = await run('readonly', (st) => st.getAll());
        if (Array.isArray(all)) {
          all.sort((a, b) => a.t - b.t);
          const drop = all.slice(0, all.length - KEEP).map((r) => r.id);
          await run('readwrite', (st) => { for (const id of drop) st.delete(id); return null; });
          for (const id of drop) this.ids.delete(id);
        }
      }
    } else while (this.mem.size > 16) { const k = this.mem.keys().next().value; this.mem.delete(k); this.ids.delete(k); }
  }
  async get(id) {
    if (this.mem.has(id)) return this.mem.get(id);
    const r = await run('readonly', (st) => st.get(id));
    return r && r.id ? r : null;
  }
  async clear() {
    this.mem.clear(); this.ids.clear();
    await run('readwrite', (st) => st.clear());
  }
}
