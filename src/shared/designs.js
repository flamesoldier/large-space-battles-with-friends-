// Ship design format + a procedural generator for test fleets.
//
// A design is exactly what a player's ship editor will save:
//   { name, cls, w, h, cells: Uint8Array(w*h) of BT block types, hub: cell index }
// Cell (i, j) lives at index j*w + i. Column i = w-1 is the nose.
// Until the editor exists we generate plausible designs so the sim has something to chew on.

import { BT } from './blocks.js';
import { mulberry32, randInt, randRange } from './rng.js';

export const CLASSES = {
  corvette:   { w: [6, 8],   h: [3, 5],   lasers: 1, cannons: 1, missiles: 0, pd: 0,  thrustCols: 1, heavyFront: false, armorDepth: 1 },
  frigate:    { w: [10, 13], h: [5, 7],   lasers: 1, cannons: 2, missiles: 0, pd: 1,  thrustCols: 1, heavyFront: false, armorDepth: 1 },
  destroyer:  { w: [16, 20], h: [7, 9],   lasers: 2, cannons: 4, missiles: 1, pd: 2,  thrustCols: 1, heavyFront: true,  armorDepth: 1 },
  cruiser:    { w: [26, 32], h: [11, 13], lasers: 4, cannons: 6, missiles: 2, pd: 4,  thrustCols: 2, heavyFront: true,  armorDepth: 2 },
  battleship: { w: [44, 52], h: [17, 21], lasers: 8, cannons: 12, missiles: 4, pd: 8,  thrustCols: 2, heavyFront: true,  armorDepth: 2 },
  titan:      { w: [80, 90], h: [29, 33], lasers: 16, cannons: 22, missiles: 8, pd: 16, thrustCols: 3, heavyFront: true,  armorDepth: 3 },
};

// Default combat stance odds per class for generated test designs. In the real game the
// player picks the stance in the ship designer.
const STANCE_ODDS = {
  corvette: [['charge', 0.5], ['brawl', 0.5]],
  frigate: [['brawl', 0.4], ['escort', 0.3], ['line', 0.3]],
  destroyer: [['line', 0.5], ['escort', 0.3], ['brawl', 0.2]],
  cruiser: [['line', 0.6], ['standoff', 0.4]],
  battleship: [['standoff', 0.7], ['line', 0.3]],
  titan: [['standoff', 1]],
};

export const CLASS_MIX = [
  ['corvette', 0.45],
  ['frigate', 0.27],
  ['destroyer', 0.15],
  ['cruiser', 0.09],
  ['battleship', 0.035],
  ['titan', 0.005],
];

const lerp = (a, b, t) => a + (b - a) * t;

