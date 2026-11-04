// Usage: node tools/test-world.mjs
// Checks the galaxy generator, routes, economy and fleet rules, and plays a short game with real
// battles resolved by the sim.
import assert from 'node:assert/strict';
import { generateGalaxy } from '../src/world/galaxyGen.js';
import { planRoute, fleetPosition, laneMap } from '../src/world/routes.js';
import {
  createWorld, advanceTo, runWorld, buildShipyard, sellShipyard, quoteShipyard, sendFleet, previewFleet,
  shipsAt, incomeOf, allied, YARD_MS, designOf,
} from '../src/world/world.js';
import { readBattle } from '../src/world/battleSetup.js';
import { Battle } from '../src/sim/battle.js';
import { makeDesign } from '../src/shared/designs.js';
import { BT } from '../src/shared/blocks.js';
import { designCost } from '../src/shared/shipStats.js';
import { STARTING_CREDITS, HOME_INCOME, SHIPYARD_SELL_REFUND, shipyardPrice } from '../src/shared/economy.js';
import { HOUR_MS, HYPERLANE_SPEEDUP, MAX_PLAYERS, PLANET_SPACING } from '../src/world/rules.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

// ---- galaxy generation, for every player count
for (let n = 2; n <= MAX_PLAYERS; n++)
  for (let seed = 1; seed <= 6; seed++) {
    const g = generateGalaxy({ players: n, seed });
    ok(g.spawns.length === n && new Set(g.spawns).size === n, `${n}p seed ${seed}: one spawn per player`);
    ok(g.planets.length >= n * 5, `${n}p: enough planets (${g.planets.length})`);
    for (const a of g.planets) for (const b of g.planets)
      if (a.id < b.id) ok(Math.hypot(a.x - b.x, a.y - b.y) >= PLANET_SPACING - 0.2, 'planets spaced out');
    // Lanes connect every world.
    const seen = new Set([0]), q = [0];
    while (q.length) { const u = q.pop(); for (const [a, b] of g.lanes) { const v = a === u ? b : b === u ? a : -1; if (v >= 0 && !seen.has(v)) { seen.add(v); q.push(v); } } }
    ok(seen.size === g.planets.length, `${n}p seed ${seed}: hyperlanes reach every world`);
    // Same seed, same map.
    ok(JSON.stringify(generateGalaxy({ players: n, seed })) === JSON.stringify(g), 'generation is deterministic');
    // Home worlds sit the same distance from the centre.
    const ds = g.spawns.map((id) => Math.hypot(g.planets[id].x, g.planets[id].y));
    ok(Math.max(...ds) - Math.min(...ds) < g.radius * 0.06, 'spawn points are fair');
  }

// ---- routes: lanes are 10× faster, and the planner never does worse than flying straight
{
  const g = generateGalaxy({ players: 4, seed: 3 });
  const [a, b] = g.lanes[0];
  const d = Math.hypot(g.planets[a].x - g.planets[b].x, g.planets[a].y - g.planets[b].y);
  const lane = planRoute(g.planets, g.lanes, a, b, 5, true), space = planRoute(g.planets, g.lanes, a, b, 5, false);
  ok(Math.abs(space.hours - d / 5) < 1e-9, 'normal space at fleet speed');
  ok(Math.abs(lane.hours - d / 5 / HYPERLANE_SPEEDUP) < 1e-9 && lane.legs[0].lane, 'hyperlane is 10× faster');
  // The world passes a prebuilt lane Map: it must route exactly like the plain list.
  const m = laneMap(g.lanes);
  let usedLane = 0;
  for (let k = 0; k < 200; k++) {
    const x = (k * 11) % g.planets.length, y = (k * 17 + 3) % g.planets.length;
    if (x === y) continue;
    const a1 = planRoute(g.planets, g.lanes, x, y, 4, true), a2 = planRoute(g.planets, m, x, y, 4, true);
    ok(Math.abs(a1.hours - a2.hours) < 1e-9, 'lane Map and lane list route the same');
    if (a2.legs.some((l) => l.lane)) usedLane++;
  }
  ok(usedLane > 150, `most long trips use hyperlanes (${usedLane}/200)`);
  for (let k = 0; k < 200; k++) {
    const x = (k * 7) % g.planets.length, y = (k * 13 + 5) % g.planets.length;
    if (x === y) continue;
    const r1 = planRoute(g.planets, g.lanes, x, y, 4, true), r0 = planRoute(g.planets, g.lanes, x, y, 4, false);
    ok(r1.hours <= r0.hours + 1e-9, 'lanes never slower than flying straight');
    ok(r1.legs[0].from === x && r1.legs.at(-1).to === y, 'route is joined up');
    const f = { depart: 0, legs: r1.legs, to: y };
    const end = fleetPosition(g.planets, f, r1.hours * HOUR_MS + 1);
    ok(Math.hypot(end.x - g.planets[y].x, end.y - g.planets[y].y) < 1e-6, 'fleet ends at its target');
  }
}

