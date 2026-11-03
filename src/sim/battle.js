// Headless, server-side battle resolver.
//
// Design rules that make thousands of ships feasible:
//  * Runs offline when a fleet arrives (OGame/Travian style), never in real time.
//    A battle that takes 20 s to compute is fine; nobody is watching it live.
//  * 2D. Ships are grids of blocks. No rigid-body physics, no ship-ship collision
//    response beyond a soft separation nudge.
//  * One shared broadphase grid; every projectile does an exact ray-vs-block-grid
//    walk (DDA) only against ships whose bounding circle it actually crosses.
//  * Debris chunks drift with constant velocity/spin, so the viewer can compute
//    their position at any time with a formula and nothing has to be recorded.
//  * Everything is recorded as events + low-rate transform samples (see toReplay()).

import { BT, BLOCKS, WEAPON, isWeapon } from '../shared/blocks.js';
import { mulberry32 } from '../shared/rng.js';
import { Col } from '../shared/replayFormat.js';
import { SpatialGrid } from './spatial.js';

export const DT = 0.1; // 10 ticks per simulated second
export const TRACK_EVERY = 4; // ship transform sample every 0.4 s (viewer uses spline interpolation)
export const MISSILE_EVERY = 3; // missile position sample every 0.3 s
export const POS_Q = 4; // position quantisation: 1/4 block
const TWO_PI = Math.PI * 2;
const ANG_Q = 2048 / Math.PI; // 4096 steps per turn
export const EV_Q = 4; // event positions stored as Int16 in 1/4 block (±8191 blocks)
const q16 = (v) => { const r = Math.round(v * EV_Q); return r > 32767 ? 32767 : r < -32768 ? -32768 : r; };
const qAng = (a) => Math.round((wrapAngle(a) / TWO_PI) * 65536) & 0xffff;
const wrapAngle = (a) => a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
const SHIP = 0, CHUNK = 1;
const CHUNK_RETIRE_TICKS = 250; // after 25 s debris stops being hittable (still drawn by viewer)
const K_KINETIC = 0, K_MISSILE = 1;

export class Battle {
  constructor({ designs, ships, seed = 1, maxTime = 180 }) {
    this.designs = designs;
    this.rng = mulberry32(seed);
    this.tick = 0;
    this.now = 0;
    this.maxTicks = Math.round(maxTime / DT);
    this.endTick = -1;
    this.done = false;
    this.ents = [];
    this.byId = [];
    this.shipCount = ships.length;
    this.teamAlive = [0, 0];
    this.teamStart = [0, 0];
    this.teamCx = [0, 0];
    this.teamCy = [0, 0];
    this.grid = new SpatialGrid(32, 6144);
    this.stamp = new Int32Array(8192);
    this.stampGen = 1;
    this.queue = new Int32Array(8192);
    this.initProjectiles(8192);
    this.initRecorder();
    this.perf = { ticks: 0, ms: 0, raycasts: 0, peakProjectiles: 0, peakEntities: 0 };
    for (const s of ships) this.spawnShip(s);
    this.grid.build(this.ents);
    this.recordTracks();
  }

  // ---------------------------------------------------------------- setup
  spawnShip(spec) {
    const d = this.designs[spec.design];
    const e = this.makeEntity(SHIP, spec.team, d.w, d.h, d.cells.slice());
    for (let i = 0; i < e.types.length; i++) if (e.types[i]) { e.hp[i] = BLOCKS[e.types[i]].hp; e.alive++; }
    e.x = spec.x; e.y = spec.y; e.a = spec.a; e.c = Math.cos(e.a); e.s = Math.sin(e.a);
    e.design = spec.design;
    e.hub = d.hub;
    e.orbit = this.rng() < 0.5 ? 1 : -1;
    e.targets = [];
    e.retarget = this.rng();
    e.weapons = [];
    for (let i = 0; i < e.types.length; i++) {
      if (!isWeapon(e.types[i])) continue;
      e.weapons.push({ cell: i, type: e.types[i], lx: (i % d.w) + 0.5 - d.w / 2, ly: ((i / d.w) | 0) + 0.5 - d.h / 2, cd: this.rng() * 2 });
    }
    e.track = [];
    e.t1 = 65535;
    this.refit(e);
    this.teamAlive[e.team]++;
    this.teamStart[e.team]++;
  }

