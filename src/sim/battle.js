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

import { BT, BLOCKS, WEAPON, MULTIBLOCK, COOKOFF, isWeapon } from '../shared/blocks.js';
import { lineOfFire, updateLineOfFire, binOf, binOpen, binAngle, ARC_BINS } from '../shared/arcs.js';
import { bayRoute } from '../shared/bayRoute.js';
import { mulberry32 } from '../shared/rng.js';
import { Col } from '../shared/replayFormat.js';
import { SpatialGrid } from './spatial.js';

export const DT = 0.1; // 10 ticks per simulated second
export const TRACK_EVERY = 4; // ship transform sample every 0.4 s (viewer uses spline interpolation)
// Debris shoved by a ship is re-recorded at most this often (ticks). The viewer blends into each
// record over this window, so pushed debris is drawn where the sim had it.
export const SHOVE_EVERY = 3;
export const MISSILE_EVERY = 3; // missile position sample every 0.3 s
export const POS_Q = 4; // position quantisation: 1/4 block
const TWO_PI = Math.PI * 2;
const ANG_Q = 2048 / Math.PI; // 4096 steps per turn
export const EV_Q = 4; // event positions stored as Int16 in 1/4 block (±8191 blocks)
const VEL_Q = 64; // shoved-debris velocities stored as Int16 in 1/64 block per second
const qVel = (v) => { const r = Math.round(v * VEL_Q); return r > 32767 ? 32767 : r < -32768 ? -32768 : r; };
const q16 = (v) => { const r = Math.round(v * EV_Q); return r > 32767 ? 32767 : r < -32768 ? -32768 : r; };
const qAng = (a) => Math.round((wrapAngle(a) / TWO_PI) * 65536) & 0xffff;
const wrapAngle = (a) => a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
const SHIP = 0, CHUNK = 1;
export const MAX_TEAMS = 16; // sides in one battle (players plus militia); fr[] is indexed (a << 4) | b
// Debris stays hittable and solid for the whole battle (owner: debris is part of the fight).
// The retire mechanism is kept as a cap that can be set if very long battles ever get slow.
const CHUNK_RETIRE_TICKS = Infinity;
const K_KINETIC = 0, K_SHELL = 1, K_MISSILE = 2, K_PLASMA = 3, K_FIGHTER = 4;
// Fighters (owner, Nov 2026): launched by fighter bays, kept in their own list (this.Fi), not P.
const FIGHTER = WEAPON[BT.BAY].fighter;
const FIGHTER_R = 2; // how close a shot must pass to hit one (blocks)
// Spacing between ships (see Battle.spacing): hull gap they try to keep, how hard it bends
// their heading and slides them sideways, and how often it's refreshed.
const SPACING_GAP = 25, SPACING_TURN = 3, SPACING_SLIDE = 1, SPACING_EVERY = 5;
// Debris still over the ship it broke off from is pushed out at up to this speed (blocks/s).
const OWN_CLEAR_SPEED = 6;
// Hulls with at least this many grid cells (80 × 80) get two exact checks that small ships don't
// need (owner, 13 Nov 2026, Aegis fortresses): collisions against a coarse map of where their
// blocks really are (TILE × TILE cells per tile) instead of their outline box, so ships and
// fighters can fly into a hollow fortress's courtyards and lanes; and a check of the real shot
// line through their own blocks before a gun fires, since a 5.6° arc slice is tens of blocks wide
// across a 1,000-block hull and shots were leaving through a gap and flying through the far arm.
const BIG_HULL_CELLS = 6400, TILE = 4;
// A ship holding its distance drifts sideways at this share of its back-off speed (see move()).
const HOLD_DRIFT = 1;
// Plasma cannon aiming: an ally within this many blocks of the line counts as in the way.
const LANCE_SPEED = WEAPON[BT.LANCE].speed;
const LANCE_COOK_SCALE = BLOCKS[BT.LANCE].hp / COOKOFF.refHp;
const LANCE_ALLY_MARGIN = 0; // 0: ~1 in 3 shots hits an ally first, 4 enemies killed per ally (owner wants friendly fire); 5: almost never, but it holds fire far more
const NONE = 0xffffffff; // 'no entity' in replay id columns

// Combat stances, chosen per ship design. range(e, direct, shortest, longest, far, near) -> preferred distance.
//   direct   = main gun range (cannon, else laser, else missile), shortest = shortest gun range
//   (point defence and heavy lasers left out), longest = longest of those, far = longest of any
//   weapon (heavy lasers too), near = shortest of any weapon (point defence too).
// Flank and raid steer by a goal ship (`e.goal`, picked in `pickGoal`); their range is how
// close they pass or circle it.
const close = (e, d, s, l, f, n) => Math.max(14, Math.min(60, n * 0.5));
export const STANCES = {
  charge:   { label: 'Charge',      range: (e) => e.radius + 14 },            // dive in, point blank
  brawl:    { label: 'Brawler',     range: (e, d, s) => s * 0.4 },           // close range, inside enemy guns
  line:     { label: 'Front line',  range: (e, d) => d * 0.45 },             // holds the front, in range of all its guns
  standoff: { label: 'Artillery',   range: (e, d, s, l, f) => f * 0.6 },     // hangs back at 60% of its longest weapon, holds there guns on target
  skirmish: { label: 'Skirmisher',  range: (e, d, s, l, f) => f * 0.6 },     // the old artillery: turns and opens the range when pressed (kiting)
  escort:   { label: 'Escort',      range: (e, d) => d * 0.6 },              // screen a big friendly ship
  flank:    { label: 'Flanker',     range: close },                          // through the enemy line, circles their big ships
  raid:     { label: 'Raider',      range: close },                          // attack runs: straight through, out, turn, again
};

// Every weapon object gets its line-of-fire fields up front (one object shape, see makeEntity).
const arcFields = () => ({ sq: 0, route: -1, rtT: 0, omni: false, buried: false, m0: 0, m1: 0, ox: 0, oy: 0, bx0: 1, by0: 1, bx1: 0, by1: 0, blk: null });

export class Battle {
  // maxTime: 4 minutes while testing; the plan for launch is 30 minutes so every battle resolves.
  // teams: how many sides (each player in a free-for-all is its own side, up to MAX_TEAMS).
  // hostile(a, b): whether sides a and b fight; by default every side fights every other side.
  // Sides that don't fight each other are allies: their shots don't hurt each other.
  constructor({ designs, ships, seed = 1, maxTime = 240, friendlyFire = false, teams = 2, hostile = null }) {
    // friendlyFire off: allied hulls still block shots (rounds stop on them), they just take no damage.
    this.friendlyFire = friendlyFire;
    this.designs = designs;
    this.rng = mulberry32(seed);
    this.tick = 0;
    this.now = 0;
    this.maxTicks = Math.round(maxTime / DT);
    this.endTick = -1;
    this.done = false;
    // Why the battle ended ('destroyed', 'rout', 'stalled', 'time') and the side that broke and ran
    // in a rout (-1 otherwise). A routed side has lost even though some of its ships still fire.
    this.endReason = null;
    this.routed = -1;
    this.ents = [];
    this.byId = [];
    this.shipCount = ships.length;
    // Sides. fr[(a << 4) | b] is 1 when a and b are friends (the same side, or allies).
    this.nT = Math.max(2, Math.min(MAX_TEAMS, teams | 0));
    for (const sp of ships) if (sp.team >= this.nT) this.nT = Math.min(MAX_TEAMS, sp.team + 1);
    const nT = this.nT;
    this.fr = new Uint8Array(MAX_TEAMS * MAX_TEAMS);
    this.foes = [];
    for (let a = 0; a < nT; a++) {
      this.foes.push([]);
      for (let b = 0; b < nT; b++) {
        const foe = a !== b && (hostile ? !!hostile(a, b) : true);
        this.fr[(a << 4) | b] = foe ? 0 : 1;
        if (foe) this.foes[a].push(b);
      }
    }
    this.routedTeams = new Uint8Array(nT); // sides that broke and are running
    this.teamAlive = new Array(nT).fill(0);
    this.teamStart = new Array(nT).fill(0);
    // Credit value of each side's ships at the start, and of its armed ships now (teamStats). The
    // rout check goes by value, not ship count (owner, Nov 2026: 80 small ships dying fast made a
    // side with 20 big ships still fighting run).
    this.teamStartWorth = new Array(nT).fill(0);
    this.armedWorth = new Array(nT).fill(0);
    this._worth = new Map(); // design index -> credit value
    this.foeCx = new Array(nT).fill(0); // centre of each side's armed enemies
    this.foeCy = new Array(nT).fill(0);
    this.foeArmed = [];
    this.grid = new SpatialGrid(32, 6144);
    this.mgrid = new SpatialGrid(64, 6144);
    this.fgrid = new SpatialGrid(64, 6144); // live fighters, rebuilt each tick (updateFighters)
    this.fobjs = []; this._fpool = [];
    this.fFoe = new Int32Array(nT); // enemy fighters alive, per side: 0 means nobody needs to look for any
    this._fCount = new Int32Array(nT);
    this._ft = 0;
    this._ax = 0; this._ay = 0;
    this._near = []; // collision candidates, reused every call
    this._tbx = 0; this._tby = 0; // push direction from tileOverlap
    this._ntx = 0; this._nty = 0; // nearest block square from nearTile
    this._collect = (o) => { this._near.push(o); };
    this.shoved = []; // debris pushed by ships since its last shove record
    this.cookoffs = []; // world x, y pairs of heavy-laser blocks destroyed this tick
    this.stamp = new Int32Array(8192);
    this.stampGen = 1;
    this.queue = new Int32Array(8192);
    this.initProjectiles(8192);
    this.initFighters(256);
    this.fRoutes = []; // fighter bay routes out of their ships: { e, pts } (see bayExit)
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
    e.fixed = !!spec.fixed;
    e.hub = d.hub;
    e.stance = STANCES[d.stance] ? d.stance : 'line';
    e.closeIn = e.stance === 'flank' || e.stance === 'raid' || e.stance === 'charge' || e.stance === 'brawl';
    e.orbit = this.rng() < 0.5 ? 1 : -1;
    e.targets = [];
    e.retarget = this.rng();
    e.weapons = [];
    const volley = 3 + this.rng() * 10; // all missile launchers on a ship share one volley timer
    let launcher = 0;
    for (let i = 0; i < e.types.length; i++) {
      const t = e.types[i];
      if (!isWeapon(t) || MULTIBLOCK[t]) continue;
      const cd = t === BT.MISSILE || t === BT.GUIDED ? volley + 0.15 * launcher++ : this.rng() * 2;
      e.weapons.push({ cell: i, cells: null, type: t, lx: (i % d.w) + 0.5 - d.w / 2, ly: ((i / d.w) | 0) + 0.5 - d.h / 2, cd, ...arcFields() });
    }
    // Multi-block weapons: each connected group of their blocks is one gun, aimed from its centre.
    const seen = new Uint8Array(e.types.length);
    for (let i = 0; i < e.types.length; i++) {
      if (!MULTIBLOCK[e.types[i]] || seen[i]) continue;
      const group = [i], t = e.types[i];
      seen[i] = 1;
      for (let k = 0; k < group.length; k++) {
        const c = group[k], x = c % d.w;
        for (const n of [x > 0 ? c - 1 : -1, x < d.w - 1 ? c + 1 : -1, c - d.w, c + d.w])
          if (n >= 0 && n < e.types.length && !seen[n] && e.types[n] === t) { seen[n] = 1; group.push(n); }
      }
      let sx = 0, sy = 0;
      for (const c of group) { sx += (c % d.w) + 0.5 - d.w / 2; sy += ((c / d.w) | 0) + 0.5 - d.h / 2; }
      // Fighter bays launch their opening squadron early; plasma cannons charge for 4-10 s.
      const cd0 = this.rng();
      const wpn = { cell: group[0], cells: group, type: t, lx: sx / group.length, ly: sy / group.length, cd: t === BT.BAY ? 1 + cd0 * 2 : 4 + cd0 * 6, ...arcFields() };
      if (t === BT.BAY) wpn.sq = WEAPON[BT.BAY].squadron; // opening squadron still to launch
      e.weapons.push(wpn);
    }
    for (const w of e.weapons) this.facing(e, w);
    e.track = [];
    e.t1 = 65535;
    this.refit(e);
    this.teamAlive[e.team]++;
    this.teamStart[e.team]++;
    let worth = this._worth.get(spec.design);
    if (worth === undefined) { worth = 0; for (const t of d.cells) if (t) worth += BLOCKS[t].cost || 0; this._worth.set(spec.design, (worth = Math.max(1, worth))); }
    e.worth = worth;
    this.teamStartWorth[e.team] += worth;
  }

  makeEntity(kind, team, w, h, types) {
    const e = {
      id: this.byId.length, kind, team, w, h, types, hp: new Float32Array(w * h), alive: 0,
      x: 0, y: 0, a: 0, vx: 0, vy: 0, va: 0, c: 1, s: 0,
      radius: Math.hypot(w, h) / 2, dead: false, retired: false, dirty: false, hubDead: false, _q: 0, t0: this.now,
      // Every field declared up front so ships and chunks share one object shape:
      // adding fields later makes V8 deoptimise every entity access (measured ~40% slower).
      _threatTick: -1, _threats: [], _gx0: 0, _gx1: 0, _gy0: 0, _gy1: 0,
      design: 0, hub: -1, stance: 'line', orbit: 1, targets: [], retarget: 0, weapons: [], track: null, t1: 65535,
      escortCount: 0, slot: 0, parent: -1, shoved: false, shoveRec: -1000,
      goal: null, runPhase: 0, runA: 0, runT: 0, // flank / raid steering
      closeIn: false, sepX: 0, sepY: 0, // spacing push away from nearby ships (see `spacing`)
      fixed: false, // a defence: never moves or turns, and nothing can shove it
      still: false, // can't move under its own power: a defence, or a ship with every thruster gone (see refit)
      // Collision box: centre (local) and half size, shrunk to the live blocks as they are lost.
      bcx: 0, bcy: 0, bhw: w / 2, bhh: h / 2,
      tiles: null, tw: 0, th: 0, // big hulls: which TILE × TILE squares hold a live block (see buildTiles)
      gapTo: -1, gapT: -1000, gap: 0, // cached distance to the first real block of a big target (see gapTo)
      mass: 1, maxSpeed: 0, turn: 0, agility: 0, prefRange: 60, ward: null,
      face: null, faceMax: 0, // firepower that bears on a target at each of the 64 directions round the ship (see refit / holdFacing)
      worth: 0, // credit value of the ship's design (rout check)
    };
    this.byId.push(e);
    this.ents.push(e);
    if (w * h > this.stamp.length) { this.stamp = new Int32Array(w * h * 2); this.queue = new Int32Array(w * h * 2); }
    return e;
  }