// ---- economy
const resolve = (scen) => {
  const b = new Battle({ designs: scen.designs, ships: scen.ships, seed: scen.seed, maxTime: scen.maxTime });
  b.run();
  return readBattle(b, scen);
};
{
  const w = createWorld({ players: [{ name: 'Ann', team: 'A' }, { name: 'Bo', team: 'A' }, { name: 'Cy' }], seed: 5 });
  ok(allied(w, 0, 1) && !allied(w, 0, 2) && !allied(w, 2, null), 'teams make allies');
  const home = w.players[0].home, P = w.planets[home];
  ok(P.owner === 0 && P.income === HOME_INCOME, 'player starts on their home world');
  ok(w.planets.filter((p) => p.owner === null).every((p) => p.garrison.length > 0), 'unclaimed worlds have militia');
  advanceTo(w, 2 * HOUR_MS);
  ok(Math.abs(w.players[0].credits - (STARTING_CREDITS + 2 * HOME_INCOME)) < 1e-6, 'income accrues per hour');

  const corv = { ...makeDesign('corvette', 9), name: 'Picket' }, dest = { ...makeDesign('destroyer', 4), name: 'Lance' };
  const q1 = quoteShipyard(w, home, dest);
  ok(q1.price === shipyardPrice(dest) && q1.mult === 1, 'first shipyard costs list price');
  const before = w.players[0].credits;
  const r1 = buildShipyard(w, 0, home, dest);
  ok(r1.ok, `build shipyard: ${r1.error}`);
  ok(Math.abs(w.players[0].credits - (before - q1.price)) < 1e-6, 'shipyard paid for');
  const q2 = quoteShipyard(w, home, corv);
  ok(q2.mult > 1 && q2.price > shipyardPrice(corv), 'second shipyard on the same world costs more');
  const elsewhere = w.planets.find((p) => p.owner === null);
  ok(quoteShipyard(w, elsewhere.id, corv).mult === 1, 'crowding is per world');
  ok(!buildShipyard(w, 0, elsewhere.id, corv).ok, 'can\'t build on a world you don\'t hold');
  ok(!buildShipyard(w, 0, w.players[1].home, corv).ok, 'or on an ally\'s');
  const broke = buildShipyard(w, 2, w.players[2].home, { ...makeDesign('titan', 2), name: 'Big' });
  ok(!broke.ok && /credits/.test(broke.error), 'can\'t buy what you can\'t afford');

  // Production: one ship every 30 minutes, also across a long gap.
  advanceTo(w, w.clock + YARD_MS * 10 + 1);
  const did = r1.yard.design;
  ok(shipsAt(P, 0)[did] === 10, `shipyard built 10 ships in 5 hours (${shipsAt(P, 0)[did]})`);

  // Selling refunds half of what was paid.
  const r2 = buildShipyard(w, 0, home, corv);
  ok(r2.ok, 'second yard');
  const c0 = w.players[0].credits;
  const s = sellShipyard(w, 0, home, r2.yard.id);
  ok(s.ok && Math.abs(w.players[0].credits - c0 - Math.round(r2.yard.paid * SHIPYARD_SELL_REFUND)) < 1e-6, 'selling refunds');
  ok(P.yards.length === 1, 'sold yard is gone');

  // Fleets: send destroyers to an ally's world (they join it), then attack a militia world.
  const ally = w.players[1].home;
  const f1 = sendFleet(w, 0, home, ally, { [did]: 3 });
  ok(f1.ok, `send to ally: ${f1.error}`);
  ok(shipsAt(P, 0)[did] === 7, 'ships leave the garrison');
  ok(!sendFleet(w, 0, home, ally, { [did]: 99 }).ok, 'can\'t send ships you don\'t have');
  runWorld(w, f1.fleet.arrive, resolve);
  ok(shipsAt(w.planets[ally], 0)[did] === 3 && w.planets[ally].owner === 1, 'ships station at an ally\'s world');

  // Pick the nearest militia world and throw a big stack at it.
  advanceTo(w, w.clock + YARD_MS * 40);
  const target = w.planets.filter((p) => p.owner === null).sort((a, b) => Math.hypot(a.x - P.x, a.y - P.y) - Math.hypot(b.x - P.x, b.y - P.y))[0];
  const n = shipsAt(P, 0)[did];
  const pv = previewFleet(w, home, target.id, { [did]: n });
  ok(pv.ok && pv.hours > 0, 'route preview');
  const f2 = sendFleet(w, 0, home, target.id, { [did]: n });
  ok(f2.ok, `attack: ${f2.error}`);
  const income0 = incomeOf(w, 0);
  runWorld(w, f2.fleet.arrive, resolve);
  const last = w.log.filter((e) => e.kind === 'battle').at(-1);
  ok(last && last.battle, 'a battle was fought and logged');
  console.log(`  battle: ${last.text}`);
  if (last.battle.won) {
    ok(target.owner === 0 && incomeOf(w, 0) === income0 + target.income, 'winner takes the world and its income');
    ok(target.yards.length === 0, 'no yards survive capture');
    ok(target.garrison.every((s) => s.owner === 0), 'survivors garrison the world');
  }

  // Capture destroys enemy shipyards: Cy builds a yard at home, Ann walks into an empty home world.
  const cyHome = w.planets[w.players[2].home];
  w.players[2].credits += 1e6;
  ok(buildShipyard(w, 2, cyHome.id, corv).ok, 'Cy builds');
  cyHome.garrison = []; // nobody home
  for (const y of cyHome.yards) y.next = Infinity; // and nothing coming off the line before Ann arrives
  const src = w.planets.find((p) => p.owner === 0 && shipsAt(p, 0)[did] > 0) || P;
  advanceTo(w, w.clock + YARD_MS * 4);
  const atk = sendFleet(w, 0, src.id, cyHome.id, { [did]: Math.max(1, shipsAt(src, 0)[did]) });
  ok(atk.ok, `attack Cy: ${atk.error}`);
  runWorld(w, atk.fleet.arrive, resolve);
  ok(cyHome.owner === 0 && cyHome.yards.length === 0, 'undefended enemy world taken, its shipyards destroyed');
  ok(w.players[2].eliminated, 'Cy, with nothing left, is out');
  ok(w.winner && w.winner.includes(0) && w.winner.includes(1), 'Ann and Bo (allies) win');

  // The world survives a JSON round trip and keeps working.
  const w2 = JSON.parse(JSON.stringify(w));
  advanceTo(w2, w2.clock + HOUR_MS);
  ok(designOf(w2, did).w === dest.w, 'designs decode after a reload');
}