  makeEntity(kind, team, w, h, types) {
    const e = {
      id: this.byId.length, kind, team, w, h, types, hp: new Float32Array(w * h), alive: 0,
      x: 0, y: 0, a: 0, vx: 0, vy: 0, va: 0, c: 1, s: 0,
      radius: Math.hypot(w, h) / 2, dead: false, retired: false, dirty: false, hubDead: false, _q: 0, t0: this.now,
    };
    this.byId.push(e);
    this.ents.push(e);
    if (w * h > this.stamp.length) { this.stamp = new Int32Array(w * h * 2); this.queue = new Int32Array(w * h * 2); }
    return e;
  }

  /** Recompute mobility and weapon list after blocks are lost. */
  refit(e) {
    let mass = 0, thrust = 0, range = 0;
    for (let i = 0; i < e.types.length; i++) {
      const t = e.types[i];
      if (!t || e.hp[i] <= 0) continue;
      mass += BLOCKS[t].mass;
      if (t === BT.THRUSTER) thrust += BLOCKS[t].thrust;
    }
    e.weapons = e.weapons.filter((w) => e.hp[w.cell] > 0);
    for (const w of e.weapons) if (w.type !== BT.MISSILE) range = Math.max(range, WEAPON[w.type].range);
    e.mass = Math.max(1, mass);
    // The hub has weak manoeuvring jets, so a ship that loses every engine still crawls.
    e.maxSpeed = Math.max(2.5, Math.min(22, (30 * thrust) / e.mass));
    e.turn = Math.max(0.05, Math.min(2.5, (1.6 * e.maxSpeed) / e.w));
    e.agility = Math.max(0.25, Math.min(2, e.maxSpeed / 8));
    e.prefRange = range ? range * 0.75 : 60;
  }

  // ---------------------------------------------------------------- main loop
  step() {
    if (this.done) return false;
    const t0 = performance.now();
    this.now = this.tick + 1;
    this.teamStats();

    for (let k = 0; k < this.ents.length; k++) {
      const e = this.ents[k];
      if (e.dead) continue;
      if (e.kind === SHIP) { this.think(e); this.move(e); }
      else {
        e.x += e.vx * DT; e.y += e.vy * DT; e.a += e.va * DT;
        e.c = Math.cos(e.a); e.s = Math.sin(e.a);
        if (this.now - e.t0 > CHUNK_RETIRE_TICKS) e.retired = true;
      }
    }
    this.ents = this.ents.filter((e) => !e.dead && !e.retired);
    this.grid.build(this.ents);

    this.updateProjectiles();
    const n = this.ents.length;
    for (let k = 0; k < n; k++) { const e = this.ents[k]; if (e.kind === SHIP && !e.dead) this.fire(e); }
    this.resolveDamage();
    if (this.now % TRACK_EVERY === 0) this.recordTracks();

    this.tick++;
    this.perf.ticks++;
    this.perf.ms += performance.now() - t0;
    this.perf.peakProjectiles = Math.max(this.perf.peakProjectiles, this.P.n);
    this.perf.peakEntities = Math.max(this.perf.peakEntities, this.ents.length);

    // End when a side has no warships left, when the fleets have disengaged (20 s with no
    // damage dealt), or at the time limit.
    const stalled = this.tick > 300 && this.now - (this.lastDamage || 0) > 200;
    // Rout: a side down to <12% of its starting ships still able to fight, and outgunned 2:1.
    const a0 = this.armed[0].length, a1 = this.armed[1].length;
    const routed = (a0 < this.teamStart[0] * 0.12 && a1 > 2 * a0) || (a1 < this.teamStart[1] * 0.12 && a0 > 2 * a1);
    if (this.endTick < 0 && (!a0 || !a1 || stalled || routed || this.tick >= this.maxTicks))
      this.endTick = this.tick + 40; // let the last missiles and debris play out
    if (this.endTick >= 0 && this.tick >= this.endTick) this.done = true;
    return !this.done;
  }

  run(onProgress) {
    while (this.step()) if (onProgress && this.tick % 50 === 0) onProgress(this);
    return this;
  }

  teamStats() {
    // Only armed ships count: disarmed hulks retreat and no longer hold the field.
    const sx = [0, 0], sy = [0, 0];
    this.armed = [[], []];
    for (const e of this.ents)
      if (e.kind === SHIP && !e.dead && e.weapons.length) { sx[e.team] += e.x; sy[e.team] += e.y; this.armed[e.team].push(e); }
    for (let t = 0; t < 2; t++) {
      const n = this.armed[t].length;
      if (n) { this.teamCx[t] = sx[t] / n; this.teamCy[t] = sy[t] / n; }
    }
  }

