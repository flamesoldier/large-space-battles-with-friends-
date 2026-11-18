// Usage: node tools/sim-galaxy.mjs [--players 4] [--seed 5] [--days 4] [--budget-min 30] [--out dir]
//
// 2.0 test game (owner, 18 Nov 2026): a whole galaxy played by simple bots, with REAL battles,
// resolved one at a time exactly like the server's battle worker (Battle → readBattle → toReplay →
// packReplay). Measures what the server would have to do and whether the front lines move.
//
// Bots: each player has three generated designs; every game hour (and after every event) it buys a
// shipyard whenever it can afford one, on the world where it's cheapest (the crowding tax makes it
// spread out), picking one of its designs at random. No destinations, no defences: fleets go for
// the nearest enemy by themselves.
//
// Prints a line per game half-day and a summary; writes battles.csv and the replays of the biggest
// and a typical battle (lsb-replay bytes) to --out.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, buildShipyard, quoteShipyard, dueEvent, planEvent, applyEvent, advanceTo, countShips, holdReason, allied } from '../src/world/world.js';
import { makeDesign } from '../src/shared/designs.js';
import { Battle } from '../src/sim/battle.js';
import { readBattle, shipColors, battleOptions } from '../src/world/battleSetup.js';
import { packReplay } from '../src/shared/replayFormat.js';
import { mulberry32 } from '../src/shared/rng.js';
import { HOUR_MS } from '../src/world/rules.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const NP = +arg('players', 4), SEED = +arg('seed', 5), DAYS = +arg('days', 4), BUDGET = +arg('budget-min', 30) * 60000, OUT = arg('out', '/tmp/sim-galaxy');
mkdirSync(OUT, { recursive: true });

const w = createWorld({ players: Array.from({ length: NP }, (_, i) => ({ name: `Bot${i + 1}` })), seed: SEED });
const rnd = mulberry32(SEED * 7919);
// Every bot gets the same mix of hull sizes (its own generated designs), so the test is fair.
const POOLS = [['frigate', 'destroyer', 'cruiser']];
const pools = w.players.map((p, i) => POOLS[i % POOLS.length].map((cls, k) => ({ ...makeDesign(cls, SEED * 100 + i * 10 + k), name: `${p.name} ${cls}` })));

function shop(pid) {
  let bought = 0;
  for (let guard = 0; guard < 50; guard++) {
    const pl = w.players[pid];
    if (pl.eliminated) return bought;
    const mine = w.planets.filter((P) => P.owner === pid);
    if (!mine.length) return bought;
    // A random design it can afford, on the world where that's cheapest.
    let best = null;
    const order = [...pools[pid]].sort(() => rnd() - 0.5);
    for (const d of order) {
      for (const P of mine) { const q = quoteShipyard(w, P.id, d); if (q.price <= pl.credits && (!best || best.d !== d ? !best : q.price < best.q.price)) best = { P, q, d }; else if (best && best.d === d && q.price < best.q.price) best = { P, q, d }; }
      if (best) break;
    }
    if (!best) return bought;
    const d = best.d;
    if (!buildShipyard(w, pid, best.P.id, d).ok) return bought;
    bought++;
  }
  return bought;
}

const battles = [];
let keep = { big: null, typical: [] };
const t0 = performance.now(), end = DAYS * 24 * HOUR_MS;
let nextShop = 0, nextReport = 12 * HOUR_MS, events = 0, captures = 0, flips = 0, stopped = false;
const lastOwner = w.planets.map((p) => p.owner), everOwned = w.planets.map((p) => new Set(p.owner === null ? [] : [p.owner]));
for (const pl of w.players) shop(pl.id);

while (w.clock < end) {
  if (performance.now() - t0 > BUDGET) { stopped = true; break; }
  const ev = dueEvent(w, Math.min(end, nextShop, nextReport));
  if (!ev) {
    const t = Math.min(end, nextShop, nextReport);
    advanceTo(w, t);
    if (t === nextShop) { for (const pl of w.players) shop(pl.id); nextShop += HOUR_MS; }
    if (t === nextReport) { report(); nextReport += 12 * HOUR_MS; }
    if (t >= end) break;
    continue;
  }
  advanceTo(w, ev.at);
  const plan = planEvent(w, ev);
  let result = null;
  if (plan.kind === 'battle') {
    const B = plan.battle, ships = B.groups.reduce((s, g) => s + g.n, 0);
    const c0 = performance.now();
    const b = new Battle({ designs: B.designs, ships: B.ships, seed: B.seed, maxTime: B.maxTime, ...battleOptions(B) });
    while (!b.done) b.step();
    result = readBattle(b, B);
    const rep = b.toReplay();
    rep.meta.colors = shipColors(B);
    const bytes = packReplay(rep.meta, rep.cols);
    const ms = performance.now() - c0;
    const sides = new Set(B.groups.map((g) => g.team)).size;
    const rec = { t: w.clock / HOUR_MS, planet: B.planet, ships, sides, sim: result.seconds, ms: Math.round(ms), mb: +(bytes.length / 1e6).toFixed(2), rss: Math.round(process.memoryUsage().rss / 1e6) };
    battles.push(rec);
    if (!keep.big || ships > keep.big.rec.ships) keep.big = { rec, bytes, title: `Battle of ${w.planets[B.planet].name} (${ships} ships)` };
    if (ships >= 150 && ships <= 400 && keep.typical.length < 3) keep.typical.push({ rec, bytes, title: `Battle of ${w.planets[B.planet].name} (${ships} ships)` });
  }
  applyEvent(w, ev, plan, result);
  events++;
  w.planets.forEach((P, i) => {
    if (P.owner === lastOwner[i]) return;
    captures++;
    if (P.owner !== null && everOwned[i].has(P.owner) && lastOwner[i] !== null) flips++; // taken back by someone who held it before
    if (P.owner !== null) everOwned[i].add(P.owner);
    lastOwner[i] = P.owner;
  });
  if (ev.kind === 'build' || plan.kind === 'battle') for (const pl of w.players) shop(pl.id);
}
report();

