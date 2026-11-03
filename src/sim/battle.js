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
const K_KINETIC = 0, K_SHELL = 1, K_MISSILE = 2;

// Combat stances, chosen per ship design. range(e, direct, shortest, longest) -> preferred distance.
//   direct   = longest non-missile weapon range, shortest = shortest weapon range,
//   longest  = longest range of any weapon (missiles included).
export const STANCES = {
  charge:   { label: 'Charge',   range: (e) => e.radius + 14 },            // dive in, point blank
  brawl:    { label: 'Brawler',  range: (e, d, s) => s * 0.55 },          // close range, inside enemy guns
  line:     { label: 'Line',     range: (e, d) => d * 0.75 },             // mid range, best gun range
  standoff: { label: 'Standoff', range: (e, d, s, l) => Math.max(d, l) * 0.85 }, // hang back, back off if pressed
  escort:   { label: 'Escort',   range: (e, d) => d * 0.75 },             // guard a big friendly ship
};

export class Battle {
  constructor({ designs, ships, seed = 1, maxTime = 180, friendlyFire = false }) {
    // friendlyFire off: allied hulls still block shots (rounds stop on them), they just take no damage.
    this.friendlyFire = friendlyFire;
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
    this.mgrid = new SpatialGrid(64, 6144);
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
    e.stance = STANCES[d.stance] ? d.stance : 'line';
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
    // Point defence doesn't drive positioning. "Direct" range is the main gun: cannons if fitted, else lasers.
    let shortest = Infinity, longest = 0, cannon = 0, laser = 0;
    for (const w of e.weapons) {
      if (w.type === BT.PD) continue;
      const r = WEAPON[w.type].range;
      if (w.type === BT.CANNON) cannon = r;
      if (w.type === BT.LASER) laser = r;
      if (w.type !== BT.MISSILE) shortest = Math.min(shortest, r);
      longest = Math.max(longest, r);
    }
    range = cannon || laser;
    e.mass = Math.max(1, mass);
    // The hub has weak manoeuvring jets, so a ship that loses every engine still crawls.
    e.maxSpeed = Math.max(2.5, Math.min(22, (30 * thrust) / e.mass));
    e.turn = Math.max(0.05, Math.min(2.5, (1.6 * e.maxSpeed) / e.w));
    e.agility = Math.max(0.25, Math.min(2, e.maxSpeed / 8));
    e.prefRange = STANCES[e.stance].range(e, range || 60, shortest === Infinity ? 60 : shortest, longest || 60);
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
    this.buildMissileGrid();
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
    if (e.stance === 'escort' && (!e.ward || e.ward.dead)) e.ward = this.pickWard(e);
  }

  /** Escorts guard the biggest friendly warship nearby (at least 3x their own mass). */
  pickWard(e) {
    let best = null;
    for (const o of this.armed[e.team])
      if (o !== e && o.mass > e.mass * 3 && (!best || o.mass > best.mass) && (o.x - e.x) ** 2 + (o.y - e.y) ** 2 < 600 * 600) best = o;
    return best;
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
    let slow = false;
    const ward = e.stance === 'escort' && e.ward && !e.ward.dead ? e.ward : null;
    if (ward && !disarmed) {
      // Hold station between the ward and the enemy, engaging whatever comes in range.
      const ex = tg ? tg.x - ward.x : this.teamCx[other] - ward.x, ey = tg ? tg.y - ward.y : this.teamCy[other] - ward.y;
      const el = Math.hypot(ex, ey) || 1, off = ward.radius + 18;
      const sx = ward.x + (ex / el) * off + e.orbit * (-ey / el) * off * 0.6, sy = ward.y + (ey / el) * off + e.orbit * (ex / el) * off * 0.6;
      const qx = sx - e.x, qy = sy - e.y, qd = Math.hypot(qx, qy);
      desired = qd > 6 ? Math.atan2(qy, qx) : Math.atan2(ey, ex);
      slow = qd < 25;
    } else if (tg && !disarmed) {
      if (e.stance === 'standoff' && d < pr * 0.7) { desired += Math.PI - e.orbit * 0.4; } // too close: open the range
      else if (e.stance === 'charge' && d > pr) { /* straight at them */ }
      else if (d < pr * 0.8) { desired += e.orbit * Math.PI * 0.5; slow = e.stance !== 'charge'; } // broadside / orbit
      else if (d < pr * 1.1) { desired += e.orbit * 0.5; slow = e.stance === 'standoff'; }
    }
    const da = wrapAngle(desired - e.a), mt = e.turn * DT;
    e.a = wrapAngle(e.a + (da > mt ? mt : da < -mt ? -mt : da));
    e.c = Math.cos(e.a); e.s = Math.sin(e.a);
    {
      const want = slow && !disarmed ? e.maxSpeed * 0.55 : e.maxSpeed;
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
      wtype: new Uint8Array(cap), hp: new Float32Array(cap),
    };
  }

