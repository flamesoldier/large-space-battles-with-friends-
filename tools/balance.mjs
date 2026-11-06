// Weapon balance harness: equal-credit fleets of single-weapon ships fight each other.
//
// Usage: node tools/balance.mjs [seeds=4] [budget=60000] [--cls cruiser] [--only laser,cannon]
//
// Every ship uses the same generated hull (one per seed); all its guns are replaced by one weapon
// type, with roughly the same credits spent on weapons. Fleets are sized to the same total cost.
// Score for a matchup = share of the enemy fleet's credits destroyed minus share of your own lost
// (+1 = flawless win, -1 = wiped out for nothing). Also prints each type against a mixed fleet
// of generated designs (what an average player fleet looks like).
import { makeDesign, CLASS_MIX } from '../src/shared/designs.js';
import { designCost } from '../src/shared/shipStats.js';
import { BT, BLOCKS, WEAPON } from '../src/shared/blocks.js';
import { lineOfFire, openDegrees } from '../src/shared/arcs.js';
import { Battle } from '../src/sim/battle.js';
import { mulberry32 } from '../src/shared/rng.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const SEEDS = Number(pos[0] ?? 4), BUDGET = Number(pos[1] ?? 60000);
const CLS = flag('--cls', 'cruiser');
const WEAPON_SHARE = Number(flag('--share', 900)); // credits of guns per ship (cruiser)
const STANCE = flag('--stance', null);
const CORE = Number(flag('--core', 0)); // heavy armour this many blocks round the hub
const HEAVY_HULL = args.includes('--heavy'); // every armour block becomes heavy armour
// --set laser.cost=70,cannon.damage=90 : try numbers without editing blocks.js (cost/hp/mass go
// to BLOCKS, everything else to WEAPON).
const KEYS = { laser: BT.LASER, cannon: BT.CANNON, missile: BT.MISSILE, pd: BT.PD, armor: BT.ARMOR, heavy: BT.HEAVY, hub: BT.HUB, frame: BT.FRAME, thruster: BT.THRUSTER, lance: BT.LANCE };
for (const kv of (flag('--set', '') || '').split(',').filter(Boolean)) {
  const [path, v] = kv.split('='), [name, field] = path.split('.');
  const tgt = ['cost', 'hp', 'mass', 'thrust'].includes(field) ? BLOCKS[KEYS[name]] : WEAPON[KEYS[name]];
  tgt[field] = Number(v);
}

const TYPES = {
  laser: { t: BT.LASER, stance: 'line' },
  cannon: { t: BT.CANNON, stance: 'line' },
  missile: { t: BT.MISSILE, stance: 'standoff' },
  pd: { t: BT.PD, stance: 'charge' },
  mixed: { t: 0, stance: 'line' },
  'cannon+pd': { t: BT.CANNON, stance: 'line', pd: 0.25 }, // a quarter of the gun money on point defence
  'laser+pd': { t: BT.LASER, stance: 'line', pd: 0.25 }, // the generator's own laser/cannon/missile/PD mix, guns rescaled to the same spend
};
const only = flag('--only', null);
// "weapon@stance" in --only picks a stance, e.g. pd@flank,cannon@standoff.
for (const k of (only || '').split(',')) if (k.includes('@') && TYPES[k.split('@')[0]]) TYPES[k] = { ...TYPES[k.split('@')[0]], stance: k.split('@')[1] };
const names = only ? only.split(',').filter((k) => TYPES[k]) : Object.keys(TYPES).filter((k) => !k.includes('+'));

/** Same hull, guns swapped: every weapon cell becomes armour, then `n` guns of type t on the skin. */
export function variant(base, t, credits, stance, pdShare = 0) {
  const d = { ...base, cells: base.cells.slice(), stance, name: `${base.name}-${t}` };
  const { w, h } = d;
  const wasGun = [];
  for (let i = 0; i < d.cells.length; i++) if (d.cells[i] >= BT.LASER && d.cells[i] <= BT.PD) { wasGun.push(i); d.cells[i] = BT.ARMOR; }
  if (HEAVY_HULL) for (let i = 0; i < d.cells.length; i++) if (d.cells[i] === BT.ARMOR) d.cells[i] = BT.HEAVY;
  if (CORE) { // heavy-armour box round the hub (a player's answer to lasers burning in to it)
    const hx = d.hub % w, hy = (d.hub / w) | 0;
    for (let y = hy - CORE; y <= hy + CORE; y++) for (let x = hx - CORE; x <= hx + CORE; x++) {
      const i = y * w + x;
      if (x >= 0 && y >= 0 && x < w && y < h && i !== d.hub && d.cells[i] && d.cells[i] !== BT.THRUSTER) d.cells[i] = BT.HEAVY;
    }
  }
  if (!t) { // mixed: keep the original layout
    for (const i of wasGun) d.cells[i] = base.cells[i];
    return d;
  }
  const n = Math.max(2, Math.round((credits * (1 - pdShare)) / BLOCKS[t].cost / 2) * 2);
  const nPd = pdShare ? Math.max(2, Math.round((credits * pdShare) / BLOCKS[BT.PD].cost / 2) * 2) : 0;
  // Candidate cells: outer skin (any non-thruster, non-hub block with an empty/outside neighbour),
  // ranked by how much arc a gun there gets. Mirrored pairs keep the ship symmetric.
  const cy = (h - 1) / 2, cand = [];
  for (let y = 0; y <= Math.floor(cy); y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, c = d.cells[i];
      if (!c || c === BT.HUB || c === BT.THRUSTER) continue;
      const edge = x === w - 1 || y === 0 || !d.cells[i - w] || (x < w - 1 && !d.cells[i + 1]);
      if (!edge) continue;
      const f = lineOfFire(d.cells, null, w, h, i, { m0: 0, m1: 0, buried: false }), arc = f.buried ? 0 : openDegrees(f.m0, f.m1);
      cand.push([arc, i]);
    }
  cand.sort((a, b) => b[0] - a[0]);
  // Main guns get the best spots; point defence is spread evenly over the rest.
  let placed = 0, k = 0;
  const put = (i, type) => { const x = i % w, y = (i / w) | 0, m = (h - 1 - y) * w + x; d.cells[i] = type; placed++; if (m !== i) { d.cells[m] = type; placed++; } };
  for (; k < cand.length && placed < n; k++) put(cand[k][1], t);
  const rest = cand.slice(k), pairs = nPd / 2;
  for (let p = 0; p < pairs && rest.length; p++) put(rest[Math.floor(((p + 0.5) / pairs) * rest.length)][1], BT.PD);
  return d;
}

