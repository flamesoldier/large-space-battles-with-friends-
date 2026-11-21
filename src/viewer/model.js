// Turns a packed replay into something the renderer can query at ANY time t.
//
// Nothing here is incremental: every block, chunk, shot and spark is a pure function of t.
// That is what makes scrubbing backwards/forwards free and keeps the viewer simple.
// Time is measured in sim ticks (float).

import { unpackReplay } from '../shared/replayFormat.js';
import { MULTIBLOCK, BT } from '../shared/blocks.js';
import { lineOfFire } from '../shared/arcs.js';
import { bayRoute } from '../shared/bayRoute.js';
import { openDir, unitDir } from '../shared/weaponLook.js';

export function lowerBound(arr, v, n = arr.length) {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

export class ReplayModel {
  constructor(input) {
    const { meta, cols } = input instanceof Uint8Array || input instanceof ArrayBuffer ? unpackReplay(input) : input;
    this.meta = meta;
    this.dt = meta.dt;
    this.ticks = meta.ticks;
    this.designs = meta.designs;
    this.decodeShips(meta, cols);
    this.decodeChunks(meta, cols);
    this.applyBlockDeaths(cols);
    this.decodeEffects(meta, cols);
    this.computeBounds();
    this.computeStrength();
  }

  decodeShips(meta, c) {
    const S = meta.shipCount, TE = meta.trackEvery;
    this.TE = TE;
    const total = c.shipTrackCount.reduce((a, b) => a + b, 0);
    this.tx = new Float32Array(total); this.ty = new Float32Array(total); this.ta = new Float32Array(total);
    const T = meta.trackTotal, dX = c.trackDelta.subarray(0, T), dY = c.trackDelta.subarray(T, 2 * T), dA = c.trackDelta.subarray(2 * T);
    this.ents = [];
    let w = 0;
    for (let k = 0; k < S; k++) {
      const n = c.shipTrackCount[k];
      let o = c.shipTrackStart[k];
      let x = c.shipX0[k], y = c.shipY0[k], a = c.shipA0[k], vx = 0, vy = 0, va = 0;
      const s0 = w;
      for (let s = 0; s < n; s++) {
        if (s > 0) { vx += dX[o]; vy += dY[o]; va += dA[o]; o++; x += vx; y += vy; a += va; }
        this.tx[w] = x / meta.posQ; this.ty[w] = y / meta.posQ; this.ta[w] = a / meta.angQ; w++;
      }
      const d = this.designs[c.shipDesign[k]];
      const e = this.makeEnt(0, c.shipTeam[k], d.w, d.h);
      e.design = c.shipDesign[k];
      e.s0 = s0; e.n = n; e.t0 = 0;
      e.t1 = c.shipT1[k] === 65535 ? Infinity : c.shipT1[k];
      const up = unitPos(d);
      for (let i = 0; i < d.cells.length; i++) if (d.cells[i]) this.addCell(e, i, d.cells[i], up[i]);
      this.finishEnt(e);
    }
  }

  makeEnt(kind, team, w, h) {
    const e = { kind, team, w, h, parent: null, look: null, radius: Math.hypot(w, h) / 2, map: new Int32Array(w * h).fill(-1), tmp: [], sv0: 0, svN: 0, sh0: 0, shN: 0, thr: null, thrBehind: null, nb: null, unit: null };
    this.ents.push(e);
    return e;
  }

  /** unit: for plasma cannon blocks, 1 + position in its 10x10 unit (u * 10 + v); else 0. */
  addCell(e, gridIndex, type, unit = 0) {
    e.map[gridIndex] = e.tmp.length / 4;
    e.tmp.push((gridIndex % e.w) + 0.5 - e.w / 2, ((gridIndex / e.w) | 0) + 0.5 - e.h / 2, type, unit);
  }

  finishEnt(e) {
    const n = e.tmp.length / 4;
    e.lx = new Float32Array(n); e.ly = new Float32Array(n); e.type = new Uint8Array(n); e.unit = new Uint16Array(n);
    e.death = new Float32Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) { const o = i * 4; e.lx[i] = e.tmp[o]; e.ly[i] = e.tmp[o + 1]; e.type[i] = e.tmp[o + 2]; e.unit[i] = e.tmp[o + 3]; }
    e.tmp = null;
  }

  decodeChunks(meta, c) {
    const C = meta.chunkCount;
    for (let k = 0; k < C; k++) {
      const parent = this.ents[c.chParent[k]];
      const pd = this.designs[parent.design];
      const cw = c.chW[k], ch = c.chH[k], minI = c.chMinI[k], minJ = c.chMinJ[k];
      const e = this.makeEnt(1, parent.team, cw, ch);
      e.parent = parent;
      e.t0 = c.chT0[k];
      e.x0 = c.chX[k]; e.y0 = c.chY[k]; e.a0 = c.chA[k];
      e.vx = c.chVx[k]; e.vy = c.chVy[k]; e.va = c.chVa[k];
      e.size = c.chN[k];
      for (let m = 0; m < c.chN[k]; m++) {
        const pi = c.chCells[c.chC0[k] + m];
        const ci = (((pi / pd.w) | 0) - minJ) * cw + ((pi % pd.w) - minI);
        this.addCell(e, ci, pd.cells[pi], unitPos(pd)[pi]);
      }
      this.finishEnt(e);
    }
    this.decodeShoves(meta, c);
    this.decodeShields(c);
  }

  /**
   * Debris pushed by ships (replays from before debris collided have none). Each piece's records
   * are gathered in time order: from record k it drifts from svX/svY at svVx/svVy.
   */
  decodeShields(c) {
    const n = c.shT ? c.shT.length : 0;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => c.shEnt[a] - c.shEnt[b] || c.shT[a] - c.shT[b] || a - b);
    this.sh = { t: new Float32Array(n), v: new Float32Array(n) };
    for (let k = 0; k < n; k++) {
      const i = order[k], e = this.ents[c.shEnt[i]];
      this.sh.t[k] = c.shT[i]; this.sh.v[k] = c.shV[i] / 255;
      if (!e.shN) e.sh0 = k;
      e.shN++;
    }
  }

  /**
   * A ship's shield at time t (shield generators): out.v = how full (0..1), out.hit = how much it
   * dropped over the last half second (for the flash when it's struck), out.down = ticks since it
   * collapsed to nothing (or -1).
   */
  shieldAt(e, t, out) {
    out.v = 0; out.hit = 0; out.down = -1;
    if (!e.shN) return out;
    const T = this.sh.t, V = this.sh.v, a = e.sh0, b = a + e.shN;
    let lo = a, hi = b; // first record after t
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m + 1; else hi = m; }
    const k = lo - 1;
    if (k < a) return out;
    let v = V[k];
    if (lo < b && V[lo] > v && T[lo] > T[k]) v += ((V[lo] - v) * (t - T[k])) / (T[lo] - T[k]); // refilling: smooth
    out.v = v;
    for (let j = k; j > a && T[j] >= t - 5; j--) if (V[j - 1] > V[j]) out.hit += V[j - 1] - V[j];
    if (V[k] === 0 && k > a && V[k - 1] > 0) out.down = t - T[k];
    return out;
  }

  /**
   * Distance map for a shielded ship's bubble at time t (owner, 15 Nov 2026: shields should hug the
   * outline of ships and defences; a box round an Aegis fortress was just a big box). A grid over the
   * live blocks plus a margin, each cell holding its distance (in blocks) to the nearest live block,
   * scaled to 0..255 over 0..maxD. Cells are `s` blocks wide so a giant stays under ~160
   * cells a side. Rebuilt only when the number of live blocks changes (checked at most every 0.3 s of
   * replay time). Returns { d: Uint8Array, gw, gh, s, ox, oy (local position of cell 0's corner), m
   * (bubble margin), maxD, ver (bumped on rebuild) } or null if no block is left.
   */
  shieldMap(e, t, px) {
    const c = e.shMap || (e.shMap = { t: -1e9, n: -1, d: null, gw: 0, gh: 0, s: 1, ox: 0, oy: 0, m: 0, maxD: 1, ver: 0 });
    if (Math.abs(t - c.t) <= 3 && c.d) return c;
    c.t = t;
    const lx = e.lx, ly = e.ly, de = e.death;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
    for (let i = 0; i < lx.length; i++) {
      if (de[i] <= t) continue;
      n++;
      const x = lx[i], y = ly[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!n) { c.n = 0; c.d = null; return null; }
    if (n === c.n && c.d) return c;
    c.n = n;
    const hw = (x1 - x0) / 2 + 0.5, hh = (y1 - y0) / 2 + 0.5;
    const m = Math.min(12, 3 + 0.05 * Math.min(hw, hh)); // gap between hull and bubble, in blocks
    const maxD = m * 1.6 + 2, pad = maxD;
    const W = x1 - x0 + 1 + 2 * pad, H = y1 - y0 + 1 + 2 * pad;
    const s = Math.max(1, Math.ceil(Math.max(W, H) / 160));
    const gw = Math.ceil(W / s) + 1, gh = Math.ceil(H / s) + 1;
    const ox = x0 - 0.5 - pad, oy = y0 - 0.5 - pad;
    // Nearest live cell for every cell by two sweeps passing nearest-source coordinates on (dead
    // reckoning), so distances are Euclidean and the bubble's corners come out round.
    const sx = new Int32Array(gw * gh).fill(-1), sy = new Int32Array(gw * gh), dist = new Float32Array(gw * gh).fill(1e9);
    for (let i = 0; i < lx.length; i++) {
      if (de[i] <= t) continue;
      const gx = Math.floor((lx[i] - ox) / s), gy = Math.floor((ly[i] - oy) / s), k = gy * gw + gx;
      sx[k] = gx; sy[k] = gy; dist[k] = 0;
    }
    const tryN = (k, x, y, j) => {
      if (sx[j] < 0) return;
      const dx = x - sx[j], dy = y - sy[j], d = Math.sqrt(dx * dx + dy * dy);
      if (d < dist[k]) { dist[k] = d; sx[k] = sx[j]; sy[k] = sy[j]; }
    };
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const k = y * gw + x;
        if (x > 0) tryN(k, x, y, k - 1);
        if (y > 0) { tryN(k, x, y, k - gw); if (x > 0) tryN(k, x, y, k - gw - 1); if (x < gw - 1) tryN(k, x, y, k - gw + 1); }
      }
      for (let x = gw - 2; x >= 0; x--) tryN(y * gw + x, x, y, y * gw + x + 1);
    }
    for (let y = gh - 1; y >= 0; y--) {
      for (let x = gw - 1; x >= 0; x--) {
        const k = y * gw + x;
        if (x < gw - 1) tryN(k, x, y, k + 1);
        if (y < gh - 1) { tryN(k, x, y, k + gw); if (x < gw - 1) tryN(k, x, y, k + gw + 1); if (x > 0) tryN(k, x, y, k + gw - 1); }
      }
      for (let x = 1; x < gw; x++) tryN(y * gw + x, x, y, y * gw + x - 1);
    }
    const out = new Uint8Array(gw * gh);
    for (let k = 0; k < out.length; k++) {
      // cell centre to the nearest block's cell centre, less half a cell so big cells don't shrink the bubble
      const b = Math.max(0, dist[k] * s - (s - 1) / 2);
      out[k] = Math.min(255, Math.round((b / maxD) * 255));
    }
    Object.assign(c, { d: out, gw, gh, s, ox, oy, m, maxD, ver: c.ver + 1 });
    return c;
  }

  decodeShoves(meta, c) {
    const n = c.svT ? c.svT.length : 0;
    this.shoveEvery = meta.shoveEvery || 3;
    const pq = meta.evQ, vq = meta.velQ || 64;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => c.svEnt[a] - c.svEnt[b] || c.svT[a] - c.svT[b]);
    this.sv = { t: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n) };
    for (let k = 0; k < n; k++) {
      const i = order[k], e = this.ents[c.svEnt[i]];
      this.sv.t[k] = c.svT[i]; this.sv.x[k] = c.svX[i] / pq; this.sv.y[k] = c.svY[i] / pq; this.sv.vx[k] = c.svVx[i] / vq; this.sv.vy[k] = c.svVy[i] / vq;
      if (!e.svN) e.sv0 = k;
      e.svN++;
    }
  }

  applyBlockDeaths(c) {
    const n = c.bdT.length;
    for (let k = 0; k < n; k++) {
      const e = this.ents[c.bdEnt[k]], li = e.map[c.bdCell[k]];
      if (li >= 0 && c.bdT[k] < e.death[li]) e.death[li] = c.bdT[k];
    }
    for (const e of this.ents) {
      if (e.kind === 1) { let m = 0; for (const d of e.death) m = Math.max(m, d); e.t1 = m; }
    }
    // Sparks: where and how fast each destroyed (not merely detached) block was moving.
    // Filled straight into a typed array: a battle of thousands of giant ships destroys tens of
    // millions of blocks, more than a plain list can hold.
    let ns = 0;
    for (let k = 0; k < n; k++) if (c.bdCause[k] === 0) ns++;
    const sp = new Float32Array(ns * 7);
    let o = 0;
    const tr = { x: 0, y: 0, a: 0 }, tr2 = { x: 0, y: 0, a: 0 };
    for (let k = 0; k < n; k++) {
      if (c.bdCause[k] !== 0) continue;
      const ei = c.bdEnt[k], e = this.ents[ei], t = c.bdT[k];
      const li = e.map[c.bdCell[k]];
      this.transform(e, t, tr); this.transform(e, t - 1, tr2);
      const cs = Math.cos(tr.a), sn = Math.sin(tr.a);
      sp[o++] = t; sp[o++] = tr.x + e.lx[li] * cs - e.ly[li] * sn; sp[o++] = tr.y + e.lx[li] * sn + e.ly[li] * cs;
      sp[o++] = (tr.x - tr2.x) / this.dt; sp[o++] = (tr.y - tr2.y) / this.dt; sp[o++] = k; sp[o++] = e.type[li];
    }
    // Thrusters of each ship, with the block directly behind each one (toward the stern), so the
    // renderer can draw a flame on every working thruster that has open space behind it.
    for (const e of this.ents) {
      if (e.kind !== 0) continue;
      const thr = [], behind = [];
      for (let g = 0; g < e.map.length; g++) {
        const li = e.map[g];
        if (li < 0 || e.type[li] !== BT.THRUSTER) continue;
        thr.push(li); behind.push(g % e.w > 0 ? e.map[g - 1] : -1);
      }
      e.thr = Int32Array.from(thr); e.thrBehind = Int32Array.from(behind);
    }
    for (const e of this.ents) { neighbours(e); e.map = null; } // the grid map is only needed until here
    this.spark = sp;
    this.sparkT = new Float32Array(sp.length / 7);
    for (let i = 0; i < this.sparkT.length; i++) this.sparkT[i] = sp[i * 7];
  }

  decodeEffects(meta, c) {
    const q = meta.evQ, dt = meta.dt, sp = meta.kineticSpeed;
    // Shells (kind 0) and heavy missiles (kind 1) fly straight from launch: every position
    // is launch point + velocity * age. Split by kind so each has a tight time window.
    // Shots counted by kind first and listed in typed arrays (21 Nov 2026: a 20,000-ship battle with
    // flak and auto guns has ~15 million shots; plain lists of them spent most of the load in GC).
    const nShot = c.shotT0.length, perKind = new Int32Array(256);
    for (let i = 0; i < nShot; i++) perKind[c.shotKind[i]]++;
    const straight = (kind) => {
      const idx = new Int32Array(perKind[kind]);
      for (let i = 0, k = 0; i < nShot; i++) if (c.shotKind[i] === kind) idx[k++] = i;
      const n = idx.length, spd = meta.shotSpeed[kind] * dt;
      const S = { n, t0: new Float32Array(n), t1: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n),
        vx: new Float32Array(n), vy: new Float32Array(n), hit: new Uint8Array(n), team: new Uint8Array(n), a0: new Float32Array(n), maxFlight: 0 };
      for (let k = 0; k < n; k++) {
        const i = idx[k], f = c.shotFlight[i] / 10, a = (c.shotAng[i] / 65536) * Math.PI * 2;
        S.t0[k] = c.shotT0[i]; S.t1[k] = c.shotT0[i] + f; S.x[k] = c.shotX[i] / q; S.y[k] = c.shotY[i] / q;
        const v = c.shotSpd && c.shotSpd[i] ? (spd * c.shotSpd[i]) / 200 : spd; // shrapnel speeds vary (shotSpd, 15 Nov 2026)
        S.vx[k] = Math.cos(a) * v; S.vy[k] = Math.sin(a) * v; // units per tick
        S.hit[k] = c.shotHit[i]; S.team[k] = c.shotTeam[i];
        if (f > S.maxFlight) S.maxFlight = f;
      }
      return S;
    };
    this.shell = liveIndex(straight(0));
    this.missile = liveIndex(withGuided(straight(1), c, q));
    this.plasma = liveIndex(straight(2)); // plasma cannon bolts (none in replays before Nov 2026)
    this.flak = meta.shotSpeed[5] ? liveIndex(straight(5)) : null; // flak shells (14 Nov 2026); older replays have none
    this.auto = meta.shotSpeed[7] ? liveIndex(straight(7)) : null; // auto gun bullets (20 Nov 2026)
    this.frag = meta.shotSpeed[6] ? liveIndex(straight(6)) : null; // flak shrapnel, each piece a projectile (14 Nov 2026)
    this.fighter = fighters(c, q); // fighters from fighter bays (shot kind 4, Nov 2026), or null
    const nl = c.lasT.length;
    this.laser = { n: nl, t: c.lasT, x0: new Float32Array(nl), y0: new Float32Array(nl), x1: new Float32Array(nl), y1: new Float32Array(nl), team: c.lasTeam, hit: c.lasHit, kind: c.lasKind,
      // Beam ends attached to entities (newer replays): ids (0xffffffff = none) and local offsets.
      src: c.lasSrc || null, dst: c.lasDst || null,
      sx: c.lasSX ? Float32Array.from(c.lasSX, (v) => v / q) : null, sy: c.lasSY ? Float32Array.from(c.lasSY, (v) => v / q) : null,
      dx: c.lasDX ? Float32Array.from(c.lasDX, (v) => v / q) : null, dy: c.lasDY ? Float32Array.from(c.lasDY, (v) => v / q) : null };
    // World positions at the moment of firing (used for culling, and for unattached ends).
    // Attached ends are stored only relative to their entity, so work them out here.
    const L = this.laser, none = L.src && L.src.BYTES_PER_ELEMENT === 2 ? 0xffff : 0xffffffff, bt = { x: 0, y: 0, a: 0 };
    const at = (id, t, lx, ly, out, k) => {
      this.transform(this.ents[id], t, bt);
      const cs = Math.cos(bt.a), sn = Math.sin(bt.a);
      out[k] = bt.x + lx * cs - ly * sn; out[k + 1] = bt.y + lx * sn + ly * cs;
    };
    const p = [0, 0];
    for (let i = 0; i < nl; i++) {
      const a = (c.lasAng[i] / 65536) * Math.PI * 2, len = c.lasLen[i];
      if (L.src && L.src[i] !== none) { at(L.src[i], L.t[i], L.sx[i], L.sy[i], p, 0); L.x0[i] = p[0]; L.y0[i] = p[1]; }
      else { L.x0[i] = c.lasX[i] / q; L.y0[i] = c.lasY[i] / q; }
      if (L.dst && L.dst[i] !== none) { at(L.dst[i], L.t[i], L.dx[i], L.dy[i], p, 0); L.x1[i] = p[0]; L.y1[i] = p[1]; }
      else { L.x1[i] = L.x0[i] + Math.cos(a) * len; L.y1[i] = L.y0[i] + Math.sin(a) * len; }
    }
    this.expl = { n: c.expT.length, t: c.expT, s: c.expS, x: Float32Array.from(c.expX, (v) => v / q), y: Float32Array.from(c.expY, (v) => v / q) };
    // Ship deaths, sorted by time.
    const deaths = [];
    const tr = { x: 0, y: 0, a: 0 };
    for (const e of this.ents) if (e.kind === 0 && e.t1 !== Infinity) { this.transform(e, e.t1, tr); deaths.push([e.t1, tr.x, tr.y, e.radius, e.team]); }
    deaths.sort((a, b) => a[0] - b[0]);
    this.death = { n: deaths.length, t: Float32Array.from(deaths, (d) => d[0]), d: deaths };
  }

  /** Interpolated transform. Ships: Catmull-Rom through 0.4 s samples. Chunks: analytic drift. */
  /**
   * Where beam i's ends are at time t: attached ends follow their ship or wreck, so a fading
   * beam stays on the block it hit. Writes out.x0, y0, x1, y1.
   */
  beamAt(i, t, out) {
    const L = this.laser, tr = this._tr || (this._tr = { x: 0, y: 0, a: 0 });
    out.x0 = L.x0[i]; out.y0 = L.y0[i]; out.x1 = L.x1[i]; out.y1 = L.y1[i];
    if (!L.src) return out;
    const s = L.src[i], d = L.dst[i], none = L.src.BYTES_PER_ELEMENT === 2 ? 0xffff : 0xffffffff;
    if (s !== none && this.ents[s]) {
      this.transform(this.ents[s], t, tr);
      const c = Math.cos(tr.a), n = Math.sin(tr.a);
      out.x0 = tr.x + L.sx[i] * c - L.sy[i] * n; out.y0 = tr.y + L.sx[i] * n + L.sy[i] * c;
    }
    if (d !== none && this.ents[d]) {
      this.transform(this.ents[d], t, tr);
      const c = Math.cos(tr.a), n = Math.sin(tr.a);
      out.x1 = tr.x + L.dx[i] * c - L.dy[i] * n; out.y1 = tr.y + L.dx[i] * n + L.dy[i] * c;
    }
    return out;
  }

  /**
   * How fast each ship or wreck (shoves included) can move, in blocks per tick, by index in
   * this.ents (Float32Array), with room for the curve between track samples to overshoot. The
   * renderer uses it to skip anything that can't have reached the screen since it last saw it,
   * without working out where it is. Per entity, so one wild shove doesn't slow everything down.
   */
  speeds() {
    if (this._speeds) return this._speeds;
    const out = new Float32Array(this.ents.length), S = this.sv, w = this.shoveEvery;
    this.ents.forEach((e, i) => {
      let v = 0;
      if (e.kind === 1) {
        // A wreck drifts at its speed; a shoved one also blends into each new record over w ticks
        // (smoothstep, so at most 1.5x the gap per w ticks) on top of its drift.
        let x = e.x0, y = e.y0, vx = e.vx, vy = e.vy, tk = e.t0;
        v = Math.hypot(vx, vy) * this.dt;
        for (let k = e.sv0; k < e.sv0 + e.svN; k++) {
          const d = (S.t[k] - tk) * this.dt, gap = Math.hypot(S.x[k] - (x + vx * d), S.y[k] - (y + vy * d));
          v = Math.max(v, Math.hypot(vx, vy) * this.dt + (gap * 1.5) / w, Math.hypot(S.vx[k], S.vy[k]) * this.dt);
          x = S.x[k]; y = S.y[k]; vx = S.vx[k]; vy = S.vy[k]; tk = S.t[k];
        }
      } else for (let k = e.s0 + 1; k < e.s0 + e.n; k++) v = Math.max(v, Math.hypot(this.tx[k] - this.tx[k - 1], this.ty[k] - this.ty[k - 1]) / this.TE);
      out[i] = v * 1.5 + 0.05;
    });
    return (this._speeds = out);
  }

  transform(e, t, out) {
    if (e.kind === 1) {
      const s = (t - e.t0) * this.dt;
      out.a = e.a0 + e.va * s;
      if (!e.svN) { out.x = e.x0 + e.vx * s; out.y = e.y0 + e.vy * s; return out; }
      // Pushed debris: drift from the last record before t, and in the few ticks before the
      // next record blend into it (the push happened in that window), so motion stays smooth.
      const S = this.sv, b = e.sv0, n = e.svN;
      let lo = -1, hi = n - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S.t[b + m] <= t) lo = m; else hi = m - 1; }
      let tk, x, y, vx, vy;
      if (lo < 0) { tk = e.t0; x = e.x0; y = e.y0; vx = e.vx; vy = e.vy; }
      else { const k = b + lo; tk = S.t[k]; x = S.x[k]; y = S.y[k]; vx = S.vx[k]; vy = S.vy[k]; }
      const d = (t - tk) * this.dt;
      out.x = x + vx * d; out.y = y + vy * d;
      if (lo + 1 < n) {
        const k = b + lo + 1, w = this.shoveEvery, u = 1 - (S.t[k] - t) / w;
        if (u > 0) {
          const f = u * u * (3 - 2 * u), dn = (S.t[k] - tk) * this.dt;
          out.x += (S.x[k] - (x + vx * dn)) * f; out.y += (S.y[k] - (y + vy * dn)) * f;
        }
      }
      return out;
    }
    const n = e.n, f = Math.max(0, t / this.TE);
    let i = Math.floor(f);
    if (i >= n - 1) {
      const b = e.s0 + n - 1, p = n > 1 ? b - 1 : b, u = f - (n - 1);
      out.x = this.tx[b] + (this.tx[b] - this.tx[p]) * u;
      out.y = this.ty[b] + (this.ty[b] - this.ty[p]) * u;
      out.a = this.ta[b] + (this.ta[b] - this.ta[p]) * u;
      return out;
    }
    const u = f - i, b = e.s0;
    const i0 = b + Math.max(0, i - 1), i1 = b + i, i2 = b + i + 1, i3 = b + Math.min(n - 1, i + 2);
    out.x = cr(this.tx[i0], this.tx[i1], this.tx[i2], this.tx[i3], u);
    out.y = cr(this.ty[i0], this.ty[i1], this.ty[i2], this.ty[i3], u);
    out.a = this.ta[i1] + (this.ta[i2] - this.ta[i1]) * u;
    return out;
  }

  computeBounds() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const e of this.ents) {
      if (e.kind !== 0) continue;
      const x = this.tx[e.s0], y = this.ty[e.s0];
      minX = Math.min(minX, x - e.radius); maxX = Math.max(maxX, x + e.radius);
      minY = Math.min(minY, y - e.radius); maxY = Math.max(maxY, y + e.radius);
    }
    const pad = 200;
    this.bounds = { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
  }

  /** Ships remaining per team, once per simulated second, for the timeline graph. */
  computeStrength() {
    const secs = Math.ceil(this.ticks * this.dt) + 1, per = Math.round(1 / this.dt);
    this.teams = Math.max(2, this.meta.teams || 2); // sides (free-for-all battles have more than two)
    const s = [];
    for (let t = 0; t < this.teams; t++) s.push(new Float32Array(secs));
    for (const e of this.ents) {
      if (e.kind !== 0) continue;
      const end = e.t1 === Infinity ? secs : Math.min(secs, Math.ceil(e.t1 / per));
      for (let k = 0; k < end; k++) s[e.team][k]++;
    }
    this.strength = s;
    this.startCount = s.map((x) => x[0]);
  }
}