function report() {
  const h = w.clock / HOUR_MS, recent = battles.filter((b) => b.t > h - 12);
  const ships = w.players.map((p) => w.planets.reduce((s, P) => s + P.garrison.filter((g) => g.owner === p.id).reduce((a, g) => a + g.n, 0), 0) + w.fleets.filter((f) => f.owner === p.id).reduce((a, f) => a + countShips(f.ships), 0));
  const worlds = w.players.map((p) => w.planets.filter((P) => P.owner === p.id).length);
  const yards = w.players.map((p) => w.planets.reduce((s, P) => s + (P.owner === p.id ? P.yards.length : 0), 0));
  const big = recent.reduce((m, b) => Math.max(m, b.ships), 0), cpu = recent.reduce((s, b) => s + b.ms, 0) / 1000;
  // Where each player's ships are: flying, waiting in a siege, or sitting at a world (and why).
  const where = w.players.map((p) => {
    const o = { flying: 0, siege: 0, pinned: 0, late: 0, nothing: 0, defences: 0 };
    for (const f of w.fleets) if (f.owner === p.id) o[f.wait != null ? 'siege' : 'flying'] += countShips(f.ships);
    for (const P of w.planets) for (const g of P.garrison) {
      if (g.owner !== p.id || g.n <= 0) continue;
      if (w.designs[g.design].fixed || !allied(w, P.owner, p.id)) { o.defences += g.n; continue; }
      const r = holdReason(w, P, p.id, { [g.design]: g.n }, g.goal === undefined ? (P.dest?.to ?? null) : g.goal);
      o[r === 'siege' ? 'late' : r ?? 'nothing'] += g.n;
    }
    return o;
  });
  console.log(`  where: ${where.map((o, i) => `${w.players[i].name} fly ${o.flying} siege ${o.siege} pinned ${o.pinned} waiting ${o.late} idle ${o.nothing}`).join(' | ')}`);
  console.log(`day ${(h / 24).toFixed(1)}: worlds ${worlds.join('/')} militia ${w.planets.filter((P) => P.owner === null).length} · yards ${yards.join('/')} · ships ${ships.join('/')} · last 12 h: ${recent.length} battles, biggest ${big} ships, compute ${cpu.toFixed(0)} s · wall ${((performance.now() - t0) / 60000).toFixed(1)} min`);
}

const sorted = (k) => battles.map((b) => b[k]).sort((a, b) => a - b), pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const S = sorted('ships'), M = sorted('ms'), R = sorted('mb');
const hours = w.clock / HOUR_MS;
console.log(`\n${stopped ? 'STOPPED at the time budget' : 'Done'}: ${(hours / 24).toFixed(2)} game days, ${events} events, ${battles.length} battles, ${captures} worlds changed hands (${flips} taken back by a former holder)`);
console.log(`ships per battle: median ${pct(S, 0.5)}, 90% ${pct(S, 0.9)}, biggest ${pct(S, 1)}`);
console.log(`compute per battle: median ${(pct(M, 0.5) / 1000).toFixed(1)} s, 90% ${(pct(M, 0.9) / 1000).toFixed(1)} s, worst ${(pct(M, 1) / 1000).toFixed(1)} s; total ${(M.reduce((a, b) => a + b, 0) / 1000).toFixed(0)} s = ${(M.reduce((a, b) => a + b, 0) / 1000 / hours * 24 / 3600).toFixed(2)} h of compute per game day`);
console.log(`replays: median ${pct(R, 0.5)} MB, biggest ${pct(R, 1)} MB, ${(R.reduce((a, b) => a + b, 0) / hours * 24).toFixed(0)} MB per game day; peak memory ${Math.max(...battles.map((b) => b.rss), 0)} MB`);
const st = w.stats?.p || [];
console.log(`money per player (cr): ${w.players.map((p, i) => `${p.name} income ${Math.round(st[i]?.earned || 0).toLocaleString()} bounty ${Math.round(st[i]?.bounty || 0).toLocaleString()}`).join(' | ')}`);
writeFileSync(join(OUT, 'battles.csv'), 'hour,planet,ships,sides,sim_s,compute_ms,replay_mb,rss_mb\n' + battles.map((b) => [b.t.toFixed(2), b.planet, b.ships, b.sides, b.sim, b.ms, b.mb, b.rss].join(',')).join('\n'));
for (const [name, k] of [['big', keep.big], ...keep.typical.map((x, i) => [`typical${i + 1}`, x])]) if (k) { writeFileSync(join(OUT, `${name}.bin`), k.bytes); writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ title: k.title, ...k.rec })); }
