// The page's side of server/worldSync.mjs: keeps the pieces of the world it was sent, applies each
// delta and rebuilds the world. Every rebuilt world is a fresh copy, so the page can change it (it
// runs the clock forward between updates) without touching the pieces it keeps.

const KEEP = 6; // past versions remembered, so an answer that crossed a newer one still applies

export class WorldCopy {
  constructor() {
    this.wv = -1; // newest world version held
    this.hist = new Map(); // world version -> layout: { key: { a: [hashes] } | { o: { key: hash } } | { v: hash } }
    this.vals = new Map(); // hash -> JSON text of the piece
  }

  /**
   * Apply a delta ({ from, keys, drop, vals }) that brings version `from` (-1: nothing) to wv. Returns a
   * fresh world object, or null if this page already has wv or newer (an answer that arrived late).
   * Throws if it doesn't have `from` any more; then the page asks for everything again.
   */
  apply(d, wv) {
    if (wv <= this.wv) return null;
    const base = d.from === -1 ? {} : this.hist.get(d.from);
    if (!base) throw new Error(`World update starts from version ${d.from}, which this page doesn't have.`);
    for (const h in d.vals) this.vals.set(h, JSON.stringify(d.vals[h]));
    const keys = { ...base };
    for (const k of d.drop || []) delete keys[k];
    for (const k in d.keys) {
      const n = d.keys[k];
      if (n.a) {
        const prev = base[k]?.a || [], out = [];
        for (const r of n.a) {
          if (typeof r === 'string') out.push(r);
          else for (let i = 0; i < r[1]; i++) out.push(prev[r[0] + i]);
        }
        keys[k] = { a: out };
      } else keys[k] = n;
    }
    // Rebuild as one JSON text and parse it: every object comes out new and unshared.
    const get = (h) => { const s = this.vals.get(h); if (s === undefined) throw new Error('World update is missing a piece.'); return s; };
    const parts = [];
    for (const k in keys) {
      const n = keys[k];
      let s;
      if (n.a) s = '[' + n.a.map(get).join(',') + ']';
      else if (n.o) s = '{' + Object.entries(n.o).map(([kk, h]) => JSON.stringify(kk) + ':' + get(h)).join(',') + '}';
      else s = get(n.v);
      parts.push(JSON.stringify(k) + ':' + s);
    }
    const world = JSON.parse('{' + parts.join(',') + '}');
    this.hist.set(wv, keys);
    this.wv = wv;
    while (this.hist.size > KEEP) this.hist.delete(this.hist.keys().next().value);
    // forget pieces no remembered version uses
    const used = new Set();
    for (const L of this.hist.values()) for (const k in L) { const n = L[k]; if (n.a) n.a.forEach((h) => used.add(h)); else if (n.o) for (const kk in n.o) used.add(n.o[kk]); else used.add(n.v); }
    for (const h of this.vals.keys()) if (!used.has(h)) this.vals.delete(h);
    return world;
  }
}