function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
/** For each block of an entity, the block index on each side (+x, -x, +y, -y), or -1. Built once. */
function neighbours(e) {
  const n = e.lx.length, nb = new Int32Array(n * 4), w = e.w, h = e.h, map = e.map;
  for (let i = 0; i < n; i++) {
    const x = Math.round(e.lx[i] + w / 2 - 0.5), y = Math.round(e.ly[i] + h / 2 - 0.5), o = i * 4;
    nb[o] = x + 1 < w ? map[y * w + x + 1] : -1;
    nb[o + 1] = x > 0 ? map[y * w + x - 1] : -1;
    nb[o + 2] = y + 1 < h ? map[(y + 1) * w + x] : -1;
    nb[o + 3] = y > 0 ? map[(y - 1) * w + x] : -1;
  }
  return (e.nb = nb);
}
/**
 * For each cell of a design: 1 + its position (u * n + v) inside its multi-block unit (plasma
 * cannon / flak / shield 10x10, fighter bay 6x6, auto gun 2x2), plus n² × the way the unit's guns
 * point (0..7, see weaponLook.js; shields always 0); for a single-block weapon 1 + the way it
 * points; else 0. Units never touch (the designer refuses that), so each connected group of one
 * type is one unit and its bounding box gives the position. Cached on the design.
 */
