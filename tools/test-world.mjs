// Usage: node tools/test-world.mjs
// Checks the galaxy generator, routes, economy and fleet rules, and plays a short game with real
// battles resolved by the sim.
import assert from 'node:assert/strict';
import { generateGalaxy } from '../src/world/galaxyGen.js';
import { planRoute, fleetPosition, laneMap } from '../src/world/routes.js';
import {
  createWorld, advanceTo, runWorld, buildShipyard, sellShipyard, quoteShipyard, sendFleet, previewFleet,
  shipsAt, incomeOf, allied, YARD_MS, HOLD_MS, designOf, upgradeWorld,
  proposeAlliance, acceptAlliance, breakAlliance, proposalsFor, dueEvent, siegeAt, renameDesign,
  buildDefense, planEvent, applyEvent, registerDesign,
} from '../src/world/world.js';
import { writeFileSync } from 'node:fs';
import { packReplay } from '../src/shared/replayFormat.js';
import { readBattle, makeBattleScenario, battleOptions, shipColors } from '../src/world/battleSetup.js';
import { Battle } from '../src/sim/battle.js';
import { makeDesign } from '../src/shared/designs.js';
import { makeTestScenario } from '../src/designer/testBattle.js';
import { BT } from '../src/shared/blocks.js';
import { designCost, encodeDesign, decodeDesign } from '../src/shared/shipStats.js';
import { STARTING_CREDITS, HOME_INCOME, SHIPYARD_SELL_REFUND, shipyardPrice, defensePrice } from '../src/shared/economy.js';
import { HOUR_MS, HYPERLANE_SPEEDUP, MAX_PLAYERS, PLANET_SPACING } from '../src/world/rules.js';

let checks = 0;
const countShipsT = (o) => Object.values(o).reduce((a, n) => a + n, 0);
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
    // Every home world has a lane heading inward, not only along the rim.
    for (const id of g.spawns) {
      const H = g.planets[id], R = (p) => Math.hypot(p.x, p.y);
      ok(g.lanes.some(([a, b]) => (a === id || b === id) && R(g.planets[a === id ? b : a]) < R(H) * 0.85), `${n}p seed ${seed}: home world ${id} has an inward lane`);
    }
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
let lastBattle = null;
const resolve = (scen) => {
  const b = new Battle({ designs: scen.designs, ships: scen.ships, seed: scen.seed, maxTime: scen.maxTime, ...battleOptions(scen) });
  lastBattle = { b, scen };
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
  // The owner's rule (Nov 2026): +100% for every 750,000 cr of shipyards already on the world,
  // however that value is split (one big yard or many small ones).
  {
    const fill = (design, n) => {
      const t = createWorld({ players: [{ name: 'X' }, { name: 'Y' }], seed: 3 }), h = t.players[0].home;
      t.players[0].credits = 1e15;
      for (let k = 0; k < n; k++) ok(buildShipyard(t, 0, h, design).ok, 'stack yards');
      return { t, h };
    };
    const big = { ...dest, cells: dest.cells.slice() }, list = shipyardPrice(big);
    const nBig = Math.round(750000 / list);
    const { t, h } = fill(big, nBig);
    const q = quoteShipyard(t, h, big), m = 1 + (nBig * list) / 750000;
    ok(Math.abs(q.mult - m) < 0.001, `${nBig} yards worth ${nBig * list} cr: next costs ${q.mult.toFixed(3)}× (want ${m.toFixed(3)}×)`);
    // Same value in corvette yards gives (about) the same multiplier for the next yard of any kind.
    const nSmall = Math.round((nBig * list) / shipyardPrice(corv));
    const s = fill(corv, nSmall), q2 = quoteShipyard(s.t, s.h, big);
    ok(Math.abs(q2.mult - (1 + (nSmall * shipyardPrice(corv)) / 750000)) < 0.001, 'small yards count by value too');
    ok(Math.abs(q2.mult - q.mult) < 0.02, `one kind or many: same share (${q.mult.toFixed(3)} vs ${q2.mult.toFixed(3)})`);
  }
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

  // Renaming a design: owner only, shows everywhere, survives decoding.
  ok(!renameDesign(w, 1, did, 'Stolen').ok, 'can\'t rename someone else\'s design');
  ok(!renameDesign(w, 0, did, '   ').ok, 'empty names are refused');
  const rn = renameDesign(w, 0, did, '  Ironclad\u0007 ');
  ok(rn.ok && w.designs[did].name === 'Ironclad' && designOf(w, did).name === 'Ironclad', `rename works and is tidied (${rn.name})`);

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
  runWorld(w, f2.fleet.arrive + HOLD_MS + 1, resolve);
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
  runWorld(w, atk.fleet.arrive + HOLD_MS + 1, resolve);
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
  runWorld(w, f.fleet.arrive + HOLD_MS + 1, resolve);
  const e = w.log.filter((x) => x.kind === 'battle').at(-1);
  console.log(`  battle: ${e.text}`);
  ok(!e.battle.won && target.owner === null, '1 frigate does not beat the militia');
  ok(target.garrison.reduce((s, g) => s + g.n, 0) <= militia, 'defender losses are applied');
  const back = w.fleets.find((x) => x.retreat);
  if (back) { runWorld(w, back.arrive, resolve); ok(shipsAt(P, 0)[r.yard.design] >= 1, 'survivors make it home'); }
}