  // ---------------------------------------------------------------- AI
  think(e) {
    e.retarget -= DT;
    if (e.targets.length && e.targets[0].dead) e.targets = e.targets.filter((t) => !t.dead);
    if (e.retarget > 0 && e.targets.length) return;
    e.retarget = 0.8 + this.rng() * 0.8;
    const best = [], bd = [];
    const fn = (o) => {
      if (o.kind !== SHIP || o.dead || o.team === e.team) return;
      // Prefer ships that can still shoot back; burning hulks are low priority.
      const d = ((o.x - e.x) ** 2 + (o.y - e.y) ** 2) * (o.weapons.length ? 1 : 9);
      let k = best.length;
      while (k > 0 && bd[k - 1] > d) k--;
      if (k >= 4) return;
      best.splice(k, 0, o); bd.splice(k, 0, d);
      if (best.length > 4) { best.pop(); bd.pop(); }
    };
    fn.done = (ring) => (best.length >= 4 && ring >= 1) || (best.length > 0 && ring >= 3);
    this.grid.queryRings(e.x, e.y, 10, fn);
    if (!best.length) {
      // Nobody close: pick the nearest of a random sample of enemy warships and go get them.
      const pool = this.armed[1 - e.team];
      for (let k = 0; k < Math.min(16, pool.length); k++) fn(pool[(this.rng() * pool.length) | 0]);
    }
    e.targets = best;
  }

  move(e) {
    const tg = e.targets[0];
    let tx, ty;
    const other = 1 - e.team;
    const disarmed = !e.weapons.length;
    if (tg && !disarmed) { tx = tg.x; ty = tg.y; }
    else if (this.armed[other].length) { tx = this.teamCx[other]; ty = this.teamCy[other]; }
    else { tx = e.x + e.c; ty = e.y + e.s; }
    const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
    let desired = Math.atan2(dy, dx);
    if (disarmed) desired += Math.PI; // crippled: run away from the enemy fleet
    const pr = e.prefRange;
    if (tg && !disarmed) {
      if (d < pr * 0.8) desired += e.orbit * Math.PI * 0.5; // broadside / orbit
      else if (d < pr * 1.1) desired += e.orbit * 0.5;
    }
    const da = wrapAngle(desired - e.a), mt = e.turn * DT;
    e.a = wrapAngle(e.a + (da > mt ? mt : da < -mt ? -mt : da));
    e.c = Math.cos(e.a); e.s = Math.sin(e.a);
    {
      const want = tg && !disarmed && d < pr * 0.8 ? e.maxSpeed * 0.55 : e.maxSpeed;
      const k = 1 - Math.exp(-e.agility * DT);
      e.vx += (e.c * want - e.vx) * k;
      e.vy += (e.s * want - e.vy) * k;
    }
    // Soft separation from friendly ships sharing our grid cell (cheap, approximate).
    const g = this.grid, cell = g.cx(e.y) * g.n + g.cx(e.x), s = g.start[cell], m = Math.min(g.count[cell], 8);
    for (let k = 0; k < m; k++) {
      const o = g.ents[g.items[s + k]];
      if (o === e || o.kind !== SHIP || o.dead || o.team !== e.team) continue;
      const ox = e.x - o.x, oy = e.y - o.y, d2 = ox * ox + oy * oy, md = (e.radius + o.radius) * 0.5;
      if (d2 < md * md && d2 > 1e-4) {
        const dd = Math.sqrt(d2), push = ((md - dd) / md) * 3 * DT * (o.mass / (o.mass + e.mass)) * 10;
        e.vx += (ox / dd) * push; e.vy += (oy / dd) * push;
      }
    }
    e.x += e.vx * DT; e.y += e.vy * DT;
  }

  // ---------------------------------------------------------------- weapons
  initProjectiles(cap) {
    this.P = {
      n: 0, cap,
      x: new Float64Array(cap), y: new Float64Array(cap), vx: new Float64Array(cap), vy: new Float64Array(cap),
      life: new Int32Array(cap), kind: new Uint8Array(cap), owner: new Int32Array(cap), team: new Uint8Array(cap),
      target: new Int32Array(cap), dmg: new Float32Array(cap), rec: new Int32Array(cap), t0: new Int32Array(cap),
    };
  }

  addProjectile(kind, x, y, vx, vy, life, owner, team, target, dmg, rec) {
    let P = this.P;
    if (P.n === P.cap) {
      const old = P;
      this.initProjectiles(old.cap * 2);
      P = this.P;
      for (const k of Object.keys(P)) if (ArrayBuffer.isView(P[k])) P[k].set(old[k]);
      P.n = old.n;
    }
    const i = P.n++;
    P.x[i] = x; P.y[i] = y; P.vx[i] = vx; P.vy[i] = vy; P.life[i] = life; P.kind[i] = kind;
    P.owner[i] = owner; P.team[i] = team; P.target[i] = target; P.dmg[i] = dmg; P.rec[i] = rec; P.t0[i] = this.now;
  }