const SINGLE_GUN = new Set([BT.LASER, BT.CANNON, BT.MISSILE, BT.PD, BT.GUIDED]);
function unitPos(d) {
  if (d._unit) return d._unit;
  const { w, h, cells } = d, out = new Uint16Array(w * h), seen = new Uint8Array(w * h), stack = [];
  for (let s = 0; s < cells.length; s++) {
    const T = cells[s];
    if (SINGLE_GUN.has(T)) { out[s] = 1 + openDir(cells, w, h, s); continue; }
    if (!MULTIBLOCK[T] || seen[s]) continue;
    const N = MULTIBLOCK[T].size;
    const group = [];
    let x0 = Infinity, y0 = Infinity;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const c = stack.pop(), x = c % w, y = (c / w) | 0;
      group.push(c); x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      for (const n of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, y > 0 ? c - w : -1, y < h - 1 ? c + w : -1])
        if (n >= 0 && !seen[n] && cells[n] === T) { seen[n] = 1; stack.push(n); }
    }
    let dir = 0;
    if (T !== BT.SHIELD) {
      const lf = lineOfFire(cells, null, w, h, group[0], {}, group);
      dir = unitDir({ m0: lf.m0, m1: lf.m1, route: lf.buried && T === BT.BAY ? bayRoute(cells, null, w, h, group) : null });
    }
    for (const c of group) out[c] = 1 + Math.min(N - 1, (c % w) - x0) * N + Math.min(N - 1, ((c / w) | 0) - y0) + dir * N * N;
  }
  return (d._unit = out);
}