// ---- fleets stop at every world on their way: defenders there can block or ambush them
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 11, planetsPerPlayer: 8 });
  const home = w.players[0].home, P = w.planets[home];
  w.players[0].credits = 1e8;
  const yard = buildShipyard(w, 0, home, { ...makeDesign('cruiser', 5), name: 'Line' });
  advanceTo(w, w.clock + YARD_MS * 60 + 1);
  const did = yard.yard.design, ships = { [did]: 10 };
  // Avoiding hostile worlds: the planner never routes through one.
  let detours = 0, tried = 0;
  for (const T of w.planets) {
    if (T.id === home) continue;
    const safe = previewFleet(w, home, T.id, ships, { owner: 0, avoid: true });
    const fast = previewFleet(w, home, T.id, ships, { owner: 0, avoid: false });
    ok(safe.ok && safe.stops.length === 0, 'avoiding: no hostile stops');
    ok(safe.hours >= fast.hours - 1e-9, 'avoiding can only take longer');
    tried++; if (fast.stops.length) detours++;
  }
  ok(detours > 0, `some fast routes run through hostile worlds (${detours}/${tried})`);
  // Send a fleet the fast way through militia worlds: it must fight at the first one.
  const T = w.planets.filter((p) => p.id !== home).map((p) => ({ p, pv: previewFleet(w, home, p.id, ships, { owner: 0, avoid: false }) }))
    .filter((x) => x.pv.stops.length).sort((a, b) => a.pv.hours - b.pv.hours)[0];
  const firstStop = T.pv.stops[0];
  const f = sendFleet(w, 0, home, T.p.id, ships, { avoid: false });
  ok(f.ok && f.fleet.legs.length > 1 && f.fleet.next < f.fleet.arrive, 'fleet has stops on the way');
  // Each stop with a fight adds a 30-minute hold, so run until the fleet is done.
  for (let k = 0; k < 40 && w.fleets.some((x) => x.id === f.fleet.id); k++) runWorld(w, w.clock + HOLD_MS, resolve);
  const fights = w.log.filter((e) => e.battle?.passing);
  ok(fights.length >= 1 && fights[0].planet === firstStop, 'stopped and fought at the first hostile world on its route');
  ok(fights[0].t - f.fleet.depart >= HOLD_MS, 'the battle waited 30 minutes after the fleet arrived');
  if (fights[0].battle.won) ok(w.planets[firstStop].owner === 0, 'winning at a world on the way takes it');
  console.log(`  ${fights[0].text}`);
  // Older saves (fleets without stops) still load and fly straight on.
  const old = JSON.parse(JSON.stringify(w));
  old.fleets.push({ id: 9999, owner: 0, ships: { [did]: 1 }, from: home, to: T.p.id, legs: T.pv.legs.map(({ from, to, lane, hours }) => ({ from, to, lane, hours })), speed: T.pv.speed, depart: old.clock, arrive: old.clock + Math.round(T.pv.hours * HOUR_MS) });
  upgradeWorld(old);
  const of = old.fleets.find((x) => x.id === 9999);
  ok(of.leg === of.legs.length - 1 && of.next === of.arrive, 'old fleets fly straight to their target');
}