  removeProjectile(i) {
    const P = this.P, j = --P.n;
    if (i === j) return;
    for (const k in P) { const a = P[k]; if (ArrayBuffer.isView(a)) a[i] = a[j]; }
  }

  fire(e) {
    const tl = e.targets.length;
    if (!tl) { for (const w of e.weapons) w.cd -= DT; return; }
    for (let k = 0; k < e.weapons.length; k++) {
      const w = e.weapons[k];
      w.cd -= DT;
      if (w.cd > 0) continue;
      const W = WEAPON[w.type];
      let tg = e.targets[k % tl];
      const wx = e.x + w.lx * e.c - w.ly * e.s, wy = e.y + w.lx * e.s + w.ly * e.c;
      let dx = tg.x - wx, dy = tg.y - wy;
      if (dx * dx + dy * dy > W.range * W.range) {
        tg = e.targets[0]; dx = tg.x - wx; dy = tg.y - wy;
        if (dx * dx + dy * dy > W.range * W.range) { w.cd = 0.3 + this.rng() * 0.3; continue; }
      }
      w.cd = W.cooldown * (0.85 + 0.3 * this.rng());
      // Aim at a random block of the target so hits spread over the hull.
      let ax = tg.x, ay = tg.y;
      for (let tries = 0; tries < 4; tries++) {
        const ci = (this.rng() * tg.types.length) | 0;
        if (!tg.types[ci] || tg.hp[ci] <= 0) continue;
        const lx = (ci % tg.w) + 0.5 - tg.w / 2, ly = ((ci / tg.w) | 0) + 0.5 - tg.h / 2;
        ax = tg.x + lx * tg.c - ly * tg.s; ay = tg.y + lx * tg.s + ly * tg.c;
        break;
      }
      if (W.kind === 'laser') this.fireLaser(e, wx, wy, ax, ay, W);
      else if (W.kind === 'kinetic') {
        const dist = Math.hypot(ax - wx, ay - wy), t = dist / W.speed;
        ax += tg.vx * t; ay += tg.vy * t; // lead the target
        const ang = Math.atan2(ay - wy, ax - wx) + (this.rng() - 0.5) * 2 * W.spread;
        const rec = this.R.shotT0.push(this.now);
        this.R.shotFlight.push(0); this.R.shotX.push(q16(wx)); this.R.shotY.push(q16(wy));
        this.R.shotAng.push(qAng(ang));
        this.R.shotHit.push(0); this.R.shotTeam.push(e.team);
        const life = Math.ceil((W.range * 1.15) / W.speed / DT);
        this.addProjectile(K_KINETIC, wx, wy, Math.cos(ang) * W.speed, Math.sin(ang) * W.speed, life, e.id, e.team, -1, W.damage, rec);
      } else {
        const ang = Math.atan2(ay - wy, ax - wx) + (this.rng() - 0.5) * 1.8;
        const rec = this.R.misT0.push(this.now);
        this.R.misT1.push(0); this.R.misTeam.push(e.team); this.R.misHit.push(0);
        this.R.misS0.push(this.R.misXY.n / 2); this.R.misN.push(1);
        this.R.misXY.push(q16(wx)); this.R.misXY.push(q16(wy));
        this.addProjectile(K_MISSILE, wx, wy, Math.cos(ang) * W.speed, Math.sin(ang) * W.speed, Math.round(W.life / DT), e.id, e.team, tg.id, W.damage, rec);
      }
    }
  }

  fireLaser(e, x0, y0, ax, ay, W) {
    const dx = ax - x0, dy = ay - y0, d = Math.hypot(dx, dy) || 1;
    const x1 = x0 + (dx / d) * W.range, y1 = y0 + (dy / d) * W.range;
    const hit = this.sweep(x0, y0, x1, y1, e.id);
    let ex = x1, ey = y1;
    if (hit) {
      ex = x0 + (x1 - x0) * this.hitT; ey = y0 + (y1 - y0) * this.hitT;
      this.damageCell(this.hitE, this.hitCell, W.damage);
    }
    const R = this.R;
    R.lasT.push(this.now); R.lasX.push(q16(x0)); R.lasY.push(q16(y0));
    R.lasAng.push(qAng(Math.atan2(dy, dx))); R.lasLen.push(Math.min(255, Math.round(Math.hypot(ex - x0, ey - y0))));
    R.lasTeam.push(e.team); R.lasHit.push(hit ? 1 : 0);
  }