// ---- a beaten attack: survivors fall back, the defenders keep the world
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 8 });
  const home = w.players[0].home;
  w.players[0].credits = 1e7;
  const r = buildShipyard(w, 0, home, { ...makeDesign('frigate', 5), name: 'Scout' });
  advanceTo(w, w.clock + YARD_MS * 2 + 1);
  const P = w.planets[home];
  const target = w.planets.filter((p) => p.owner === null).sort((a, b) => b.garrison.reduce((s, g) => s + g.n, 0) - a.garrison.reduce((s, g) => s + g.n, 0))[0];
  const militia = target.garrison.reduce((s, g) => s + g.n, 0);
  const f = sendFleet(w, 0, home, target.id, { [r.yard.design]: 1 });
  ok(f.ok, 'lone scout sent');
  runWorld(w, f.fleet.arrive, resolve);
  const e = w.log.filter((x) => x.kind === 'battle').at(-1);
  console.log(`  battle: ${e.text}`);
  ok(!e.battle.won && target.owner === null, '1 frigate does not beat the militia');
  ok(target.garrison.reduce((s, g) => s + g.n, 0) <= militia, 'defender losses are applied');
  const back = w.fleets.find((x) => x.retreat);
  if (back) { runWorld(w, back.arrive, resolve); ok(shipsAt(P, 0)[r.yard.design] >= 1, 'survivors make it home'); }
}

// ---- fixed defences: a ship with no engines can't leave
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 2 });
  const d = makeDesign('battleship', 3);
  for (let i = 0; i < d.cells.length; i++) if (d.cells[i] === BT.THRUSTER) d.cells[i] = BT.ARMOR;
  w.players[0].credits = 1e7;
  const r = buildShipyard(w, 0, w.players[0].home, { ...d, name: 'Fort' });
  ok(r.ok, `fort yard ${r.error}`);
  advanceTo(w, w.clock + YARD_MS + 1);
  const speed = w.designs[r.yard.design].speed;
  console.log(`  engine-less battleship speed: ${speed.toFixed(2)}`);
  if (speed < 0.5) ok(!sendFleet(w, 0, w.players[0].home, w.players[1].home, { [r.yard.design]: 1 }).ok, 'immobile ships stay home');
}

console.log(`world: ${checks} checks passed`);