// ---- allies: guests defend, allies attack together, reinforcements join during the hold
{
  const w = createWorld({ players: [{ name: 'Ann', team: 'A' }, { name: 'Bo', team: 'A' }, { name: 'Cy' }], seed: 21 });
  const [ann, bo, cy] = w.players;
  const dd = { ...makeDesign('destroyer', 8), name: 'Wall' };
  const ids = [ann, bo, cy].map((p) => { p.credits = 1e8; return buildShipyard(w, p.id, p.home, { ...dd, name: `Wall ${p.name}` }).yard.design; });
  for (const P of w.planets) for (const y of P.yards) y.next = Infinity; // ship counts set by hand below
  const boHome = w.planets[bo.home], cyHome = w.planets[cy.home];
  // A staging world next to each target, so fleets land within minutes of each other.
  const near = (T) => w.planets.filter((p) => p.id !== T.id && p.home < 0).sort((p, q) => Math.hypot(p.x - T.x, p.y - T.y) - Math.hypot(q.x - T.x, q.y - T.y))[0];
  const straight = { lanes: false, avoid: true };

  // 1. Ann stations ships at her ally Bo's world. Cy attacks; Bo rushes reinforcements in during the hold.
  boHome.garrison = [{ owner: bo.id, design: ids[1], n: 4 }, { owner: ann.id, design: ids[0], n: 10 }];
  const stage = near(boHome);
  stage.owner = cy.id; stage.garrison = [{ owner: cy.id, design: ids[2], n: 16 }];
  const relief = near(stage) === boHome ? w.planets.find((p) => p.home < 0 && p.id !== stage.id) : near(stage);
  const atk = sendFleet(w, cy.id, stage.id, bo.home, { [ids[2]]: 16 }, straight);
  ok(atk.ok, 'Cy attacks Bo');
  runWorld(w, atk.fleet.arrive, resolve);
  ok(w.sieges.length === 1 && w.sieges[0].planet === bo.home, 'arriving starts a siege, not a battle');
  ok(!w.log.some((e) => e.battle && e.planet === bo.home), 'no battle yet');
  const siege = w.sieges[0];
  // Bo's reinforcements, launched so they land 10 minutes before the battle.
  relief.owner = bo.id; relief.garrison = [{ owner: bo.id, design: ids[1], n: 6 }];
  const rp = previewFleet(w, relief.id, bo.home, { [ids[1]]: 6 }, { owner: bo.id, ...straight });
  const launchAt = siege.startsAt - 10 * 60000 - Math.round(rp.hours * HOUR_MS);
  if (launchAt < w.clock) w.clock = launchAt; // (rewinding is only safe in a test: nothing else is due)
  else runWorld(w, launchAt, resolve);
  const rf = sendFleet(w, bo.id, relief.id, bo.home, { [ids[1]]: 6 }, straight);
  ok(rf.ok && rf.fleet.arrive < siege.startsAt, 'Bo\'s reinforcements will land inside the hold');
  runWorld(w, siege.startsAt + 1, resolve);
  const b1 = w.log.filter((e) => e.battle && e.planet === bo.home).at(-1);
  ok(b1, 'the battle happens after the hold');
  ok(b1.t - atk.fleet.arrive === HOLD_MS, 'it starts exactly 30 minutes after the attackers arrived');
  ok(b1.battle.defenders.includes(ann.id) && b1.battle.defenders.includes(bo.id), 'Ann\'s stationed ships fought beside Bo');
  ok(b1.battle.ships[1] === 4 + 10 + 6, `the reinforcements were in the battle (${b1.battle.ships[1]} defenders: 4 + 10 guests + 6 arrived)`);
  ok((shipsAt(boHome, ann.id)[ids[0]] || 0) <= 10, 'Ann\'s losses come off her stationed ships');
  console.log(`  ally defence: ${b1.text}`);

  // 2. Ann and Bo attack Cy together: Bo's fleet lands during Ann's hold and joins her siege.
  cyHome.garrison = [{ owner: cy.id, design: ids[2], n: 8 }];
  const st2 = near(cyHome);
  st2.owner = ann.id; st2.garrison = [{ owner: ann.id, design: ids[0], n: 8 }, { owner: bo.id, design: ids[1], n: 8 }];
  const a2 = sendFleet(w, ann.id, st2.id, cy.home, { [ids[0]]: 8 }, straight);
  runWorld(w, w.clock + 10 * 60000, resolve);
  const b2 = sendFleet(w, bo.id, st2.id, cy.home, { [ids[1]]: 8 }, straight);
  ok(a2.ok && b2.ok, 'Ann attacks, Bo follows ten minutes later');
  runWorld(w, b2.fleet.arrive, resolve);
  const sg = w.sieges.find((s) => s.planet === cy.home);
  ok(sg && sg.leader === ann.id && sg.fleets.length === 2, 'Bo\'s fleet joined Ann\'s siege instead of starting its own');
  runWorld(w, sg.startsAt + 1, resolve);
  const b3 = w.log.filter((e) => e.battle && e.planet === cy.home).at(-1);
  ok(b3.battle.attackers.includes(ann.id) && b3.battle.attackers.includes(bo.id) && b3.battle.ships[0] === 16, 'Ann and Bo fought on the same side');
  if (b3.battle.won) ok(allied(w, cyHome.owner, ann.id) && cyHome.garrison.every((s) => s.owner === ann.id || s.owner === bo.id), 'the allies hold the world together');
  console.log(`  joint attack: ${b3.text}`);
}