  /** Collision box from the live blocks' cell bounds (x0..x1, y0..y1 inclusive). */
  setBox(e, x0, x1, y0, y1) {
    if (x1 < 0) return;
    e.bhw = (x1 - x0 + 1) / 2; e.bhh = (y1 - y0 + 1) / 2;
    e.bcx = (x0 + x1 + 1) / 2 - e.w / 2; e.bcy = (y0 + y1 + 1) / 2 - e.h / 2;
  }

  /** Shrink a wreck's collision box after it loses blocks. */
  fitChunkBox(e) {
    let x0 = e.w, x1 = -1, y0 = e.h, y1 = -1;
    for (let i = 0, x = 0, y = 0; i < e.types.length; i++, x === e.w - 1 ? (x = 0, y++) : x++)
      if (e.types[i] && e.hp[i] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    this.setBox(e, x0, x1, y0, y1);
    this.buildTiles(e);
  }

  /** Big hulls only: a cleared tile map to fill in (null for small hulls). */
  prepTiles(e) {
    if (e.w * e.h < BIG_HULL_CELLS) return null;
    const tw = Math.ceil(e.w / TILE), th = Math.ceil(e.h / TILE);
    if (!e.tiles) { e.tiles = new Uint8Array(tw * th); e.tw = tw; e.th = th; } else e.tiles.fill(0);
    return e.tiles;
  }

  /** Big hulls only: mark the TILE × TILE squares of the grid that still hold a live block. */
  buildTiles(e) {
    const T = this.prepTiles(e);
    if (!T) return;
    const tw = e.tw, w = e.w, types = e.types, hp = e.hp;
    for (let y = 0; y < e.h; y++) {
      const row = y * w, trow = ((y / TILE) | 0) * tw;
      for (let x = 0; x < w; x++) if (types[row + x] && hp[row + x] > 0) T[trow + ((x / TILE) | 0)] = 1;
    }
  }

  /** Recompute mobility and weapon list after blocks are lost. */
  refit(e) {
    let mass = 0, thrust = 0, range = 0;
    let x0 = e.w, x1 = -1, y0 = e.h, y1 = -1;
    const T = this.prepTiles(e), tw = e.tw; // big hulls: the tile map is filled in the same pass
    for (let i = 0, x = 0, y = 0; i < e.types.length; i++, x === e.w - 1 ? (x = 0, y++) : x++) {
      const t = e.types[i];
      if (!t || e.hp[i] <= 0) continue;
      if (T) T[((y / TILE) | 0) * tw + ((x / TILE) | 0)] = 1;
      mass += BLOCKS[t].mass;
      if (t === BT.THRUSTER) thrust += BLOCKS[t].thrust;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    this.setBox(e, x0, x1, y0, y1);
    e.weapons = e.weapons.filter((w) => {
      if (!w.cells) return e.hp[w.cell] > 0;
      let alive = 0;
      for (const c of w.cells) if (e.hp[c] > 0) alive++;
      return alive >= w.cells.length * MULTIBLOCK[w.type].minIntact;
    });
    for (const w of e.weapons) { // armour shot away can open new arcs (and new ways out for fighter bays)
      updateLineOfFire(e.types, e.hp, e.w, e.h, w);
      if (w.type === BT.BAY) this.bayExit(e, w, false);
    }
    // How much firepower bears on a target in each direction (owner, Nov 2026: ships holding their
    // range turn so their guns face the enemy, instead of turning away from it).
    if (!e.face) e.face = new Float32Array(ARC_BINS);
    e.face.fill(0);
    for (const w of e.weapons) {
      const W = WEAPON[w.type];
      if (w.type === BT.PD || w.type === BT.BAY || w.buried) continue;
      const v = (W.damage || 1) / W.cooldown;
      for (let k = 0; k < ARC_BINS; k++) if (w.omni || binOpen(w.m0, w.m1, k)) e.face[k] += v;
    }
    e.faceMax = 0;
    for (let k = 0; k < ARC_BINS; k++) if (e.face[k] > e.faceMax) e.faceMax = e.face[k];
    // Point defence doesn't drive positioning. "Direct" range is the main gun: cannons if fitted, else lasers.
    let shortest = Infinity, longest = 0, cannon = 0, laser = 0, far = 0, near = Infinity;
    for (const w of e.weapons) {
      const W = WEAPON[w.type], wr = W.range;
      far = Math.max(far, wr); near = Math.min(near, wr);
      if (w.type === BT.PD || w.type === BT.LANCE) continue;
      const r = WEAPON[w.type].range;
      if (w.type === BT.CANNON) cannon = r;
      if (w.type === BT.LASER) laser = r;
      if (w.type !== BT.MISSILE && w.type !== BT.GUIDED && w.type !== BT.BAY) shortest = Math.min(shortest, r);
      longest = Math.max(longest, r);
    }
    range = cannon || laser || longest; // missile boats stand off at missile range, not at 60
    e.mass = Math.max(1, mass);
    e.still = e.fixed || thrust === 0;
    // The hub has weak manoeuvring jets, so a ship that loses every engine still crawls.
    e.maxSpeed = Math.max(2.5, Math.min(22, (30 * thrust) / e.mass));
    e.turn = Math.max(0.05, Math.min(2.5, (1.6 * e.maxSpeed) / e.w));
    e.agility = Math.max(0.25, Math.min(2, e.maxSpeed / 8));
    e.prefRange = STANCES[e.stance].range(e, range || 60, shortest === Infinity ? 60 : shortest, longest || 60, far || 60, near === Infinity ? 60 : near);
  }

  /**
   * Line of fire: the directions this weapon can shoot without hitting its own ship
   * (src/shared/arcs.js). Recomputed when blocks are lost, so shooting away the armour around
   * a gun opens up its arc. Applies to every weapon; the heavy laser looks out from the centre
   * of its 10x10 unit.
   */
  facing(e, w) {
    lineOfFire(e.types, e.hp, e.w, e.h, w.cell, w, w.cells);
    if (w.type === BT.BAY) this.bayExit(e, w, true);
  }

  /**
   * Fighter bay with no straight open line to space (owner, Nov 2026): it can still launch if a
   * path of empty cells, corners allowed, leads out of the ship (`bayRoute`, shared with the
   * designer). The route is worked out once, in ship-local coordinates, and kept: blocks are never
   * added in battle, so it stays open. A sealed bay looks again after losing blocks, at most every
   * 2 s. Sets `w.route` (index into `this.fRoutes`, -1 none) and `w.buried`.
   */
  bayExit(e, w, force) {
    if (w.m0 || w.m1 || w.route >= 0) { w.buried = false; return; }
    w.buried = true;
    if (!force && this.now < w.rtT) return;
    w.rtT = this.now + 20;
    const r = bayRoute(e.types, e.hp, e.w, e.h, w.cells);
    if (!r) return;
    const pts = new Float32Array(r.length);
    for (let k = 0; k < r.length; k += 2) { pts[k] = r[k] - e.w / 2; pts[k + 1] = r[k + 1] - e.h / 2; }
    w.route = this.fRoutes.length;
    this.fRoutes.push({ e, pts });
    w.buried = false;
  }

  /** Can this weapon bear on point (tx, ty)? One rotation, one atan2 and a bit test. */
  bears(e, w, wx, wy, tx, ty) {
    if (w.omni) return true;
    if (w.buried) return false;
    const dx = tx - wx, dy = ty - wy;
    return binOpen(w.m0, w.m1, binOf(dx * e.c + dy * e.s, -dx * e.s + dy * e.c));
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
    this.recordShoves();
    this.ents = this.ents.filter((e) => !e.dead && !e.retired);
    this.grid.build(this.ents);

    this.updateFighters();
    this.updateProjectiles();
    this.buildMissileGrid();
    const n = this.ents.length;
    for (let k = 0; k < n; k++) { const e = this.ents[k]; if (e.kind === SHIP && !e.dead) this.fire(e); }
    this.resolveCookoffs();
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
    // Rout: a side down to <20% of its starting value (credits) still able to fight, and outgunned
    // 2:1 by value by its enemies together (against it plus its allies). By value, not ship count
    // (owner, Nov 2026), so a swarm of cheap ships dying fast doesn't make the big ships run. It breaks and runs (its ships flee like disarmed hulks and no longer
    // count as holding the field); the others fight on if any of them are still enemies.
    let newRout = -1;
    if (this.endTick < 0) {
      const nT = this.nT, armed = this.armed, worth = this.armedWorth, R = this.routedTeams;
      for (let t = 0; t < nT; t++) {
        if (!armed[t].length || R[t]) continue;
        if (worth[t] >= this.teamStartWorth[t] * 0.2) continue;
        // Outgunned 2:1: its enemies against it and its allies together (a small allied
        // contingent doesn't run while its friends are winning).
        let foes = 0, friends = 0;
        for (let o = 0; o < nT; o++) if (!R[o]) { if (this.fr[(t << 4) | o]) friends += worth[o]; else foes += worth[o]; }
        if (foes > 2 * friends) { R[t] = 1; if (newRout < 0) newRout = t; if (this.routed < 0) this.routed = t; }
      }
    }
    // The battle is over when no two sides still in the fight are enemies.
    let fighting = false;
    for (let t = 0; t < this.nT && !fighting; t++) {
      if (!this.armed[t].length || this.routedTeams[t]) continue;
      for (const o of this.foes[t]) if (this.armed[o].length && !this.routedTeams[o]) { fighting = true; break; }
    }
    if (this.endTick < 0 && (!fighting || stalled || this.tick >= this.maxTicks)) {
      this.endTick = this.tick + 40; // let the last missiles and debris play out
      this.endReason = !fighting ? (newRout >= 0 ? 'rout' : 'destroyed') : stalled ? 'stalled' : 'time';
    }
    if (this.endTick >= 0 && this.tick >= this.endTick) this.done = true;
    return !this.done;
  }

  run(onProgress) {
    while (this.step()) if (onProgress && this.tick % 50 === 0) onProgress(this);
    return this;
  }

  teamStats() {
    // Only armed ships count: disarmed hulks retreat and no longer hold the field.
    const nT = this.nT, sx = new Array(nT).fill(0), sy = new Array(nT).fill(0);
    this.armed = [];
    for (let t = 0; t < nT; t++) { this.armed.push([]); this.armedWorth[t] = 0; }
    for (const e of this.ents)
      if (e.kind === SHIP && !e.dead && e.weapons.length) { sx[e.team] += e.x; sy[e.team] += e.y; this.armed[e.team].push(e); this.armedWorth[e.team] += e.worth; }
    // Each side's enemies: one list (the other side's, with two sides) and their centre.
    for (let t = 0; t < nT; t++) {
      const foes = this.foes[t];
      let pool, x = 0, y = 0;
      if (foes.length === 1) { pool = this.armed[foes[0]]; x = sx[foes[0]]; y = sy[foes[0]]; }
      else { pool = []; for (const o of foes) { for (const e of this.armed[o]) pool.push(e); x += sx[o]; y += sy[o]; } }
      this.foeArmed[t] = pool;
      if (pool.length) { this.foeCx[t] = x / pool.length; this.foeCy[t] = y / pool.length; }
    }
  }

  // ---------------------------------------------------------------- AI
  think(e) {
    e.retarget -= DT;
    if (e.targets.length && e.targets[0].dead) e.targets = e.targets.filter((t) => !t.dead);
    if (e.retarget > 0 && e.targets.length) return;
    e.retarget = 0.8 + this.rng() * 0.8;
    // Big ships keep more targets, so guns all along a long hull have something to shoot at.
    const maxT = e.radius < 40 ? 4 : Math.min(24, 4 + ((e.radius / 20) | 0));
    const best = [], bd = [], fr = this.fr.subarray(e.team << 4, (e.team << 4) + 16);
    const fn = (o) => {
      if (o.kind !== SHIP || o.dead || fr[o.team]) return;
      // Ships that can still shoot back come first. Disarmed hulks (and ships of a side that has
      // broken and run) are only finished off when they're close, so nobody chases a fleeing
      // wreck across the map while the fight goes on.
      const d0 = (o.x - e.x) ** 2 + (o.y - e.y) ** 2;
      const threat = o.weapons.length && !this.routedTeams[o.team];
      if (!threat && d0 > 150 * 150) return;
      const d = d0 * (threat ? 1 : 9);
      let k = best.length;
      while (k > 0 && bd[k - 1] > d) k--;
      if (k >= maxT) return;
      best.splice(k, 0, o); bd.splice(k, 0, d);
      if (best.length > maxT) { best.pop(); bd.pop(); }
    };
    const rings = 10 + ((e.radius / 32) | 0);
    fn.done = (ring) => (best.length >= maxT && ring >= 1 + ((e.radius / 32) | 0)) || (best.length > 0 && ring >= 3 + ((e.radius / 32) | 0));
    this.grid.queryRings(e.x, e.y, rings, fn);
    if (!best.length) {
      // Nobody close: pick the nearest of a random sample of enemy warships and go get them.
      const pool = this.foeArmed[e.team];
      for (let k = 0; k < Math.min(16, pool.length); k++) fn(pool[(this.rng() * pool.length) | 0]);
    }
    e.targets = best;
    if (e.stance === 'escort' && (!e.ward || e.ward.dead)) this.pickWard(e);
    if (e.stance === 'flank' || e.stance === 'raid') {
      this.pickGoal(e);
      // Guns fire at the goal too (it goes first), as well as at whatever is nearest.
      const g = e.goal;
      if (g && !best.includes(g)) { best.unshift(g); if (best.length > maxT) best.pop(); }
    }
  }

  /**
   * The ship a flanker circles or a raider makes its run on.
   *   flank: the biggest enemy warship within reach (prefers one 2x its own mass or more).
   *   raid: a big, near enemy, kept for the whole run and changed after each pass.
   */
  pickGoal(e) {
    const g = e.goal, live = g && !g.dead && g.weapons.length && !this.routedTeams[g.team] && !this.fr[(e.team << 4) | g.team];
    if (live && (e.stance === 'raid' || (g.x - e.x) ** 2 + (g.y - e.y) ** 2 < 600 * 600)) return;
    e.goal = null; e.runPhase = 0;
    let best = null, bs = -Infinity;
    const pool = this.foeArmed[e.team];
    const score = (o) => {
      const d = Math.hypot(o.x - e.x, o.y - e.y);
      if (d > 600) return;
      // Bigger is better, but not at any distance: 10x the mass is worth ~280 further away, so
      // they go for the big ships within reach first and work deeper as the lines close.
      const sc = Math.log(o.mass) - d / 120;
      if (sc > bs) { bs = sc; best = o; }
    };
    for (const o of e.targets) score(o);
    for (let k = 0; k < Math.min(12, pool.length); k++) score(pool[(this.rng() * pool.length) | 0]);
    e.goal = best;
  }

  /**
   * Escorts screen a big friendly warship (at least 3x their mass) that still has room:
   * each ward takes a limited number of escorts, roughly one per 6 blocks of its radius,
   * so they spread across the fleet instead of all piling onto the same titan.
   */
  pickWard(e) {
    let best = null, bestScore = Infinity;
    for (let t = 0; t < this.nT; t++) if (this.fr[(e.team << 4) | t]) for (const o of this.armed[t]) {
      if (o === e || o.mass <= e.mass * 3 || o.escortCount >= Math.max(2, Math.round(o.radius / 6))) continue;
      const d2 = (o.x - e.x) ** 2 + (o.y - e.y) ** 2;
      if (d2 > 500 * 500) continue;
      const score = d2 / o.mass; // close and big is best
      if (score < bestScore) { bestScore = score; best = o; }
    }
    e.ward = best;
    if (best) e.slot = best.escortCount++;
  }

  move(e) {
    if (e.fixed) { e.vx = 0; e.vy = 0; e.va = 0; this.collide(e); return; } // defences hold their spot (and push debris off)
    const tg = e.targets[0];
    let tx, ty;
    const disarmed = !e.weapons.length || this.routedTeams[e.team] === 1; // routed sides run too
    if (tg && !disarmed) { tx = tg.x; ty = tg.y; }
    else if (this.foeArmed[e.team].length) { tx = this.foeCx[e.team]; ty = this.foeCy[e.team]; }
    else { tx = e.x + e.c; ty = e.y + e.s; }
    const dx = tx - e.x, dy = ty - e.y;
    // Stance distances are roughly hull to hull: a giant's guns and its target's hull are a long
    // way from their centres. (No effect on small ships.)
    // A big hollow target (a fortress): the distance to its first real block along the way in,
    // so ships fly into its open lanes and courtyards instead of stopping at its outline.
    const d = tg && tg.tiles ? Math.max(1, this.gapTo(e, tg) - Math.max(0, e.radius - 12) * 0.8)
      : Math.max(1, Math.hypot(dx, dy) - (tg ? Math.max(0, tg.radius - 12) * 0.8 : 0) - Math.max(0, e.radius - 12) * 0.8);
    let desired = Math.atan2(dy, dx);
    if (disarmed) desired += Math.PI; // crippled: run away from the enemy fleet
    const pr = e.prefRange;
    let slow = false, hold = false, backX = 0, backY = 0;
    let ward = e.stance === 'escort' && e.ward && !e.ward.dead ? e.ward : null;
    // Escorts break station to attack anything that gets within 250 of their ward.
    if (ward && tg && (tg.x - ward.x) ** 2 + (tg.y - ward.y) ** 2 < 250 * 250) ward = null;
    if (ward && !disarmed) {
      // Hold station between the ward and the enemy, engaging whatever comes in range.
      const ex = tg ? tg.x - ward.x : this.foeCx[e.team] - ward.x, ey = tg ? tg.y - ward.y : this.foeCy[e.team] - ward.y;
      // Each escort has its own slot on an arc out in front of the ward, toward the enemy.
      const cap = Math.max(2, Math.round(ward.radius / 6));
      const ang = Math.atan2(ey, ex) + ((e.slot % cap) / (cap - 1) - 0.5) * 2.2;
      const off = ward.radius + 35;
      const sx = ward.x + Math.cos(ang) * off, sy = ward.y + Math.sin(ang) * off;
      const qx = sx - e.x, qy = sy - e.y, qd = Math.hypot(qx, qy);
      desired = qd > 6 ? Math.atan2(qy, qx) : Math.atan2(ey, ex);
      slow = qd < 25;
    } else if (!disarmed && (e.stance === 'flank' || e.stance === 'raid')) {
      [desired, slow] = this.steerGoal(e, desired, pr);
    } else if (tg && !disarmed && e.stance === 'skirmish') {
      // Skirmisher (owner, Nov 2026): the old artillery rule, kiting on purpose. Too close, it turns
      // away and opens the range (its forward guns stop bearing while it runs).
      if (d < pr * 0.7) { desired += Math.PI - e.orbit * 0.4; }
      else if (d < pr * 0.8) { desired += e.orbit * Math.PI * 0.5; slow = true; }
      else if (d < pr * 1.1) { desired += e.orbit * 0.5; slow = true; }
    } else if (tg && !disarmed) {
      // Every other stance (owner, Nov 2026: "people assume ships move forward to that range then
      // fight"): close to its distance, then hold there, turned so the most firepower bears on
      // the target, braking to a stop. Pressed hard (under 60% of its distance) it backs off
      // slowly, still facing the enemy, instead of turning and running.
      if (d > pr) { slow = d < pr * 1.15 && e.stance !== 'charge'; }
      else {
        desired = this.holdFacing(e, desired);
        hold = true;
        // Drift slowly sideways round the target (each ship its own way), so the line keeps moving.
        backX = -dy * e.orbit * HOLD_DRIFT; backY = dx * e.orbit * HOLD_DRIFT;
        if (d < pr * 0.6 && e.stance !== 'charge') { backX -= dx; backY -= dy; }
      }
    }
    // Spacing (owner, Nov 2026: the front was too crowded to see the shots): every ship steers
    // away from ships crowding it, friend or foe, but only sideways or forwards, never back, so
    // it still goes where its stance wants and the lines spread out instead of piling up.
    if ((e.id + this.now) % SPACING_EVERY === 0) this.spacing(e);
    let sx = e.sepX, sy = e.sepY;
    if (sx || sy) {
      const fx = Math.cos(desired), fy = Math.sin(desired), dot = sx * fx + sy * fy;
      if (dot < 0) { sx -= dot * fx; sy -= dot * fy; }
      desired = Math.atan2(fy + sy * SPACING_TURN, fx + sx * SPACING_TURN);
    }
    const da = wrapAngle(desired - e.a), mt = e.turn * DT;
    e.a = wrapAngle(e.a + (da > mt ? mt : da < -mt ? -mt : da));
    e.c = Math.cos(e.a); e.s = Math.sin(e.a);
    {
      const want = hold ? 0 : slow && !disarmed ? e.maxSpeed * 0.55 : e.maxSpeed;
      const k = 1 - Math.exp(-e.agility * DT);
      // Manoeuvring jets slide it sideways out of a crowd as well as turning it.
      const lat = e.maxSpeed * SPACING_SLIDE;
      // Holding ground: stop, or back away slowly (30% speed) without turning from the enemy.
      let bx = 0, by = 0;
      if (backX || backY) { const bl = Math.hypot(backX, backY) || 1, bs = e.maxSpeed * 0.3; bx = (backX / bl) * bs; by = (backY / bl) * bs; }
      e.vx += (e.c * want + bx + sx * lat - e.vx) * k;
      e.vy += (e.s * want + by + sy * lat - e.vy) * k;
    }
    this.collide(e);
    e.x += e.vx * DT; e.y += e.vy * DT;
  }

  /**
   * Heading for a ship holding its distance: the target sits in the direction (of 64 round the
   * ship) where the most firepower bears (`e.face`, from refit), choosing among the best ones
   * (within 90% of the most) the one needing the least turn. Nose guns: face it; broadside guns:
   * side on. No gun bears anywhere: face it. `to` is the direction to the target.
   */
  holdFacing(e, to) {
    if (!(e.faceMax > 0)) return to;
    const f = e.face, lim = e.faceMax * 0.9;
    let best = to, bt = Infinity;
    for (let k = 0; k < ARC_BINS; k++) {
      if (f[k] < lim) continue;
      const h = to - binAngle(k), t = Math.abs(wrapAngle(h - e.a));
      if (t < bt) { bt = t; best = h; }
    }
    return best;
  }

  /**
   * Push away from ships whose hulls are within SPACING_GAP of this one's (any side), weighted
   * so the lighter ship gives way more. Stored in sepX/sepY (length up to ~1), refreshed every
   * SPACING_EVERY ticks. Ships only, not debris (ships plough through wrecks).
   */
  spacing(e) {
    const near = this._near, er = e.radius * 0.7, R = er + SPACING_GAP + 20; // +20: most neighbours' own reach
    near.length = 0;
    this.grid.queryBox(e.x - R, e.y - R, e.x + R, e.y + R, this._collect);
    // A flanker's or raider's goal, and a charging ship's target, don't push it away: getting
    // close to them is the point.
    // Close-in stances (flank, raid, charge, brawl) only spread out from friends: enemies are
    // what they came for (point defence needs to be within 30). And nobody slides away from an
    // enemy close-in ship, or the spacing would dodge every flanker.
    const skip = e.goal || (e.stance === 'charge' ? e.targets[0] : null);
    const fr = this.fr, tb = e.team << 4, knife = e.closeIn;
    let sx = 0, sy = 0;
    for (const o of near) {
      if (o === e || o === skip || o.kind !== SHIP || o.dead || ((knife || o.closeIn) && !fr[tb | o.team])) continue;
      if (o.tiles) { // a big hollow hull: keep clear of its real blocks, not a circle round it
        const reach = er + SPACING_GAP, t = this.nearTile(o, e.x, e.y, reach);
        if (t < 0) continue;
        const dx = e.x - this._ntx, dy = e.y - this._nty, dc = Math.hypot(dx, dy) || 0.01;
        const push = (1 - dc / reach) * (2 * o.mass) / (o.mass + e.mass);
        sx += (dx / dc) * push; sy += (dy / dc) * push;
        continue;
      }
      const dx = e.x - o.x, dy = e.y - o.y, dc = Math.hypot(dx, dy) || 0.01;
      const want = er + o.radius * 0.7 + SPACING_GAP;
      if (dc >= want) continue;
      const push = (1 - dc / want) * (2 * o.mass) / (o.mass + e.mass);
      sx += (dx / dc) * push; sy += (dy / dc) * push;
    }
    near.length = 0;
    const l = Math.hypot(sx, sy);
    if (l > 1) { sx /= l; sy /= l; }
    e.sepX = sx; e.sepY = sy;
  }

  /**
   * Flankers and raiders steer by their goal ship. Returns [heading, slow].
   *   flank: fly straight at it, ignoring the ships in between, then circle it close in at full
   *          speed (its guns fire at whatever is in range on the way).
   *   raid:  run in at full speed aiming to skim past its side, carry on out the far side, turn
   *          and come back for another pass, at a new target.
   */
  steerGoal(e, desired, pr) {
    const g = e.goal;
    if (!g || g.dead) return [desired, false];
    const dx = g.x - e.x, dy = g.y - e.y, dc = Math.hypot(dx, dy) || 1;
    const to = Math.atan2(dy, dx), d = (g.tiles ? this.gapTo(e, g) : dc - g.radius * 0.8) - e.radius * 0.5;
    if (e.stance !== 'raid') {
      if (d > pr * 1.6) return [to, false];
      // Circle it: tangent, bent in or out to hold the distance.
      const k = Math.max(-1, Math.min(1, (d - pr) / pr));
      return [to + e.orbit * (Math.PI / 2 - 0.9 * k), false];
    }
    // Raider. 0: run in, aiming beside the target so the pass skims its hull.
    e.runT += DT;
    if (e.runPhase === 0) {
      const side = g.radius * 0.7 + e.radius + pr * 0.5;
      const ax = g.x - (dy / dc) * side * e.orbit, ay = g.y + (dx / dc) * side * e.orbit;
      const passed = dc < g.radius + e.radius + pr * 1.5 && dx * e.vx + dy * e.vy < 0;
      if (passed || e.runT > 40) { e.runPhase = 1; e.runA = e.a; e.runT = 0; }
      return [Math.atan2(ay - e.y, ax - e.x), false];
    }
    // 1: carry on out the far side; then turn back for a new pass (maybe at a new target).
    if (dc > g.radius + 80 + e.radius * 2 || e.runT > 6) {
      e.runPhase = 0; e.runT = 0; e.orbit = -e.orbit; e.goal = null;
      this.pickGoal(e);
      return [to, false];
    }
    return [e.runA, false];
  }

  /**
   * Ships don't fly through each other or through debris: each ship's hull rectangle is pushed
   * out of any other ship's or wreck's rectangle it overlaps (either team), using a
   * separating-axis test on the 4 box axes. The lighter one gets shoved more; a wreck is shoved
   * here too, since debris has no move() of its own. Rectangles, not exact blocks: cheap and it
   * stops the visible overlap. Boxes shrink to the blocks still there (`setBox`), so nothing
   * bumps into the empty space where half a ship used to be. A piece that breaks off still
   * overlapping its ship's box passes through that ship only until the two have drifted clear,
   * then collides with it like any other wreck. Debris doesn't collide with other debris
   * (pieces of one break-up start overlapping).
   */
  collide(e) {
    const R = e.radius, near = this._near;
    near.length = 0;
    this.grid.queryBox(e.x - R, e.y - R, e.x + R, e.y + R, this._collect);
    const ehw = e.bhw, ehh = e.bhh;
    const ex = e.x + e.bcx * e.c - e.bcy * e.s, ey = e.y + e.bcx * e.s + e.bcy * e.c;
    for (let n = 0; n < near.length; n++) {
      const o = near[n];
      if (o === e || o.dead || o.retired) continue;
      const own = o.kind === CHUNK && o.parent === e.id; // broke off this ship: ignore until clear of it
      const dx = o.x + o.bcx * o.c - o.bcy * o.s - ex, dy = o.y + o.bcx * o.s + o.bcy * o.c - ey;
      if (dx * dx + dy * dy > (R + o.radius) ** 2) { if (own) o.parent = -1; continue; }
      // Separating axes: e's forward and side, then o's. Keep the one with the least overlap.
      let best = Infinity, bx = 0, by = 0;
      for (let k = 0; k < 4; k++) {
        const ux = k === 0 ? e.c : k === 1 ? -e.s : k === 2 ? o.c : -o.s;
        const uy = k === 0 ? e.s : k === 1 ? e.c : k === 2 ? o.s : o.c;
        const re = ehw * Math.abs(e.c * ux + e.s * uy) + ehh * Math.abs(-e.s * ux + e.c * uy);
        const ro = o.bhw * Math.abs(o.c * ux + o.s * uy) + o.bhh * Math.abs(-o.s * ux + o.c * uy);
        const dist = dx * ux + dy * uy, pen = re + ro - Math.abs(dist);
        if (pen <= 0) { best = 0; break; }
        if (pen < best) { best = pen; bx = dist > 0 ? -ux : ux; by = dist > 0 ? -uy : uy; }
      }
      // A big hollow hull (a fortress with courtyards and lanes) collides by the squares that
      // really hold blocks, not its outline box: ships can fly into the open space inside it.
      if (!own && best > 0 && (e.tiles || o.tiles)) {
        best = this.tileOverlap(e, o, ex, ey);
        bx = this._tbx; by = this._tby;
      }
      if (own) {
        if (best <= 0) { o.parent = -1; continue; }
        // Still over the ship it broke off from (owner: debris sitting on its own ship looks
        // gross): push the piece out along the shortest way, without knocking the ship. It
        // drifts clear at up to OWN_CLEAR_SPEED faster than the ship, and is still let through
        // the hull meanwhile, so it never jams against it.
        // Deeper inside a big hull, faster out.
        const ux = -bx, uy = -by, rel = (o.vx - e.vx) * ux + (o.vy - e.vy) * uy, want = OWN_CLEAR_SPEED + best * 0.5;
        if (rel < want) { const dv = Math.min(want - rel, 1.5); o.vx += ux * dv; o.vy += uy * dv; }
        const sh = Math.min(best, 4) * 0.15;
        o.x += ux * sh; o.y += uy * sh;
        if (!o.shoved) { o.shoved = true; this.shoved.push(o); }
        continue;
      }
      if (best <= 0) continue;
      // The lighter one gets shoved more; a defence (fixed) never moves, so the other takes it all.
      const pen = Math.min(best, 4), share = e.fixed ? 0 : o.fixed ? 1 : o.mass / (o.mass + e.mass);
      const push = pen * share;
      e.x += bx * push * 0.5; e.y += by * push * 0.5; // positional correction
      e.vx += bx * push * 2; e.vy += by * push * 2; // and a nudge so they steer apart
      if (o.kind === CHUNK) {
        const op = pen - push; // the wreck takes the rest, the other way
        o.x -= bx * op * 0.5; o.y -= by * op * 0.5;
        o.vx -= bx * op * 2; o.vy -= by * op * 2;
        if (!o.shoved) { o.shoved = true; this.shoved.push(o); }
      }
    }
  }

  /**
   * Distance from e to the first square of big target tg that holds a block, along the straight
   * line from e to tg's centre (walked square by square over tg's tile map). Cached for 5 ticks.
   * If the line meets no block (shouldn't happen: the hub is at the centre), the centre distance.
   */
  gapTo(e, tg) {
    if (e.gapTo === tg.id && this.now - e.gapT < 5) return e.gap;
    const dx = e.x - tg.x, dy = e.y - tg.y, full = Math.hypot(dx, dy);
    let gap = full;
    // e's position in tg's grid, in tile units; walk toward the centre.
    const gx = (dx * tg.c + dy * tg.s + tg.w / 2) / TILE, gy = (-dx * tg.s + dy * tg.c + tg.h / 2) / TILE;
    const ex = tg.w / 2 / TILE, ey = tg.h / 2 / TILE, ddx = ex - gx, ddy = ey - gy;
    // clip the start to the grid
    let t0 = 0;
    if (ddx !== 0) { const a = (0 - gx) / ddx, b = (tg.tw - gx) / ddx; t0 = Math.max(t0, Math.min(a, b)); }
    if (ddy !== 0) { const a = (0 - gy) / ddy, b = (tg.th - gy) / ddy; t0 = Math.max(t0, Math.min(a, b)); }
    if (t0 < 1) {
      let ix = Math.floor(gx + ddx * t0), iy = Math.floor(gy + ddy * t0);
      const stx = ddx > 0 ? 1 : -1, sty = ddy > 0 ? 1 : -1;
      const tdx = ddx !== 0 ? Math.abs(1 / ddx) : Infinity, tdy = ddy !== 0 ? Math.abs(1 / ddy) : Infinity;
      const sx0 = gx + ddx * t0, sy0 = gy + ddy * t0;
      let tmx = ddx > 0 ? (ix + 1 - sx0) / ddx + t0 : ddx < 0 ? (ix - sx0) / ddx + t0 : Infinity;
      let tmy = ddy > 0 ? (iy + 1 - sy0) / ddy + t0 : ddy < 0 ? (iy - sy0) / ddy + t0 : Infinity;
      let t = t0;
      for (let guard = tg.tw + tg.th + 2; guard > 0 && t <= 1; guard--) {
        if (ix >= 0 && iy >= 0 && ix < tg.tw && iy < tg.th && tg.tiles[iy * tg.tw + ix]) { gap = full * t; break; }
        if (tmx < tmy) { t = tmx; ix += stx; tmx += tdx; } else { t = tmy; iy += sty; tmy += tdy; }
      }
    }
    e.gapTo = tg.id; e.gapT = this.now; e.gap = gap;
    return gap;
  }

  /** Nearest square of big hull o that holds a block, within `reach` of (x, y): sets _ntx/_nty (world), returns its index or -1. */
  nearTile(o, x, y, reach) {
    const dx = x - o.x, dy = y - o.y;
    const gx = dx * o.c + dy * o.s + o.w / 2, gy = -dx * o.s + dy * o.c + o.h / 2;
    const tx0 = Math.max(0, Math.floor((gx - reach) / TILE)), tx1 = Math.min(o.tw - 1, Math.floor((gx + reach) / TILE));
    const ty0 = Math.max(0, Math.floor((gy - reach) / TILE)), ty1 = Math.min(o.th - 1, Math.floor((gy + reach) / TILE));
    let best = -1, bd = reach * reach;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const i = ty * o.tw + tx;
      if (!o.tiles[i]) continue;
      const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2, d2 = (cx - gx) ** 2 + (cy - gy) ** 2;
      if (d2 < bd) { bd = d2; best = i; }
    }
    if (best >= 0) {
      const lx = (best % o.tw) * TILE + TILE / 2 - o.w / 2, ly = ((best / o.tw) | 0) * TILE + TILE / 2 - o.h / 2;
      this._ntx = o.x + lx * o.c - ly * o.s; this._nty = o.y + lx * o.s + ly * o.c;
    }
    return best;
  }

  /**
   * Overlap of e's box with o's box where one (or both) is a big hull with a tile map: each
   * TILE × TILE square of the big one that holds a block is a small box, separated from the other
   * one's box by the same 4-axis test as collide(). Returns the deepest overlap (0 = none) and puts
   * the direction pushing e away from o in _tbx/_tby (the sum of every overlapping square's push).
   */
  tileOverlap(e, o, ex, ey) {
    // B owns the tiles (the bigger one if both have them); S is the other, seen as its box.
    const eBig = e.tiles && (!o.tiles || e.w * e.h >= o.w * o.h);
    const B = eBig ? e : o, S = eBig ? o : e;
    const scx = S === e ? ex : o.x + o.bcx * o.c - o.bcy * o.s, scy = S === e ? ey : o.y + o.bcx * o.s + o.bcy * o.c;
    const shw = S.bhw, shh = S.bhh, sc = S.c, ss = S.s, bc = B.c, bs = B.s;
    // S's box corners in B's grid (cell) coordinates -> range of tiles to look at.
    let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const hx = k & 1 ? shw : -shw, hy = k & 2 ? shh : -shh;
      const wx = scx + hx * sc - hy * ss - B.x, wy = scy + hx * ss + hy * sc - B.y;
      const gx = wx * bc + wy * bs + B.w / 2, gy = -wx * bs + wy * bc + B.h / 2;
      if (gx < gx0) gx0 = gx; if (gx > gx1) gx1 = gx; if (gy < gy0) gy0 = gy; if (gy > gy1) gy1 = gy;
    }
    const tx0 = Math.max(0, Math.floor(gx0 / TILE)), tx1 = Math.min(B.tw - 1, Math.floor(gx1 / TILE));
    const ty0 = Math.max(0, Math.floor(gy0 / TILE)), ty1 = Math.min(B.th - 1, Math.floor(gy1 / TILE));
    let deepest = 0, sx = 0, sy = 0;
    const hT = TILE / 2;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      if (!B.tiles[ty * B.tw + tx]) continue;
      const lx = tx * TILE + hT - B.w / 2, ly = ty * TILE + hT - B.h / 2;
      const tcx = B.x + lx * bc - ly * bs, tcy = B.y + lx * bs + ly * bc;
      const dx = tcx - scx, dy = tcy - scy; // from S to the tile
      let best = Infinity, ux0 = 0, uy0 = 0;
      for (let k = 0; k < 4; k++) {
        const ux = k === 0 ? sc : k === 1 ? -ss : k === 2 ? bc : -bs;
        const uy = k === 0 ? ss : k === 1 ? sc : k === 2 ? bs : bc;
        const rs = shw * Math.abs(sc * ux + ss * uy) + shh * Math.abs(-ss * ux + sc * uy);
        const rt = hT * Math.abs(bc * ux + bs * uy) + hT * Math.abs(-bs * ux + bc * uy);
        const dist = dx * ux + dy * uy, pen = rs + rt - Math.abs(dist);
        if (pen <= 0) { best = 0; break; }
        if (pen < best) { best = pen; ux0 = dist > 0 ? -ux : ux; uy0 = dist > 0 ? -uy : uy; } // pushes S away from the tile
      }
      if (best <= 0) continue;
      sx += ux0 * best; sy += uy0 * best;
      if (best > deepest) deepest = best;
    }
    const l = Math.hypot(sx, sy);
    if (!deepest || l < 1e-9) { this._tbx = 0; this._tby = 0; return 0; }
    // Directions above push S; e is pushed the same way if it is S, the other way if it is B.
    const sign = S === e ? 1 : -1;
    this._tbx = (sx / l) * sign; this._tby = (sy / l) * sign;
    return deepest;
  }

  /**
   * Big hulls only (BIG_HULL_CELLS): would a shot from the weapon at (x0, y0) heading `ang` cross
   * one of its own ship's live blocks within `len`? The weapon's own cells (a plasma unit's 10 × 10)
   * don't count. Small ships return false at once (their 64-slice arcs are exact enough).
   */
  ownHullInWay(e, w, x0, y0, ang, len) {
    if (e.w * e.h < BIG_HULL_CELLS) return false;
    const W_ = e.w, H_ = e.h, c = e.c, s = e.s, types = e.types, hp = e.hp;
    let sx0 = w.cell % W_, sx1 = sx0, sy0 = (w.cell / W_) | 0, sy1 = sy0; // skip box: the weapon itself
    if (w.cells) for (const k of w.cells) { const x = k % W_, y = (k / W_) | 0; if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; if (y < sy0) sy0 = y; if (y > sy1) sy1 = y; }
    let dx = x0 - e.x, dy = y0 - e.y;
    const gx0 = dx * c + dy * s + W_ * 0.5, gy0 = -dx * s + dy * c + H_ * 0.5;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ddx = (ca * c + sa * s) * len, ddy = (-ca * s + sa * c) * len;
    let ix = Math.floor(gx0), iy = Math.floor(gy0);
    if (ix < 0 || iy < 0 || ix >= W_ || iy >= H_) return false;
    const stx = ddx > 0 ? 1 : -1, sty = ddy > 0 ? 1 : -1;
    const tdx = ddx !== 0 ? Math.abs(1 / ddx) : Infinity, tdy = ddy !== 0 ? Math.abs(1 / ddy) : Infinity;
    let tmx = ddx > 0 ? (ix + 1 - gx0) / ddx : ddx < 0 ? (ix - gx0) / ddx : Infinity;
    let tmy = ddy > 0 ? (iy + 1 - gy0) / ddy : ddy < 0 ? (iy - gy0) / ddy : Infinity;
    for (let guard = W_ + H_ + 2; guard > 0; guard--) {
      const i = iy * W_ + ix;
      if (types[i] && hp[i] > 0 && (ix < sx0 || ix > sx1 || iy < sy0 || iy > sy1)) return true;
      if (tmx < tmy) { if (tmx > 1) return false; ix += stx; tmx += tdx; if (ix < 0 || ix >= W_) return false; }
      else { if (tmy > 1) return false; iy += sty; tmy += tdy; if (iy < 0 || iy >= H_) return false; }
    }
    return false;
  }

  /**
   * Re-record debris that ships have pushed, so the viewer draws it where it really is (debris
   * otherwise drifts in a straight line from where it broke off). At most every SHOVE_EVERY
   * ticks per piece; the last record after a contact ends carries its final drift.
   */
  recordShoves() {
    const L = this.shoved, R = this.R;
    let k = 0;
    for (let i = 0; i < L.length; i++) {
      const o = L[i];
      if (o.dead || o.retired) { o.shoved = false; continue; }
      if (this.now - o.shoveRec < SHOVE_EVERY) { L[k++] = o; continue; }
      R.svT.push(this.now); R.svEnt.push(o.id);
      R.svX.push(q16(o.x)); R.svY.push(q16(o.y)); R.svVx.push(qVel(o.vx)); R.svVy.push(qVel(o.vy));
      // Carry on from the stored (rounded) state, so sim and replay don't drift apart.
      o.x = R.svX.a[R.svX.n - 1] / EV_Q; o.y = R.svY.a[R.svY.n - 1] / EV_Q;
      o.vx = R.svVx.a[R.svVx.n - 1] / VEL_Q; o.vy = R.svVy.a[R.svVy.n - 1] / VEL_Q;
      o.shoveRec = this.now; o.shoved = false;
    }
    L.length = k;
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
        w.cd = this.firePD(e, w, wx, wy, W) ? W.cooldown * (0.85 + 0.3 * this.rng()) : 0.25;
        continue;
      }
      if (W.kind === 'bay') {
        // The opening squadron leaves a few tenths of a second apart, then one fighter every cooldown.
        if (this.launchFighter(e, w, wx, wy)) w.cd = w.sq > 0 && --w.sq > 0 ? W.squadronGap : W.cooldown;
        else w.cd = 0.5;
        continue;
      }
      if (!tl) { if (!this.fireAtFighter(e, w, wx, wy, W)) w.cd = 0.3; continue; }
      // Preferred target first, then any other target that is in range and inside this weapon's arc.
      // Missiles and heavy lasers all go for the primary target so volleys land together.
      const spreadFire = W.kind !== 'missile' && W.kind !== 'lance';
      // Missiles pick the biggest ship in range (a 9-block blast is wasted on a corvette, and big
      // ships are slow enough to hit). Every launcher on a ship picks the same one, so the volley
      // still lands together.
      const big = W.kind === 'missile';
      let tg = null, ax = 0, ay = 0, best = -1;
      const r2 = W.range * W.range;
      for (let j = 0; j < tl; j++) {
        const o = e.targets[spreadFire ? (k + j) % tl : j];
        if (big && o.alive <= best) continue;
        const d2 = (o.x - wx) ** 2 + (o.y - wy) ** 2;
        let px, py;
        if (d2 <= r2) {
          if (!this.bears(e, w, wx, wy, o.x, o.y)) continue;
          [px, py] = this.aimPoint(o);
        } else {
          // Centre out of range, but a big ship's near side may be in range: aim at a block there.
          if (o.radius < 12 || Math.sqrt(d2) - o.radius > W.range) continue;
          if (!this.aimInRange(o, wx, wy, r2)) continue;
          px = this._ax; py = this._ay;
          if (!this.bears(e, w, wx, wy, px, py)) continue;
        }
        tg = o; ax = px; ay = py;
        if (!big) break;
        best = o.alive;
      }
      // This gun has no enemy ship it can reach and bear on: it turns on enemy fighters (owner,
      // Nov 2026: gun by gun, so a gun that would otherwise sit idle shoots them).
      if (!tg) { if (!this.fireAtFighter(e, w, wx, wy, W)) w.cd = 0.2 + this.rng() * 0.2; continue; }
      if (W.kind === 'lance') {
        if (this.lanceAim(e, w, wx, wy, W, ax, ay)) { ax = this._ax; ay = this._ay; }
        w.cd = this.firePlasma(e, w, wx, wy, ax, ay, tg, W) ? W.cooldown : 0.5;
        continue;
      }
      // A big hull doesn't shoot through itself (see ownHullInWay). Missiles fly over ships.
      if (W.kind === 'laser' && this.ownHullInWay(e, w, wx, wy, Math.atan2(ay - wy, ax - wx), W.range)) { w.cd = 0.3; continue; }
      // Launchers keep in step (no jitter) so a ship's missiles always leave as one volley.
      w.cd = W.kind === 'missile' ? W.cooldown : W.cooldown * (0.85 + 0.3 * this.rng());
      if (W.kind === 'laser') { if (!this.fireLaser(e, wx, wy, ax, ay, W)) w.cd = 0.3; continue; }
      // Shells and missiles are unguided: aimed with lead at launch, then fly dead straight.
      // Lead is capped: a heavy missile can take 30 s to arrive, and leading a manoeuvring ship
      // that far ahead sent volleys sideways or even backwards. Past maxLead, aim where it is.
      const t = Math.min(Math.hypot(ax - wx, ay - wy) / W.speed, W.maxLead ?? Infinity);
      const ang = Math.atan2(ay + tg.vy * t - wy, ax + tg.vx * t - wx) + (this.rng() - 0.5) * 2 * W.spread;
      const kind = W.kind === 'shell' ? K_SHELL : K_MISSILE;
      if (kind === K_SHELL && this.ownHullInWay(e, w, wx, wy, ang, W.range)) { w.cd = 0.3; continue; }
      const rec = this.shotStart(kind, e.team, wx, wy, ang, !!W.guided);
      this.addProjectile(kind, w.type, wx, wy, Math.cos(ang) * W.speed, Math.sin(ang) * W.speed,
        Math.round(W.life / DT), e.id, e.team, tg.id, W.damage, W.hp || 0, rec);
    }
  }

  /** Try a few random live blocks of a big target for one within range (sets _ax, _ay). */
  aimInRange(tg, wx, wy, r2) {
    // A big hull: random picks anywhere on it are nearly always out of a short-range gun's reach
    // (and ships now fly inside hollow fortresses, so hundreds of guns try every tick). Pick
    // squares near the gun instead, using the tile map, then a live block in that square.
    if (tg.tiles) {
      const r = Math.sqrt(r2), dx = wx - tg.x, dy = wy - tg.y;
      const gx = dx * tg.c + dy * tg.s + tg.w / 2, gy = -dx * tg.s + dy * tg.c + tg.h / 2;
      for (let tries = 0; tries < 8; tries++) {
        const px = Math.floor(gx + (this.rng() * 2 - 1) * r), py = Math.floor(gy + (this.rng() * 2 - 1) * r);
        if (px < 0 || py < 0 || px >= tg.w || py >= tg.h || !tg.tiles[((py / TILE) | 0) * tg.tw + ((px / TILE) | 0)]) continue;
        const x0 = px - (px % TILE), y0 = py - (py % TILE);
        for (let k = 0; k < TILE * TILE; k++) {
          const cx = x0 + (k % TILE), cy = y0 + ((k / TILE) | 0);
          if (cx >= tg.w || cy >= tg.h) continue;
          const ci = cy * tg.w + cx;
          if (!tg.types[ci] || tg.hp[ci] <= 0) continue;
          const lx = cx + 0.5 - tg.w / 2, ly = cy + 0.5 - tg.h / 2;
          const x = tg.x + lx * tg.c - ly * tg.s, y = tg.y + lx * tg.s + ly * tg.c;
          if ((x - wx) ** 2 + (y - wy) ** 2 <= r2) { this._ax = x; this._ay = y; return true; }
          break;
        }
      }
      return false;
    }
    for (let tries = 0; tries < 8; tries++) {
      const ci = (this.rng() * tg.types.length) | 0;
      if (!tg.types[ci] || tg.hp[ci] <= 0) continue;
      const lx = (ci % tg.w) + 0.5 - tg.w / 2, ly = ((ci / tg.w) | 0) + 0.5 - tg.h / 2;
      const x = tg.x + lx * tg.c - ly * tg.s, y = tg.y + lx * tg.s + ly * tg.c;
      if ((x - wx) ** 2 + (y - wy) ** 2 <= r2) { this._ax = x; this._ay = y; return true; }
    }
    const [x, y] = this.aimPoint(tg); // a few more chances on badly damaged hulls
    if ((x - wx) ** 2 + (y - wy) ** 2 <= r2 && (x !== tg.x || y !== tg.y)) { this._ax = x; this._ay = y; return true; }
    return false;
  }

  /**
   * A random live block of the target, so hits spread over the hull. Never a destroyed block:
   * aiming into a hole sent shots through the wreck at whatever was behind it.
   */
  aimPoint(tg) {
    const n = tg.types.length;
    let ci = -1;
    for (let tries = 0; tries < 6 && ci < 0; tries++) {
      const c = (this.rng() * n) | 0;
      if (tg.types[c] && tg.hp[c] > 0) ci = c;
    }
    if (ci < 0) { // badly damaged: walk from a random cell to the next live one
      const s0 = (this.rng() * n) | 0;
      for (let k = 0; k < n; k++) { const c = (s0 + k) % n; if (tg.types[c] && tg.hp[c] > 0) { ci = c; break; } }
      if (ci < 0) return [tg.x, tg.y];
    }
    const lx = (ci % tg.w) + 0.5 - tg.w / 2, ly = ((ci / tg.w) | 0) + 0.5 - tg.h / 2;
    return [tg.x + lx * tg.c - ly * tg.s, tg.y + lx * tg.s + ly * tg.c];
  }


  /** Point defence: nearest enemy missile in range first, otherwise an enemy ship that close. */
  firePD(e, w, wx, wy, W) {
    const P = this.P, r = W.range;
    let best = -1, bd = r * r;
    // Enemy missiles near the ship are gathered once per tick and shared by all its PD blocks.
    if (e._threatTick !== this.now) {
      e._threatTick = this.now;
      const list = e._threats, R = e.radius + r;
      list.length = 0;
      if (this.mobjs.length) this.mgrid.queryBox(e.x - R, e.y - R, e.x + R, e.y + R, (o) => { if (!this.fr[(e.team << 4) | P.team[o.i]]) list.push(o.i); });
    }
    for (const i of e._threats) {
      if (P.hp[i] <= 0) continue;
      const d = (P.x[i] - wx) ** 2 + (P.y[i] - wy) ** 2;
      if (d < bd && this.bears(e, w, wx, wy, P.x[i], P.y[i])) { bd = d; best = i; }
    }
    if (best >= 0) {
      const tx = P.x[best], ty = P.y[best];
      // An enemy ship in the way soaks the burst instead. Allied ships don't (owner, 13 Nov 2026:
      // point defence shoots through its own and allied ships at missiles, as it does at fighters).
      if (this.sweep(wx, wy, tx, ty, e.id) && this.hitT < 0.97 && !this.fr[(e.team << 4) | this.hitE.team]) {
        if (this.canDamage(this.hitE, e.team)) this.damageCell(this.hitE, this.hitCell, W.damage);
        this.recBeam(wx, wy, wx + (tx - wx) * this.hitT, wy + (ty - wy) * this.hitT, e.team, 1, 1, e, this.hitE);
      } else {
        P.hp[best] -= W.missileDamage;
        this.recBeam(wx, wy, tx, ty, e.team, 1, 1, e, null);
      }
      return true;
    }
    // No missile: enemy fighters come before ships (owner, Nov 2026), within the same 80.
    const j = this.nearestFighter(wx, wy, r, e.team, e, w);
    // Point defence shoots through its own hull at missiles and fighters (owner, 13 Nov 2026: "that's
    // needed"), so no own-hull check here or for missiles above; only bursts at ships are checked.
    if (j >= 0) {
      const Fi = this.Fi;
      Fi.hp[j] -= W.fighterDamage ?? W.damage; // point defence is the fighter counter (rework, Nov 2026)
      this.recBeam(wx, wy, Fi.x[j], Fi.y[j], e.team, 1, 1, e, null);
      return true;
    }
    const rs = r;
    for (const tg of e.targets) {
      if (Math.hypot(tg.x - wx, tg.y - wy) - tg.radius > rs) continue;
      // Aim at a block of the target that is actually in reach.
      if (!this.aimInRange(tg, wx, wy, rs * rs) || !this.bears(e, w, wx, wy, this._ax, this._ay)) continue;
      if (this.ownHullInWay(e, w, wx, wy, Math.atan2(this._ay - wy, this._ax - wx), rs)) continue;
      this.fireBeam(e, wx, wy, this._ax, this._ay, rs, W.damage, 1);
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
    // A miss ends in empty space: a fixed world point (pinning it to the shooter swung it round as the shooter turned).
    this.recBeam(x0, y0, ex, ey, e.team, kind, hit ? 1 : 0, e, hit ? this.hitE : null);
  }

  /**
   * Laser: a smaller cousin of the heavy laser. The beam carries a damage budget and burns
   * through blocks (and on into whatever is behind) until it is spent. Holds fire (returns
   * false) if a friendly ship is first in line, so a slow-recharging shot isn't wasted.
   * Sweeps from hit to hit rather than scanning the whole line, since the budget is small.
   */
  fireLaser(e, x0, y0, ax, ay, W) {
    const dx = ax - x0, dy = ay - y0, d = Math.hypot(dx, dy) || 1;
    const x1 = x0 + (dx / d) * W.range, y1 = y0 + (dy / d) * W.range;
    let sx = x0, sy = y0, budget = W.damage, last = null, ex = x1, ey = y1;
    for (let guard = 0; guard < 48; guard++) {
      if (!this.sweep(sx, sy, x1, y1, e.id)) break;
      const o = this.hitE, cell = this.hitCell, t = this.hitT;
      const hx = sx + (x1 - sx) * t, hy = sy + (y1 - sy) * t;
      if (!this.canDamage(o, e.team)) {
        if (!last) return false; // a friend is first in line: wait
        ex = hx; ey = hy; last = o; budget = 0; break; // a friendly hull stops the beam
      }
      const hp = o.hp[cell], dmg = Math.min(hp, budget);
      this.damageCell(o, cell, dmg);
      budget -= dmg; last = o;
      if (budget <= 0) { ex = hx; ey = hy; break; }
      sx = hx; sy = hy;
    }
    // The end sits on whatever stopped the beam; if it burned through everything, it ends in
    // empty space at a fixed world point. (It used to be pinned to the shooter there, so the far
    // end swung round with the shooter's turn: lasers looked as if they retargeted wildly.)
    // Enemy fighters on the beam's path are burnt out of the sky (a 400-damage beam kills any).
    if (this.fFoe[e.team]) this.fightersOnSegment(x0, y0, ex, ey, (j) => { if (this.fighterFoe(j, e.team)) this.Fi.hp[j] -= W.damage; });
    this.recBeam(x0, y0, ex, ey, e.team, 0, last ? 1 : 0, e, budget <= 0 && last ? last : null);
    return true;
  }

  /**
   * Record a beam. `src` is the ship that fired it and `dst` the entity its far end sits on (the
   * ship or wreck it hit, or the shooter itself for a miss); both may be null. The viewer draws
   * each end attached to its entity, so a fading beam stays on the block it hit instead of
   * pointing at where that block was.
   */
  recBeam(x0, y0, x1, y1, team, kind, hit, src = null, dst = null) {
    const R = this.R;
    // World position and angle/length only for ends that aren't attached (zeros compress away).
    R.lasT.push(this.now); R.lasX.push(src ? 0 : q16(x0)); R.lasY.push(src ? 0 : q16(y0));
    R.lasAng.push(dst ? 0 : qAng(Math.atan2(y1 - y0, x1 - x0))); R.lasLen.push(dst ? 0 : Math.round(Math.hypot(x1 - x0, y1 - y0)));
    R.lasTeam.push(team); R.lasHit.push(hit); R.lasKind.push(kind);
    R.lasSrc.push(src ? src.id : NONE); R.lasDst.push(dst ? dst.id : NONE);
    // Ends in the local frame of their entity (zero when not attached).
    let dx = src ? x0 - src.x : 0, dy = src ? y0 - src.y : 0;
    R.lasSX.push(src ? q16(dx * src.c + dy * src.s) : 0); R.lasSY.push(src ? q16(-dx * src.s + dy * src.c) : 0);
    dx = dst ? x1 - dst.x : 0; dy = dst ? y1 - dst.y : 0;
    R.lasDX.push(dst ? q16(dx * dst.c + dy * dst.s) : 0); R.lasDY.push(dst ? q16(-dx * dst.s + dy * dst.c) : 0);
  }

  updateProjectiles() {
    const P = this.P, R = this.R;
    for (let i = 0; i < P.n; i++) {
      const kind = P.kind[i], rec = P.rec[i];
      if (kind === K_MISSILE && P.hp[i] <= 0) {
        // Shot down by point defence.
        this.guidedPoint(i, P.x[i], P.y[i], this.now);
        this.shotEnd(rec, this.now, 2);
        this.recExplosion(P.x[i], P.y[i], 0);
        this.removeProjectile(i--);
        continue;
      }
      if (kind === K_MISSILE && WEAPON[P.wtype[i]].guided) this.steerMissile(i);
      const x0 = P.x[i], y0 = P.y[i], x1 = x0 + P.vx[i] * DT, y1 = y0 + P.vy[i] * DT;
      if (kind === K_PLASMA) {
        // A plasma bolt burns every fighter it passes, friend or foe, like everything else.
        if (this.fobjs.length) this.fightersOnSegment(x0, y0, x1, y1, (j) => { this.Fi.hp[j] = 0; });
        if (this.plasmaStep(i, x0, y0, x1, y1)) {
          this.shotEnd(rec, this.now - 1 + this.hitT, 1);
          this.recExplosion(this._ax, this._ay, 5); // 5: the spent bolt's final blast
          this.removeProjectile(i--);
          continue;
        }
      } else {
      // Heavy missiles fly over their own side's ships; everything else stops on whatever it meets.
      const hit = this.sweep(x0, y0, x1, y1, P.owner[i], kind === K_MISSILE ? P.team[i] : -1);
      // A cannon shell stops on an enemy fighter if it meets one before any hull.
      if (kind === K_SHELL && this.fFoe[P.team[i]]) {
        const j = this.fighterOnSegment(x0, y0, x1, y1, P.team[i], hit ? this.hitT : 1);
        if (j >= 0) {
          const t = this._ft, hx = x0 + (x1 - x0) * t, hy = y0 + (y1 - y0) * t;
          this.Fi.hp[j] -= P.dmg[i];
          this.shotEnd(rec, this.now - 1 + t, 1);
          this.recExplosion(hx, hy, 1);
          this.removeProjectile(i--);
          continue;
        }
      }
      if (hit) {
        const t = this.hitT, hx = x0 + (x1 - x0) * t, hy = y0 + (y1 - y0) * t;
        const ok = this.canDamage(this.hitE, P.team[i]);
        if (kind === K_MISSILE) this.blast(hx, hy, WEAPON[P.wtype[i]].splash, P.dmg[i], P.team[i]);
        else if (ok) this.splash(this.hitE, hx, hy, WEAPON[P.wtype[i]].splash, P.dmg[i]);
        this.guidedPoint(i, hx, hy, this.now - 1 + t);
        this.shotEnd(rec, this.now - 1 + t, 1);
        this.recExplosion(hx, hy, kind === K_MISSILE ? 2 : 1);
        this.removeProjectile(i--);
        continue;
      }
      }
      P.x[i] = x1; P.y[i] = y1;
      if (kind === K_MISSILE && (this.now - P.t0[i]) % MISSILE_EVERY === 0 && WEAPON[P.wtype[i]].guided) this.guidedPoint(i, x1, y1, this.now);
      if (--P.life[i] <= 0) {
        this.guidedPoint(i, x1, y1, this.now);
        this.shotEnd(rec, this.now, 0);
        this.removeProjectile(i--);
        continue;
      }
    }
  }

  /**
   * Guided missile: turn toward the target (led, like at launch) at up to W.turn rad/s. If the
   * target is gone, pick the nearest enemy ship within W.seek; with none, fly straight on.
   */
  steerMissile(i) {
    const P = this.P, W = WEAPON[P.wtype[i]], team = P.team[i];
    let tg = this.byId[P.target[i]];
    if (!tg || tg.dead || tg.retired || tg.kind !== SHIP || this.fr[(team << 4) | tg.team]) {
      tg = null;
      if ((this.now - P.t0[i]) % 5 === 0) { // look for a new target now and then, not every tick
        const x = P.x[i], y = P.y[i], R = W.seek;
        let best = R * R;
        this.grid.queryBox(x - R, y - R, x + R, y + R, (o) => {
          if (o.dead || o.retired || o.kind !== SHIP || this.fr[(team << 4) | o.team]) return;
          const d2 = (o.x - x) ** 2 + (o.y - y) ** 2;
          if (d2 < best) { best = d2; tg = o; }
        });
        P.target[i] = tg ? tg.id : -1;
      }
      if (!tg) return;
    }
    const x = P.x[i], y = P.y[i], vx = P.vx[i], vy = P.vy[i];
    const t = Math.min(Math.hypot(tg.x - x, tg.y - y) / W.speed, W.maxLead);
    const want = Math.atan2(tg.y + tg.vy * t - y, tg.x + tg.vx * t - x), cur = Math.atan2(vy, vx);
    let d = want - cur;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    const step = W.turn * DT, a = cur + Math.max(-step, Math.min(step, d));
    P.vx[i] = Math.cos(a) * W.speed; P.vy[i] = Math.sin(a) * W.speed;
  }

  // ---------------------------------------------------------------- fighters
  // Fighters (owner, Nov 2026): launched by fighter bays, not made of blocks. Like missiles they
  // are separate flying objects with hit points, but they live until killed, circle an enemy ship
  // shooting a small gun at it, and dogfight enemy fighters. Kept in their own list (this.Fi) so
  // their indexes only change in updateFighters(), where dead ones are removed: everything else
  // just lowers their hit points.
  initFighters(cap) {
    this.Fi = {
      n: 0, cap,
      x: new Float64Array(cap), y: new Float64Array(cap), vx: new Float64Array(cap), vy: new Float64Array(cap),
      hp: new Float32Array(cap), team: new Uint8Array(cap), target: new Int32Array(cap), rec: new Int32Array(cap),
      t0: new Int32Array(cap), cd: new Float32Array(cap), ln: new Int32Array(cap),
      // Taxiing out of its carrier along a bay route: route index (-1 = flying free), next point, local position.
      rt: new Int32Array(cap), rs: new Int32Array(cap), lx: new Float32Array(cap), ly: new Float32Array(cap),
    };
  }

  addFighter(x, y, ang, team, target, ln) {
    let Fi = this.Fi;
    if (Fi.n === Fi.cap) {
      const old = Fi;
      this.initFighters(old.cap * 2);
      Fi = this.Fi;
      for (const k of Object.keys(Fi)) if (ArrayBuffer.isView(Fi[k])) Fi[k].set(old[k]);
      Fi.n = old.n;
    }
    const i = Fi.n++;
    Fi.x[i] = x; Fi.y[i] = y; Fi.vx[i] = Math.cos(ang) * FIGHTER.speed; Fi.vy[i] = Math.sin(ang) * FIGHTER.speed;
    Fi.hp[i] = FIGHTER.hp; Fi.team[i] = team; Fi.target[i] = target; Fi.t0[i] = this.now;
    Fi.cd[i] = 0.5 + this.rng() * 0.5; Fi.ln[i] = ln; Fi.rt[i] = -1;
    Fi.rec[i] = this.shotStart(K_FIGHTER, team, x, y, ang);
  }

  removeFighter(i) {
    const Fi = this.Fi, j = --Fi.n;
    if (i === j) return;
    for (const k in Fi) { const a = Fi[k]; if (ArrayBuffer.isView(a)) a[i] = a[j]; }
  }

  /** Can a shot from `team` hurt fighter j? */
  fighterFoe(j, team) { return this.friendlyFire || !this.fr[(team << 4) | this.Fi.team[j]]; }

  /**
   * Launch a fighter whenever there is an enemy ship anywhere (owner: no range limit, as long as
   * the battle goes on): out along the open line of fire (arcs.js) nearest the target's direction,
   * flying straight until it's clear of its own ship. A bay on the hull edge has a wide opening;
   * one deep inside needs a straight empty tunnel.
   */
  launchFighter(e, w, wx, wy) {
    if (w.buried) return false;
    let tg = null;
    for (const o of e.targets) if (!o.dead) { tg = o; break; }
    if (!tg) { // nothing tracked nearby: the nearest armed enemy ship anywhere
      let bd = Infinity;
      for (const o of this.foeArmed[e.team] || []) { const d = (o.x - wx) ** 2 + (o.y - wy) ** 2; if (d < bd) { bd = d; tg = o; } }
    }
    if (!tg) return false;
    const dx = tg.x - wx, dy = tg.y - wy, k0 = binOf(dx * e.c + dy * e.s, -dx * e.s + dy * e.c);
    let k = -1;
    for (let s = 0; s <= ARC_BINS / 2 && k < 0; s++) {
      if (binOpen(w.m0, w.m1, (k0 + s) % ARC_BINS)) k = (k0 + s) % ARC_BINS;
      else if (binOpen(w.m0, w.m1, (k0 - s + ARC_BINS) % ARC_BINS)) k = (k0 - s + ARC_BINS) % ARC_BINS;
    }
    if (k < 0) {
      // No straight line out: taxi out along the bay's route through the hull.
      if (w.route < 0) return false;
      const pts = this.fRoutes[w.route].pts;
      const ax = pts[2] - pts[0], ay = pts[3] - pts[1];
      this.addFighter(wx, wy, Math.atan2(ax * e.s + ay * e.c, ax * e.c - ay * e.s), e.team, tg.id, 0);
      const i = this.Fi.n - 1;
      this.Fi.rt[i] = w.route; this.Fi.rs[i] = 1; this.Fi.lx[i] = pts[0]; this.Fi.ly[i] = pts[1];
      return true;
    }
    // Along the middle of the open slice: that's the line the arc check proved is clear.
    const ang = binAngle(k) + e.a;
    const ln = Math.ceil((e.radius + Math.hypot(w.lx, w.ly)) / (FIGHTER.speed * DT)) + 1;
    this.addFighter(wx, wy, ang, e.team, tg.id, ln);
    return true;
  }

  /** Steer, fly, then shoot. Runs before other shots move, so they see where fighters are now. */
  updateFighters() {
    const Fi = this.Fi, objs = this.fobjs, pool = this._fpool;
    objs.length = 0;
    this.fFoe.fill(0);
    if (!Fi.n) return;
    for (let i = 0; i < Fi.n; i++) {
      if (Fi.hp[i] <= 0) { // shot down
        this.fighterPoint(i, this.now);
        this.shotEnd(Fi.rec[i], this.now, 2);
        this.recExplosion(Fi.x[i], Fi.y[i], 0);
        this.removeFighter(i--);
        continue;
      }
      if (Fi.rt[i] >= 0) { this.taxiFighter(i); this.fighterPoint(i, this.now); continue; } // every tick: corners stay sharp
      if (Fi.ln[i] > 0) Fi.ln[i]--; else this.steerFighter(i);
      Fi.x[i] += Fi.vx[i] * DT; Fi.y[i] += Fi.vy[i] * DT;
      if ((this.now - Fi.t0[i]) % MISSILE_EVERY === 0) this.fighterPoint(i, this.now);
    }
    const cnt = this._fCount;
    cnt.fill(0);
    for (let i = 0; i < Fi.n; i++) {
      const o = pool[i] || (pool[i] = { x: 0, y: 0, radius: FIGHTER_R, i: 0, _q: 0, _gx0: 0, _gx1: 0, _gy0: 0, _gy1: 0 });
      o.x = Fi.x[i]; o.y = Fi.y[i]; o.i = i;
      objs.push(o);
      cnt[Fi.team[i]]++;
    }
    for (let t = 0; t < this.nT; t++) for (const o of this.foes[t]) this.fFoe[t] += cnt[o];
    if (this.friendlyFire) for (let t = 0; t < this.nT; t++) this.fFoe[t] = Fi.n;
    this.fgrid.build(objs, 0);
    for (let i = 0; i < Fi.n; i++) {
      Fi.cd[i] -= DT;
      if (Fi.cd[i] > 0 || Fi.rt[i] >= 0) continue; // no shooting while still inside its carrier
      Fi.cd[i] = this.fighterGun(i) ? FIGHTER.cooldown * (0.85 + 0.3 * this.rng()) : 0.2;
    }
  }

  /**
   * A fighter still inside its carrier follows the bay's route (ship-local points, so it moves
   * with the ship) at full speed. Out past the hull, or if the carrier is destroyed, it flies free
   * along the last leg and steers normally a couple of ticks later.
   */
  taxiFighter(i) {
    const Fi = this.Fi, R = this.fRoutes[Fi.rt[i]], e = R.e, pts = R.pts, n = pts.length / 2;
    if (e.dead) { Fi.rt[i] = -1; Fi.ln[i] = 2; return; }
    let step = FIGHTER.speed * DT, lx = Fi.lx[i], ly = Fi.ly[i], k = Fi.rs[i];
    while (step > 0 && k < n) {
      const dx = pts[k * 2] - lx, dy = pts[k * 2 + 1] - ly, d = Math.hypot(dx, dy);
      if (d <= step) { lx = pts[k * 2]; ly = pts[k * 2 + 1]; step -= d; k++; }
      else { lx += (dx / d) * step; ly += (dy / d) * step; step = 0; }
    }
    Fi.lx[i] = lx; Fi.ly[i] = ly; Fi.rs[i] = k;
    Fi.x[i] = e.x + lx * e.c - ly * e.s; Fi.y[i] = e.y + lx * e.s + ly * e.c;
    // Heading = the leg it's on (or the last one), turned with the ship; moving with the ship too.
    const j = Math.min(k, n - 1), ax = pts[j * 2] - pts[j * 2 - 2], ay = pts[j * 2 + 1] - pts[j * 2 - 1], d = Math.hypot(ax, ay) || 1;
    Fi.vx[i] = ((ax * e.c - ay * e.s) / d) * FIGHTER.speed + e.vx; Fi.vy[i] = ((ax * e.s + ay * e.c) / d) * FIGHTER.speed + e.vy;
    if (k >= n) { Fi.rt[i] = -1; Fi.ln[i] = 2; }
  }

  /**
   * Head for the target ship, then circle it `orbit` blocks off its hull (half the fighters each
   * way round). A dead or disarmed target: every 5 ticks look for the nearest armed enemy ship.
   */
  steerFighter(i) {
    const Fi = this.Fi, F = FIGHTER, team = Fi.team[i], x = Fi.x[i], y = Fi.y[i];
    let tg = this.byId[Fi.target[i]];
    if (!tg || tg.dead || tg.kind !== SHIP || !tg.weapons.length || this.fr[(team << 4) | tg.team]) {
      tg = null;
      if ((this.now + Fi.rec[i]) % 5 === 0) {
        const pool = this.foeArmed[team] || [];
        let bd = Infinity;
        const look = (o) => { const d = (o.x - x) ** 2 + (o.y - y) ** 2; if (d < bd) { bd = d; tg = o; } };
        if (pool.length <= 32) for (const o of pool) look(o);
        else for (let k = 0; k < 24; k++) look(pool[(this.rng() * pool.length) | 0]);
        Fi.target[i] = tg ? tg.id : -1;
      }
    }
    const dir = Fi.rec[i] & 1 ? 1 : -1, cur = Math.atan2(Fi.vy[i], Fi.vx[i]);
    let want;
    if (!tg) want = cur + dir; // nothing to fight: circle where it is
    else {
      const dx = tg.x - x, dy = tg.y - y, d = Math.hypot(dx, dy), R = tg.radius + F.orbit;
      if (d > R * 1.5 + 20) { // on the way in: lead the target a little
        const t = Math.min(d / F.speed, 2);
        want = Math.atan2(tg.y + tg.vy * t - y, tg.x + tg.vx * t - x);
      } else { // circling: tangent, bent in or out to hold the distance
        want = Math.atan2(dy, dx) + dir * (Math.PI / 2 - Math.max(-0.7, Math.min(0.7, (d - R) / R)));
      }
    }
    // Keep out of hulls and wrecks (owner: no flying through ships and debris; real collisions would
    // cost too much): look 0.7 s ahead, and if that point is inside a ship's or wreck's box, steer
    // round it the way it is already turning, a little outward.
    // Already inside one (a ship moved onto it, a wreck broke off over it): turn straight out.
    let o = this.solidAt(x, y, 1), boost = 2.5;
    if (o) want = Math.atan2(y - o.y, x - o.x);
    else {
      o = this.solidAt(x + Fi.vx[i] * 0.3, y + Fi.vy[i] * 0.3, 3) || this.solidAt(x + Fi.vx[i] * 0.7, y + Fi.vy[i] * 0.7, 3);
      boost = 1.5;
      if (o) {
        const side = (x - o.x) * Fi.vy[i] - (y - o.y) * Fi.vx[i] >= 0 ? 1 : -1;
        want = Math.atan2(y - o.y, x - o.x) + side * 1.2;
      }
    }
    let da = want - cur;
    da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI;
    const step = (o ? F.turn * boost : F.turn) * DT, a = cur + Math.max(-step, Math.min(step, da));
    Fi.vx[i] = Math.cos(a) * F.speed; Fi.vy[i] = Math.sin(a) * F.speed;
  }

  /** A ship or wreck whose box (grown by `pad`) holds the point (x, y), or null. */
  solidAt(x, y, pad) {
    let hit = null;
    this.grid.queryBox(x - 1, y - 1, x + 1, y + 1, (o) => {
      if (hit || o.dead) return;
      const dx = x - o.x, dy = y - o.y, lx = dx * o.c + dy * o.s - o.bcx, ly = -dx * o.s + dy * o.c - o.bcy;
      if (!(Math.abs(lx) < o.bhw + pad && Math.abs(ly) < o.bhh + pad)) return;
      if (!o.tiles) { hit = o; return; }
      // A big hollow hull: only the squares that hold blocks are solid (fighters fly into courtyards).
      const gx = lx + o.bcx + o.w / 2, gy = ly + o.bcy + o.h / 2;
      const tx0 = Math.max(0, Math.floor((gx - pad) / TILE)), tx1 = Math.min(o.tw - 1, Math.floor((gx + pad) / TILE));
      const ty0 = Math.max(0, Math.floor((gy - pad) / TILE)), ty1 = Math.min(o.th - 1, Math.floor((gy + pad) / TILE));
      for (let ty = ty0; ty <= ty1 && !hit; ty++) for (let tx = tx0; tx <= tx1; tx++) if (o.tiles[ty * o.tw + tx]) { hit = o; break; }
    });
    return hit;
  }

  /** Fighter gun: an enemy fighter in reach first (dogfights), else the ship it is circling. */
  fighterGun(i) {
    const Fi = this.Fi, F = FIGHTER, team = Fi.team[i], x = Fi.x[i], y = Fi.y[i], r = F.range;
    const j = this.nearestFighter(x, y, r, team);
    if (j >= 0) {
      Fi.hp[j] -= F.damage;
      this.recBeam(x, y, Fi.x[j], Fi.y[j], team, 3, 1);
      return true;
    }
    const tg = this.byId[Fi.target[i]];
    if (!tg || tg.dead || tg.kind !== SHIP || Math.hypot(tg.x - x, tg.y - y) - tg.radius > r) return false;
    if (!this.aimInRange(tg, x, y, r * r)) return false;
    const dx = this._ax - x, dy = this._ay - y, dd = Math.hypot(dx, dy) || 1;
    const x1 = x + (dx / dd) * r, y1 = y + (dy / dd) * r;
    if (this.sweep(x, y, x1, y1, -1)) {
      const o = this.hitE, t = this.hitT;
      if (this.canDamage(o, team)) this.damageCell(o, this.hitCell, F.damage);
      this.recBeam(x, y, x + (x1 - x) * t, y + (y1 - y) * t, team, 3, 1, null, o);
    } else this.recBeam(x, y, x1, y1, team, 3, 0);
    return true;
  }

  /**
   * Nearest enemy fighter (of `team`) within r of (x, y), or -1. With a ship and weapon given,
   * only fighters that weapon can bear on.
   */
  nearestFighter(x, y, r, team, e = null, w = null) {
    if (!this.fFoe[team]) return -1;
    const Fi = this.Fi;
    let best = -1, bd = r * r;
    this.fgrid.queryBox(x - r, y - r, x + r, y + r, (o) => {
      const j = o.i;
      if (Fi.hp[j] <= 0 || !this.fighterFoe(j, team)) return;
      const d = (Fi.x[j] - x) ** 2 + (Fi.y[j] - y) ** 2;
      if (d >= bd || (e && !this.bears(e, w, x, y, Fi.x[j], Fi.y[j]))) return;
      bd = d; best = j;
    });
    return best;
  }

  /** Cannons and lasers with no enemy ship in reach shoot at an enemy fighter. False if none. */
  fireAtFighter(e, w, wx, wy, W) {
    if (!this.fFoe[e.team] || (W.kind !== 'shell' && W.kind !== 'laser')) return false;
    const j = this.nearestFighter(wx, wy, W.range, e.team, e, w);
    if (j < 0) return false;
    const Fi = this.Fi, fx = Fi.x[j], fy = Fi.y[j];
    if (W.kind === 'laser') {
      // A big slow-charging laser is bad at tracking a small fast fighter (rework, Nov 2026): it
      // hits only `fighterHit` of the time; a miss sweeps just past it (drawn, and it may still hit
      // whatever is beyond).
      let tx = fx, ty = fy;
      if (this.rng() >= (W.fighterHit ?? 1)) {
        const d = Math.hypot(fx - wx, fy - wy) || 1, side = this.rng() < 0.5 ? -1 : 1, off = FIGHTER_R + 2;
        tx += (-(fy - wy) / d) * off * side; ty += ((fx - wx) / d) * off * side;
      }
      if (this.ownHullInWay(e, w, wx, wy, Math.atan2(ty - wy, tx - wx), W.range) || !this.fireLaser(e, wx, wy, tx, ty, W)) return false;
    } else {
      const t = Math.hypot(fx - wx, fy - wy) / W.speed;
      const ang = Math.atan2(fy + Fi.vy[j] * t - wy, fx + Fi.vx[j] * t - wx) + (this.rng() - 0.5) * 2 * W.spread;
      if (this.ownHullInWay(e, w, wx, wy, ang, W.range)) return false;
      const rec = this.shotStart(K_SHELL, e.team, wx, wy, ang);
      this.addProjectile(K_SHELL, w.type, wx, wy, Math.cos(ang) * W.speed, Math.sin(ang) * W.speed,
        Math.round(W.life / DT), e.id, e.team, -1, W.damage, 0, rec);
    }
    w.cd = W.cooldown * (0.85 + 0.3 * this.rng());
    return true;
  }

  /** First enemy fighter the segment passes within FIGHTER_R of, before param tMax; sets _ft. */
  fighterOnSegment(x0, y0, x1, y1, team, tMax) {
    const Fi = this.Fi, R = FIGHTER_R, sdx = x1 - x0, sdy = y1 - y0, len2 = sdx * sdx + sdy * sdy || 1e-9;
    let best = -1, bt = tMax;
    this.fgrid.queryBox(Math.min(x0, x1) - R, Math.min(y0, y1) - R, Math.max(x0, x1) + R, Math.max(y0, y1) + R, (o) => {
      const j = o.i;
      if (Fi.hp[j] <= 0 || !this.fighterFoe(j, team)) return;
      let t = ((Fi.x[j] - x0) * sdx + (Fi.y[j] - y0) * sdy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (t >= bt || (x0 + sdx * t - Fi.x[j]) ** 2 + (y0 + sdy * t - Fi.y[j]) ** 2 > R * R) return;
      bt = t; best = j;
    });
    this._ft = bt;
    return best;
  }

  /** Call fn(j) for every live fighter the segment passes within FIGHTER_R of. */
  fightersOnSegment(x0, y0, x1, y1, fn) {
    const Fi = this.Fi, R = FIGHTER_R, sdx = x1 - x0, sdy = y1 - y0, len2 = sdx * sdx + sdy * sdy || 1e-9;
    this.fgrid.queryBox(Math.min(x0, x1) - R, Math.min(y0, y1) - R, Math.max(x0, x1) + R, Math.max(y0, y1) + R, (o) => {
      const j = o.i;
      if (Fi.hp[j] <= 0) return;
      let t = ((Fi.x[j] - x0) * sdx + (Fi.y[j] - y0) * sdy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if ((x0 + sdx * t - Fi.x[j]) ** 2 + (y0 + sdy * t - Fi.y[j]) ** 2 <= R * R) fn(j);
    });
  }

  /** Record a point on a fighter's path (t in ticks), like guidedPoint. */
  fighterPoint(i, t) {
    const R = this.R, Fi = this.Fi;
    R.gmRec.push(Fi.rec[i]); R.gmT.push(Math.round(t * 10)); R.gmX.push(q16(Fi.x[i])); R.gmY.push(q16(Fi.y[i]));
  }

  /** Record a point on a guided missile's path (t in ticks); the viewer draws straight pieces between them. */
  guidedPoint(i, x, y, t) {
    const P = this.P;
    if (P.kind[i] !== K_MISSILE || !WEAPON[P.wtype[i]].guided) return;
    const R = this.R;
    R.gmRec.push(P.rec[i]); R.gmT.push(Math.round(t * 10)); R.gmX.push(q16(x)); R.gmY.push(q16(y));
  }

  // Straight projectiles need only launch time, point, angle and flight time: the viewer
  // recomputes every position, so nothing is recorded while they fly (guided missiles add
  // a point every MISSILE_EVERY ticks, see guidedPoint).
  shotStart(kind, team, x, y, ang, guided = false) {
    const R = this.R;
    const rec = R.shotT0.push(this.now);
    R.shotFlight.push(0); R.shotX.push(q16(x)); R.shotY.push(q16(y)); R.shotAng.push(qAng(ang));
    R.shotHit.push(0); R.shotTeam.push(team); R.shotKind.push(kind === K_FIGHTER ? 4 : guided ? 3 : kind === K_MISSILE ? 1 : kind === K_PLASMA ? 2 : 0);
    return rec;
  }
  /** hit: 0 expired, 1 hit something, 2 shot down by point defence. */
  shotEnd(rec, t1, hit) {
    const R = this.R;
    R.shotFlight.set(rec, Math.min(65535, Math.round((t1 - R.shotT0.a[rec]) * 10)));
    R.shotHit.set(rec, hit);
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
          if (e.dead || e.retired || e.id === ownerId || (skipTeam >= 0 && e.kind === SHIP && this.fr[(skipTeam << 4) | e.team])) continue;
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
    return this.friendlyFire || target.kind !== SHIP || !this.fr[(team << 4) | target.team];
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
    if (e.types[i] === BT.LANCE) {
      // Heavy-laser blocks cook off. Queue the blast and set it off in resolveCookoffs(), so a
      // chain reaction through the rest of the gun doesn't recurse.
      const lx = (i % e.w) + 0.5 - e.w / 2, ly = ((i / e.w) | 0) + 0.5 - e.h / 2;
      this.cookoffs.push(e.x + lx * e.c - ly * e.s, e.y + lx * e.s + ly * e.c);
    }
  }

  /**
   * Detonate destroyed heavy-laser blocks. The blast ignores the friendly-fire setting: it
   * wrecks its own ship and any ally alongside. It can kill the next heavy-laser blocks, which
   * go off in turn, so a hit gun often takes the whole unit (and the middle of the ship) with it.
   */
  resolveCookoffs() {
    const C = COOKOFF;
    for (let k = 0; k < this.cookoffs.length && k < 4000; k += 2) {
      const x = this.cookoffs[k], y = this.cookoffs[k + 1];
      this.recExplosion(x, y, 3);
      this.blast(x, y, C.radius, C.damage, -1, true);
    }
    this.cookoffs.length = 0;
  }

  /**
   * Missile blast: hits every ship and wreck within the radius, block by block, with damage
   * falling off as peak * (1 - d / radius)^2. Lethal at the centre, a wide ring of weakened
   * blocks around it, so overlapping blasts are what really tear ships apart.
   */
  blast(x, y, radius, peak, team, anyone = false) {
    const R = radius, hit = [];
    this.grid.queryBox(x - R, y - R, x + R, y + R, (e) => { if (!e.dead && !e.retired) hit.push(e); });
    for (const e of hit) {
      if (!anyone && !this.canDamage(e, team)) continue;
      const dx = x - e.x, dy = y - e.y;
      if (dx * dx + dy * dy > (R + e.radius) ** 2) continue;
      const gx = dx * e.c + dy * e.s + e.w * 0.5, gy = -dx * e.s + dy * e.c + e.h * 0.5;
      const r = Math.ceil(R);
      for (let j = Math.max(0, Math.floor(gy) - r); j <= Math.min(e.h - 1, Math.floor(gy) + r); j++)
        for (let i = Math.max(0, Math.floor(gx) - r); i <= Math.min(e.w - 1, Math.floor(gx) + r); i++) {
          const c = j * e.w + i;
          if (!e.types[c] || e.hp[c] <= 0) continue;
          const d = Math.hypot(i + 0.5 - gx, j + 0.5 - gy);
          if (d >= R) continue;
          const f = 1 - d / R;
          let dmg = peak * f * f;
          if (anyone && e.types[c] === BT.LANCE) dmg *= LANCE_COOK_SCALE; // cook-offs chain through plasma blocks however tough
          if (dmg > 1) this.damageCell(e, c, dmg);
        }
    }
    // Fighters caught in the blast.
    if (this.fobjs.length) {
      const Fi = this.Fi;
      this.fgrid.queryBox(x - R, y - R, x + R, y + R, (o) => {
        const j = o.i;
        if (Fi.hp[j] <= 0 || (!anyone && !this.fighterFoe(j, team))) return;
        const d = Math.hypot(Fi.x[j] - x, Fi.y[j] - y);
        if (d < R) { const f = 1 - d / R; Fi.hp[j] -= peak * f * f; }
      });
    }
  }

  /**
   * Heavy laser aiming: try a few blocks on each target in range and pick the line that crosses
   * the most enemy ships (none if a friendly ship comes first), so one shot cuts through a whole
   * row of ships. Hull circles, not blocks: it's only choosing a direction. Sets _ax/_ay; false keeps
   * the default aim.
   */
  lanceAim(e, w, wx, wy, W, ax0, ay0) {
    const r2 = W.range * W.range, cand = this._lanceCand || (this._lanceCand = []);
    cand.length = 0;
    cand.push(ax0, ay0);
    for (let j = 0; j < e.targets.length && cand.length < 24; j++) {
      const o = e.targets[j];
      for (let tries = 0; tries < 2; tries++) {
        const [x, y] = this.aimPoint(o);
        if ((x - wx) ** 2 + (y - wy) ** 2 <= r2 && this.bears(e, w, wx, wy, x, y)) cand.push(x, y);
      }
    }
    let best = -1, bestN = 0;
    for (let k = 0; k < cand.length; k += 2) {
      const n = this.lanceCount(e, wx, wy, cand[k], cand[k + 1], W.range);
      if (n > bestN) { bestN = n; best = k; }
    }
    if (best < 0) return false;
    this._ax = cand[best]; this._ay = cand[best + 1];
    return true;
  }

  /** Enemy ships whose hull circle the beam line crosses before the first friendly ship. */
  lanceCount(e, x0, y0, ax, ay, range) {
    const dx = ax - x0, dy = ay - y0, d = Math.hypot(dx, dy) || 1;
    const x1 = x0 + (dx / d) * range, y1 = y0 + (dy / d) * range;
    const g = this.grid, q = ++g.qid, n = g.n, pad = 20; // pad: friends flying in from just off the line
    const gx0 = g.cx(Math.min(x0, x1) - pad), gx1 = g.cx(Math.max(x0, x1) + pad), gy0 = g.cx(Math.min(y0, y1) - pad), gy1 = g.cx(Math.max(y0, y1) + pad);
    const sdx = x1 - x0, sdy = y1 - y0, len2 = sdx * sdx + sdy * sdy;
    let friendT = 2, allies = 0;
    const ts = this._lanceTs || (this._lanceTs = []);
    ts.length = 0;
    for (let cy = gy0; cy <= gy1; cy++)
      for (let cx = gx0; cx <= gx1; cx++) {
        const c = cy * n + cx, s = g.start[c], m = g.count[c];
        for (let k = 0; k < m; k++) {
          const o = g.ents[g.items[s + k]];
          if (o._q === q) continue;
          o._q = q;
          if (o.dead || o.retired || o === e || o.kind !== SHIP) continue;
          const t = ((o.x - x0) * sdx + (o.y - y0) * sdy) / len2;
          if (t < 0 || t > 1) continue;
          // Enemies count through the middle half of the hull (a graze doesn't cut anything in
          // half); allies anywhere near the line count, with room for them to move into it while
          // the bolt flies.
          const d2 = (x0 + sdx * t - o.x) ** 2 + (y0 + sdy * t - o.y) ** 2;
          if (this.fr[(e.team << 4) | o.team]) {
            if (o.fixed || (o.still && o.vx * o.vx + o.vy * o.vy < 1)) {
              // A friend that can't move (a defence, or a ship with no thrusters left that has
              // come to a stop; one still drifting on its old momentum counts as moving) will never
              // drift into the line, so only a bolt that really runs through its blocks counts
              // (owner, Nov 2026: plasma defences in rows hardly fired). The bolt still hurts it.
              const tb = this.raycast(o, x0, y0, x1, y1, 1);
              if (tb >= 0) { allies++; if (tb < friendT) friendT = tb; }
              continue;
            }
            // Moving friends: where it is now, or where it will be when the bolt gets there (owner,
            // Nov 2026: bolts grazed friends flying into the line; friendly ships hit −85%).
            const ra = o.radius + LANCE_ALLY_MARGIN;
            let near = d2 <= ra * ra;
            if (!near) {
              const ft = (t * range) / LANCE_SPEED, qx = o.x + o.vx * ft, qy = o.y + o.vy * ft;
              const tq = ((qx - x0) * sdx + (qy - y0) * sdy) / len2;
              near = (x0 + sdx * tq - qx) ** 2 + (y0 + sdy * tq - qy) ** 2 <= ra * ra;
            }
            if (near) { allies++; if (t < friendT) friendT = t; }
          } else if (d2 <= o.radius * o.radius * 0.25) ts.push(t);
        }
      }
    let first = 2;
    for (const t of ts) if (t < first) first = t;
    // The bolt carves through allies too: never a line with a friend first, and each ally on
    // the line counts against it twice as much as an enemy counts for it.
    return friendT < first ? 0 : Math.max(0, ts.length - 2 * allies);
  }

  /**
   * Plasma cannon: launch a bolt (see plasmaStep). Holds fire (returns false) if a friendly ship
   * is the first thing in line, since the bolt would carve straight through it.
   */
  firePlasma(e, w, x0, y0, ax, ay, tg, W) {
    const d = Math.hypot(ax - x0, ay - y0) || 1;
    const t = Math.min(d / W.speed, W.maxLead);
    const ang = Math.atan2(ay + tg.vy * t - y0, ax + tg.vx * t - x0), ux = Math.cos(ang), uy = Math.sin(ang);
    // Checked along the real (led) direction: hold if a friend is first in line, or the line has
    // more allies than it's worth (lanceCount), so it rarely opens up on its own side.
    if (this.ownHullInWay(e, w, x0, y0, ang, W.range)) return false; // a giant doesn't shoot through itself
    if (this.sweep(x0, y0, x0 + ux * W.range, y0 + uy * W.range, e.id) && this.hitE.kind === SHIP && this.fr[(e.team << 4) | this.hitE.team]) return false;
    if (!this.lanceCount(e, x0, y0, x0 + ux, y0 + uy, W.range)) return false;
    const rec = this.shotStart(K_PLASMA, e.team, x0, y0, ang);
    this.addProjectile(K_PLASMA, BT.LANCE, x0, y0, ux * W.speed, uy * W.speed,
      Math.round(W.life / DT), e.id, e.team, -1, W.damage, 0, rec); // target: the last hull it burst into
    return true;
  }

  /**
   * Move plasma bolt i along x0,y0 → x1,y1 this tick, burning every live block on the way, in
   * order, on every ship and wreck except the gun ship itself: friendly fire included (owner:
   * something that powerful carves through friend and foe alike). Each hull it bursts into gets a
   * flash. Returns true when the budget is spent (the bolt ends there with a blast).
   */
  plasmaStep(i, x0, y0, x1, y1) {
    const P = this.P, owner = P.owner[i], hits = this._plasmaHits || (this._plasmaHits = []);
    hits.length = 0;
    const g = this.grid, q = ++g.qid, n = g.n, pad = 1;
    const gx0 = g.cx(Math.min(x0, x1) - pad), gx1 = g.cx(Math.max(x0, x1) + pad), gy0 = g.cx(Math.min(y0, y1) - pad), gy1 = g.cx(Math.max(y0, y1) + pad);
    const sdx = x1 - x0, sdy = y1 - y0, len2 = sdx * sdx + sdy * sdy || 1;
    for (let cy = gy0; cy <= gy1; cy++)
      for (let cx = gx0; cx <= gx1; cx++) {
        const c = cy * n + cx, st = g.start[c], m = g.count[c];
        for (let k = 0; k < m; k++) {
          const o = g.ents[g.items[st + k]];
          if (o._q === q) continue;
          o._q = q;
          if (o.dead || o.retired || o.id === owner) continue;
          let t = ((o.x - x0) * sdx + (o.y - y0) * sdy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const rr = o.radius + pad;
          if ((x0 + sdx * t - o.x) ** 2 + (y0 + sdy * t - o.y) ** 2 > rr * rr) continue;
          this.raycastAll(o, x0, y0, x1, y1, hits);
        }
      }
    if (!hits.length) return false;
    hits.sort((a, b) => a.t - b.t);
    let budget = P.dmg[i], last = null;
    for (const h of hits) {
      const o = h.e, hp = o.hp[h.cell];
      if (hp <= 0) continue;
      if (o !== last && o.id !== P.target[i]) { // bursting into a new hull: a flash
        this.recExplosion(x0 + sdx * h.t, y0 + sdy * h.t, 4); // 4: plasma bursting into a hull
        P.target[i] = o.id; last = o;
      }
      const dmg = Math.min(hp, budget);
      this.damageCell(o, h.cell, dmg);
      budget -= dmg;
      if (budget <= 0) {
        P.dmg[i] = 0;
        this._ax = x0 + sdx * h.t; this._ay = y0 + sdy * h.t; this.hitT = h.t;
        return true;
      }
    }
    P.dmg[i] = budget;
    return false;
  }

  /** Like raycast(), but records every live block along the segment, not just the first. */
  raycastAll(e, x0, y0, x1, y1, out) {
    const c = e.c, s = e.s, w = e.w, h = e.h;
    let dx = x0 - e.x, dy = y0 - e.y;
    const gx0 = dx * c + dy * s + w * 0.5, gy0 = -dx * s + dy * c + h * 0.5;
    dx = x1 - e.x; dy = y1 - e.y;
    const ddx = dx * c + dy * s + w * 0.5 - gx0, ddy = -dx * s + dy * c + h * 0.5 - gy0;
    let t0 = 0, t1 = 1;
    for (const [p0, dd, lim] of [[gx0, ddx, w], [gy0, ddy, h]]) {
      if (dd === 0) { if (p0 < 0 || p0 > lim) return; continue; }
      const ra = -p0 / dd, rb = (lim - p0) / dd;
      t0 = Math.max(t0, Math.min(ra, rb)); t1 = Math.min(t1, Math.max(ra, rb));
    }
    if (t0 > t1) return;
    let ix = Math.min(w - 1, Math.max(0, Math.floor(gx0 + ddx * t0))), iy = Math.min(h - 1, Math.max(0, Math.floor(gy0 + ddy * t0)));
    const stx = ddx > 0 ? 1 : -1, sty = ddy > 0 ? 1 : -1;
    const tdx = ddx !== 0 ? Math.abs(1 / ddx) : Infinity, tdy = ddy !== 0 ? Math.abs(1 / ddy) : Infinity;
    let tmx = ddx > 0 ? (ix + 1 - gx0) / ddx : ddx < 0 ? (ix - gx0) / ddx : Infinity;
    let tmy = ddy > 0 ? (iy + 1 - gy0) / ddy : ddy < 0 ? (iy - gy0) / ddy : Infinity;
    let t = t0;
    for (let guard = w + h + 2; guard > 0; guard--) {
      const i = iy * w + ix;
      if (e.types[i] && e.hp[i] > 0) out.push({ t, e, cell: i });
      if (tmx < tmy) { t = tmx; if (t > t1) return; ix += stx; tmx += tdx; if (ix < 0 || ix >= w) return; }
      else { t = tmy; if (t > t1) return; iy += sty; tmy += tdy; if (iy < 0 || iy >= h) return; }
    }
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
      if (e.kind === CHUNK) { if (e.alive <= 0) e.dead = true; else this.fitChunkBox(e); continue; }
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
    if (e.ward) e.ward.escortCount--;
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
    e.parent = p.id;
    let mass = 0;
    for (const idx of cells) {
      const ci = (((idx / pw) | 0) - minJ) * cw + ((idx % pw) - minI);
      mass += BLOCKS[p.types[idx]].mass;
      e.types[ci] = p.types[idx];
      e.hp[ci] = p.hp[idx];
      e.alive++;
      p.types[idx] = 0; p.hp[idx] = 0; p.alive--;
      this.recBlockDeath(p.id, idx, 1);
    }
    e.mass = Math.max(1, mass);
    this.buildTiles(e);
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
      bdT: C(Uint16Array), bdEnt: C(Uint32Array), bdCell: C(Uint32Array), bdCause: C(Uint8Array),
      // Shells and missiles fly straight: launch + angle + flight time (in 0.01 s) is enough.
      shotT0: C(Uint16Array), shotFlight: C(Uint16Array), shotX: C(Int16Array), shotY: C(Int16Array),
      shotAng: C(Uint16Array), shotHit: C(Uint8Array), shotTeam: C(Uint8Array), shotKind: C(Uint8Array),
      lasT: C(Uint16Array), lasX: C(Int16Array), lasY: C(Int16Array), lasAng: C(Uint16Array), lasLen: C(Uint16Array), lasKind: C(Uint8Array),
      lasTeam: C(Uint8Array), lasHit: C(Uint8Array),
      lasSrc: C(Uint32Array), lasDst: C(Uint32Array), lasSX: C(Int16Array), lasSY: C(Int16Array), lasDX: C(Int16Array), lasDY: C(Int16Array),
      expT: C(Uint16Array), expX: C(Int16Array), expY: C(Int16Array), expS: C(Uint8Array),
      chParent: C(Uint32Array), chT0: C(Uint16Array), chX: C(Float32Array), chY: C(Float32Array), chA: C(Float32Array),
      chVx: C(Float32Array), chVy: C(Float32Array), chVa: C(Float32Array),
      chMinI: C(Uint16Array), chMinJ: C(Uint16Array), chW: C(Uint16Array), chH: C(Uint16Array),
      chC0: C(Uint32Array), chN: C(Uint32Array), chCells: C(Uint32Array),
      // Debris pushed by ships: from tick svT the piece is at svX/svY drifting at svVx/svVy.
      // Positions in 1/EV_Q block, velocities in 1/VEL_Q block per second.
      svT: C(Uint16Array), svEnt: C(Uint32Array), svX: C(Int16Array), svY: C(Int16Array), svVx: C(Int16Array), svVy: C(Int16Array),
      // Guided missiles (shot kind 3) and fighters (shot kind 4): points on their path, gmT in 0.01 s (ticks × 10), for shot gmRec.
      gmRec: C(Uint32Array), gmT: C(Uint32Array), gmX: C(Int16Array), gmY: C(Int16Array),
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
    // Shots still flying when the battle ends never got a flight time (it is written when a shot
    // ends), so the viewer drew none of them: every plasma bolt fired in a battle's last 30 s
    // was invisible. Give them the rest of their life; the replay stops at the battle's end.
    const P = this.P;
    for (let i = 0; i < P.n; i++) if (this.R.shotFlight.a[P.rec[i]] === 0) {
      if (P.kind[i] === K_MISSILE && WEAPON[P.wtype[i]].guided) { this.guidedPoint(i, P.x[i], P.y[i], this.now); this.shotEnd(P.rec[i], this.now, 1); continue; }
      this.shotEnd(P.rec[i], this.now + P.life[i], 0);
    }
    const Fi = this.Fi; // fighters still flying at the end
    for (let i = 0; i < Fi.n; i++) { this.fighterPoint(i, this.now); this.shotEnd(Fi.rec[i], this.now, 1); }
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
      cols[k] = c.done();
    }
    // Beam entity ids fit in 16 bits in almost every battle: store them that way (0xffff = none).
    if (this.byId.length < 0xffff)
      for (const k of ['lasSrc', 'lasDst']) cols[k] = Uint16Array.from(cols[k], (v) => (v === NONE ? 0xffff : v));
    const meta = {
      version: 1, friendlyFire: this.friendlyFire, trackTotal: total, evQ: EV_Q, dt: DT, trackEvery: TRACK_EVERY, shoveEvery: SHOVE_EVERY, velQ: VEL_Q, missileEvery: MISSILE_EVERY, posQ: POS_Q, angQ: ANG_Q,
      ticks: this.tick, shipCount: S, chunkCount: this.byId.length - S,
      shotSpeed: [WEAPON[BT.CANNON].speed, WEAPON[BT.MISSILE].speed, WEAPON[BT.LANCE].speed], fighterSpeed: FIGHTER.speed,
      designs: this.designs.map((d) => ({ name: d.name, cls: d.cls, stance: d.stance, w: d.w, h: d.h, hub: d.hub, cells: Array.from(d.cells) })),
      survivors: [...this.teamAlive], teams: this.nT,
    };
    return { meta, cols };
  }
}
