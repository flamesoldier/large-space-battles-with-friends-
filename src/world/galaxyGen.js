// Galaxy generator: worlds scattered over a disc, one home world (spawn point) per player spread
// evenly round a ring, and a hyperlane network joining them.
//
// Hyperlanes: a Euclidean minimum spanning tree (so every world is reachable by lane, and tree
// edges never cross), plus a share of the remaining short links between near neighbours that
// don't cross an existing lane or pass too close to another world. Seeded, so the same seed and
// player count always give the same map.

import { mulberry32 } from '../shared/rng.js';
import { HOME_INCOME, PLANET_INCOME } from '../shared/economy.js';
import { PLANET_SPACING, HOME_CLEARANCE, DEFAULT_PLANETS_PER_PLAYER } from './rules.js';

const SYL_A = ['Ar', 'Bel', 'Cor', 'Dra', 'El', 'Fen', 'Gal', 'Hes', 'Ix', 'Jor', 'Kal', 'Lyr', 'Mor', 'Nex', 'Or', 'Pyr', 'Quin', 'Rho', 'Sel', 'Tar', 'Ul', 'Vey', 'Wyr', 'Xan', 'Yor', 'Zeph'];
const SYL_B = ['a', 'e', 'i', 'o', 'u', 'ae', 'io', 'ar', 'en', 'or', 'is', 'ux'];
const SYL_C = ['dis', 'nar', 'thos', 'vex', 'lon', 'mir', 'ra', 'tis', 'gon', 'ris', 'phe', 'ka', 'don', 'sca'];
const SUFFIX = ['', '', '', '', ' Prime', ' II', ' III', ' IV', ' Minor', ' Major'];

function nameGen(r) {
  const used = new Set();
  return () => {
    for (let k = 0; k < 50; k++) {
      const n = SYL_A[(r() * SYL_A.length) | 0] + SYL_B[(r() * SYL_B.length) | 0] + SYL_C[(r() * SYL_C.length) | 0] + SUFFIX[(r() * SUFFIX.length) | 0];
      if (!used.has(n)) { used.add(n); return n; }
    }
    return `World ${used.size + 1}`;
  };
}

/** Do segments ab and cd cross (sharing an endpoint doesn't count)? */
function segmentsCross(a, b, c, d) {
  if (a === c || a === d || b === c || b === d) return false;
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Distance from point p to segment ab. */
function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Make a galaxy for `players` players (2–10).
 * Returns { radius, planets: [{ id, name, x, y, size, income, home }], lanes: [[a, b], ...], spawns: [planetId per player] }.
 * `home` is the index of the player whose spawn point it is, or -1.
 */
export function generateGalaxy({ players, seed = 1, planetsPerPlayer = DEFAULT_PLANETS_PER_PLAYER, laneDensity = 0.45 }) {
  const r = mulberry32(seed * 7919 + players * 101);
  const total = players * planetsPerPlayer + 3;
  // Disc big enough for the planets at roughly constant density.
  const radius = Math.sqrt((total * PLANET_SPACING * PLANET_SPACING * 2.1) / Math.PI);
  const name = nameGen(mulberry32(seed * 31 + 7));
  const pts = [];

  // Spawn points: evenly round a ring at 72% of the radius, with a little jitter, so every
  // player starts the same distance from the centre and from their two neighbours.
  const spin = r() * Math.PI * 2;
  for (let k = 0; k < players; k++) {
    const a = spin + (k / players) * Math.PI * 2 + (r() - 0.5) * 0.12;
    const d = radius * (0.72 + (r() - 0.5) * 0.04);
    pts.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, home: k });
  }
  // Everything else by dart throwing (Poisson-disc style), keeping clear of home worlds.
  for (let tries = 0; pts.length < total && tries < total * 400; tries++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius;
    const p = { x: Math.cos(a) * d, y: Math.sin(a) * d, home: -1 };
    if (pts.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= (q.home >= 0 ? HOME_CLEARANCE : PLANET_SPACING))) pts.push(p);
  }

  const step = 50, [lo, hi] = PLANET_INCOME;
  const planets = pts.map((p, id) => ({
    id, name: name(), x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
    size: p.home >= 0 ? 1 : 0.55 + r() * 0.45,
    income: p.home >= 0 ? HOME_INCOME : lo + step * Math.floor(r() * ((hi - lo) / step + 1)),
    home: p.home,
  }));
  // Bigger worlds pay a bit more (purely cosmetic link: size follows income).
  for (const p of planets) if (p.home < 0) p.size = 0.5 + 0.5 * ((p.income - lo) / (hi - lo));

  // ---- hyperlanes
  const n = planets.length, lanes = [], has = new Set();
  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const add = (a, b) => { lanes.push(a < b ? [a, b] : [b, a]); has.add(key(a, b)); };
  const dist = (a, b) => Math.hypot(planets[a].x - planets[b].x, planets[a].y - planets[b].y);
  // Prim's MST over the complete graph (n is under 100, so O(n²) is nothing).
  const inTree = new Uint8Array(n), best = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1);
  best[0] = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
    inTree[u] = 1;
    if (from[u] >= 0) add(from[u], u);
    for (let v = 0; v < n; v++) if (!inTree[v] && dist(u, v) < best[v]) { best[v] = dist(u, v); from[v] = u; }
  }
  // Extra links between near neighbours, shortest first.
  const cands = [];
  for (let a = 0; a < n; a++) {
    const near = [...Array(n).keys()].filter((b) => b !== a).sort((x, y) => dist(a, x) - dist(a, y)).slice(0, 4);
    for (const b of near) if (a < b || !near.includes(a)) cands.push([Math.min(a, b), Math.max(a, b)]);
  }
  cands.sort((x, y) => dist(...x) - dist(...y));
  for (const [a, b] of cands) {
    if (has.has(key(a, b)) || r() > laneDensity) continue;
    const A = planets[a], B = planets[b];
    if (lanes.some(([c, d]) => segmentsCross(A, B, planets[c], planets[d]))) continue;
    if (planets.some((p, i) => i !== a && i !== b && pointSegDist(p, A, B) < PLANET_SPACING * 0.35)) continue;
    add(a, b);
  }
  lanes.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const spawns = [];
  for (const p of planets) if (p.home >= 0) spawns[p.home] = p.id;
  return { radius, planets, lanes, spawns };
}