// ---- owner's rules: an ally of both sides sits out; the world goes to whoever started the siege
{
  // A and C are allies; B is allied with both A and C. Cy... here: A attacks D, B is D's ally too.
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], seed: 33 });
  const [A, B, C, D] = w.players.map((p) => p.id);
  for (const [x, y] of [[A, C], [B, A], [B, D]]) { proposeAlliance(w, x, y); acceptAlliance(w, y, x); }
  ok(allied(w, A, C) && allied(w, B, A) && allied(w, B, D) && !allied(w, A, D) && !allied(w, C, D), 'A+C, B+A, B+D; A and D enemies');
  const dd = { ...makeDesign('destroyer', 8), name: 'Wall' };
  const ids = w.players.map((p) => { p.credits = 1e8; return buildShipyard(w, p.id, p.home, { ...dd, name: `Wall ${p.name}` }).yard.design; });
  for (const P of w.planets) for (const y of P.yards) y.next = Infinity;
  const T = w.planets[w.players[D].home];
  const stage = w.planets.filter((p) => p.home < 0).sort((p, q) => Math.hypot(p.x - T.x, p.y - T.y) - Math.hypot(q.x - T.x, q.y - T.y))[0];
  // D's world: D's own ships plus B's guests (B is D's ally... and A's).
  T.garrison = [{ owner: D, design: ids[D], n: 6 }, { owner: B, design: ids[B], n: 5 }];
  // A leads with a single destroyer; ally C brings the real fleet ten minutes later; B also sends ships.
  stage.owner = A; stage.garrison = [{ owner: A, design: ids[A], n: 1 }, { owner: C, design: ids[C], n: 20 }, { owner: B, design: ids[B], n: 3 }];
  const straight = { lanes: false };
  const fa = sendFleet(w, A, stage.id, T.id, { [ids[A]]: 1 }, straight);
  runWorld(w, w.clock + 10 * 60000, resolve);
  const fc = sendFleet(w, C, stage.id, T.id, { [ids[C]]: 20 }, straight);
  const fb = sendFleet(w, B, stage.id, T.id, { [ids[B]]: 3 }, straight);
  ok(fa.ok && fc.ok && fb.ok, 'A, C and B send fleets');
  runWorld(w, fc.fleet.arrive, resolve);
  const sg = w.sieges.find((x) => x.planet === T.id);
  ok(sg.leader === A && sg.fleets.length === 2, 'A leads the siege; C joins it');
  ok(shipsAt(T, B)[ids[B]] === 5 + 3, 'B, allied with D, lands as a guest at D\'s world instead of attacking');
  runWorld(w, sg.startsAt + 1, resolve);
  const bt = w.log.filter((e) => e.battle && e.planet === T.id).at(-1);
  // Free-for-all (Nov 2026): B is allied with A and D but at war with C, so B fights C (only C),
  // on the owner's side of the summary.
  ok(bt.battle.defenders.includes(B) && !bt.battle.attackers.includes(B), 'B (at war with C) fought, on D\'s side');
  ok(bt.battle.ships[1] === 6 + 8, `D's 6 and B's 8 ships were on the world's side (${bt.battle.ships[1]})`);
  ok(bt.battle.players.length === 4, 'four sides: A, C, B and D');
  if (bt.battle.won) {
    const aLived = bt.battle.players.find((q) => q.id === A).survived > 0;
    ok(T.owner === (aLived ? A : C), `the world goes to A if A's ship survived, else C (owner ${T.owner})`);
  }
  console.log(`  ${bt.text}`);
}

// ---- a neutral guest (allied with the defender and an attacker, not the leader) leaves unharmed when the world falls
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], seed: 34 });
  const [A, B, C, D] = w.players.map((p) => p.id);
  for (const [x, y] of [[A, C], [B, C], [B, D]]) { proposeAlliance(w, x, y); acceptAlliance(w, y, x); }
  ok(!allied(w, A, B) && allied(w, B, C) && allied(w, B, D), 'B is allied with C (attacker) and D (defender), not A (leader)');
  const dd = { ...makeDesign('destroyer', 8), name: 'Wall' };
  const ids = w.players.map((p) => { p.credits = 1e8; return buildShipyard(w, p.id, p.home, { ...dd, name: `Wall ${p.name}` }).yard.design; });
  for (const P of w.planets) for (const y of P.yards) y.next = Infinity;
  const T = w.planets[w.players[D].home];
  T.garrison = [{ owner: D, design: ids[D], n: 3 }, { owner: B, design: ids[B], n: 4 }];
  const stage = w.planets.filter((p) => p.home < 0).sort((p, q) => Math.hypot(p.x - T.x, p.y - T.y) - Math.hypot(q.x - T.x, q.y - T.y))[0];
  stage.owner = A; stage.garrison = [{ owner: A, design: ids[A], n: 4 }, { owner: C, design: ids[C], n: 20 }];
  const fa = sendFleet(w, A, stage.id, T.id, { [ids[A]]: 4 }, { lanes: false });
  const fc = sendFleet(w, C, stage.id, T.id, { [ids[C]]: 20 }, { lanes: false });
  ok(fa.ok && fc.ok, 'A attacks with C');
  runWorld(w, fc.fleet.arrive + HOLD_MS + 1, resolve);
  const bt = w.log.filter((e) => e.battle && e.planet === T.id).at(-1);
  // Free-for-all: B is at war with A, so B's guests fight A (and only A), on D's side.
  ok(bt.battle.ships[1] === 3 + 4 && bt.battle.defenders.includes(B), 'B\'s guests fought A, on D\'s side');
  if (bt.battle.won) {
    const aLived = bt.battle.players.find((q) => q.id === A).survived > 0;
    ok(T.owner === (aLived ? A : C), 'A takes the world if A survived, else C');
    if (T.owner === A) ok(!shipsAt(T, B)[ids[B]], 'B\'s survivors leave (B is at war with the new owner)');
    else ok(!w.fleets.some((f) => f.owner === B && !f.retreat) , 'B (allied with C) is not driven off by C');
  }
  console.log(`  neutral guest: ${bt.text}`);
}

