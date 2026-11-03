// Turns a packed replay into something the renderer can query at ANY time t.
//
// Nothing here is incremental: every block, chunk, shot and spark is a pure function of t.
// That is what makes scrubbing backwards/forwards free and keeps the viewer simple.
// Time is measured in sim ticks (float).

import { unpackReplay } from '../shared/replayFormat.js';

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
      for (let i = 0; i < d.cells.length; i++) if (d.cells[i]) this.addCell(e, i, d.cells[i]);
      this.finishEnt(e);
    }
  }

  makeEnt(kind, team, w, h) {
    const e = { kind, team, w, h, radius: Math.hypot(w, h) / 2, map: new Int32Array(w * h).fill(-1), tmp: [] };
    this.ents.push(e);
    return e;
  }

  addCell(e, gridIndex, type) {
    e.map[gridIndex] = e.tmp.length / 3;
    e.tmp.push((gridIndex % e.w) + 0.5 - e.w / 2, ((gridIndex / e.w) | 0) + 0.5 - e.h / 2, type);
  }

  finishEnt(e) {
    const n = e.tmp.length / 3;
    e.lx = new Float32Array(n); e.ly = new Float32Array(n); e.type = new Uint8Array(n);
    e.death = new Float32Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) { e.lx[i] = e.tmp[i * 3]; e.ly[i] = e.tmp[i * 3 + 1]; e.type[i] = e.tmp[i * 3 + 2]; }
    e.tmp = null;
  }

  decodeChunks(meta, c) {
    const C = meta.chunkCount;
    for (let k = 0; k < C; k++) {
      const parent = this.ents[c.chParent[k]];
      const pd = this.designs[parent.design];
      const cw = c.chW[k], ch = c.chH[k], minI = c.chMinI[k], minJ = c.chMinJ[k];
      const e = this.makeEnt(1, parent.team, cw, ch);
      e.t0 = c.chT0[k];
      e.x0 = c.chX[k]; e.y0 = c.chY[k]; e.a0 = c.chA[k];
      e.vx = c.chVx[k]; e.vy = c.chVy[k]; e.va = c.chVa[k];
      e.size = c.chN[k];
      for (let m = 0; m < c.chN[k]; m++) {
        const pi = c.chCells[c.chC0[k] + m];
        const ci = (((pi / pd.w) | 0) - minJ) * cw + ((pi % pd.w) - minI);
        this.addCell(e, ci, pd.cells[pi]);
      }
      this.finishEnt(e);
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
    const sp = [];
    const tr = { x: 0, y: 0, a: 0 }, tr2 = { x: 0, y: 0, a: 0 };
    for (let k = 0; k < n; k++) {
      if (c.bdCause[k] !== 0) continue;
      const ei = c.bdEnt[k], e = this.ents[ei], t = c.bdT[k];
      const li = e.map[c.bdCell[k]];
      this.transform(e, t, tr); this.transform(e, t - 1, tr2);
      const cs = Math.cos(tr.a), sn = Math.sin(tr.a);
      sp.push(t, tr.x + e.lx[li] * cs - e.ly[li] * sn, tr.y + e.lx[li] * sn + e.ly[li] * cs,
        (tr.x - tr2.x) / this.dt, (tr.y - tr2.y) / this.dt, k, e.type[li]);
    }
    for (const e of this.ents) e.map = null;
    this.spark = new Float32Array(sp);
    this.sparkT = new Float32Array(sp.length / 7);
    for (let i = 0; i < this.sparkT.length; i++) this.sparkT[i] = sp[i * 7];
  }

  decodeEffects(meta, c) {
    const q = meta.evQ, dt = meta.dt, sp = meta.kineticSpeed;
    // Kinetic rounds: straight lines from spawn.
    const ns = c.shotT0.length;
    this.shot = { n: ns, t0: c.shotT0, t1: new Float32Array(ns), x: new Float32Array(ns), y: new Float32Array(ns),
      vx: new Float32Array(ns), vy: new Float32Array(ns), hit: c.shotHit, team: c.shotTeam, maxFlight: 0 };
    for (let i = 0; i < ns; i++) {
      const s = this.shot, f = c.shotFlight[i] / 10, a = (c.shotAng[i] / 65536) * Math.PI * 2;
      s.t1[i] = c.shotT0[i] + f; s.x[i] = c.shotX[i] / q; s.y[i] = c.shotY[i] / q;
      s.vx[i] = Math.cos(a) * sp * dt; s.vy[i] = Math.sin(a) * sp * dt; // units per tick
      if (f > s.maxFlight) s.maxFlight = f;
    }
    const nl = c.lasT.length;
    this.laser = { n: nl, t: c.lasT, x0: new Float32Array(nl), y0: new Float32Array(nl), x1: new Float32Array(nl), y1: new Float32Array(nl), team: c.lasTeam, hit: c.lasHit };
    for (let i = 0; i < nl; i++) {
      const L = this.laser, a = (c.lasAng[i] / 65536) * Math.PI * 2, len = c.lasLen[i];
      L.x0[i] = c.lasX[i] / q; L.y0[i] = c.lasY[i] / q;
      L.x1[i] = L.x0[i] + Math.cos(a) * len; L.y1[i] = L.y0[i] + Math.sin(a) * len;
    }
    const nm = c.misT0.length;
    this.missile = { n: nm, t0: c.misT0, t1: c.misT1, team: c.misTeam, hit: c.misHit, s0: c.misS0, sn: c.misN,
      xy: Float32Array.from(c.misXY, (v) => v / q), every: meta.missileEvery, maxLife: 0 };
    for (let i = 0; i < nm; i++) this.missile.maxLife = Math.max(this.missile.maxLife, c.misT1[i] - c.misT0[i]);
    this.expl = { n: c.expT.length, t: c.expT, x: Float32Array.from(c.expX, (v) => v / q), y: Float32Array.from(c.expY, (v) => v / q) };
    // Ship deaths, sorted by time.
    const deaths = [];
    const tr = { x: 0, y: 0, a: 0 };
    for (const e of this.ents) if (e.kind === 0 && e.t1 !== Infinity) { this.transform(e, e.t1, tr); deaths.push([e.t1, tr.x, tr.y, e.radius, e.team]); }
    deaths.sort((a, b) => a[0] - b[0]);
    this.death = { n: deaths.length, t: Float32Array.from(deaths, (d) => d[0]), d: deaths };
  }

  /** Interpolated transform. Ships: Catmull-Rom through 0.4 s samples. Chunks: analytic drift. */
  transform(e, t, out) {
    if (e.kind === 1) {
      const s = (t - e.t0) * this.dt;
      out.x = e.x0 + e.vx * s; out.y = e.y0 + e.vy * s; out.a = e.a0 + e.va * s;
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
    const s = [new Float32Array(secs), new Float32Array(secs)];
    for (const e of this.ents) {
      if (e.kind !== 0) continue;
      const end = e.t1 === Infinity ? secs : Math.min(secs, Math.ceil(e.t1 / per));
      for (let k = 0; k < end; k++) s[e.team][k]++;
    }
    this.strength = s;
    this.startCount = [s[0][0], s[1][0]];
  }
}

function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