  addProjectile(kind, wtype, x, y, vx, vy, life, owner, team, target, dmg, hp, rec) {
    let P = this.P;
    if (P.n === P.cap) {
      const old = P;
      this.initProjectiles(old.cap * 2);
      P = this.P;
      for (const k of Object.keys(P)) if (ArrayBuffer.isView(P[k])) P[k].set(old[k]);
      P.n = old.n;
    }
    const i = P.n++;
    P.x[i] = x; P.y[i] = y; P.vx[i] = vx; P.vy[i] = vy; P.life[i] = life; P.kind[i] = kind; P.wtype[i] = wtype;
    P.owner[i] = owner; P.team[i] = team; P.target[i] = target; P.dmg[i] = dmg; P.hp[i] = hp; P.rec[i] = rec; P.t0[i] = this.now;
  }

  removeProjectile(i) {
    const P = this.P, j = --P.n;
    if (i === j) return;
    for (const k in P) { const a = P[k]; if (ArrayBuffer.isView(a)) a[i] = a[j]; }
  }

  /** Spatial index of live heavy missiles, rebuilt each tick, so point defence can find them. */
  buildMissileGrid() {
    const P = this.P, objs = [];
    for (let i = 0; i < P.n; i++) if (P.kind[i] === K_MISSILE) objs.push({ x: P.x[i], y: P.y[i], radius: 1, i, _q: 0 });
    this.mobjs = objs;
    this.mgrid.build(objs, 0);
  }

  fire(e) {
    const tl = e.targets.length;
    for (let k = 0; k < e.weapons.length; k++) {
      const w = e.weapons[k];
      w.cd -= DT;
      if (w.cd > 0) continue;
      const W = WEAPON[w.type];
      const wx = e.x + w.lx * e.c - w.ly * e.s, wy = e.y + w.lx * e.s + w.ly * e.c;
      if (W.kind === 'pd') {
        w.cd = this.firePD(e, wx, wy, W) ? W.cooldown * (0.85 + 0.3 * this.rng()) : 0.1;
        continue;
      }
      if (!tl) { w.cd = 0.3; continue; }
      let tg = e.targets[k % tl];
      let dx = tg.x - wx, dy = tg.y - wy;
      if (dx * dx + dy * dy > W.range * W.range) {
        tg = e.targets[0]; dx = tg.x - wx; dy = tg.y - wy;
        if (dx * dx + dy * dy > W.range * W.range) { w.cd = 0.3 + this.rng() * 0.3; continue; }
      }
      w.cd = W.cooldown * (0.85 + 0.3 * this.rng());
      const [ax, ay] = this.aimPoint(tg);
      if (W.kind === 'laser') { this.fireBeam(e, wx, wy, ax, ay, W.range, W.damage, 0); continue; }
      let ang;
      if (W.kind === 'shell') {
        const t = Math.hypot(ax - wx, ay - wy) / W.speed;
        ang = Math.atan2(ay + tg.vy * t - wy, ax + tg.vx * t - wx) + (this.rng() - 0.5) * 2 * W.spread; // lead the target
      } else {
        ang = Math.atan2(ay - wy, ax - wx) + (this.rng() - 0.5) * 1.8; // missiles launch wide, then turn in
      }
      const kind = W.kind === 'shell' ? K_SHELL : K_MISSILE;
      const rec = this.trackStart(kind, e.team, wx, wy);
      this.addProjectile(kind, w.type, wx, wy, Math.cos(ang) * W.speed, Math.sin(ang) * W.speed,
        Math.round(W.life / DT), e.id, e.team, tg.id, W.damage, W.hp || 0, rec);
    }
  }