// ---- diplomacy: alliances form and break during the game
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], seed: 4 });
  ok(!allied(w, 0, 1), 'no teams: everyone starts as enemies');
  ok(proposeAlliance(w, 0, 1).ok && proposalsFor(w, 1).length === 1 && !allied(w, 0, 1), 'a proposal waits for an answer');
  ok(acceptAlliance(w, 1, 0).ok && allied(w, 0, 1) && allied(w, 1, 0), 'accepting makes them allies');
  ok(!allied(w, 0, 2) && !allied(w, 1, 2), 'alliances are per pair');
  ok(proposeAlliance(w, 1, 2).ok && proposeAlliance(w, 2, 1).allied, 'proposing back counts as accepting');
  ok(allied(w, 1, 2) && !allied(w, 0, 2), 'not transitive: A and C are still enemies');
  // A stations ships at B's world, then B breaks the alliance: they go home.
  const d = Object.keys(w.designs)[0];
  w.planets[w.players[1].home].garrison.push({ owner: 0, design: d, n: 3 });
  ok(breakAlliance(w, 1, 0).ok && !allied(w, 0, 1), 'either side can break an alliance');
  ok(!shipsAt(w.planets[w.players[1].home], 0)[d], 'guests leave the new enemy\'s world');
  ok(w.fleets.some((f) => f.owner === 0 && f.retreat), 'and fly home');
  ok(!breakAlliance(w, 1, 0).ok, 'can\'t break what isn\'t there');
  // Everyone allied with everyone left = victory.
  proposeAlliance(w, 0, 1); acceptAlliance(w, 1, 0);
  proposeAlliance(w, 0, 2); acceptAlliance(w, 2, 0);
  ok(w.winner === null, 'nobody wins while everyone is still in, even all allied');
  // A siege dissolves if the two sides make peace during the hold.
  const w2 = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 5 });
  w2.players[0].credits = 1e8;
  const y = buildShipyard(w2, 0, w2.players[0].home, { ...makeDesign('frigate', 3), name: 'F' });
  advanceTo(w2, w2.clock + YARD_MS * 4 + 1);
  w2.planets[w2.players[1].home].garrison = [{ owner: 1, design: y.yard.design, n: 1 }];
  const f = sendFleet(w2, 0, w2.players[0].home, w2.players[1].home, { [y.yard.design]: 4 }, { avoid: true });
  runWorld(w2, f.fleet.arrive, resolve);
  ok(w2.sieges.length === 1, 'siege started');
  proposeAlliance(w2, 1, 0); acceptAlliance(w2, 0, 1);
  runWorld(w2, w2.clock + HOLD_MS + 1, resolve);
  ok(!w2.log.some((e) => e.battle), 'peace during the hold: no battle');
  ok(shipsAt(w2.planets[w2.players[1].home], 0)[y.yard.design] === 4, 'the fleet stays as a guest of its new ally');
  ok(w2.winner === null, 'nobody wins while nobody has been knocked out');
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

// ---- a routed defender loses (bug: 300 vs 100 ended by rout was recorded as a defender win)
{
  const d = makeDesign('destroyer', 4);
  const scen = makeBattleScenario([{ side: 0, owner: 0, design: 'x', n: 300 }, { side: 1, owner: 1, design: 'x', n: 100 }], () => d, 7);
  const b = new Battle({ designs: scen.designs, ships: scen.ships, seed: scen.seed });
  b.run();
  const r = readBattle(b, scen);
  console.log(`  300 vs 100: ended by ${b.endReason} after ${r.seconds} s, survivors ${r.groups.map((g) => g.survived).join(' vs ')}`);
  ok(r.attackerWon, 'the big fleet wins against 100');
  if (b.endReason === 'rout') ok(r.routed[1] === 1 && r.groups[1].survived > 0, 'rout: defenders broke with ships still armed');
  const b2 = new Battle({ designs: scen.designs, ships: scen.ships.map((s) => ({ ...s, team: 1 - s.team })), seed: scen.seed });
  b2.run();
  ok(!readBattle(b2, { ...scen, groups: scen.groups.map((g) => ({ ...g, side: 1 - g.side, team: 1 - g.team })) }).attackerWon, 'a routed attacker loses');
}