export function makeDesign(cls, seed) {
  const C = CLASSES[cls];
  const r = mulberry32(seed);
  const w = randInt(r, C.w[0], C.w[1]);
  let h = randInt(r, C.h[0], C.h[1]);
  if (h % 2 === 0) h += 1; // odd height => a centre row for symmetry
  const cy = (h - 1) / 2;

  // 1. Hull silhouette: a half-height per column, mirrored top/bottom.
  const rear = randRange(r, 0.45, 0.8);
  const noseLen = randRange(r, 0.18, 0.38);
  const tip = randRange(r, 0.1, 0.4);
  const half = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    const t = w === 1 ? 0.5 : x / (w - 1);
    let v;
    if (t < 0.15) v = lerp(rear, 1, t / 0.15);
    else if (t < 1 - noseLen) v = 1;
    else v = lerp(1, tip, (t - (1 - noseLen)) / noseLen);
    half[x] = Math.max(0, Math.round(v * cy));
  }
  // Notches and wings for bigger ships so they don't all look like lozenges.
  if (w > 12) {
    const notches = randInt(r, 1, 3);
    for (let n = 0; n < notches; n++) {
      const x0 = randInt(r, 2, w - 4), len = randInt(r, 1, Math.max(1, (w / 10) | 0));
      const cut = randInt(r, 1, Math.max(1, (cy / 3) | 0));
      for (let x = x0; x < Math.min(w - 1, x0 + len); x++) half[x] = Math.max(1, half[x] - cut);
    }
    if (r() < 0.6) {
      const x0 = randInt(r, 1, (w * 0.4) | 0), len = randInt(r, 2, Math.max(2, (w / 6) | 0));
      for (let x = x0; x < Math.min(w, x0 + len); x++) half[x] = cy;
    }
  }

  const cells = new Uint8Array(w * h);
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) if (Math.abs(y - cy) <= half[x]) cells[y * w + x] = BT.FRAME;

  // 2. Distance from the outside (1 = outer skin) to place armour layers.
  const dist = new Int32Array(w * h);
  const q = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!cells[i]) continue;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !cells[i - 1] || !cells[i + 1] || !cells[i - w] || !cells[i + w];
      if (edge) { dist[i] = 1; q.push(i); }
    }
  for (let k = 0; k < q.length; k++) {
    const i = q[k], x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && cells[j] && !dist[j]) { dist[j] = dist[i] + 1; q.push(j); }
  }
  for (let i = 0; i < w * h; i++) {
    if (!cells[i] || dist[i] > C.armorDepth) continue;
    const x = i % w;
    cells[i] = C.heavyFront && x > w * 0.62 ? BT.HEAVY : BT.ARMOR;
  }

  // 3. Thrusters on the rear columns.
  for (let x = 0; x < C.thrustCols; x++)
    for (let y = 0; y < h; y++) if (cells[y * w + x]) cells[y * w + x] = BT.THRUSTER;

  // 4. Hub, buried in the middle.
  const hubX = Math.max(C.thrustCols, Math.round(w * 0.45));
  const hub = cy * w + hubX;
  cells[hub] = BT.HUB;

  // 5. Weapons: mirrored pairs on the outer skin; missiles one layer in.
  const skin = [], inner = [];
  for (let y = 0; y <= cy; y++)
    for (let x = C.thrustCols; x < w - 1; x++) {
      const i = y * w + x;
      if (!cells[i] || i === hub) continue;
      if (dist[i] === 1) skin.push(i);
      else if (dist[i] === 2) inner.push(i);
    }
  const place = (list, n, type) => {
    if (!list.length || n <= 0) return;
    const pairs = Math.ceil(n / 2);
    for (let k = 0; k < pairs; k++) {
      const i = list[Math.floor(((k + 0.5) / pairs) * list.length)];
      const x = i % w, y = (i / w) | 0;
      const mirror = (h - 1 - y) * w + x;
      if (cells[i] !== BT.HUB) cells[i] = type;
      if (cells[mirror] !== BT.HUB) cells[mirror] = type;
    }
  };
  // Interleave so lasers, cannons and point defence spread along the hull.
  const shuffled = skin.slice().sort(() => r() - 0.5), third = Math.ceil(shuffled.length / 3);
  const groups = [0, 1, 2].map((g) => shuffled.slice(g * third, (g + 1) * third).sort((a, b) => a - b));
  place(groups[0], C.lasers, BT.LASER);
  place(groups[1], C.cannons, BT.CANNON);
  place(groups[2], C.pd, BT.PD);
  place(inner.length ? inner : skin, C.missiles, BT.MISSILE);
  // Small ships get a nose gun.
  if (w <= 13) cells[cy * w + (w - 1)] = r() < 0.5 ? BT.CANNON : BT.LASER;

  let roll = r(), stance = 'line';
  for (const [st, p] of STANCE_ODDS[cls]) { if (roll < p) { stance = st; break; } roll -= p; }
  return { name: `${cls}-${seed % 1000}`, cls, w, h, cells, hub, stance };
}

/** Build two opposing fleets. Returns { designs, ships:[{design, team, x, y, a}] }. */
export function makeScenario({ perSide = 500, seed = 1, variants = 3 } = {}) {
  const r = mulberry32(seed * 7919 + 13);
  const designs = [];
  const byTeamClass = [{}, {}];
  for (let team = 0; team < 2; team++)
    for (const [cls] of CLASS_MIX) {
      byTeamClass[team][cls] = [];
      for (let v = 0; v < variants; v++) {
        byTeamClass[team][cls].push(designs.length);
        designs.push(makeDesign(cls, seed * 1000 + team * 100 + designs.length));
      }
    }

  const ships = [];
  const backOffset = { corvette: 0, frigate: 25, destroyer: 60, cruiser: 110, battleship: 180, titan: 280 };
  const spanY = Math.max(500, Math.sqrt(perSide) * 55);
  for (let team = 0; team < 2; team++) {
    const counts = CLASS_MIX.map(([cls, f]) => [cls, Math.round(perSide * f)]);
    const titan = counts.find((c) => c[0] === 'titan');
    if (perSide >= 40 && titan[1] === 0) titan[1] = 1;
    const dir = team === 0 ? 1 : -1;
    const front = 260;
    for (const [cls, n] of counts)
      for (let k = 0; k < n; k++) {
        const list = byTeamClass[team][cls];
        const design = list[k % list.length];
        const depth = backOffset[cls] + r() * (40 + Math.sqrt(n) * 18);
        ships.push({
          design, team,
          x: -dir * (front + depth),
          y: (r() - 0.5) * spanY,
          a: team === 0 ? 0 : Math.PI,
        });
      }
  }
  return { designs, ships };
}
