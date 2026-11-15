// Sends players only the parts of the world that changed (owner, 15 Nov 2026: Railway bills every GB
// sent, and the server sent every open tab the whole world, every design included, each time anything
// happened: ~58 GB in 11 days).
//
// The world is cut into pieces: each element of a top-level array (planets, fleets, log, ...), each
// entry of a big top-level object (designs, relations, ...), and every other top-level value whole.
// Each piece is named by a hash of its JSON. A world version's "layout" says which pieces make up each
// top-level key. To update a client that has version `from`, the server sends the layouts of keys that
// changed (arrays as runs copied from the client's old layout plus new hashes) and only the pieces the
// client doesn't have. The client (src/galaxy/net.js, applyWorldDelta) rebuilds an identical world.
// A client whose version is too old (or who has none) gets every piece: the same format from nothing.

import { createHash } from 'node:crypto';

const hashOf = (s) => createHash('sha1').update(s).digest('base64url').slice(0, 12);
const BIG_OBJECT = 8; // a top-level object with more entries than this is sent entry by entry

/** Layout of one array against the client's old one: [start, count] runs copied from it, or new hashes. */
export function encodeRuns(prev, next) {
  if (!prev) return next.slice();
  const at = new Map();
  prev.forEach((h, i) => { if (!at.has(h)) at.set(h, i); });
  const out = [];
  for (let i = 0; i < next.length;) {
    const s = at.get(next[i]);
    if (s === undefined) { out.push(next[i++]); continue; }
    let n = 1;
    while (i + n < next.length && s + n < prev.length && prev[s + n] === next[i + n]) n++;
    out.push([s, n]);
    i += n;
  }
  return out;
}

/** Inverse of encodeRuns (used by the client; here for tests). */
export function decodeRuns(prev, runs) {
  const out = [];
  for (const r of runs) {
    if (typeof r === 'string') out.push(r);
    else for (let k = 0; k < r[1]; k++) out.push(prev[r[0] + k]);
  }
  return out;
}

export class WorldSync {
  constructor(keep = 60) {
    this.keep = keep; // how many past layouts a client can be behind and still get a delta
    // Layout ids: every distinct layout sent gets one. They start at the clock time so they keep
    // rising across server restarts (a page holding an id from before a restart is sent everything).
    this.nextSid = Date.now();
    this.hist = new Map(); // layout id -> { wv, keys, sigs, all }
    this.cur = null; // the newest layout and its piece values
    this.cache = new Map(); // from layout id -> delta, for the newest layout
  }

  /** World version a layout id was taken at (undefined if unknown). */
  versionOf(sid) { return this.hist.get(sid)?.wv; }

  /**
   * The world's layout now. The world also changes a little between versions (the clock, credits, ships
   * a shipyard built), so it is taken again when the version changed or the last one is over 2 s old.
   */
  layout(world, wv) {
    const now = Date.now();
    if (this.cur && this.cur.wv === wv && now - this.cur.t < 2000) return this.cur;
    const keys = {}, vals = new Map();
    // Pieces are kept as JSON text taken now, so every client gets exactly what the hashes say.
    const put = (x) => { const s = JSON.stringify(x) ?? 'null'; const h = hashOf(s); if (!vals.has(h)) vals.set(h, s); return h; };
    for (const [k, v] of Object.entries(world)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) keys[k] = { a: v.map(put) };
      else if (v && typeof v === 'object' && Object.keys(v).length > BIG_OBJECT) {
        const o = {};
        for (const [kk, x] of Object.entries(v)) if (x !== undefined) o[kk] = put(x);
        keys[k] = { o };
      } else keys[k] = { v: put(v) };
    }
    const sigs = {};
    for (const k in keys) sigs[k] = hashOf(JSON.stringify(keys[k]));
    const sig = hashOf(JSON.stringify(sigs));
    if (this.cur && this.cur.sig === sig) { this.cur.t = now; this.cur.wv = wv; this.hist.get(this.cur.sid).wv = wv; return this.cur; }
    const sid = ++this.nextSid;
    const L = { sid, wv, t: now, sig, keys, sigs, vals, all: new Set(vals.keys()) };
    this.cur = L; this.cache.clear();
    this.hist.set(sid, { wv, keys, sigs, all: L.all });
    while (this.hist.size > this.keep) this.hist.delete(this.hist.keys().next().value);
    return L;
  }

  /**
   * What a client holding layout `from` needs to reach the world now:
   * { from, sid, keys: { k: { a: runs } | { o: {..} } | { v: hash } }, drop: [k], vals: { hash: value } }.
   * from = -1 (or a layout we no longer remember) sends everything (and `from` comes back as -1).
   */
  delta(world, wv, from) {
    const L = this.layout(world, wv);
    const old = this.hist.get(from) && from !== L.sid ? this.hist.get(from) : null;
    const key = old ? from : -1;
    let d = this.cache.get(key);
    if (d) return d;
    const keys = {}, vals = {}, drop = [];
    const need = (h) => { if (!(old && old.all.has(h)) && !(h in vals)) vals[h] = JSON.parse(L.vals.get(h)); };
    for (const k in L.keys) {
      if (old && old.sigs[k] === L.sigs[k]) continue;
      const lk = L.keys[k];
      if (lk.a) { keys[k] = { a: encodeRuns(old?.keys[k]?.a, lk.a) }; lk.a.forEach(need); }
      else if (lk.o) { keys[k] = { o: lk.o }; for (const kk in lk.o) need(lk.o[kk]); }
      else { keys[k] = { v: lk.v }; need(lk.v); }
    }
    if (old) for (const k in old.keys) if (!(k in L.keys)) drop.push(k);
    d = { from: key, sid: L.sid, keys, drop, vals };
    this.cache.set(key, d);
    return d;
  }
}