// ---- free-for-all (owner, Nov 2026): ten players with a messy mixture of alliances at one world
{
  const names = ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal', 'Ivy', 'Jo'];
  const w = createWorld({ players: names.map((name) => ({ name })), seed: 77 });
  const ids = w.players.map((p) => p.id), [A, , , , , , , , , J] = ids;
  // Messy alliances (not transitive), plus Jo, who is allied with everyone and should sit it out.
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [0, 8], [8, 4], [2, 6]];
  for (const [x, y] of pairs) { proposeAlliance(w, x, y); acceptAlliance(w, y, x); }
  for (const x of ids) if (x !== J) { proposeAlliance(w, x, J); acceptAlliance(w, J, x); }
  ok(allied(w, 0, 1) && allied(w, 1, 2) && !allied(w, 0, 2), 'messy: Ann+Bo, Bo+Cy, but Ann and Cy at war');
  const des = ids.map((k) => { w.players[k].credits = 1e8; return buildShipyard(w, k, w.players[k].home, { ...makeDesign('destroyer', 10), name: `Ship ${names[k]}` }).yard.design; });
  for (const P of w.planets) for (const y of P.yards) y.next = Infinity;
  // The target: Ann's home, held by Ann; everyone else comes from one staging world at the same time.
  const T = w.planets[w.players[A].home];
  T.garrison = [{ owner: A, design: des[A], n: 12 }];
  const stage = w.planets.filter((p) => p.home < 0).sort((p, q) => Math.hypot(p.x - T.x, p.y - T.y) - Math.hypot(q.x - T.x, q.y - T.y))[0];
  stage.owner = J; stage.garrison = ids.filter((k) => k !== A).map((k) => ({ owner: k, design: des[k], n: 10 }));
  const sent = ids.filter((k) => k !== A).map((k) => sendFleet(w, k, stage.id, T.id, { [des[k]]: 10 }, { lanes: false }));
  ok(sent.every((r) => r.ok), 'nine fleets launched at Ann\'s world');
  // Players allied with Ann land in her garrison; everyone else joins ONE siege.
  runWorld(w, Math.max(...sent.map((r) => r.fleet.arrive)), resolve);
  const sieges = siegeAt(w, T.id);
  ok(sieges.length === 1, `one siege at the world (${sieges.length})`);
  const sg = sieges[0];
  const garrisoned = ids.filter((k) => k !== A && allied(w, k, A));
  ok(garrisoned.every((k) => shipsAt(T, k)[des[k]] === 10), 'Ann\'s allies landed in her garrison');
  ok(sg.fleets.length === ids.filter((k) => !allied(w, k, A)).length, 'every fleet at war with Ann is in the siege');
  runWorld(w, sg.startsAt + 1, resolve);
  const bt = w.log.filter((e) => e.battle && e.planet === T.id).at(-1)?.battle;
  ok(bt, 'one battle was fought');
  const fought = bt.players.map((q) => q.id);
  ok(!fought.includes(J), 'Jo (allied with everyone) sat it out');
  ok(fought.length === 9, `nine sides fought (${fought.length})`);
  // Allies never hurt each other: check every hit in the battle was between enemies.
  const { b: BB, scen } = lastBattle;
  ok(BB.nT === 9, 'nine sides in the engine');
  const owners = scen.owners;
  for (let a = 0; a < owners.length; a++) for (let c = 0; c < owners.length; c++)
    if (a !== c) ok(!BB.fr[(a << 4) | c] === (owners[a] !== owners[c] && !allied(w, owners[a], owners[c])), 'engine friends = allies');
  // Who holds the world follows the owner's rule.
  const holds = (q) => q.survived > 0 && !q.routed;
  const defends = (o) => o === A || allied(w, o, A);
  const kept = bt.players.some((q) => holds(q) && defends(q.id));
  let expect = A;
  if (!kept) {
    const cands = bt.players.filter((q) => holds(q) && !defends(q.id));
    expect = cands.some((q) => q.id === sg.leader) ? sg.leader : cands.sort((p, q) => q.survived - p.survived || p.id - q.id)[0]?.id ?? A;
  }
  ok(T.owner === expect, `the world went by the rule (owner ${names[T.owner]}, expected ${names[expect]})`);
  ok(!w.fleets.some((f) => f.wait === sg.id), 'nobody is left waiting in the finished siege');
  ok(!w.sieges.some((x) => x.planet === T.id) || w.sieges.find((x) => x.planet === T.id).id !== sg.id, 'the siege is over');
  // Jo's ships: untouched, either at the world (allied with the holder) or on their way.
  const joAt = shipsAt(T, J)[des[J]] || 0, joFly = w.fleets.filter((f) => f.owner === J).reduce((a, f) => a + countShipsT(f.ships), 0);
  ok(joAt + joFly === 10, `all 10 of Jo's ships are safe (${joAt} at the world, ${joFly} flying)`);
  console.log(`  free-for-all: ${w.log.filter((e) => e.battle && e.planet === T.id).at(-1).text}`);
  console.log(`  sides: ${bt.players.map((q) => `${names[q.id]} ${q.survived}/${q.ships}${q.routed ? ' (ran)' : ''}`).join(', ')}`);
  if (process.env.SAVE_REPLAY) {
    const rep = BB.toReplay(); rep.meta.colors = shipColors(scen);
    writeFileSync(process.env.SAVE_REPLAY, packReplay(rep.meta, rep.cols));
    writeFileSync(process.env.SAVE_REPLAY + '.json', JSON.stringify({ teams: owners.map((o) => names[o]) }));
  }
}