/**
 * Fighters (shot kind 4, Nov 2026) are recorded like guided missiles: launch point, then a point
 * on their path every few ticks (gmRec/gmT/gmX/gmY) up to where they were shot down. Each stretch
 * between two points is a straight piece { t0, t1, x, y, vx, vy }; `launch` marks a fighter's
 * first piece (launch flash), `dead` a shot-down fighter's last piece (the renderer draws it
 * tumbling and burning out after that), and `fid` its shot index. Null if the replay has no fighters.
 */
function fighters(c, q) {
  if (!c.gmRec || !c.shotKind.includes(4)) return null;
  const pts = new Map();
  for (let k = 0; k < c.gmRec.length; k++) {
    const r = c.gmRec[k];
    if (c.shotKind[r] !== 4) continue;
    if (!pts.has(r)) pts.set(r, []);
    pts.get(r).push(c.gmT[k] / 10, c.gmX[k] / q, c.gmY[k] / q);
  }
  const seg = [];
  for (let i = 0; i < c.shotT0.length; i++) {
    if (c.shotKind[i] !== 4) continue;
    const p = [c.shotT0[i], c.shotX[i] / q, c.shotY[i] / q, ...(pts.get(i) || [])];
    let lastK = -1;
    for (let k = 0; k + 1 < p.length / 3; k++) if (p[k * 3 + 3] > p[k * 3]) lastK = k;
    for (let k = 0; k + 1 < p.length / 3; k++) {
      const ta = p[k * 3], tb = p[k * 3 + 3];
      if (tb <= ta) continue;
      const xa = p[k * 3 + 1], ya = p[k * 3 + 2];
      seg.push([ta, tb, xa, ya, (p[k * 3 + 4] - xa) / (tb - ta), (p[k * 3 + 5] - ya) / (tb - ta), c.shotTeam[i], k === 0 ? 1 : 0, i, k === lastK && c.shotHit[i] === 2 ? 1 : 0]);
    }
  }
  seg.sort((a, b) => a[0] - b[0]);
  const n = seg.length, F = { n, t0: new Float32Array(n), t1: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n),
    vx: new Float32Array(n), vy: new Float32Array(n), team: new Uint8Array(n), launch: new Uint8Array(n), fid: new Uint32Array(n), dead: new Uint8Array(n), maxPiece: 0 };
  seg.forEach((r, k) => {
    F.t0[k] = r[0]; F.t1[k] = r[1]; F.x[k] = r[2]; F.y[k] = r[3]; F.vx[k] = r[4]; F.vy[k] = r[5]; F.team[k] = r[6]; F.launch[k] = r[7]; F.fid[k] = r[8]; F.dead[k] = r[9];
    if (r[1] - r[0] > F.maxPiece) F.maxPiece = r[1] - r[0];
  });
  return F;
}