  updateProjectiles() {
    const P = this.P, R = this.R;
    const MW = WEAPON[BT.MISSILE];
    for (let i = 0; i < P.n; i++) {
      if (P.kind[i] === K_MISSILE) {
        const tg = this.byId[P.target[i]];
        if (tg && !tg.dead) {
          const cur = Math.atan2(P.vy[i], P.vx[i]);
          const da = wrapAngle(Math.atan2(tg.y - P.y[i], tg.x - P.x[i]) - cur), mt = MW.turn * DT;
          const na = cur + (da > mt ? mt : da < -mt ? -mt : da);
          P.vx[i] = Math.cos(na) * MW.speed; P.vy[i] = Math.sin(na) * MW.speed;
        }
      }
      const x0 = P.x[i], y0 = P.y[i], x1 = x0 + P.vx[i] * DT, y1 = y0 + P.vy[i] * DT;
      const hit = this.sweep(x0, y0, x1, y1, P.owner[i]);
      const rec = P.rec[i];
      if (hit) {
        const t = this.hitT, hx = x0 + (x1 - x0) * t, hy = y0 + (y1 - y0) * t;
        if (P.kind[i] === K_KINETIC) {
          this.damageCell(this.hitE, this.hitCell, P.dmg[i]);
          R.shotFlight.set(rec, Math.round((this.now - 1 + t - R.shotT0.a[rec]) * 10)); R.shotHit.set(rec, 1);
        } else {
          this.splash(this.hitE, hx, hy, MW.splash, P.dmg[i]);
          this.endMissile(rec, hx, hy, this.now - 1 + t, 1);
          R.expT.push(this.now); R.expX.push(q16(hx)); R.expY.push(q16(hy));
        }
        this.removeProjectile(i--);
        continue;
      }
      P.x[i] = x1; P.y[i] = y1;
      if (--P.life[i] <= 0) {
        if (P.kind[i] === K_KINETIC) R.shotFlight.set(rec, Math.round((this.now - R.shotT0.a[rec]) * 10));
        else this.endMissile(rec, x1, y1, this.now, 0);
        this.removeProjectile(i--);
        continue;
      }
      if (P.kind[i] === K_MISSILE && (this.now - P.t0[i]) % MISSILE_EVERY === 0) {
        R.misXY.push(q16(x1)); R.misXY.push(q16(y1)); R.misN.set(rec, R.misN.a[rec] + 1);
      }
    }
  }

  endMissile(rec, x, y, t1, hit) {
    const R = this.R;
    R.misXY.push(q16(x)); R.misXY.push(q16(y));
    R.misN.set(rec, R.misN.a[rec] + 1);
    R.misT1.set(rec, t1); R.misHit.set(rec, hit);
  }

