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
    const e = { kind, team, w, h, radius: Math.hypot(w, h) / 2, map: new Int32Array(w * h).fill(-1), tmp: [], sv0: 0, svN: 0 };
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
    this.decodeShoves(meta, c);
  }

  /**
   * Debris pushed by ships (replays from before debris collided have none). Each piece's records
   * are gathered in time order: from record k it drifts from svX/svY at svVx/svVy.
   */
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
    // Shells (kind 0) and heavy missiles (kind 1) fly straight from launch: every position
    // is launch point + velocity * age. Split by kind so each has a tight time window.
    const straight = (kind) => {
      const idx = [];
      for (let i = 0; i < c.shotT0.length; i++) if (c.shotKind[i] === kind) idx.push(i);
      const n = idx.length, spd = meta.shotSpeed[kind] * dt;
      const S = { n, t0: new Float32Array(n), t1: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n),
        vx: new Float32Array(n), vy: new Float32Array(n), hit: new Uint8Array(n), team: new Uint8Array(n), maxFlight: 0 };
      idx.forEach((i, k) => {
        const f = c.shotFlight[i] / 10, a = (c.shotAng[i] / 65536) * Math.PI * 2;
        S.t0[k] = c.shotT0[i]; S.t1[k] = c.shotT0[i] + f; S.x[k] = c.shotX[i] / q; S.y[k] = c.shotY[i] / q;
        S.vx[k] = Math.cos(a) * spd; S.vy[k] = Math.sin(a) * spd; // units per tick
        S.hit[k] = c.shotHit[i]; S.team[k] = c.shotTeam[i];
        if (f > S.maxFlight) S.maxFlight = f;
      });
      return S;
    };
    this.shell = straight(0);
    this.missile = straight(1);
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