/**
 * Guided missiles (shot kind 3, Nov 2026) are recorded as points on their path (gmRec/gmT/gmX/gmY).
 * Each stretch between two points becomes a straight piece drawn like any heavy missile, with
 * a0 = the missile's age at the start of the piece (so its smoke trail keeps growing). Merged into
 * the missile list and sorted by start time. Replays without guided missiles are returned as is.
 */
/**
 * Which shots are around in each slice of LIVE_SLICE ticks (21 Nov 2026). Drawing used to look at
 * every shot fired within the longest flight of its kind (30 s for shells, 90 s for missiles), and
 * nearly all of those had long since hit: in a 4,000-ship battle 20 shells were looked at for every
 * one still flying. Now a frame only looks at the shots listed for its slice: S.live(t) gives the
 * [from, to) range in S.liveIdx. Each shot is listed from LIVE_PRE ticks before it fires (plasma's
 * charge-up glow) to LIVE_POST after it ends (impact sparks), in firing order within a slice.
 */
export const LIVE_SLICE = 16, LIVE_PRE = 16, LIVE_POST = 10; // POST covers hit sparks (5 ticks) plus the auto gun's drawn second tracer (2)
function liveIndex(S) {
  const n = S.n, a = new Int32Array(n), b = new Int32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    a[i] = Math.max(0, Math.floor((S.t0[i] - LIVE_PRE) / LIVE_SLICE));
    b[i] = Math.max(a[i], Math.floor((S.t1[i] + LIVE_POST) / LIVE_SLICE));
    if (b[i] > last) last = b[i];
  }
  const start = new Int32Array(last + 2);
  for (let i = 0; i < n; i++) for (let k = a[i]; k <= b[i]; k++) start[k + 1]++;
  for (let k = 0; k <= last; k++) start[k + 1] += start[k];
  const idx = new Int32Array(start[last + 1]), fill = start.slice(0, last + 1);
  for (let i = 0; i < n; i++) for (let k = a[i]; k <= b[i]; k++) idx[fill[k]++] = i;
  S.liveStart = start; S.liveIdx = idx;
  S.live = (t) => { const k = Math.floor(t / LIVE_SLICE); return k < 0 || k > last ? [0, 0] : [start[k], start[k + 1]]; };
  return S;
}