  /** A random live block of the target, so hits spread over the hull. */
  aimPoint(tg) {
    for (let tries = 0; tries < 4; tries++) {
      const ci = (this.rng() * tg.types.length) | 0;
      if (!tg.types[ci] || tg.hp[ci] <= 0) continue;
      const lx = (ci % tg.w) + 0.5 - tg.w / 2, ly = ((ci / tg.w) | 0) + 0.5 - tg.h / 2;
      return [tg.x + lx * tg.c - ly * tg.s, tg.y + lx * tg.s + ly * tg.c];
    }
    return [tg.x, tg.y];
  }

  /** Point defence: nearest enemy missile in range first, otherwise an enemy ship that close. */
  firePD(e, wx, wy, W) {
    const P = this.P, r = W.range;
    let best = -1, bd = r * r;
    this.mgrid.queryBox(wx - r, wy - r, wx + r, wy + r, (o) => {
      const i = o.i;
      if (P.team[i] === e.team || P.hp[i] <= 0) return;
      const d = (P.x[i] - wx) ** 2 + (P.y[i] - wy) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) {
      const tx = P.x[best], ty = P.y[best];
      // A ship in the way (friend or foe) soaks the burst instead.
      if (this.sweep(wx, wy, tx, ty, e.id) && this.hitT < 0.97) {
        if (this.canDamage(this.hitE, e.team)) this.damageCell(this.hitE, this.hitCell, W.damage);
        this.recBeam(wx, wy, wx + (tx - wx) * this.hitT, wy + (ty - wy) * this.hitT, e.team, 1, 1);
      } else {
        P.hp[best] -= W.missileDamage;
        this.recBeam(wx, wy, tx, ty, e.team, 1, 1);
      }
      return true;
    }
    for (const tg of e.targets) {
      if (Math.hypot(tg.x - wx, tg.y - wy) - tg.radius * 0.6 > r) continue;
      const [ax, ay] = this.aimPoint(tg);
      this.fireBeam(e, wx, wy, ax, ay, r, W.damage, 1);
      return true;
    }
    return false;
  }

  fireBeam(e, x0, y0, ax, ay, range, damage, kind) {
    const dx = ax - x0, dy = ay - y0, d = Math.hypot(dx, dy) || 1;
    const x1 = x0 + (dx / d) * range, y1 = y0 + (dy / d) * range;
    const hit = this.sweep(x0, y0, x1, y1, e.id);
    let ex = x1, ey = y1;
    if (hit) {
      ex = x0 + (x1 - x0) * this.hitT; ey = y0 + (y1 - y0) * this.hitT;
      if (this.canDamage(this.hitE, e.team)) this.damageCell(this.hitE, this.hitCell, damage);
    }
    this.recBeam(x0, y0, ex, ey, e.team, kind, hit ? 1 : 0);
  }

  recBeam(x0, y0, x1, y1, team, kind, hit) {
    const R = this.R;
    R.lasT.push(this.now); R.lasX.push(q16(x0)); R.lasY.push(q16(y0));
    R.lasAng.push(qAng(Math.atan2(y1 - y0, x1 - x0))); R.lasLen.push(Math.round(Math.hypot(x1 - x0, y1 - y0)));
    R.lasTeam.push(team); R.lasHit.push(hit); R.lasKind.push(kind);
  }

  /** Nearest of a random sample of enemy warships (missiles whose target died pick a new one). */
  sampleEnemy(team, x, y) {
    const pool = this.armed[1 - team];
    let best = null, bd = Infinity;
    for (let k = 0; k < Math.min(10, pool.length); k++) {
      const o = pool[(this.rng() * pool.length) | 0], d = (o.x - x) ** 2 + (o.y - y) ** 2;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  updateProjectiles() {
    const P = this.P, R = this.R;
    for (let i = 0; i < P.n; i++) {
      const kind = P.kind[i], rec = P.rec[i];
      if (kind === K_MISSILE && P.hp[i] <= 0) {
        // Shot down by point defence.
        this.trackEnd(kind, rec, P.x[i], P.y[i], this.now, 2);
        this.recExplosion(P.x[i], P.y[i], 0);
        this.removeProjectile(i--);
        continue;
      }
      if (kind !== K_KINETIC) {
        const W = WEAPON[P.wtype[i]];
        let tg = this.byId[P.target[i]];
        if ((!tg || tg.dead) && kind === K_MISSILE) { tg = this.sampleEnemy(P.team[i], P.x[i], P.y[i]); if (tg) P.target[i] = tg.id; }
        if (tg && !tg.dead) {
          const cur = Math.atan2(P.vy[i], P.vx[i]);
          const da = wrapAngle(Math.atan2(tg.y - P.y[i], tg.x - P.x[i]) - cur), mt = W.turn * DT;
          const na = cur + (da > mt ? mt : da < -mt ? -mt : da);
          P.vx[i] = Math.cos(na) * W.speed; P.vy[i] = Math.sin(na) * W.speed;
        }
      }
      const x0 = P.x[i], y0 = P.y[i], x1 = x0 + P.vx[i] * DT, y1 = y0 + P.vy[i] * DT;
      // Heavy missiles fly over their own side's ships; everything else stops on whatever it meets.
      const hit = this.sweep(x0, y0, x1, y1, P.owner[i], kind === K_MISSILE ? P.team[i] : -1);
      if (hit) {
        const t = this.hitT, hx = x0 + (x1 - x0) * t, hy = y0 + (y1 - y0) * t;
        const ok = this.canDamage(this.hitE, P.team[i]);
        if (kind === K_KINETIC) {
          if (ok) this.damageCell(this.hitE, this.hitCell, P.dmg[i]);
          R.shotFlight.set(rec, Math.round((this.now - 1 + t - R.shotT0.a[rec]) * 10)); R.shotHit.set(rec, 1);
        } else {
          if (ok) this.splash(this.hitE, hx, hy, WEAPON[P.wtype[i]].splash, P.dmg[i]);
          this.trackEnd(kind, rec, hx, hy, this.now - 1 + t, 1);
          this.recExplosion(hx, hy, kind === K_MISSILE ? 2 : 1);
        }
        this.removeProjectile(i--);
        continue;
      }
      P.x[i] = x1; P.y[i] = y1;
      if (--P.life[i] <= 0) {
        if (kind === K_KINETIC) R.shotFlight.set(rec, Math.round((this.now - R.shotT0.a[rec]) * 10));
        else this.trackEnd(kind, rec, x1, y1, this.now, 0);
        this.removeProjectile(i--);
        continue;
      }
      if (kind !== K_KINETIC && (this.now - P.t0[i]) % MISSILE_EVERY === 0) this.trackSample(kind, rec, x1, y1);
    }
  }

  // Shells and heavy missiles are recorded as low-rate position tracks, one stream each.
  trackStart(kind, team, x, y) {
    const S = kind === K_SHELL ? this.R.cn : this.R.bm;
    const rec = S.T0.push(this.now);
    S.T1.push(0); S.Team.push(team); S.Hit.push(0);
    S.pts.push([q16(x), q16(y)]); // per-projectile until export, so samples stay contiguous
    return rec;
  }
  trackSample(kind, rec, x, y) {
    const S = kind === K_SHELL ? this.R.cn : this.R.bm;
    S.pts[rec].push(q16(x), q16(y));
  }
  trackEnd(kind, rec, x, y, t1, hit) {
    const S = kind === K_SHELL ? this.R.cn : this.R.bm;
    this.trackSample(kind, rec, x, y);
    S.T1.set(rec, t1); S.Hit.set(rec, hit);
  }
  recExplosion(x, y, size) {
    const R = this.R;
    R.expT.push(this.now); R.expX.push(q16(x)); R.expY.push(q16(y)); R.expS.push(size);
  }

  // ---------------------------------------------------------------- hit detection
  /** Find the first live block hit by segment (x0,y0)->(x1,y1). Sets hitE/hitCell/hitT. */
  sweep(x0, y0, x1, y1, ownerId, skipTeam = -1) {
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
          if (e.dead || e.retired || e.id === ownerId || (e.team === skipTeam && e.kind === SHIP)) continue;
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

  /** Shots always stop on whatever they hit; with friendly fire off, allied ships just shrug it off. */
  canDamage(target, team) {
    return this.friendlyFire || target.kind !== SHIP || target.team !== team;
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
      lasT: C(Uint16Array), lasX: C(Int16Array), lasY: C(Int16Array), lasAng: C(Uint16Array), lasLen: C(Uint16Array), lasKind: C(Uint8Array),
      lasTeam: C(Uint8Array), lasHit: C(Uint8Array),
      expT: C(Uint16Array), expX: C(Int16Array), expY: C(Int16Array), expS: C(Uint8Array),
      chParent: C(Uint32Array), chT0: C(Uint16Array), chX: C(Float32Array), chY: C(Float32Array), chA: C(Float32Array),
      chVx: C(Float32Array), chVy: C(Float32Array), chVa: C(Float32Array),
      chMinI: C(Uint16Array), chMinJ: C(Uint16Array), chW: C(Uint16Array), chH: C(Uint16Array),
      chC0: C(Uint32Array), chN: C(Uint32Array), chCells: C(Uint16Array),
    };
    // Guided projectiles: cn = cannon shells, bm = heavy missiles. Hit: 0 expired, 1 hit, 2 shot down.
    const track = () => ({ T0: C(Uint16Array), T1: C(Float32Array), Team: C(Uint8Array), Hit: C(Uint8Array), pts: [] });
    this.R.cn = track();
    this.R.bm = track();
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
    for (const [k, c] of Object.entries(this.R)) {
      if (c instanceof Col) cols[k] = c.done();
      else {
        for (const [sub, cc] of Object.entries(c)) if (cc instanceof Col) cols[k + sub] = cc.done();
        const n = c.pts.length, s0 = new Uint32Array(n), cnt = new Uint16Array(n);
        const xy = new Int16Array(c.pts.reduce((a, p) => a + p.length, 0));
        let o = 0;
        c.pts.forEach((p, i) => { s0[i] = o / 2; cnt[i] = p.length / 2; xy.set(p, o); o += p.length; });
        cols[k + 'S0'] = s0; cols[k + 'N'] = cnt; cols[k + 'XY'] = xy;
      }
    }
    const meta = {
      version: 1, friendlyFire: this.friendlyFire, trackTotal: total, evQ: EV_Q, dt: DT, trackEvery: TRACK_EVERY, missileEvery: MISSILE_EVERY, posQ: POS_Q, angQ: ANG_Q,
      ticks: this.tick, shipCount: S, chunkCount: this.byId.length - S,
      kineticSpeed: WEAPON[BT.CANNON].speed,
      designs: this.designs.map((d) => ({ name: d.name, cls: d.cls, stance: d.stance, w: d.w, h: d.h, hub: d.hub, cells: Array.from(d.cells) })),
      survivors: [...this.teamAlive],
    };
    return { meta, cols };
  }
}