  // ---------------------------------------------------------------- hit detection
  /** Find the first live block hit by segment (x0,y0)->(x1,y1). Sets hitE/hitCell/hitT. */
  sweep(x0, y0, x1, y1, ownerId) {
    const g = this.grid, q = ++g.qid, ents = g.ents, n = g.n;
    const gx0 = g.cx(Math.min(x0, x1)), gx1 = g.cx(Math.max(x0, x1));
    const gy0 = g.cx(Math.min(y0, y1)), gy1 = g.cx(Math.max(y0, y1));
    const sdx = x1 - x0, sdy = y1 - y0, len2 = sdx * sdx + sdy * sdy || 1e-9;
    let bestT = 2, bestE = null, bestCell = -1;
    for (let cy = gy0; cy <= gy1; cy++)
      for (let cx = gx0; cx <= gx1; cx++) {
        const c = cy * n + cx, s = g.start[c], m = g.count[c];
        for (let k = 0; k < m; k++) {
          const e = ents[g.items[s + k]];
          if (e._q === q) continue;
          e._q = q;
          if (e.dead || e.retired || e.id === ownerId) continue;
          // Bounding circle vs segment.
          let t = ((e.x - x0) * sdx + (e.y - y0) * sdy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = x0 + sdx * t - e.x, py = y0 + sdy * t - e.y;
          if (px * px + py * py > e.radius * e.radius) continue;
          this.perf.raycasts++;
          const ht = this.raycast(e, x0, y0, x1, y1, bestT);
          if (ht >= 0 && ht < bestT) { bestT = ht; bestE = e; bestCell = this._cell; }
        }
      }
    if (!bestE) return false;
    this.hitE = bestE; this.hitCell = bestCell; this.hitT = bestT;
    return true;
  }

  /** Grid DDA (Amanatides & Woo) in the ship's local block grid. Returns segment param or -1. */
  raycast(e, x0, y0, x1, y1, tMax) {
    const c = e.c, s = e.s, w = e.w, h = e.h, types = e.types, hp = e.hp;
    let dx = x0 - e.x, dy = y0 - e.y;
    const gx0 = dx * c + dy * s + w * 0.5, gy0 = -dx * s + dy * c + h * 0.5;
    dx = x1 - e.x; dy = y1 - e.y;
    const ddx = dx * c + dy * s + w * 0.5 - gx0, ddy = -dx * s + dy * c + h * 0.5 - gy0;
    let t0 = 0, t1 = tMax < 1 ? tMax : 1, r;
    // Liang-Barsky clip to [0,w]x[0,h]
    if (ddx === 0) { if (gx0 < 0 || gx0 > w) return -1; }
    else {
      r = -gx0 / ddx; const r2 = (w - gx0) / ddx;
      const lo = r < r2 ? r : r2, hi = r < r2 ? r2 : r;
      if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
    }
    if (ddy === 0) { if (gy0 < 0 || gy0 > h) return -1; }
    else {
      r = -gy0 / ddy; const r2 = (h - gy0) / ddy;
      const lo = r < r2 ? r : r2, hi = r < r2 ? r2 : r;
      if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
    }
    if (t0 > t1) return -1;
    let ix = Math.floor(gx0 + ddx * t0), iy = Math.floor(gy0 + ddy * t0);
    if (ix < 0) ix = 0; else if (ix >= w) ix = w - 1;
    if (iy < 0) iy = 0; else if (iy >= h) iy = h - 1;
    const stx = ddx > 0 ? 1 : -1, sty = ddy > 0 ? 1 : -1;
    const tdx = ddx !== 0 ? Math.abs(1 / ddx) : Infinity, tdy = ddy !== 0 ? Math.abs(1 / ddy) : Infinity;
    let tmx = ddx > 0 ? (ix + 1 - gx0) / ddx : ddx < 0 ? (ix - gx0) / ddx : Infinity;
    let tmy = ddy > 0 ? (iy + 1 - gy0) / ddy : ddy < 0 ? (iy - gy0) / ddy : Infinity;
    let t = t0;
    for (let guard = w + h + 2; guard > 0; guard--) {
      const i = iy * w + ix;
      if (types[i] && hp[i] > 0) { this._cell = i; return t; }
      if (tmx < tmy) { t = tmx; if (t > t1) return -1; ix += stx; tmx += tdx; if (ix < 0 || ix >= w) return -1; }
      else { t = tmy; if (t > t1) return -1; iy += sty; tmy += tdy; if (iy < 0 || iy >= h) return -1; }
    }
    return -1;
  }

  damageCell(e, i, dmg) {
    const before = e.hp[i];
    if (before <= 0) return;
    e.hp[i] = before - dmg;
    this.lastDamage = this.now;
    if (e.hp[i] > 0) return;
    e.hp[i] = 0;
    e.alive--;
    e.dirty = true;
    this.recBlockDeath(e.id, i, 0);
    if (e.kind === SHIP && i === e.hub) e.hubDead = true;
  }

  splash(e, x, y, radius, dmg) {
    const dx = x - e.x, dy = y - e.y;
    const gx = dx * e.c + dy * e.s + e.w * 0.5, gy = -dx * e.s + dy * e.c + e.h * 0.5;
    const r = Math.ceil(radius);
    for (let j = Math.max(0, Math.floor(gy) - r); j <= Math.min(e.h - 1, Math.floor(gy) + r); j++)
      for (let i = Math.max(0, Math.floor(gx) - r); i <= Math.min(e.w - 1, Math.floor(gx) + r); i++) {
        const d = Math.hypot(i + 0.5 - gx, j + 0.5 - gy);
        if (d <= radius && e.types[j * e.w + i]) this.damageCell(e, j * e.w + i, dmg * (1 - (0.6 * d) / radius));
      }
  }

  // ---------------------------------------------------------------- break-up
  resolveDamage() {
    const n = this.ents.length;
    for (let k = 0; k < n; k++) {
      const e = this.ents[k];
      if (!e.dirty || e.dead) continue;
      e.dirty = false;
      if (e.kind === CHUNK) { if (e.alive <= 0) e.dead = true; continue; }
      if (e.hubDead || e.alive <= 0) { this.destroyShip(e); continue; }
      // Anything no longer connected to the hub breaks off as a debris chunk.
      const seen = this.flood(e, e.hub);
      for (let i = 0; i < e.types.length; i++)
        if (e.types[i] && e.hp[i] > 0 && this.stamp[i] !== seen) this.makeChunk(e, this.flood(e, i, true));
      this.refit(e);
    }
  }

  /** BFS over live 4-connected blocks. Returns the stamp, or the cell list if wantList. */
  flood(e, start, wantList = false) {
    const gen = ++this.stampGen, st = this.stamp, q = this.queue, w = e.w, h = e.h;
    let head = 0, tail = 0;
    q[tail++] = start; st[start] = gen;
    while (head < tail) {
      const i = q[head++], x = i % w, y = (i / w) | 0;
      if (x > 0) { const j = i - 1; if (st[j] !== gen && e.types[j] && e.hp[j] > 0) { st[j] = gen; q[tail++] = j; } }
      if (x < w - 1) { const j = i + 1; if (st[j] !== gen && e.types[j] && e.hp[j] > 0) { st[j] = gen; q[tail++] = j; } }
      if (y > 0) { const j = i - w; if (st[j] !== gen && e.types[j] && e.hp[j] > 0) { st[j] = gen; q[tail++] = j; } }
      if (y < h - 1) { const j = i + w; if (st[j] !== gen && e.types[j] && e.hp[j] > 0) { st[j] = gen; q[tail++] = j; } }
    }
    return wantList ? Array.from(q.subarray(0, tail)) : gen;
  }

  destroyShip(e) {
    e.dead = true;
    e.t1 = this.now;
    this.teamAlive[e.team]--;
    for (let i = 0; i < e.types.length; i++)
      if (e.types[i] && e.hp[i] > 0) this.makeChunk(e, this.flood(e, i, true), 1.8);
  }

  makeChunk(p, cells, violence = 1) {
    const pw = p.w;
    let minI = 1e9, maxI = -1, minJ = 1e9, maxJ = -1;
    for (const idx of cells) {
      const i = idx % pw, j = (idx / pw) | 0;
      if (i < minI) minI = i; if (i > maxI) maxI = i; if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
    }
    const cw = maxI - minI + 1, ch = maxJ - minJ + 1;
    const lcx = (minI + maxI + 1) / 2 - pw / 2, lcy = (minJ + maxJ + 1) / 2 - p.h / 2;
    const e = this.makeEntity(CHUNK, p.team, cw, ch, new Uint8Array(cw * ch));
    for (const idx of cells) {
      const ci = (((idx / pw) | 0) - minJ) * cw + ((idx % pw) - minI);
      e.types[ci] = p.types[idx];
      e.hp[ci] = p.hp[idx];
      e.alive++;
      p.types[idx] = 0; p.hp[idx] = 0; p.alive--;
      this.recBlockDeath(p.id, idx, 1);
    }
    e.x = p.x + lcx * p.c - lcy * p.s;
    e.y = p.y + lcx * p.s + lcy * p.c;
    e.a = p.a; e.c = p.c; e.s = p.s;
    const ox = e.x - p.x, oy = e.y - p.y, od = Math.hypot(ox, oy) || 1;
    const kick = (1 + this.rng() * 4) * violence / Math.sqrt(Math.max(1, cells.length / 6));
    e.vx = p.vx + (ox / od) * kick + (this.rng() - 0.5) * violence;
    e.vy = p.vy + (oy / od) * kick + (this.rng() - 0.5) * violence;
    e.va = ((this.rng() - 0.5) * 1.6 * violence) / Math.sqrt(cells.length);
    const R = this.R;
    R.chParent.push(p.id); R.chT0.push(this.now);
    R.chX.push(e.x); R.chY.push(e.y); R.chA.push(e.a); R.chVx.push(e.vx); R.chVy.push(e.vy); R.chVa.push(e.va);
    R.chMinI.push(minI); R.chMinJ.push(minJ); R.chW.push(cw); R.chH.push(ch);
    R.chC0.push(R.chCells.n); R.chN.push(cells.length);
    for (const idx of cells) R.chCells.push(idx);
  }

  // ---------------------------------------------------------------- recording
  initRecorder() {
    const C = (T) => new Col(T);
    this.R = {
      bdT: C(Uint16Array), bdEnt: C(Uint32Array), bdCell: C(Uint16Array), bdCause: C(Uint8Array),
      // Kinetic rounds fly straight, so spawn + angle + flight time (0.01 s) is enough.
      shotT0: C(Uint16Array), shotFlight: C(Uint8Array), shotX: C(Int16Array), shotY: C(Int16Array),
      shotAng: C(Uint16Array), shotHit: C(Uint8Array), shotTeam: C(Uint8Array),
      lasT: C(Uint16Array), lasX: C(Int16Array), lasY: C(Int16Array), lasAng: C(Uint16Array), lasLen: C(Uint8Array),
      lasTeam: C(Uint8Array), lasHit: C(Uint8Array),
      misT0: C(Uint16Array), misT1: C(Float32Array), misTeam: C(Uint8Array), misHit: C(Uint8Array),
      misS0: C(Uint32Array), misN: C(Uint16Array), misXY: C(Int16Array),
      expT: C(Uint16Array), expX: C(Int16Array), expY: C(Int16Array),
      chParent: C(Uint32Array), chT0: C(Uint16Array), chX: C(Float32Array), chY: C(Float32Array), chA: C(Float32Array),
      chVx: C(Float32Array), chVy: C(Float32Array), chVa: C(Float32Array),
      chMinI: C(Uint16Array), chMinJ: C(Uint16Array), chW: C(Uint16Array), chH: C(Uint16Array),
      chC0: C(Uint32Array), chN: C(Uint32Array), chCells: C(Uint16Array),
    };
  }

  recBlockDeath(ent, cell, cause) {
    const R = this.R;
    R.bdT.push(this.now); R.bdEnt.push(ent); R.bdCell.push(cell); R.bdCause.push(cause);
  }

  recordTracks() {
    for (const e of this.ents)
      if (e.kind === SHIP && !e.dead)
        e.track.push(Math.round(e.x * POS_Q), Math.round(e.y * POS_Q), Math.round(e.a * ANG_Q));
  }

  /** Columnar replay: { meta, cols } ready for packReplay(). */
  toReplay() {
    const S = this.shipCount;
    const team = new Uint8Array(S), design = new Uint16Array(S), t1 = new Uint16Array(S);
    const tStart = new Uint32Array(S), tCount = new Uint32Array(S);
    const x0 = new Int32Array(S), y0 = new Int32Array(S), a0 = new Int16Array(S);
    let total = 0;
    for (let k = 0; k < S; k++) total += this.byId[k].track.length / 3 - 1;
    // Stored as three separate streams (x, y, angle): similar values together compress better.
    const deltas = new Int16Array(total * 3);
    const dX = deltas.subarray(0, total), dY = deltas.subarray(total, 2 * total), dA = deltas.subarray(2 * total);
    let o = 0;
    const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    for (let k = 0; k < S; k++) {
      const e = this.byId[k], tr = e.track, n = tr.length / 3;
      team[k] = e.team; design[k] = e.design; t1[k] = e.t1;
      tStart[k] = o; tCount[k] = n;
      x0[k] = tr[0]; y0[k] = tr[1]; a0[k] = tr[2] & 4095;
      // Second-order deltas (change in velocity): ~0 for smooth motion, compresses very well.
      let pdx = 0, pdy = 0, pda = 0;
      for (let s = 1; s < n; s++) {
        const dx = tr[s * 3] - tr[s * 3 - 3], dy = tr[s * 3 + 1] - tr[s * 3 - 2];
        const da = (((tr[s * 3 + 2] - tr[s * 3 - 1]) + 2048) & 4095) - 2048;
        dX[o] = clamp16(dx - pdx); dY[o] = clamp16(dy - pdy); dA[o] = da - pda;
        o++;
        pdx = dx; pdy = dy; pda = da;
      }
    }
    const cols = {
      shipTeam: team, shipDesign: design, shipT1: t1, shipTrackStart: tStart, shipTrackCount: tCount,
      shipX0: x0, shipY0: y0, shipA0: a0, trackDelta: deltas,
    };
    for (const [k, c] of Object.entries(this.R)) cols[k] = c.done();
    const meta = {
      version: 1, trackTotal: total, evQ: EV_Q, dt: DT, trackEvery: TRACK_EVERY, missileEvery: MISSILE_EVERY, posQ: POS_Q, angQ: ANG_Q,
      ticks: this.tick, shipCount: S, chunkCount: this.byId.length - S,
      kineticSpeed: WEAPON[BT.CANNON].speed,
      designs: this.designs.map((d) => ({ name: d.name, cls: d.cls, w: d.w, h: d.h, hub: d.hub, cells: Array.from(d.cells) })),
      survivors: [...this.teamAlive],
    };
    return { meta, cols };
  }
}