// ---- defences: built outright at a fifth of the price, no thrusters, never move, lost with the world
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 12 });
  const A = 0, B = 1, aHome = w.planets[w.players[A].home], bHome = w.planets[w.players[B].home];
  const noThrust = (d) => ({ ...d, cells: d.cells.map((t) => (t === BT.THRUSTER ? BT.ARMOR : t)) });
  const ship = { ...makeDesign('cruiser', 21), name: 'Bastion' }, fort = { ...noThrust(ship), name: 'Bastion fort' };
  ok(defensePrice(fort) === Math.round(designCost(fort) / 5), 'a defence costs a fifth of its blocks');
  const c0 = w.players[A].credits = 1e6;
  ok(!buildDefense(w, A, aHome.id, ship, 1).ok, 'a design with thrusters can\'t be a defence');
  ok(!buildDefense(w, A, bHome.id, fort, 1).ok, 'only on your own worlds');
  ok(!buildDefense(w, A, aHome.id, fort, 0).ok && !buildDefense(w, A, aHome.id, fort, 2.5).ok, 'whole numbers only');
  const r = buildDefense(w, A, aHome.id, fort, 12);
  ok(r.ok && shipsAt(aHome, A)[r.design] === 12, `12 defences built at once (${r.error})`);
  ok(Math.abs(w.players[A].credits - (c0 - 12 * defensePrice(fort))) < 1e-6, 'paid once, at a fifth of the price');
  ok(w.designs[r.design].fixed && w.designs[r.design].speed === 0 && w.designs[r.design].cost === defensePrice(fort), 'stored as a defence, valued at what it cost');
  ok(buildDefense(w, A, aHome.id, fort, 3).design === r.design && shipsAt(aHome, A)[r.design] === 15, 'more of the same defence stack up');
  const near = w.planets.find((p) => p.owner === null);
  const sent = sendFleet(w, A, aHome.id, near.id, { [r.design]: 1 });
  ok(!sent.ok && /defence/.test(sent.error), 'defences can\'t be sent anywhere');
  w.designs[r.design].cost = 1; upgradeWorld(w);
  ok(w.designs[r.design].cost === defensePrice(fort), 'upgradeWorld keeps defence prices at a fifth');

  // An attack on a world held only by defences: they fight from fixed spots round the world.
  w.players[B].credits = 1e7;
  const atkYard = buildShipyard(w, B, bHome.id, { ...makeDesign('destroyer', 22), name: 'Raider' });
  bHome.garrison = []; aHome.garrison = aHome.garrison.filter((g) => g.design === r.design);
  const atkId = atkYard.yard.design;
  bHome.garrison.push({ owner: B, design: atkId, n: 60 });
  const f = sendFleet(w, B, bHome.id, aHome.id, { [atkId]: 60 }, { avoid: true, lanes: false });
  ok(f.ok, `B attacks A's defences (${f.error})`);
  runWorld(w, f.fleet.arrive, resolve);
  const sg = siegeAt(w, aHome.id)[0];
  ok(sg, 'defences alone stop a fleet and start a siege');
  const plan = planEvent(w, { kind: 'siege', siege: sg });
  const fixedShips = plan.battle.ships.filter((x) => x.fixed);
  ok(fixedShips.length === 15, 'all 15 defences are in the battle as fixed');
  ok(plan.battle.ships.filter((x) => !x.fixed).every((x) => Math.hypot(x.x, x.y) > Math.max(...fixedShips.map((d) => Math.hypot(d.x, d.y)))), 'fleets start outside the ring of defences');
  const before = fixedShips.map((x) => [x.x, x.y]);
  runWorld(w, sg.startsAt + 1, resolve);
  const fx = lastBattle.b.byId.filter((e) => e.fixed);
  ok(fx.every((e, k) => Math.hypot(e.x - before[k][0], e.y - before[k][1]) < 1e-9), 'defences never moved in the battle');
  const e = w.log.filter((x) => x.battle).at(-1);
  console.log(`  defences: ${e.text}`);
  const left = shipsAt(aHome, A)[r.design] || 0;
  if (aHome.owner === A) ok(left === e.battle.players.find((q) => q.id === A).survived, 'destroyed defences are gone, survivors stay');
  else {
    ok(left === 0 && !w.fleets.some((x) => x.owner === A), 'world lost: its defences are destroyed, none fly home');
    const survivors = e.battle.players.find((q) => q.id === A).survived;
    ok(!survivors || /defences? destroyed/.test(e.text), 'the log says any surviving defences were destroyed');
  }
}

// ---- a world that falls takes its surviving defences with it (its side routed with defences standing)
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 13 });
  const P = w.planets[w.players[0].home], bHome = w.planets[w.players[1].home];
  w.players[0].credits = 1e6; w.players[1].credits = 1e7;
  const fort = { ...makeDesign('frigate', 3), name: 'Picket fort' };
  fort.cells = fort.cells.map((t) => (t === BT.THRUSTER ? BT.ARMOR : t));
  const r = buildDefense(w, 0, P.id, fort, 4);
  P.garrison = P.garrison.filter((g) => g.design === r.design);
  const y = buildShipyard(w, 1, bHome.id, { ...makeDesign('destroyer', 8), name: 'Hammer' });
  bHome.garrison = [{ owner: 1, design: y.yard.design, n: 5 }];
  const f = sendFleet(w, 1, bHome.id, P.id, { [y.yard.design]: 5 }, { avoid: true, lanes: false });
  runWorld(w, f.fleet.arrive, resolve);
  const sg = siegeAt(w, P.id)[0];
  const plan = planEvent(w, { kind: 'siege', siege: sg });
  // Everyone survives, but A's side broke and ran: B takes the world.
  const teamA = plan.battle.owners.indexOf(0);
  const result = { routed: plan.battle.owners.map((o, t) => (t === teamA ? 1 : 0)), groups: plan.battle.groups.map((g) => ({ ...g, survived: g.n })), seconds: 60 };
  w.clock = sg.startsAt;
  applyEvent(w, { kind: 'siege', siege: sg }, plan, result);
  ok(P.owner === 1, 'B takes the world when A routs');
  ok(!(shipsAt(P, 0)[r.design] > 0) && !w.fleets.some((x) => x.owner === 0), 'A\'s surviving defences are destroyed, not sent home');
  ok(/4 defences destroyed/.test(w.log.filter((e) => e.battle).at(-1).text), 'the log counts the destroyed defences');
}