function withGuided(S, c, q) {
  if (!c.gmRec || !c.gmRec.length) return S;
  const pts = new Map();
  for (let k = 0; k < c.gmRec.length; k++) {
    const r = c.gmRec[k];
    if (!pts.has(r)) pts.set(r, []);
    pts.get(r).push(c.gmT[k] / 10, c.gmX[k] / q, c.gmY[k] / q);
  }
  const seg = [];
  for (let i = 0; i < c.shotT0.length; i++) {
    if (c.shotKind[i] !== 3) continue;
    const t0 = c.shotT0[i], p = [t0, c.shotX[i] / q, c.shotY[i] / q, ...(pts.get(i) || [])];
    const last = p.length / 3 - 1;
    for (let k = 0; k < last; k++) {
      const ta = p[k * 3], tb = p[k * 3 + 3];
      if (tb <= ta) continue;
      const xa = p[k * 3 + 1], ya = p[k * 3 + 2];
      seg.push([ta, tb, xa, ya, (p[k * 3 + 4] - xa) / (tb - ta), (p[k * 3 + 5] - ya) / (tb - ta), k === last - 1 ? c.shotHit[i] : 1, c.shotTeam[i], ta - t0]);
    }
  }
  if (!seg.length) return S;
  const all = [];
  for (let k = 0; k < S.n; k++) all.push([S.t0[k], S.t1[k], S.x[k], S.y[k], S.vx[k], S.vy[k], S.hit[k], S.team[k], 0]);
  for (const x of seg) all.push(x); // not push(...seg): a big battle has far more pieces than a call can take arguments
  all.sort((a, b) => a[0] - b[0]);
  const n = all.length, out = { n, t0: new Float32Array(n), t1: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n),
    vx: new Float32Array(n), vy: new Float32Array(n), hit: new Uint8Array(n), team: new Uint8Array(n), a0: new Float32Array(n), maxFlight: S.maxFlight };
  all.forEach((r, k) => {
    out.t0[k] = r[0]; out.t1[k] = r[1]; out.x[k] = r[2]; out.y[k] = r[3]; out.vx[k] = r[4]; out.vy[k] = r[5]; out.hit[k] = r[6]; out.team[k] = r[7]; out.a0[k] = r[8];
    if (r[1] - r[0] > out.maxFlight) out.maxFlight = r[1] - r[0];
  });
  return out;
}