function fight(dA, dB, seed) {
  const cA = designCost(dA), cB = designCost(dB);
  const nA = Math.max(1, Math.round(BUDGET / cA)), nB = Math.max(1, Math.round(BUDGET / cB));
  const r = mulberry32(seed * 31 + 7), ships = [];
  const place = (team, n, di, d) => {
    const dir = team === 0 ? 1 : -1, spanY = Math.max(160, Math.sqrt(n) * 45);
    for (let k = 0; k < n; k++) ships.push({ design: di, team, x: -dir * (300 + Math.hypot(d.w, d.h) * 0.6 + r() * (30 + Math.sqrt(n) * 10)), y: (r() - 0.5) * spanY, a: team ? Math.PI : 0 });
  };
  place(0, nA, 0, dA); place(1, nB, 1, dB);
  const b = new Battle({ designs: [dA, dB], ships, seed, maxTime: 240 });
  b.run();
  const lost = [0, 0], start = [nA * cA, nB * cB];
  for (let k = 0; k < ships.length; k++) {
    const e = b.byId[k];
    if (e.dead || e.hubDead || !e.weapons.length) lost[ships[k].team] += ships[k].team ? cB : cA;
  }
  return { a: lost[1] / start[1] - lost[0] / start[0], t: b.tick / 10, why: b.endReason, nA, nB };
}

const table = {};
const t0 = performance.now();
for (let s = 1; s <= SEEDS; s++) {
  const base = makeDesign(CLS, 5000 + s * 17);
  const ds = {};
  for (const k of names) ds[k] = variant(base, TYPES[k].t, WEAPON_SHARE, STANCE || TYPES[k].stance, TYPES[k].pd || 0);
  // mixed: rescale nothing (it's the generator's design); report its cost for reference
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const r = fight(ds[names[i]], ds[names[j]], s);
      const key = `${names[i]}|${names[j]}`;
      (table[key] ||= []).push(r);
    }
  if (s === 1) for (const k of names) console.log(`${k.padEnd(16)} cost ${designCost(ds[k])}  guns ${ds[k].cells.filter((c) => c >= BT.LASER && c <= BT.PD).length}  stance ${ds[k].stance}`);
}
console.log(`\n${CLS}, ${SEEDS} seeds, ${BUDGET} cr per side. Row's score vs column (+1 flawless win, -1 wiped out):`);
const score = {};
console.log(''.padEnd(16) + names.map((n) => n.slice(0, 15).padStart(16)).join(''));
for (const a of names) {
  let line = a.slice(0, 15).padEnd(16), tot = 0;
  for (const b of names) {
    if (a === b) { line += '-'.padStart(16); continue; }
    const k1 = `${a}|${b}`, k2 = `${b}|${a}`;
    const rs = table[k1] ? table[k1].map((r) => r.a) : table[k2].map((r) => -r.a);
    const m = rs.reduce((x, y) => x + y, 0) / rs.length;
    tot += m;
    line += ((m >= 0 ? '+' : '') + m.toFixed(2)).padStart(16);
  }
  score[a] = tot / (names.length - 1);
  console.log(line + `   avg ${(score[a] >= 0 ? '+' : '') + score[a].toFixed(2)}`);
}
const lens = Object.values(table).flat();
console.log(`\nmean battle ${ (lens.reduce((x, r) => x + r.t, 0) / lens.length).toFixed(0)} s; ends: ${JSON.stringify(lens.reduce((o, r) => ((o[r.why] = (o[r.why] || 0) + 1), o), {}))}; ${((performance.now() - t0) / 1000).toFixed(0)} s compute`);