// ---- a fleet only passing a siege world stops only if someone there is its enemy; old saves merge sieges
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], seed: 9 });
  const fake = { id: 900, planet: 3, leader: 0, fleets: [], startsAt: 5000, against: null };
  w.sieges.push({ ...fake }, { ...fake, id: 901, leader: 1, startsAt: 4000 });
  upgradeWorld(w);
  ok(w.sieges.filter((x) => x.planet === 3).length === 1 && w.sieges[0].id === 901, 'old saves: two sieges at one world merge into the earliest');
}

// ---- start positions (owner, Nov 2026): picked per design, Auto = as before
{
  const base = makeDesign('destroyer', 5);
  const old = encodeDesign(base);
  ok(!('place' in old), 'a design on Auto encodes exactly as before (no place field)');
  ok(decodeDesign(old).place === 'auto', 'designs saved before start positions load as Auto');
  ok(decodeDesign({ ...old, place: 'sideways' }).place === 'auto', 'an unknown start position loads as Auto');
  ok(decodeDesign(encodeDesign({ ...base, place: 'top' })).place === 'top', 'a start position survives saving');
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 4 });
  const id1 = registerDesign(w, 0, decodeDesign(old)), id2 = registerDesign(w, 0, { ...decodeDesign(old), place: 'back' });
  ok(id1 !== id2 && registerDesign(w, 0, { ...decodeDesign(old), place: 'back' }) === id2, 'the same ship with another start position is its own design');
  ok(designOf(w, id2).place === 'back', 'world designs keep their start position');
  // Placement: side 0 attacks from the left facing right (its top wing is −y); side 1 holds the world
  // facing left (top wing +y); side 1's defences face left too.
  const places = ['auto', 'front', 'middle', 'back', 'top', 'bottom'], ds = {};
  const noThr = base.cells.map((c) => (c === BT.THRUSTER ? BT.ARMOR : c));
  for (const p of places) { ds[`s${p}`] = { ...base, place: p }; ds[`f${p}`] = { ...base, cells: noThr, place: p }; }
  const groups = [];
  for (const side of [0, 1]) for (const p of places) groups.push({ side, design: `s${p}`, n: 10 });
  for (const p of places) groups.push({ side: 1, design: `f${p}`, n: 6, fixed: true });
  const sc = makeBattleScenario(groups, (id) => ds[id], 3);
  const avg = (side, d, f) => { const g = sc.groups.find((x) => x.side === side && x.design === d); const s = sc.ships.slice(g.start, g.start + g.n); return s.reduce((t, x) => t + f(x), 0) / s.length; };
  const toEnemy = (side) => (side === 0 ? (s) => s.x : (s) => -s.x), topY = (side) => (side === 0 ? (s) => -s.y : (s) => s.y);
  for (const side of [0, 1]) {
    const f = (p) => avg(side, `s${p}`, toEnemy(side)), t = (p) => avg(side, `s${p}`, topY(side));
    ok(f('front') > f('auto') + 40 && f('auto') > f('back') + 60, `side ${side}: Front ships start nearest the enemy, Back ones furthest`);
    ok(t('top') > 150 && t('bottom') < -150 && Math.abs(t('auto')) < 80, `side ${side}: flank ships start out on their own wing`);
  }
  const fx = (p) => avg(1, `f${p}`, (s) => -s.x), fy = (p) => avg(1, `f${p}`, (s) => s.y);
  ok(fx('front') > fx('back') + 20, 'Front defences stand in front of Back ones');
  ok(fy('top') > 120 && fy('bottom') < -120, 'flank defences stand in their own block out on that wing');
  const all = sc.ships;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
    if (all[i].fixed && all[j].fixed) ok(Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y) > 8, 'defences never start inside each other');
}

// ---- rout goes by value, not ship count (owner, Nov 2026): a cheap swarm dying fast mustn't make the big ships run
{
  const small = { ...makeDesign('corvette', 4), stance: 'line' }, big = { ...makeDesign('battleship', 5), stance: 'line' };
  const scen = makeTestScenario(small, 80, null, 1, false, [{ design: big, count: 20, fixed: false }]);
  const b = new Battle({ designs: scen.designs, ships: scen.ships, seed: 1, maxTime: 480 });
  let ranWith = -1;
  while (!b.done) {
    b.step();
    if (ranWith < 0 && b.routedTeams[0]) ranWith = b.armedWorth[0] / b.teamStartWorth[0];
  }
  ok(ranWith < 0 || ranWith < 0.2, `a side only runs once under 20% of its value is still armed (ran with ${(ranWith * 100).toFixed(0)}%)`);
  ok(b.teamStartWorth[0] > 0 && b.armedWorth.length === b.nT, 'the battle tracks each side\'s value');
}

console.log(`world: ${checks} checks passed`);
