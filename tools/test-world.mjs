// Usage: node tools/test-world.mjs
// Checks the galaxy generator, routes, economy and fleet rules, and plays a short game with real
// battles resolved by the sim.
import assert from 'node:assert/strict';
import { generateGalaxy } from '../src/world/galaxyGen.js';
import { planRoute, fleetPosition, laneMap, laneSpeed, travelSpeed } from '../src/world/routes.js';
import {
  createWorld as createAutoWorld, advanceTo, runWorld, buildShipyard, sellShipyard, quoteShipyard, sendFleet, previewFleet,
  shipsAt, incomeOf, allied, YARD_MS, HOLD_MS, designOf, upgradeWorld,
  proposeAlliance, acceptAlliance, breakAlliance, proposalsFor, dueEvent, siegeAt, renameDesign, renamePlanet,
  buildDefense, setLayout, saveBlueprint, deleteBlueprint, planEvent, applyEvent, registerDesign, cancelSale, jobsAt, payBounties, giveCredits, worthOf, fleetValue, stopFleet, setRally, rallyAll,
  checkWin, nextHop, pinned, togetherDraw, setDesignOrders, dispatchAll, holdReason, addShips, setDestination, destinationAll, countShips, makeBot, fleetSpeed, retreatPlan, addLane, addLatePlayer, lateSpotProblem, MAX_SEATS,
} from '../src/world/world.js';
import { writeFileSync } from 'node:fs';
import { packReplay } from '../src/shared/replayFormat.js';
import { readBattle, makeBattleScenario, battleOptions, shipColors, fleetSpots } from '../src/world/battleSetup.js';
import { mulberry32 } from '../src/shared/rng.js';
import { Battle } from '../src/sim/battle.js';
import { makeDesign } from '../src/shared/designs.js';
import { makeTestScenario } from '../src/designer/testBattle.js';
import { BT } from '../src/shared/blocks.js';
import { designCost, encodeDesign, decodeDesign } from '../src/shared/shipStats.js';
import { STARTING_CREDITS, HOME_INCOME, SHIPYARD_SELL_REFUND, SHIPYARD_CROWDING_VALUE, SHIPS_PER_BUILD, BOUNTY_SHARE, shipyardPrice, defensePrice, SELL_HOURS, SELL_GAP_HOURS, DEFENSE_BUILD_HOURS } from '../src/shared/economy.js';
import { HOUR_MS, HYPERLANE_SPEEDUP, MAX_PLAYERS, PLANET_SPACING } from '../src/world/rules.js';

// The 1.0 tests below drive fleets by hand (sieges, captures, bounties and so on all still apply in
// 2.0), so they use a world with the fleet brain off. The 2.0 tests at the end use createAutoWorld.
const createWorld = (o) => Object.assign(createAutoWorld(o), { auto: false });

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
  ok(Math.abs(lane.hours - d / laneSpeed(5)) < 1e-9 && lane.legs[0].lane, 'hyperlane at lane speed');
  // 2.0: a typical destroyer is exactly 10× faster on a lane; twice the speed is only 40% faster there.
  const ref = travelSpeed(7.7);
  ok(Math.abs(laneSpeed(ref) / ref - HYPERLANE_SPEEDUP) < 1e-9, 'reference ship: lanes 10× faster');
  ok(Math.abs(laneSpeed(2 * ref) / laneSpeed(ref) - 1.4) < 1e-9, 'twice as fast is 40% faster on a lane');
  ok(Math.abs(travelSpeed(2 * 7.7) / ref - 2) < 1e-9, 'normal space still at full speed');
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
  // The owner's rule (Nov 2026): +100% for every SHIPYARD_CROWDING_VALUE cr (2.0: 325,000) of shipyards already on the world,
  // however that value is split (one big yard or many small ones).
  {
    const fill = (design, n) => {
      const t = createWorld({ players: [{ name: 'X' }, { name: 'Y' }], seed: 3 }), h = t.players[0].home;
      t.players[0].credits = 1e15;
      for (let k = 0; k < n; k++) ok(buildShipyard(t, 0, h, design).ok, 'stack yards');
      return { t, h };
    };
    const big = { ...dest, cells: dest.cells.slice() }, list = shipyardPrice(big);
    const nBig = Math.round(SHIPYARD_CROWDING_VALUE / list);
    const { t, h } = fill(big, nBig);
    const q = quoteShipyard(t, h, big), m = 1 + (nBig * list) / SHIPYARD_CROWDING_VALUE;
    ok(Math.abs(q.mult - m) < 0.001, `${nBig} yards worth ${nBig * list} cr: next costs ${q.mult.toFixed(3)}× (want ${m.toFixed(3)}×)`);
    // Same value in corvette yards gives (about) the same multiplier for the next yard of any kind.
    const nSmall = Math.round((nBig * list) / shipyardPrice(corv));
    const s = fill(corv, nSmall), q2 = quoteShipyard(s.t, s.h, big);
    ok(Math.abs(q2.mult - (1 + (nSmall * shipyardPrice(corv)) / SHIPYARD_CROWDING_VALUE)) < 0.001, 'small yards count by value too');
    ok(Math.abs(q2.mult - q.mult) < 0.02, `one kind or many: same share (${q.mult.toFixed(3)} vs ${q2.mult.toFixed(3)})`);
  }
  ok(!buildShipyard(w, 0, elsewhere.id, corv).ok, 'can\'t build on a world you don\'t hold');
  ok(!buildShipyard(w, 0, w.players[1].home, corv).ok, 'or on an ally\'s');
  const broke = buildShipyard(w, 2, w.players[2].home, { ...makeDesign('titan', 2), name: 'Big' });
  ok(!broke.ok && /credits/.test(broke.error), 'can\'t buy what you can\'t afford');

  // Production (2.0): SHIPS_PER_BUILD ships every interval, also across a long gap.
  advanceTo(w, w.clock + YARD_MS * 2 + 1);
  const did = r1.yard.design;
  ok(shipsAt(P, 0)[did] === 2 * SHIPS_PER_BUILD, `shipyard built ${2 * SHIPS_PER_BUILD} ships in 2 intervals (${shipsAt(P, 0)[did]})`);

  // Selling takes SELL_HOURS: the yard stops building at once and pays SHIPYARD_SELL_REFUND at the end.
  const r2 = buildShipyard(w, 0, home, corv);
  ok(r2.ok, 'second yard');
  ok(r2.yard.next === r1.yard.next, '2.0: a new shipyard joins its world\'s build clock');
  const s = sellShipyard(w, 0, home, r2.yard.id);
  ok(s.ok && P.yards.length === 2 && r2.yard.sellAt === w.clock + SELL_HOURS * HOUR_MS, 'a sale starts and the yard stays until it\'s done');
  ok(!sellShipyard(w, 0, home, r2.yard.id).ok, 'can\'t sell a yard twice');
  const builtAtSale = r2.yard.built, c0 = w.players[0].credits, inc = incomeOf(w, 0);
  const t0 = w.clock;
  runWorld(w, r2.yard.sellAt - 1, resolve);
  ok(P.yards.length === 2 && r2.yard.built === builtAtSale, 'a yard being sold builds nothing and is still there just before the end');
  runWorld(w, s.done, resolve);
  const earned = (inc * (w.clock - t0)) / HOUR_MS;
  ok(P.yards.length === 1 && Math.abs(w.players[0].credits - c0 - earned - Math.round(r2.yard.paid * SHIPYARD_SELL_REFUND)) < 1e-3, 'the sale pays out when the time is up and the yard is gone');
  ok(!w.jobs.length, 'the sale job is finished');
  ok(SHIPYARD_SELL_REFUND === 1 && w.log.at(-1).text.includes(`for ${r2.yard.paid.toLocaleString()} cr`), 'owner, 25 Nov 2026: a sale pays back the full price');
  // One sale every SELL_GAP_HOURS per player, counted from when the sale started (owner, 25 Nov 2026).
  const keep = P.yards[0];
  const early2 = sellShipyard(w, 0, home, keep.id);
  ok(!early2.ok && new RegExp(`one shipyard every ${SELL_GAP_HOURS} hours`).test(early2.error) && keep.sellAt === undefined, `a second sale straight after is refused (${early2.error})`);
  runWorld(w, s.job.started + SELL_GAP_HOURS * HOUR_MS - 60000, resolve);
  ok(!sellShipyard(w, 0, home, keep.id).ok, 'and still a minute before the gap is up');
  runWorld(w, s.job.started + SELL_GAP_HOURS * HOUR_MS, resolve);
  // Calling a sale off: it builds again, a full interval later, no refund comes, and the turn comes back.
  ok(sellShipyard(w, 0, home, keep.id).ok && cancelSale(w, 0, home, keep.id).ok, 'a sale can be called off once the gap is up');
  ok(!(w.players[0].sellReady > w.clock), 'calling it off gives the sale back');
  ok(keep.sellAt === undefined && keep.next === w.clock + YARD_MS && !w.jobs.length, 'the kept yard builds again');
  ok(!cancelSale(w, 0, home, keep.id).ok, 'nothing to call off now');
  ok(sellShipyard(w, 0, home, keep.id).ok && cancelSale(w, 0, home, keep.id).ok, 'so another sale can start at once');
  ok(!sellShipyard(w, 1, home, keep.id).ok && !cancelSale(w, 1, home, keep.id).ok, 'can\'t sell or keep another player\'s yard');
  // The other yard kept building during those 5 hours: put its stack back to 10 for the fleet checks below.
  P.garrison.find((g) => g.owner === 0 && g.design === did).n = 10;

  // Renaming a design: owner only, shows everywhere, survives decoding.
  ok(!renameDesign(w, 1, did, 'Stolen').ok, 'can\'t rename someone else\'s design');
  ok(!renameDesign(w, 0, did, '   ').ok, 'empty names are refused');
  const rn = renameDesign(w, 0, did, '  Ironclad\u0007 ');
  ok(rn.ok && w.designs[did].name === 'Ironclad' && designOf(w, did).name === 'Ironclad', `rename works and is tidied (${rn.name})`);

  // Renaming a world: only the holder, tidied, no clashing names.
  const otherP = w.planets.find((Q) => Q.id !== home && Q.owner !== 0);
  ok(!renamePlanet(w, 1, home, 'Stolen').ok && !renamePlanet(w, 0, otherP.id, 'Mine Now').ok, 'can\'t rename a world you don\'t hold');
  ok(!renamePlanet(w, 0, home, ' \u0007 ').ok, 'empty world names are refused');
  ok(!renamePlanet(w, 0, home, otherP.name.toUpperCase()).ok, 'a world can\'t take another world\'s name');
  const rp = renamePlanet(w, 0, home, '  New   Haven\u0007 and a very long tail ');
  ok(rp.ok && P.name === 'New Haven and a very lon' && w.log.at(-1).text.includes('renamed the world'), `world rename works and is tidied (${rp.name})`);

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
  // Victory needs every world held by one alliance: hand Ann and Bo the rest of the galaxy first.
  for (const p of w.planets) if (p !== cyHome && p.owner === null) { p.owner = 1; p.garrison = p.garrison.filter((s) => s.owner !== null); }
  ok(w.winner === null, 'no winner while Cy still holds a world');
  runWorld(w, atk.fleet.arrive + HOLD_MS + 1, resolve);
  ok(cyHome.owner === 0 && cyHome.yards.length === 0, 'undefended enemy world taken, its shipyards destroyed');
  ok(w.players[2].eliminated, 'Cy, with nothing left, is out');
  ok(w.winner && w.winner.includes(0) && w.winner.includes(1), 'Ann and Bo (allies) win');

  // End-of-game stats (16 Nov 2026): frozen at the moment of victory, and rebuilt for old saves.
  {
    const F = w.final;
    ok(F && F.winners.includes(0) && F.standings.length === 3, 'victory freezes the final standings');
    ok(F.standings[0].winner && F.standings[2].id === 2 && F.standings[2].eliminated, 'winners first, the knocked-out player last');
    ok([0, 1].includes(F.throne) && F.standings.find((r) => r.id === F.throne).worlds === Math.max(...F.standings.filter((r) => r.winner).map((r) => r.worlds)), 'throne goes to the winner with the most worlds');
    const ann = F.standings.find((r) => r.id === 0);
    ok(ann.battles >= 1 && ann.taken >= 2 && ann.built >= 1 && ann.earned > 0, `Ann's stats add up (${JSON.stringify({ b: ann.battles, t: ann.taken, built: ann.built, e: ann.earned })})`);
    ok(F.battles >= 1 && F.biggest && F.biggest.ships > 0, 'biggest battle recorded');
    const frozen = JSON.stringify(F);
    advanceTo(w, w.clock + HOUR_MS);
    ok(JSON.stringify(w.final) === frozen && w.stats.p[0].earned > ann.income_earned, 'play carries on after victory; the card stays as it was');
    const old = JSON.parse(JSON.stringify(w));
    delete old.stats; delete old.final;
    upgradeWorld(old);
    const o = old.final.standings.find((r) => r.id === 0);
    ok(old.stats.backfilled && o.battles === w.stats.p[0].battles && o.taken === w.stats.p[0].taken, 'an old save rebuilds battles and captures from the log');
    ok(Math.abs(o.income_earned - w.stats.p[0].earned) / w.stats.p[0].earned < 0.02, `income rebuilt from who held each world (${o.income_earned} vs ${Math.round(w.stats.p[0].earned)})`);
  }

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

// ---- calling off a multi-world trip (owner, 11 Nov 2026): the fleet still reaches its next stop, then stops there
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 11, planetsPerPlayer: 8 });
  const home = w.players[0].home;
  w.players[0].credits = 1e8;
  const yard = buildShipyard(w, 0, home, { ...makeDesign('cruiser', 5), name: 'Line' });
  advanceTo(w, w.clock + YARD_MS * 10 + 1);
  const did = yard.yard.design;
  // Give A every world but B's home, emptied of militia, so the trip just flies through.
  for (const P of w.planets) if (P.owner === null) { P.owner = 0; P.garrison = []; }
  const far = w.planets.filter((p) => p.owner === 0 && p.id !== home)
    .map((p) => ({ p, pv: previewFleet(w, home, p.id, { [did]: 2 }, { owner: 0 }) }))
    .sort((a, b) => b.pv.legs.length - a.pv.legs.length)[0];
  ok(far.pv.legs.length >= 3, `a trip through several worlds (${far.pv.legs.length} legs)`);
  const r = sendFleet(w, 0, home, far.p.id, { [did]: 2 }), f = r.fleet;
  const firstStop = f.legs[0].to, firstAt = f.legs[0].at;
  ok(!stopFleet(w, 1, f.id).ok, 'only the owner can call off a trip');
  const s = stopFleet(w, 0, f.id);
  ok(s.ok && s.stop === firstStop && f.to === firstStop && f.legs.length === 1 && f.arrive === firstAt, 'called off: it now ends at its next stop, on time');
  ok(!stopFleet(w, 0, f.id).ok, 'nothing left to call off on the last leg');
  const before = shipsAt(w.planets[firstStop], 0)[did] || 0;
  runWorld(w, firstAt + 1, null);
  ok(!w.fleets.includes(f) && (shipsAt(w.planets[firstStop], 0)[did] || 0) === before + 2, 'it arrives at that stop and joins the garrison');
  ok(w.log.some((e) => /called off/.test(e.text)), 'logged');
  // Mid-route: a fleet already past its first stop stops at the one it is flying to now.
  const r2 = sendFleet(w, 0, home, far.p.id, { [did]: 2 }), g = r2.fleet;
  runWorld(w, g.legs[0].at + 1, null);
  ok(g.leg === 1, 'flew past its first stop');
  const s2 = stopFleet(w, 0, g.id);
  ok(s2.ok && s2.stop === g.legs[1].to && g.legs.length === 2, 'stops at the world it is flying to now');
  // Retreating fleets can't be stopped.
  g.retreat = true; ok(!stopFleet(w, 0, g.id).ok, 'retreating fleets keep going'); g.retreat = false;
}

// ---- rally points (owner, 12 Nov 2026): new ships from a world's shipyards fly on to a friendly world
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 12, planetsPerPlayer: 8 });
  const home = w.players[0].home, bHome = w.players[1].home;
  w.players[0].credits = 1e8;
  const yard = buildShipyard(w, 0, home, { ...makeDesign('cruiser', 5), name: 'Line' });
  const did = yard.yard.design;
  for (const P of w.planets) if (P.owner === null) { P.owner = 0; P.garrison = []; }
  const mineOthers = w.planets.filter((p) => p.owner === 0 && p.id !== home);
  const T = mineOthers[0], T2 = mineOthers[1];
  ok(!setRally(w, 1, home, T.id).ok, 'only the owner sets a world\'s rally point');
  ok(!setRally(w, 0, home, home).ok, 'not to the world itself');
  ok(!setRally(w, 0, home, bHome).ok, 'not to an enemy world');
  ok(setRally(w, 0, T.id, T2.id).ok && T.rally?.to === T2.id, 'any world of yours can have one, shipyard or not');
  setRally(w, 0, T.id, null);
  ok(setRally(w, 0, home, T.id).ok && w.planets[home].rally.to === T.id, 'rally point set');
  const before = shipsAt(w.planets[home], 0)[did] || 0, fleets0 = w.fleets.length;
  runWorld(w, yard.yard.next + 1, null);
  const rf = w.fleets.filter((f) => f.rally);
  ok(rf.length === 1 && rf[0].ships[did] === SHIPS_PER_BUILD && rf[0].to === T.id && rf[0].from === home, 'the new ship leaves at once for the rally point');
  ok((shipsAt(w.planets[home], 0)[did] || 0) === before, 'ships already at the world stay');
  ok(rf[0].legs.every((l) => l.to === T.id || allied(w, w.planets[l.to].owner, 0)), 'the route only passes friendly worlds');
  const atT = shipsAt(T, 0)[did] || 0;
  runWorld(w, rf[0].arrive + 1, null);
  ok((shipsAt(T, 0)[did] || 0) >= atT + 1, 'it arrives and joins the garrison there');
  // A few build cycles at once (a long jump): one fleet with all of them.
  const n0 = w.fleets.filter((f) => f.rally).length, b0 = yard.yard.built;
  advanceTo(w, w.clock + YARD_MS * 3);
  const jump = w.fleets.filter((f) => f.rally).slice(n0);
  ok(jump.length === 1 && jump[0].ships[did] === yard.yard.built - b0, 'several ships built at once leave together');
  // Rally all my shipyard worlds here / stop.
  const y2 = buildShipyard(w, 0, T2.id, { ...makeDesign('destroyer', 6), name: 'Escort' });
  const ra = rallyAll(w, 0, mineOthers[2].id, true);
  ok(ra.ok && ra.n === 2 && w.planets[home].rally.to === mineOthers[2].id && T2.rally.to === mineOthers[2].id && !T.rally, 'rally all: every world with a shipyard points here');
  const rn = rallyAll(w, 0, mineOthers[2].id, false);
  ok(rn.n === 2 && !w.planets[home].rally && !T2.rally, 'stop rallying here clears them');
  ok(!rallyAll(w, 0, bHome, true).ok, 'rally all to an enemy world is refused');
  // Under attack: new ships stay home to defend.
  setRally(w, 0, home, T.id);
  w.sieges.push({ id: 999999, planet: home, startsAt: w.clock + YARD_MS * 10, leader: 1 });
  const k0 = w.fleets.filter((f) => f.rally).length;
  advanceTo(w, yard.yard.next + 1);
  ok(w.fleets.filter((f) => f.rally).length === k0, 'while its world is under siege, new ships stay to defend it');
  w.sieges = w.sieges.filter((sg) => sg.id !== 999999);
  // The rally point stops being friendly: cancelled at the next build, ships stay.
  T.owner = 1;
  const stay = shipsAt(w.planets[home], 0)[did] || 0;
  advanceTo(w, yard.yard.next + 1);
  ok(!w.planets[home].rally && (shipsAt(w.planets[home], 0)[did] || 0) === stay + SHIPS_PER_BUILD, 'a rally point that fell to an enemy is cancelled and the ship stays');
  ok(w.log.some((e) => /rally point at .* is cancelled/.test(e.text)), 'and that is logged');
  // An ally's world is fine.
  w.relations['0|1'] = 'ally';
  ok(setRally(w, 0, home, T.id).ok, 'an ally\'s world can be a rally point');
  // The page's own clock (online) never launches rally fleets.
  const k1 = w.fleets.length;
  advanceTo(w, yard.yard.next + 1, { rally: false });
  ok(w.fleets.length === k1, 'advanceTo(..., { rally: false }) leaves new ships home');
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

// ---- victory = one alliance holds every world (owner, 16 Nov 2026)
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], seed: 11 });
  const d = Object.keys(w.designs)[0];
  for (const p of w.planets) { p.owner = p.id % 2; p.garrison = []; }
  w.fleets.push({ id: 999, owner: 2, ships: { [d]: 5 }, from: 0, to: 1, depart: w.clock, arrive: w.clock + 1e12, legs: [], wait: 0 });
  w.planets[3].garrison.push({ owner: 3, design: d, n: 2 }); // D: a guest on a world it doesn't hold
  checkWin(w);
  ok(w.winner === null, 'two enemies hold every world between them: no winner');
  ok(proposeAlliance(w, 0, 1).ok && proposeAlliance(w, 1, 0).allied, 'A and B ally');
  ok(w.winner && w.winner.length === 2 && w.winner.includes(0) && w.winner.includes(1), 'their alliance holds every world: they win, though C still has a fleet');
  ok(!w.players[2].eliminated, 'C, with a fleet left, is not knocked out but has lost');
  ok(w.final && w.final.winners.length === 2, 'standings frozen at the win');

  const w2 = createWorld({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], seed: 12 });
  for (const p of w2.planets) { p.owner = 0; p.garrison = []; }
  w2.planets[5].owner = null; // one militia world left
  w2.planets[0].garrison.push({ owner: 1, design: Object.keys(w2.designs)[0], n: 3 }); // B: ships, no worlds
  proposeAlliance(w2, 0, 1); acceptAlliance(w2, 1, 0);
  ok(w2.winner === null, 'a militia world left: no winner');
  w2.planets[5].owner = 0;
  checkWin(w2);
  ok(w2.winner && w2.winner.includes(0) && w2.winner.includes(1) && !w2.winner.includes(2), 'every world held: A wins, and B, an ally still in the game with no worlds, shares it');
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
  ok(r.ok && !shipsAt(aHome, A)[r.design] && jobsAt(w, aHome.id, 'defence').length === 1, `12 defences ordered, not there yet (${r.error})`);
  ok(Math.abs(w.players[A].credits - (c0 - 12 * defensePrice(fort))) < 1e-6, 'paid up front, at a fifth of the price');
  ok(r.done === w.clock + DEFENSE_BUILD_HOURS * HOUR_MS, 'they take DEFENSE_BUILD_HOURS');
  runWorld(w, r.done - 1, resolve);
  ok(!shipsAt(aHome, A)[r.design], 'still building just before the time is up');
  runWorld(w, r.done, resolve);
  ok(shipsAt(aHome, A)[r.design] === 12 && !w.jobs.length && /12 Bastion fort defences are ready/.test(w.log.at(-1).text), 'finished on time, into the garrison, logged');
  ok(w.designs[r.design].fixed && w.designs[r.design].speed === 0 && w.designs[r.design].cost === defensePrice(fort), 'stored as a defence, valued at what it cost');
  const r3 = buildDefense(w, A, aHome.id, fort, 3);
  runWorld(w, r3.done, resolve);
  ok(r3.design === r.design && shipsAt(aHome, A)[r.design] === 15, 'more of the same defence stack up');
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

// ---- arranged defences (owner, 20 Nov 2026): players place and turn each defence; battles use it
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 12 });
  const A = 0, B = 1, aHome = w.planets[w.players[A].home], bHome = w.planets[w.players[B].home];
  const noThrust = (d) => ({ ...d, cells: d.cells.map((t) => (t === BT.THRUSTER ? BT.ARMOR : t)) });
  const fort = { ...noThrust(makeDesign('cruiser', 21)), name: 'Wall' };
  w.players[A].credits = 1e7;
  const r = buildDefense(w, A, aHome.id, fort, 6);
  runWorld(w, r.done, resolve);
  const D = w.designs[r.design].data, wd = decodeDesign(D);
  // Three walls side by side, touching, turned to face up; a fourth spot left empty for refills.
  const spots = [0, 1, 2, 3].map((k) => ({ d: r.design, x: -200 + k * wd.h, y: 50, a: -Math.PI / 2 }));
  ok(setLayout(w, A, aHome.id, spots).ok, 'touching defences can be arranged');
  ok(w.layouts[aHome.id].spots.length === 4 && w.layouts[aHome.id].owner === A, 'stored for the world');
  ok(!setLayout(w, A, aHome.id, [spots[0], { ...spots[1], x: spots[0].x + 2 }]).ok, 'overlapping defences are refused');
  ok(!setLayout(w, A, aHome.id, [{ ...spots[0], x: 5000 }]).ok, 'too far from the world is refused');
  ok(setLayout(w, A, aHome.id, [{ ...spots[0], x: -2500 }]).ok, 'room for fortresses well over 1,000 blocks out');
  setLayout(w, A, aHome.id, spots);
  ok(!setLayout(w, B, aHome.id, spots).ok, 'only the world\'s owner can arrange it');
  ok(!setLayout(w, A, aHome.id, [{ ...spots[0], d: 'nope' }]).ok, 'only your own defence designs');
  ok(w.layouts[aHome.id].spots.length === 4, 'refused layouts change nothing');
  // Blueprints: saved per player, loadable at any of their worlds.
  ok(saveBlueprint(w, A, 'Wall line', spots).ok && w.blueprints[A].length === 1, 'an arrangement is saved as a blueprint');
  ok(saveBlueprint(w, A, 'wall LINE', spots.slice(0, 2)).replaced && w.blueprints[A].length === 1 && w.blueprints[A][0].spots.length === 2, 'saving under the same name replaces it');
  ok(!saveBlueprint(w, B, 'Theft', spots).ok, 'only with your own defence designs');
  ok(!saveBlueprint(w, A, '  ', spots).ok, 'a blueprint needs a name');
  ok(deleteBlueprint(w, A, w.blueprints[A][0].id).ok && !w.blueprints[A], 'blueprints can be deleted');
  w.players[B].credits = 1e7;
  const atk = buildShipyard(w, B, bHome.id, { ...makeDesign('destroyer', 22), name: 'Raider' }).yard.design;
  bHome.garrison = [{ owner: B, design: atk, n: 30 }]; aHome.garrison = aHome.garrison.filter((g) => g.design === r.design);
  const f = sendFleet(w, B, bHome.id, aHome.id, { [atk]: 30 }, { avoid: true, lanes: false });
  runWorld(w, f.fleet.arrive, resolve);
  const sg = siegeAt(w, aHome.id)[0];
  const plan = planEvent(w, { kind: 'siege', siege: sg });
  const fx = plan.battle.ships.filter((x) => x.fixed);
  const at = (sp) => fx.filter((x) => Math.abs(x.x - sp.x) < 0.11 && Math.abs(x.y - sp.y) < 0.11 && Math.abs(x.a - w.layouts[aHome.id].spots[0].a) < 0.01).length;
  ok(fx.length === 6 && spots.every((sp) => at(sp) === 1), 'the first 4 of 6 walls stand exactly where they were put, turned as set');
  const extra = fx.filter((x) => !spots.some((sp) => Math.abs(x.x - sp.x) < 0.11 && Math.abs(x.y - sp.y) < 0.11));
  ok(extra.length === 2 && extra.every((x) => x.x < -200 - wd.w), 'the 2 extra walls stand in rows beyond the arranged ones, toward the attacker (left)');
  ok(plan.battle.ships.filter((x) => !x.fixed).every((x) => x.x < Math.min(...fx.map((d) => d.x)) - 20), 'attackers start clear of every defence');
  // Refill: with 2 walls left, the first 2 spots are used; the others stay empty for new ones.
  aHome.garrison.find((g) => g.design === r.design).n = 2;
  const fx2 = planEvent(w, { kind: 'siege', siege: sg }).battle.ships.filter((x) => x.fixed);
  ok(fx2.length === 2 && at.call(null, spots[0]) >= 0 && fx2.every((x, k) => Math.abs(x.x - spots[k].x) < 0.11), 'survivors take the first spots; empty ones wait to be refilled');
  ok(setLayout(w, A, aHome.id, []).ok && !w.layouts[aHome.id], 'an empty layout goes back to automatic rows');
  setLayout(w, A, aHome.id, spots);
  w.players[A].credits = 0;
  // A world that changes hands drops its owner's arrangement.
  aHome.garrison = [];
  runWorld(w, sg.startsAt + 1, resolve);
  ok(aHome.owner === B && !w.layouts[aHome.id], 'the arrangement goes with the world');
}

// ---- a world that falls takes its surviving defences with it (its side routed with defences standing)
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 13 });
  const P = w.planets[w.players[0].home], bHome = w.planets[w.players[1].home];
  w.players[0].credits = 1e6; w.players[1].credits = 1e7;
  const fort = { ...makeDesign('frigate', 3), name: 'Picket fort' };
  fort.cells = fort.cells.map((t) => (t === BT.THRUSTER ? BT.ARMOR : t));
  const r = buildDefense(w, 0, P.id, fort, 4);
  runWorld(w, r.done, resolve);
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

// ---- unfinished jobs are lost with the world: no payout for a yard being sold, no defences
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 14 });
  const P = w.planets[w.players[0].home], bHome = w.planets[w.players[1].home];
  w.players[0].credits = 1e6; w.players[1].credits = 1e7;
  const fort = { ...makeDesign('frigate', 3), name: 'Picket fort' };
  fort.cells = fort.cells.map((t) => (t === BT.THRUSTER ? BT.ARMOR : t));
  const y = buildShipyard(w, 1, bHome.id, { ...makeDesign('destroyer', 8), name: 'Hammer' });
  bHome.garrison = [{ owner: 1, design: y.yard.design, n: 30 }];
  const f = sendFleet(w, 1, bHome.id, P.id, { [y.yard.design]: 30 }, { avoid: true, lanes: false });
  runWorld(w, f.fleet.arrive, resolve);
  P.garrison = [];
  const yd = buildShipyard(w, 0, P.id, { ...makeDesign('corvette', 2), name: 'Gnat' });
  const sg = siegeAt(w, P.id)[0];
  ok(sg && yd.ok, 'siege on an empty world');
  // Under attack: started with 10 minutes to go (2.0: 5-minute jobs), defences are ready in time.
  const early = buildDefense(w, 0, P.id, fort, 1);
  ok(early.ok && early.done === w.clock + DEFENSE_BUILD_HOURS * HOUR_MS, 'a defence order is ready DEFENSE_BUILD_HOURS later');
  runWorld(w, sg.startsAt - 10 * 60000, resolve);
  const inTime = buildDefense(w, 0, P.id, fort, 2);
  ok(inTime.ok && inTime.done < sg.startsAt, 'defences ordered 10 minutes before the battle are ready for it');
  // With 2 minutes to go: A tries to sell up and throw up more defences. Neither is done in time.
  runWorld(w, sg.startsAt - 2 * 60000, resolve);
  const sold = sellShipyard(w, 0, P.id, yd.yard.id), def = buildDefense(w, 0, P.id, fort, 20);
  ok(sold.ok && def.ok && sold.done > sg.startsAt && def.done > sg.startsAt, 'both take longer than the siege');
  const credits = w.players[0].credits;
  runWorld(w, sg.startsAt + 1, resolve);
  ok(P.owner === 1, 'B takes the world');
  ok(!jobsAt(w, P.id).length && !(shipsAt(P, 0)[def.design] > 0), 'the jobs are cancelled');
  ok(!(w.players[0].sellReady > w.clock), 'a sale lost with its world gives the sale back');
  const capLog = w.log.filter((e) => e.capture).at(-1).text;
  ok(/20 unfinished defences lost/.test(capLog), `the log says the unfinished defences were lost (${capLog})`);
  const c1 = w.players[0].credits, t1 = w.clock, inc1 = incomeOf(w, 0);
  runWorld(w, def.done + HOUR_MS, resolve);
  ok(Math.abs(w.players[0].credits - c1 - (inc1 * (w.clock - t1)) / HOUR_MS) < 1e-3 && credits > 0, 'no sale payout after the world fell');
  ok(!(shipsAt(P, 0)[def.design] > 0) && !(shipsAt(P, 1)[def.design] > 0), 'and no defences appear later');
  // Old saves have no jobs list.
  delete w.jobs; upgradeWorld(w);
  ok(Array.isArray(w.jobs) && !w.jobs.length, 'upgradeWorld adds an empty jobs list');
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
    ok(t('top') > 150 && t('bottom') < -150 && Math.abs(t('auto')) < t('top') * 0.2, `side ${side}: flank ships start out on their own wing`); // Auto: relative, fleets take more room since START_GAP 50
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

// ---- fleets start spread out (owner, Nov 2026: no blob that spreads out once the battle starts)
{
  const mk = (cls, place, n, sd) => Array.from({ length: n }, () => ({ ...makeDesign(cls, sd), ...(place ? { place } : {}) }));
  const ds = [...mk('corvette', null, 80, 1), ...mk('destroyer', 'front', 40, 2), ...mk('battleship', null, 25, 3), ...mk('titan', 'back', 4, 4), ...mk('frigate', 'top', 20, 5)];
  const sp = fleetSpots(ds, mulberry32(3), 1);
  let worst = Infinity;
  for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
    const gap = Math.max(Math.abs(sp[i].depth - sp[j].depth) - (ds[i].w + ds[j].w) / 2, Math.abs(sp[i].across - sp[j].across) - (ds[i].h + ds[j].h) / 2);
    worst = Math.min(worst, gap);
  }
  ok(worst >= 20 - 1e-9, `every ship starts at least 20 blocks from the next (closest ${worst.toFixed(1)})`);
  const avg = (pl, f) => { const v = ds.map((d, i) => (d.place === pl ? f(sp[i]) : null)).filter((x) => x !== null); return v.reduce((a, b) => a + b, 0) / v.length; };
  ok(avg('front', (p) => p.depth) < avg(undefined, (p) => p.depth) && avg('back', (p) => p.depth) > avg(undefined, (p) => p.depth), 'Front ships still start in front, Back ships behind');
  ok(avg('top', (p) => p.across) > 150, 'Top flank ships still start out on their wing');
  const again = fleetSpots(ds, mulberry32(3), 1);
  ok(again.every((p, i) => p.depth === sp[i].depth && p.across === sp[i].across), 'the same battle starts the same way');
}

// ---- passing fleets take empty enemy worlds on the way (owner, 11 Nov 2026)
{
  const w = createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 5 });
  const home = w.players[0].home;
  const did = registerDesign(w, 0, { ...makeDesign('destroyer', 4), name: 'Runner' });
  w.planets[home].garrison.push({ owner: 0, design: did, n: 3 });
  // Find a target whose fastest route stops at other worlds; hand those to B with nobody home,
  // and empty the target too.
  let pick = null;
  for (const T of w.planets) {
    if (T.id === home) continue;
    const pv = previewFleet(w, home, T.id, { [did]: 3 }, { owner: 0, lanes: true, avoid: false });
    if (pv.ok && pv.legs.length >= 3) { pick = { T, via: pv.legs.slice(0, -1).map((l) => l.to) }; break; }
  }
  ok(pick, 'found a route with stops on the way');
  for (const id of [...pick.via, pick.T.id]) { w.planets[id].owner = 1; w.planets[id].garrison = []; w.planets[id].yards = []; }
  const f = sendFleet(w, 0, home, pick.T.id, { [did]: 3 }, { lanes: true, avoid: false });
  ok(f.ok, `send through empty enemy worlds: ${f.error}`);
  runWorld(w, f.fleet.arrive + (pick.via.length + 1) * (HOLD_MS + 1), resolve);
  ok(pick.via.every((id) => w.planets[id].owner === 0), `every empty enemy world on the way taken (${pick.via.map((id) => w.planets[id].owner)})`);
  ok(w.planets[pick.T.id].owner === 0 && shipsAt(w.planets[pick.T.id], 0)[did] === 3, 'and the fleet still reached its target with every ship');
  ok(pick.via.every((id) => !countShipsT(shipsAt(w.planets[id], 0))), 'it left the worlds on the way empty and flew on');
}

// ---- bounties and credit gifts (owner, Nov 2026)
{
  const w = createWorld({ players: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }, { name: 'P4' }], seed: 11 });
  proposeAlliance(w, 0, 1); acceptAlliance(w, 1, 0);
  ok(allied(w, 0, 1) && !allied(w, 0, 2) && !allied(w, 2, 3), 'bounty test: P1+P2 allied, P3 and P4 at war with everyone');
  const before = w.players.map((p) => p.credits);
  // The owner's example: P1 100k and P2 50k (allies) vs P3 200k vs P4 100k. P3 wins, losing
  // 100k; everyone else is wiped out.
  const per = [
    { id: 0, lost: 100000 }, { id: 1, lost: 50000 }, { id: 2, lost: 100000 }, { id: 3, lost: 100000 }, { id: null, lost: 0 },
  ];
  const b = payBounties(w, per);
  // (2.0: BOUNTY_SHARE 10%, was 20%; the owner's example was at 20%.)
  const B = (x) => Math.floor(x * BOUNTY_SHARE);
  ok(b[0] === B(200000) / 2 && b[1] === B(200000) / 2, `allies with no known value split ${B(200000)} evenly (${b[0]}, ${b[1]})`);
  ok(b[2] === B(250000) && b[3] === B(250000), `P3 and P4 each get ${BOUNTY_SHARE * 100}% of 250,000 (${b[2]}, ${b[3]})`);
  ok(w.players.every((p, i) => p.credits === before[i] + b[i]), 'bounties are paid into credits');
  // Owner, 25 Nov 2026: allies split by the value they brought in, not by survivors. P1 brought
  // 100k and P2 50k; P1 loses everything, P2 nothing: P1 still gets 2/3.
  const v = payBounties(w, [
    { id: 0, value: 100000, lost: 100000 }, { id: 1, value: 50000, lost: 0 }, { id: 2, value: 200000, lost: 60000 },
  ]);
  const pot = 60000 * BOUNTY_SHARE;
  ok(v[0] === Math.floor((pot * 2) / 3) && v[1] === Math.floor(pot / 3), `allies split by value brought in: 2/3 and 1/3 of ${pot} (${v[0]}, ${v[1]})`);
  ok(v[2] === B(100000), `P3 alone gets all of its share of the 100,000 its enemies lost (${v[2]})`);
  const one = payBounties(w, [{ id: 0, value: 0, lost: 0 }, { id: 1, value: 40000, lost: 0 }, { id: 2, value: 1, lost: 50000 }]);
  ok(one[0] === 0 && one[1] === B(50000), 'an ally that brought nothing gets nothing');
  // Militia losses pay too; militia is never paid.
  const m = payBounties(w, [{ id: 2, lost: 0 }, { id: null, lost: 30000 }]);
  ok(m[2] === B(30000) && !(null in m), `killing 30,000 cr of militia pays ${B(30000)}`);
  // Defences razed with the world count as lost.
  const r = payBounties(w, [{ id: 2, lost: 0 }, { id: 3, lost: 1000 }], new Map([[3, 9000]]));
  ok(r[2] === B(10000), 'defences razed after the battle count towards the bounty');
  // A defence is worth its full block price.
  const dd = { ...makeDesign('frigate', 5), name: 'Wall' };
  for (let i = 0; i < dd.cells.length; i++) if (dd.cells[i] === BT.THRUSTER) dd.cells[i] = BT.ARMOR;
  const did = registerDesign(w, 2, dd, true);
  ok(worthOf(w, did) === designCost(dd) && w.designs[did].cost === defensePrice(dd), 'defences: worth = block price, cost = build price');
  ok(fleetValue(w, { [did]: 3 }) === 3 * designCost(dd), 'hull value counts defences at block price');
  delete w.designs[did].worth; upgradeWorld(w);
  ok(w.designs[did].worth === designCost(dd), 'old saves get each design\'s worth when loaded');
  // Gifts.
  const c0 = w.players[2].credits, c1 = w.players[0].credits;
  ok(giveCredits(w, 2, 0, 1234.9).ok && w.players[2].credits === c0 - 1234 && w.players[0].credits === c1 + 1234, 'gift moves whole credits');
  ok(!giveCredits(w, 2, 0, w.players[2].credits + 1).ok, 'cannot send more than you have');
  ok(!giveCredits(w, 2, 0, 0).ok && !giveCredits(w, 2, 0, -5).ok && !giveCredits(w, 2, 0, 'x').ok, 'gift must be at least 1');
  ok(!giveCredits(w, 2, 2, 10).ok && !giveCredits(w, 2, 9, 10).ok, 'no gifts to yourself or nobody');
  ok(w.log.some((e) => e.gift && e.gift.from === 2 && e.gift.amount === 1234), 'gifts are logged');
}

// ---- 2.0: the fleet brain (owner, 18 Nov 2026)
const lanePlanHours = (W, a, b, d) => { const A = W.planets[a], B = W.planets[b]; return Math.hypot(A.x - B.x, A.y - B.y) / laneSpeed(travelSpeed(W.designs[d].speed)); };
{
  const fake = (W) => (scen) => {
    // Stand-in battle: the side worth most wins and keeps what's left after the others' worth.
    const val = {};
    for (const g of scen.groups) val[g.team] = (val[g.team] || 0) + g.n * worthOf(W, g.design);
    const teams = Object.keys(val).map(Number).sort((a, b) => val[b] - val[a] || a - b);
    const top = teams[0], rest = teams.slice(1).reduce((x, t) => x + val[t], 0), keep = Math.max(0, 1 - rest / val[top]);
    return { groups: scen.groups.map((g) => ({ ...g, survived: g.team === top ? Math.floor(g.n * keep) : 0 })), routed: [], seconds: 60 };
  };
  const lanes = (W) => laneMap(W.lanes);
  const w = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 21 });
  ok(w.auto, '2.0 worlds have the fleet brain on');
  const home = w.players[0].home, H = w.planets[home];
  w.players[0].credits = 1e7;
  const d1 = { ...makeDesign('destroyer', 3), name: 'One' }, d2 = { ...makeDesign('frigate', 4), name: 'Two' };
  const y1 = buildShipyard(w, 0, home, d1).yard, y2 = buildShipyard(w, 0, home, d2).yard;
  ok(y1.next === y2.next, 'both shipyards on a world build at the same moment');
  const nb = nextHop(w, home, 0);
  ok(nb && lanes(w).get(home).has(nb.hop) && w.planets[nb.target].owner === null, 'the nearest target along the lanes is a militia world');
  const t1 = y1.next;
  runWorld(w, t1, null);
  const out = w.fleets.filter((f) => f.owner === 0);
  ok(out.length === 1 && out[0].ships[y1.design] === SHIPS_PER_BUILD && out[0].ships[y2.design] === SHIPS_PER_BUILD, 'everything built there leaves at once, as one fleet');
  ok(out[0].legs.length === 1 && out[0].legs[0].lane && out[0].to === nb.hop && out[0].depart === t1, '…one hyperlane hop, to the nearest enemy');
  ok(!countShipsT(shipsAt(H, 0)), 'nothing is left sitting at home');
  // Destinations: any world; fleets head there along the lanes.
  const far = w.planets.filter((p) => p.owner === null).sort((a, b) => Math.hypot(b.x - H.x, b.y - H.y) - Math.hypot(a.x - H.x, a.y - H.y))[0];
  ok(!setDestination(w, 1, home, far.id).ok && !setDestination(w, 0, home, home).ok, 'only the owner sets it, and not to the world itself');
  ok(setDestination(w, 0, home, far.id).ok && H.dest.to === far.id, 'destination set');
  const toFar = nextHop(w, home, 0, far.id);
  ok(toFar && lanes(w).get(home).has(toFar.hop) && toFar.target === far.id, 'the route to it goes along the lanes');
  runWorld(w, y1.next, null);
  const f2 = w.fleets.find((f) => f.owner === 0 && f.depart === w.clock);
  ok(f2 && f2.goal === far.id && f2.to === toFar.hop, 'the next fleet heads for the destination');
  ok(setDestination(w, 0, home, null).ok && !H.dest, 'cleared');
  const mine = w.planets.filter((p) => p.owner === 0).map((p) => p.id);
  ok(destinationAll(w, 0, far.id).n === mine.length && destinationAll(w, 0, far.id, false).n === mine.length, 'send every world\'s fleets here, and stop');
  // Pinned: an enemy fleet heading here keeps new ships at home; they leave once it's gone.
  w.fleets = []; w.sieges = [];
  const bHome = w.players[1].home;
  w.planets.find((p) => p.id === nb.hop).owner = 1;
  const bd = registerDesign(w, 1, { ...makeDesign('destroyer', 9), name: 'Raider' });
  const raid = { id: 990001, owner: 1, ships: { [bd]: 3 }, from: nb.hop, to: home, legs: [{ from: nb.hop, to: home, lane: true, hours: 50, at: w.clock + 50 * HOUR_MS }], leg: 0, next: w.clock + 50 * HOUR_MS, wait: null, speed: 1, retreat: false, depart: w.clock - 1, arrive: w.clock + 50 * HOUR_MS };
  w.fleets.push(raid);
  ok(pinned(w, H, 0) && !pinned(w, H, 1), 'an enemy fleet heading here pins the world (for its owner)');
  runWorld(w, y1.next, null);
  ok(countShipsT(shipsAt(H, 0)) === 2 * SHIPS_PER_BUILD && !w.fleets.some((f) => f.owner === 0), 'new ships stay to defend it');
  const others = w.fleets.filter((f) => f !== raid);
  ok(!others.length, 'and nothing else of ours moved');
  w.fleets = w.fleets.filter((f) => f !== raid);
  dispatchAll(w);
  ok(!countShipsT(shipsAt(H, 0)) && w.fleets.some((f) => f.owner === 0), 'threat gone: they leave');
  // Retreat targets and fighting are checked in the game below; tie-break: two fleets launching at
  // each other's worlds along one lane at the same moment, the one arriving later turns back.
  {
    const t = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 22 });
    const [a, b] = t.lanes.find(([x, y]) => t.planets[x].home < 0 && t.planets[y].home < 0);
    for (const P of t.planets) { P.owner = P.id === b ? 1 : 0; P.garrison = []; }
    const fast = registerDesign(t, 0, { ...makeDesign('corvette', 3), name: 'Fast' }), slow = registerDesign(t, 1, { ...makeDesign('titan', 3), name: 'Slow' });
    ok(t.designs[fast].speed > t.designs[slow].speed, 'tie-break test: a fast fleet and a slow one');
    t.planets[a].garrison.push({ owner: 0, design: fast, n: 4 });
    t.planets[b].garrison.push({ owner: 1, design: slow, n: 4 });
    // Make each side's nearest target the other's world.
    for (const P of t.planets) if (P.id !== a && P.id !== b) P.owner = 0;
    t.planets[b].dest = { to: a, owner: 1 }; // B goes for A's world, along the same lane
    ok(nextHop(t, a, 0).hop === b && nextHop(t, b, 1, a).hop === a, 'each heads straight for the other along one lane');
    for (const first of [a, b]) {
      // Both leave at the same moment; whichever world is handled first, the result is the same.
      const tt = structuredClone(t), F = tt.planets[first], other = tt.planets[first === a ? b : a];
      const held = other.garrison; other.garrison = [];
      dispatchAll(tt);
      other.garrison = held;
      dispatchAll(tt);
      const fa = tt.fleets.filter((f) => f.owner === 0), fb = tt.fleets.filter((f) => f.owner === 1);
      ok(F && fa.length === 1 && fa[0].to === b && !fb.length && countShipsT(shipsAt(tt.planets[b], 1)) === 4, `the fast fleet goes, the slow one turns back to defend (${first === a ? 'A' : 'B'} handled first)`);
    }
  }
  // Orders are kept, and fleets that fought together split up again (owner, 18 Nov 2026).
  {
    const t = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 23 });
    const W = t.players[0].home, P = t.planets[W];
    for (const Q of t.planets) if (Q.owner === null) Q.owner = 0;
    const nb = [...lanes(t).get(W)];
    const G = nb[0], D = nb[1] ?? nb[0];
    const mine = registerDesign(t, 0, { ...makeDesign('destroyer', 5), name: 'Mine' });
    const bd = registerDesign(t, 1, { ...makeDesign('destroyer', 9), name: 'Raider' });
    P.dest = { to: D, owner: 0 };
    // A fleet heading for G passes through W while an enemy fleet is on its way to W.
    const raid = { id: 990101, owner: 1, ships: { [bd]: 3 }, from: G, to: W, legs: [{ from: G, to: W, lane: true, hours: 50, at: t.clock + 50 * HOUR_MS }], leg: 0, next: t.clock + 50 * HOUR_MS, wait: null, speed: 1, retreat: false, depart: t.clock - 1, arrive: t.clock + 50 * HOUR_MS };
    t.fleets.push(raid);
    const f = { id: 990102, owner: 0, ships: { [mine]: 4 }, from: nb.at(-1), to: W, legs: [{ from: nb.at(-1), to: W, lane: true, hours: 1, at: t.clock }], leg: 0, next: t.clock, wait: null, speed: 1, retreat: false, depart: t.clock - HOUR_MS, arrive: t.clock, goal: G };
    t.fleets.push(f);
    addShips(P, 0, mine, 5); // ships built here (no orders of their own)
    runWorld(t, t.clock, null);
    const st = P.garrison.filter((x) => x.owner === 0);
    ok(st.length === 2 && st.some((x) => x.goal === G && x.n === 4) && st.some((x) => x.goal === undefined && x.n === 5), 'a fleet that stays to defend keeps its own orders, apart from the ships built there');
    // The threat goes: they leave as two fleets, each with its own orders.
    t.fleets = t.fleets.filter((x) => x !== raid);
    dispatchAll(t);
    const out = t.fleets.filter((x) => x.owner === 0);
    ok(out.length === (G === D ? 1 : 2), `then they split up by where they're going (${out.length} fleets)`);
    ok(out.some((x) => x.goal === G && x.ships[mine] >= 4) && out.some((x) => x.goal === D && x.ships[mine] >= 5), 'the passing fleet still heads for its own goal; the new ships take the world\'s destination');
  }
  // No arriving late to a siege; after a successful defence the defender moves first (owner).
  {
    const t = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 24 });
    const [a, b] = t.lanes.find(([x, y]) => t.planets[x].home < 0 && t.planets[y].home < 0);
    for (const Q of t.planets) { Q.owner = Q.id === b ? 1 : 0; Q.garrison = []; }
    const fast = registerDesign(t, 0, { ...makeDesign('corvette', 3), name: 'Fast' }), def = registerDesign(t, 1, { ...makeDesign('destroyer', 4), name: 'Guard' });
    const hop = lanePlanHours(t, a, b, fast);
    // A siege at b by A, its battle sooner than a fresh fleet from a could get there.
    const lead = { id: 990201, owner: 0, ships: { [fast]: 2 }, from: a, to: b, legs: [{ from: a, to: b, lane: true, hours: hop, at: t.clock }], leg: 0, next: Infinity, wait: 990202, speed: 1, retreat: false, depart: t.clock - 1, arrive: t.clock };
    t.fleets.push(lead);
    t.sieges.push({ id: 990202, planet: b, leader: 0, fleets: [lead.id], startsAt: t.clock + Math.round(hop * HOUR_MS / 2), against: 1 });
    t.planets[b].garrison.push({ owner: 1, design: def, n: 10 });
    t.planets[a].garrison.push({ owner: 0, design: fast, n: 3 });
    t.planets[a].dest = { to: b, owner: 0 };
    dispatchAll(t);
    ok(countShipsT(shipsAt(t.planets[a], 0)) === 3 && holdReason(t, t.planets[a], 0, { [fast]: 3 }, b) === 'siege', 'a fleet that would arrive after the battle starts waits instead');
    const s0 = t.sieges[0];
    s0.startsAt = t.clock + Math.round(hop * HOUR_MS) + 60000;
    dispatchAll(t);
    ok(!countShipsT(shipsAt(t.planets[a], 0)) && t.fleets.some((x) => x.owner === 0 && x.from === a && x.to === b && x.wait == null), 'one that gets there in time sets off and joins');
    // Now B defends (stand-in battle: the bigger side wins) with A's next fleet waiting at a: B strikes first.
    t.fleets = t.fleets.filter((x) => x === lead); s0.startsAt = t.clock + Math.round(hop * HOUR_MS / 2);
    t.planets[a].garrison.push({ owner: 0, design: fast, n: 3 });
    delete t.planets[a].dest;
    t.planets[b].dest = { to: a, owner: 1 }; // B strikes back along the same lane
    runWorld(t, s0.startsAt, fake(t));
    ok(t.planets[b].owner === 1, 'B held its world');
    const counter = t.fleets.find((x) => x.owner === 1 && x.from === b && x.to === a);
    ok(counter && countShipsT(shipsAt(t.planets[a], 0)) === 3 && !t.fleets.some((x) => x.owner === 0 && x.from === a && !x.retreat), 'the successful defender strikes back first; A\'s waiting ships stay to meet it');
  }
  // Fleets already on their way turn back if they'd get there after the battle starts (owner).
  {
    const t = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 25 });
    const [a, b] = t.lanes.find(([x, y]) => t.planets[x].home < 0 && t.planets[y].home < 0);
    for (const Q of t.planets) { Q.owner = Q.id === b ? 1 : 0; Q.garrison = []; }
    const sh = registerDesign(t, 0, { ...makeDesign('destroyer', 3), name: 'Ship' });
    const hop = lanePlanHours(t, a, b, sh);
    const mk = (id, leftAgo, n) => { const at = t.clock - Math.round(leftAgo * HOUR_MS) + Math.round(hop * HOUR_MS); return { id, owner: 0, ships: { [sh]: n }, from: a, to: b, legs: [{ from: a, to: b, lane: true, hours: hop, at }], leg: 0, next: at, wait: null, speed: 1, retreat: false, depart: at - Math.round(hop * HOUR_MS), arrive: at, goal: null }; };
    const first = mk(990301, hop, 2); // arriving now: starts the siege
    const soon = mk(990302, hop - 1, 3); // an hour out: in time for a 3-hour hold
    const late = mk(990303, 0.25 * hop, 4); // just left: would be far too late
    t.fleets.push(first, soon, late);
    ok(HOLD_MS === 3 * HOUR_MS, 'sieges hold for 3 hours');
    const before = fleetPosition(t.planets, late, t.clock);
    runWorld(t, t.clock, null);
    const s = t.sieges[0];
    ok(s && s.planet === b && first.wait === s.id, 'the first fleet starts a siege');
    ok(soon.to === b && soon.turned == null, 'a fleet that gets there in time carries on');
    ok(late.to === a && late.turned === b, 'one that would arrive after the battle starts turns back');
    const now = fleetPosition(t.planets, late, t.clock);
    ok(Math.hypot(now.x - before.x, now.y - before.y) < 1e-3, 'it turns round where it is');
    ok(Math.abs(late.next - t.clock - 0.25 * hop * HOUR_MS) < 2, 'the way back takes as long as it had flown');
    runWorld(t, late.next, null);
    ok(!t.fleets.includes(late) && countShipsT(shipsAt(t.planets[a], 0)) === 4 && holdReason(t, t.planets[a], 0, { [sh]: 4 }) === 'siege', 'back home it waits for the battle to end');
  }
  // A fleet with no orders that would be late for a battle goes for another target only if that's
  // sooner than waiting for the battle and then going there (owner, 18 + 19 Nov 2026); one heading
  // for its own destination always waits.
  {
    const t = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 26 });
    const lm = lanes(t);
    const a = t.planets.find((P) => P.home < 0 && (lm.get(P.id)?.size || 0) >= 2).id;
    const [b, c] = [...lm.get(a)].map((id) => ({ id, d: Math.hypot(t.planets[id].x - t.planets[a].x, t.planets[id].y - t.planets[a].y) })).sort((x, y) => x.d - y.d).map((x) => x.id);
    for (const Q of t.planets) { Q.owner = Q.id === b || Q.id === c ? 1 : 0; Q.garrison = []; }
    const sh = registerDesign(t, 0, { ...makeDesign('destroyer', 3), name: 'Ship' });
    const tripH = (id) => Math.hypot(t.planets[id].x - t.planets[a].x, t.planets[id].y - t.planets[a].y) / laneSpeed(travelSpeed(fleetSpeed(t, { [sh]: 5 })));
    ok(tripH(c) < 1.9 * tripH(b) && tripH(c) > tripH(b), `redirect test map: c is a bit further than b (${tripH(b).toFixed(2)} h, ${tripH(c).toFixed(2)} h)`);
    const siege = { id: 990401, planet: b, leader: 0, fleets: [], startsAt: t.clock + 60000, against: 1 };
    t.sieges.push(siege);
    ok(nextHop(t, a, 0).hop === b, 'redirect test: the nearest target is the besieged world');
    t.planets[a].garrison.push({ owner: 0, design: sh, n: 5 });
    dispatchAll(t);
    ok(!t.fleets.length && countShipsT(shipsAt(t.planets[a], 0)) === 5 && holdReason(t, t.planets[a], 0, { [sh]: 5 }) === 'siege', 'late by a little: it waits for the battle rather than going further');
    siege.startsAt = t.clock + Math.round(0.9 * tripH(b) * HOUR_MS);
    dispatchAll(t);
    ok(t.fleets.some((f) => f.owner === 0 && f.from === a && f.to === c) && !countShipsT(shipsAt(t.planets[a], 0)), 'late by a lot: it goes for the next nearest target, which it reaches sooner');
    siege.startsAt = t.clock + 60000;
    t.fleets = [];
    t.planets[a].garrison.push({ owner: 0, design: sh, n: 5, goal: b });
    dispatchAll(t);
    ok(!t.fleets.length && countShipsT(shipsAt(t.planets[a], 0)) === 5 && holdReason(t, t.planets[a], 0, { [sh]: 5 }, b) === 'siege', 'a fleet heading for its own destination waits for the battle there');
    t.planets[c].owner = 0;
    t.planets[a].garrison = [{ owner: 0, design: sh, n: 5 }];
    dispatchAll(t);
    ok(!t.fleets.length && holdReason(t, t.planets[a], 0, { [sh]: 5 }) === 'siege', 'with nothing else in reach it waits too');
  }
  // 2.0 retreats through normal space go at half lane speed (owner, 19 Nov 2026; was 10× slower).
  {
    const t = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 26 });
    const lm = lanes(t);
    const sh = registerDesign(t, 0, { ...makeDesign('destroyer', 3), name: 'Ship' });
    const a = t.planets[0].id, far = t.planets.find((P) => P.id !== a && !lm.get(a).has(P.id)).id;
    const r = retreatPlan(t, 0, a, far, { [sh]: 5 });
    const dist = Math.hypot(t.planets[far].x - t.planets[a].x, t.planets[far].y - t.planets[a].y);
    const lane = laneSpeed(travelSpeed(fleetSpeed(t, { [sh]: 5 })));
    ok(r.ok && r.legs.length === 1 && !r.legs[0].lane && Math.abs(r.hours - dist / (lane * 0.5)) < 1e-9, 'a retreat through normal space takes twice the hyperlane time for that distance');
  }
  // Waiting for a battle, it first moves up to the friendly world next to it (owner, 19 Nov 2026).
  {
    const t = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 26 });
    const lm = lanes(t);
    let a = -1, m = -1, b = -1;
    for (const P of t.planets) for (const q of lm.get(P.id) || []) for (const r of lm.get(q) || [])
      if (a < 0 && r !== P.id && !lm.get(P.id).has(r)) { a = P.id; m = q; b = r; }
    for (const Q of t.planets) { Q.owner = Q.id === b ? 1 : 0; Q.garrison = []; }
    const sh = registerDesign(t, 0, { ...makeDesign('destroyer', 3), name: 'Ship' });
    t.sieges.push({ id: 990501, planet: b, leader: 1, fleets: [], startsAt: t.clock + 60000, against: 0 });
    t.planets[a].garrison.push({ owner: 0, design: sh, n: 5 });
    dispatchAll(t);
    const went = t.fleets.find((f) => f.owner === 0 && f.from === a);
    ok(went && went.to !== b && lm.get(went.to).has(b), 'two worlds from a battle it would miss, it moves up next to it');
    m = went.to;
    t.fleets = [];
    t.planets[a].garrison = [];
    t.planets[m].garrison = [{ owner: 0, design: sh, n: 5 }];
    dispatchAll(t);
    ok(!t.fleets.length && countShipsT(shipsAt(t.planets[m], 0)) === 5 && holdReason(t, t.planets[m], 0, { [sh]: 5 }) === 'siege', 'next to it, it waits for the battle');
  }
  // A whole game with stand-in battles: hyperlanes only, never a swap, the front moves both ways.
  {
    const g = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], seed: 5 });
    for (const pl of g.players) { pl.credits = 1e6; buildShipyard(g, pl.id, pl.home, { ...makeDesign('destroyer', 3 + pl.id), name: `D${pl.id}` }); }
    const lm = laneMap(g.lanes);
    let swaps = 0, offLane = 0, changes = 0, idle = 0, hops = 0;
    const owners0 = g.planets.map((p) => p.owner);
    let prev = owners0.slice();
    const res = fake(g);
    for (let t = 0; t <= 96 * HOUR_MS; t += HOUR_MS / 4) {
      runWorld(g, t, res);
      for (const f of g.fleets) {
        if (f.wait != null) continue;
        const L = f.legs[f.leg];
        if (!f.retreat && (!L.lane || !lm.get(L.from)?.has(L.to))) offLane++;
        if (!f.retreat) hops++;
        for (const e of g.fleets) if (e !== f && e.wait == null && !f.retreat && !e.retreat && e.owner !== f.owner && !allied(g, e.owner, f.owner)) {
          const M = e.legs[e.leg];
          if (M.from === L.to && M.to === L.from) swaps++;
        }
      }
      for (const P of g.planets) for (const x of P.garrison) {
        if (x.owner === null || g.designs[x.design].fixed || !allied(g, x.owner, P.owner)) continue;
        const goal = x.goal === undefined ? (P.dest?.to ?? null) : x.goal;
        if (!holdReason(g, P, x.owner, { [x.design]: x.n }, goal)) idle++;
      }
      g.planets.forEach((P, i) => { if (P.owner !== prev[i] && prev[i] !== null) changes++; });
      prev = g.planets.map((p) => p.owner);
    }
    ok(hops > 0 && !offLane, `fleets only move along hyperlanes (${hops} fleet-quarter-hours, ${offLane} off-lane)`);
    ok(!swaps, `no two enemy fleets ever fly past each other on a lane (${swaps})`);
    ok(!idle, `no ship sits at a world without a reason: pinned, waiting for a siege, or nothing to fight (${idle})`);
    ok(g.planets.filter((p) => p.owner === null).length < owners0.filter((o) => o === null).length / 2, 'militia worlds get taken');
    ok(changes >= 4, `player worlds change hands (${changes} times in 4 days)`);
  }

  // Turn-taking (owner, 19 Nov 2026): a world that beat off an attack can't be attacked from the same
  // world again until it attacks back (or one of them changes hands).
  {
    const g = createAutoWorld({ players: [1, 2, 3, 4].map((k) => ({ name: `Bot ${k}`, bot: true })), seed: 8 });
    const res = fake(g);
    let bad = 0, locksMade = 0, lifted = 0, prevLocks = [];
    for (let t = 0; t <= 72 * HOUR_MS; t += HOUR_MS / 12) {
      runWorld(g, t, res);
      for (const f of g.fleets) {
        const L = f.legs[f.leg];
        if (!L || f.retreat || f.wait != null || f.depart == null) continue;
        const P = g.planets[L.to];
        if (allied(g, f.owner, P.owner)) continue;
        if (g.locks.some((l) => l.from === L.from && l.to === L.to && l.by === f.owner && l.at < f.depart)) bad++;
      }
      const key = (l) => `${l.from}>${l.to}>${l.by}`;
      const now = new Set(g.locks.map(key)), was = new Set(prevLocks.map(key));
      for (const k of now) if (!was.has(k)) locksMade++;
      for (const l of prevLocks) if (!now.has(key(l)) && g.planets[l.from].owner === l.by && g.planets[l.to].owner === l.def) lifted++;
      prevLocks = g.locks.map((l) => ({ ...l }));
    }
    ok(locksMade > 5, `beaten-off attacks lock the lane (${locksMade} locks in 3 days)`);
    ok(!bad, `no fleet sets off along a locked lane (${bad})`);
    ok(lifted > 0, `a lock lifts when the defender strikes back (${lifted} times)`);
    // By hand: nextHop avoids a locked target, and capture clears the lock.
    const h = createAutoWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 21 });
    const a = h.players[0].home;
    const nb = nextHop(h, a, 0);
    h.planets[nb.target].owner = 1;
    const first = nextHop(h, a, 0);
    h.locks.push({ from: a, to: first.hop, by: 0, def: h.planets[first.hop].owner, at: 0 });
    const second = nextHop(h, a, 0);
    ok(!second || second.hop !== first.hop, 'a locked neighbour is not attacked');
  }

  // Bots (owner, 18 Nov 2026): the server spends their credits; they expand, defend and refuse alliances.
  {
    const g = createAutoWorld({ players: [{ name: 'Ann' }, { name: 'Bot 1', bot: true }, { name: 'Bot 2', bot: true }, { name: 'Bot 3', bot: true }], seed: 8 });
    ok(g.players[1].bot && !g.players[0].bot && g.players[1].claimed, 'createWorld marks bot seats');
    // Double income for bots (owner, 22 Nov 2026).
    {
      const e = createAutoWorld({ players: [{ name: 'Ann' }, { name: 'Bot 1', bot: true }], seed: 8 });
      const c0 = e.players.map((p) => p.credits);
      advanceTo(e, HOUR_MS);
      const gain = e.players.map((p, i) => p.credits - c0[i]);
      ok(Math.abs(gain[1] - 2 * gain[0]) < 1e-6 && gain[0] === HOME_INCOME, `bots earn double: ${gain[0]} vs ${gain[1]} cr in an hour`);
      ok(incomeOf(e, 1) === 2 * incomeOf(e, 0), 'and their income shows doubled');
    }
    proposeAlliance(g, 0, 1);
    const res = fake(g);
    let defOrders = 0;
    const seenJobs = new Set();
    const worlds0 = [1, 2, 3].map((b) => g.planets.filter((P) => P.owner === b).length);
    for (let t = 0; t <= 72 * HOUR_MS; t += HOUR_MS / 4) {
      runWorld(g, t, res);
      for (const j of g.jobs) if (j.kind === 'defence' && g.players[j.owner].bot && !seenJobs.has(j.id)) { seenJobs.add(j.id); defOrders++; }
    }
    ok(!proposalsFor(g, 1).length && !allied(g, 0, 1), 'a bot turns down alliance proposals');
    ok(g.log.filter((e) => /shipyard/i.test(e.text) && /^Bot/.test(e.text)).length >= 6, 'bots buy shipyards');
    const worlds = [1, 2, 3].map((b) => g.planets.filter((P) => P.owner === b).length);
    ok(worlds.some((n, i) => n > worlds0[i]), `bots take worlds (${worlds0.join('/')} → ${worlds.join('/')})`);
    ok(defOrders > 0, `bots build defences when an enemy is coming (${defOrders} orders)`);
    ok(g.players.filter((p) => p.bot).every((p) => p.eliminated || p.credits >= 0), 'bots never go into debt');
    ok(g.players[0].credits > 0 && !g.log.some((e) => /^Ann (started|bought)/.test(e.text)), 'the person\'s credits are left alone');
    // makeBot: an open seat becomes "Bot N" and starts playing.
    const h = createAutoWorld({ players: [{ name: 'Ann' }, { name: 'Player 2', open: true }], seed: 3 });
    ok(makeBot(h, 1).ok && h.players[1].name === 'Bot 1' && h.players[1].bot && h.players[1].claimed, 'an open seat can be made a bot');
    ok(!makeBot(h, 1).ok, 'only once');
    runWorld(h, 2 * HOUR_MS, fake(h));
    ok(h.planets.some((P) => P.owner === 1 && P.yards.length), 'the new bot buys a shipyard');
  }
}

// Militia worth NEUTRAL_GARRISON_BASE + 12 h of income (owner, 22 Nov 2026: "enough for 1.5 attacks";
// a starting player's first siege brings ~20–30k).
{
  const { NEUTRAL_GARRISON_BASE, NEUTRAL_GARRISON_HOURS } = await import('../src/shared/economy.js');
  const m = createWorld({ players: [{ name: 'Ann' }, { name: 'Ben' }, { name: 'Cy' }, { name: 'Di' }], seed: 31 });
  const mil = m.planets.filter((P) => P.owner === null);
  ok(mil.length > 10, 'the galaxy has militia worlds');
  for (const P of mil) {
    const budget = NEUTRAL_GARRISON_BASE + P.income * NEUTRAL_GARRISON_HOURS;
    const worth = P.garrison.reduce((s, g) => s + g.n * m.designs[g.design].cost, 0);
    const cheapest = Math.min(...P.garrison.map((g) => m.designs[g.design].cost));
    ok(worth <= budget && worth > budget - cheapest * 3, `militia at ${P.name} is worth ${worth} of its ${budget} (base + ${NEUTRAL_GARRISON_HOURS} h of income)`);
  }
}

// Income = base + a share per hyperlane (owner, 22 Nov 2026: more lanes, harder to hold, worth more).
{
  const { planetIncome, PLANET_INCOME_BASE, PLANET_INCOME_PER_LANE } = await import('../src/shared/economy.js');
  for (const players of [2, 5, 8]) {
    const m = createWorld({ players: Array.from({ length: players }, (_, i) => ({ name: 'P' + i })), seed: 12 });
    const deg = new Map(m.planets.map((P) => [P.id, 0]));
    for (const [a, b] of m.lanes) { deg.set(a, deg.get(a) + 1); deg.set(b, deg.get(b) + 1); }
    const bad = m.planets.filter((P) => P.home < 0 && P.income !== planetIncome(deg.get(P.id)));
    ok(!bad.length, `${players} players: every world pays ${PLANET_INCOME_BASE} + ${PLANET_INCOME_PER_LANE} per hyperlane`);
    ok(m.planets.filter((P) => P.home >= 0).every((P) => P.income === HOME_INCOME), 'home worlds keep the home income');
  }
}

// ---- Enemies never start mixed together (owner, 26 Nov 2026): Ann at war with everyone, Bo allied with
// Cy and Di, Cy and Di allied only with Bo (so at war with each other). At Bo's world Cy's and Di's
// ships both defended it and started mixed with Bo's, then fought each other at point blank.
{
  const names = ['Ann', 'Bo', 'Cy', 'Di'];
  const closest = {};
  for (const holder of [0, 1, 2]) {
    const w = createWorld({ players: names.map((name) => ({ name })), seed: 91 });
    const [A, B, C, D] = w.players.map((p) => p.id);
    for (const [x, y] of [[B, C], [B, D]]) { proposeAlliance(w, x, y); acceptAlliance(w, y, x); }
    ok(allied(w, B, C) && allied(w, B, D) && !allied(w, C, D) && !allied(w, A, B), 'Bo+Cy, Bo+Di, Cy and Di at war, Ann alone');
    const des = [A, B, C, D].map((k) => { w.players[k].credits = 1e8; return buildShipyard(w, k, w.players[k].home, { ...makeDesign('destroyer', 30), name: `Ship ${names[k]}` }).yard.design; });
    for (const P of w.planets) for (const y of P.yards) y.next = Infinity;
    for (const P of w.planets) P.garrison = [];
    const T = w.planets[w.players[holder].home];
    const defenders = [A, B, C, D].filter((k) => k === holder || allied(w, k, holder));
    T.garrison = defenders.map((k) => ({ owner: k, design: des[k], n: 25 }));
    const stage = w.planets.filter((p) => p.home < 0).sort((p, q) => Math.hypot(p.x - T.x, p.y - T.y) - Math.hypot(q.x - T.x, q.y - T.y))[0];
    const atk = [A, B, C, D].filter((k) => !defenders.includes(k));
    stage.owner = atk[0]; stage.garrison = atk.map((k) => ({ owner: k, design: des[k], n: 25 }));
    for (const k of atk) ok(sendFleet(w, k, stage.id, T.id, { [des[k]]: 25 }, { lanes: false }).ok, 'attack launched');
    runWorld(w, Math.max(...w.fleets.map((f) => f.arrive)), resolve);
    const sg = siegeAt(w, T.id)[0];
    ok(sg, 'a siege at the world');
    const plan = planEvent(w, { kind: 'siege', siege: sg });
    const sc = plan.battle, own = sc.groups.flatMap((g) => Array.from({ length: g.n }, () => g.owner));
    let near = Infinity;
    for (let i = 0; i < sc.ships.length; i++) for (let j = i + 1; j < sc.ships.length; j++) {
      if (own[i] === own[j] || allied(w, own[i], own[j])) continue;
      near = Math.min(near, Math.hypot(sc.ships[i].x - sc.ships[j].x, sc.ships[i].y - sc.ships[j].y));
    }
    closest[names[holder]] = Math.round(near);
    ok(near > 150, `at ${names[holder]}'s world no two enemies start within 150 blocks (closest ${near.toFixed(0)})`);
  }
  // Every player has a spot of their own (owner, 26 Nov 2026), and start positions work in each: Front nearest
  // the world, then Middle, then Back; Top / Bottom flank on the right wings (designer top, nose to the world).
  const places = ['front', 'middle', 'back', 'top', 'bottom', 'auto'], base = makeDesign('destroyer', 4), pd = {};
  for (const p of places) pd[p] = { ...base, place: p === 'auto' ? undefined : p };
  for (const nC of [3, 4, 6]) {
    const groups = [];
    for (let t = 0; t < nC; t++) for (const p of places) groups.push({ team: t, side: t ? 0 : 1, owner: t, design: p, n: 8 });
    const sc = makeBattleScenario(groups, (id) => pd[id], 7, { teams: nC, campOf: [...Array(nC).keys()], camps: nC });
    for (let t = 0; t < nC; t++) {
      const phi = 2 * Math.PI * t / nC, a = (phi + Math.PI) % (2 * Math.PI), st = {};
      for (const g of sc.groups.filter((g) => g.team === t)) {
        const sh = sc.ships.slice(g.start, g.start + g.n), mean = (f) => sh.reduce((q, x) => q + f(x), 0) / sh.length;
        st[g.design] = { out: mean((x) => x.x * Math.cos(phi) + x.y * Math.sin(phi)), top: mean((x) => x.x * Math.sin(a) - x.y * Math.cos(a)) };
      }
      ok(st.front.out < st.middle.out && st.middle.out < st.back.out, `${nC} camps, camp ${t}: Front, Middle, Back in order`);
      ok(st.top.top > st.auto.top + 30 && st.bottom.top < st.auto.top - 30, `${nC} camps, camp ${t}: flanks on the right wings`);
    }
  }
  console.log(`  enemies apart at the start (closest enemy pair, blocks): ${Object.entries(closest).map(([k, v]) => `${k}'s world ${v}`).join(', ')}`);
}

// ---- 2.0 with allies (owner, 22 Nov 2026: "does that work with allies?"): two allies against two
// enemies, both sending every fleet at the same enemy home. Stand-in battles (the bigger side wins).
// Also checks no ship waits without a reason: dispatchAll goes round again while it sends anything
// (this game, seed 9, had 5 ships waiting 13 minutes at 55.75 h with a single round).
{
  const g = createAutoWorld({ players: [{ name: 'Ann', team: 'A' }, { name: 'Bo', team: 'A' }, { name: 'Cy' }, { name: 'Di' }], seed: 9 });
  for (const pl of g.players) { pl.credits = 1e6; buildShipyard(g, pl.id, pl.home, { ...makeDesign('destroyer', 3 + pl.id), name: `D${pl.id}` }); }
  const target = g.players[2].home;
  for (const pid of [0, 1]) setDestination(g, pid, g.players[pid].home, target);
  const res = (scen) => {
    const val = {};
    for (const q of scen.groups) val[q.team] = (val[q.team] || 0) + q.n * worthOf(g, q.design);
    const teams = Object.keys(val).map(Number).sort((a, b) => val[b] - val[a] || a - b);
    const top = teams[0], rest = teams.slice(1).reduce((x, t) => x + val[t], 0), keep = Math.max(0, 1 - rest / val[top]);
    return { groups: scen.groups.map((q) => ({ ...q, survived: q.team === top ? Math.floor(q.n * keep) : 0 })), routed: [], seconds: 60 };
  };
  let allyAttacks = 0, idle = 0, toAlly = 0, logSeen = 0, joint = 0, allyCaptures = 0;
  for (let t = 0; t <= 96 * HOUR_MS; t += HOUR_MS / 4) {
    runWorld(g, t, res);
    for (const sg of g.sieges) { const P = g.planets[sg.planet]; if (P.owner !== null && sg.leader !== P.owner && allied(g, sg.leader, P.owner)) allyAttacks++; }
    for (const f of g.fleets) { const P = g.planets[f.legs[f.leg]?.to]; if (P && !f.retreat && P.owner !== null && P.owner !== f.owner && allied(g, P.owner, f.owner)) toAlly++; }
    for (const P of g.planets) for (const x of P.garrison) {
      if (x.owner === null || g.designs[x.design].fixed || !allied(g, x.owner, P.owner)) continue;
      const goal = x.goal === undefined ? (P.owner === x.owner ? P.dest?.to ?? null : null) : x.goal;
      if (!holdReason(g, P, x.owner, { [x.design]: x.n }, goal)) idle++;
    }
    for (; logSeen < g.log.length; logSeen++) {
      const e = g.log[logSeen];
      if (e.capture && e.capture.from !== null && e.capture.by !== e.capture.from && allied(g, e.capture.by, e.capture.from)) allyCaptures++;
      const ps = (e.battle?.players || []).map((q) => q.id);
      if (ps.includes(0) && ps.includes(1)) joint++;
    }
  }
  ok(!allyAttacks && !allyCaptures, `allies never attack or take each other's worlds (${allyAttacks} sieges, ${allyCaptures} captures)`);
  ok(toAlly > 0, `fleets fly to and through allied worlds (${toAlly} fleet-quarter-hours)`);
  ok(joint > 0, `allies fight side by side (${joint} battles)`);
  ok(!idle, `with allies too, no ship sits at a world without a reason (${idle})`);
  // Owner, 25 Nov 2026: battle reports say how many of each player's ships fell back, never where (one phrase per player).
  const btxt = g.log.filter((e) => e.battle).map((e) => e.text);
  ok(!btxt.some((t) => /back to /.test(t)), 'battle reports never say where fleets fell back to');
}
// Several beaten fleets of one player: one phrase with the total, no destinations.
{
  const w = createWorld({ players: [{ name: 'Ann' }, { name: 'Bo' }], seed: 8 });
  const home = w.players[0].home, H = w.planets[home];
  const did = registerDesign(w, 0, { ...makeDesign('frigate', 5), name: 'Scout' });
  addShips(H, 0, did, 9);
  const T = w.planets.filter((p) => p.owner === null).sort((a, b) => Math.hypot(a.x - H.x, a.y - H.y) - Math.hypot(b.x - H.x, b.y - H.y))[0];
  const fs = [2, 3, 4].map((n) => sendFleet(w, 0, home, T.id, { [did]: n }));
  ok(fs.every((x) => x.ok), 'three fleets sent');
  // stand-in battle: militia holds, each attacking group keeps half
  const res = (scen) => ({ groups: scen.groups.map((q) => ({ ...q, survived: q.owner === null ? q.n : Math.floor(q.n / 2) })), routed: [], seconds: 60 });
  runWorld(w, Math.max(...fs.map((x) => x.fleet.arrive)) + HOLD_MS + 1, res);
  const e = w.log.filter((x) => x.battle).at(-1);
  ok(e && /4 of Ann's ships fell back\./.test(e.text) && !/back to/.test(e.text) && (e.text.match(/fell back/g) || []).length === 1, `one fall-back phrase with the total (${e?.text})`);
}

// ---- 24 Nov 2026: the admin joins two worlds of a running galaxy with a new hyperlane
{
  const g = createAutoWorld({ players: ['Ann', 'Ben', 'Cat', 'Dan'], seed: 11 });
  g.planets.forEach((P) => { P.owner = null; }); // seeking: every world a target
  const linked = (a, b) => g.lanes.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  // a pair of non-home worlds not yet joined that the rules allow
  let pair = null;
  for (const A of g.planets) for (const B of g.planets) {
    if (pair || A.id >= B.id || A.home >= 0 || B.home >= 0 || linked(A.id, B.id) || Math.hypot(A.x - B.x, A.y - B.y) > PLANET_SPACING * 3) continue;
    const h = JSON.stringify(g); const r = addLane(g, A.id, B.id);
    if (r.ok) pair = [A.id, B.id]; else ok(JSON.stringify(g) === h, 'a refused lane changes nothing');
  }
  ok(pair, 'found two worlds to join');
  const [a, b] = pair, A = g.planets[a];
  const deg = (id) => g.lanes.filter(([x, y]) => x === id || y === id).length;
  ok(linked(a, b) && A.income === 120 + 100 * deg(a), `joined, and income follows the lanes (${A.income})`);
  ok(g.log.at(-1).text.startsWith('New hyperlane:'), 'players are told');
  ok(nextHop(g, a, 0, b)?.hop === b, 'routes use the new lane at once (lane cache refreshed)');
  ok(!addLane(g, a, b).ok && !addLane(g, b, a).ok && !addLane(g, a, a).ok && !addLane(g, a, 999).ok, 'no duplicates, loops or made-up worlds');
  const [c, d] = g.lanes.find(([x, y]) => x !== a && y !== a && x !== b && y !== b);
  const mids = g.planets.filter((P) => P.id !== c && P.id !== d);
  let crossRefused = false;
  for (const P of mids) for (const Q of mids) if (P.id < Q.id && !linked(P.id, Q.id)) {
    const r = addLane(g, P.id, Q.id); if (!r.ok && /cross/.test(r.error)) crossRefused = true; if (crossRefused) break;
  }
  ok(crossRefused, 'a lane crossing another is refused');
  const re = upgradeWorld(JSON.parse(JSON.stringify(g)));
  ok(re.lanes.length === g.lanes.length, 'the save keeps the new lanes');
}

// ---- 25 Nov 2026 (owner: allies arriving at a world together; "the player with 70k of fleet has a
// 70% chance of taking the planet"): the world goes by lot, weighted by the value each arrived with.
{
  // The draw itself: 70k vs 30k over many sieges comes out about 70 / 30, and is the same when asked again.
  const g = createWorld({ players: [{ name: 'Ann', team: 'A' }, { name: 'Bo', team: 'A' }, { name: 'Cy' }], seed: 4 });
  let ann = 0; const N = 4000;
  for (let id = 1; id <= N; id++) {
    const s = { id, leader: 1, together: [[0, 70000], [1, 30000]] };
    const d = togetherDraw(g, s, [0, 1]);
    if (d.winner === 0) ann++;
    ok(togetherDraw(g, s, [0, 1]).winner === d.winner, 'same siege, same draw');
  }
  ok(Math.abs(ann / N - 0.7) < 0.03, `70k vs 30k: the 70k player wins about 70% (${(ann / N * 100).toFixed(1)}%)`);
  ok(togetherDraw(g, { id: 9, leader: 0, together: [[0, 70000], [1, 30000]] }, [0]) === null, 'no draw if only one of them is still there');
  ok(togetherDraw(g, { id: 9, leader: 0 }, [0, 1]) === null, 'sieges from before this rule: no draw');

  // In a game: Ann's and Bo's fleets leave Ann's home together for an undefended militia world
  // (same design, same speed: same arrival). Played over many seeds, the world goes to each by lot.
  const play = (seed, nAnn, nBo, emptyWorld, gap = 0) => {
    const w = createWorld({ players: [{ name: 'Ann', team: 'A' }, { name: 'Bo', team: 'A' }, { name: 'Cy' }], seed });
    const did = registerDesign(w, 0, { ...makeDesign('destroyer', 4), name: 'Runner' });
    const bid = registerDesign(w, 1, { ...makeDesign('destroyer', 4), name: 'Runner' });
    const home = w.players[0].home, H = w.planets[home];
    const T = w.planets.filter((p) => p.owner === null).sort((a, b) => Math.hypot(a.x - H.x, a.y - H.y) - Math.hypot(b.x - H.x, b.y - H.y))[0];
    if (emptyWorld) T.garrison = []; else T.garrison = [{ owner: null, design: did, n: 1 }];
    addShips(H, 0, did, nAnn); addShips(H, 1, bid, nBo);
    const fb = sendFleet(w, 1, home, T.id, { [bid]: nBo });
    if (gap) advanceTo(w, w.clock + gap);
    const fa = sendFleet(w, 0, home, T.id, { [did]: nAnn });
    ok(fa.ok && fb.ok, `both fleets sent (${fa.error || fb.error || ''})`);
    // stand-in battle: militia's one ship dies, everyone else survives
    const res = (scen) => ({ groups: scen.groups.map((q) => ({ ...q, survived: q.owner === null ? 0 : q.n })), routed: [], seconds: 60 });
    runWorld(w, Math.max(fa.fleet.arrive, fb.fleet.arrive) + HOLD_MS + 1, res);
    const e = w.log.filter((x) => x.capture && x.capture.from === null && x.planet === T.id).at(-1);
    return { owner: T.owner, text: e?.text || '' };
  };
  for (const empty of [true, false]) {
    let annWins = 0, texts = 0; const runs = 200;
    for (let seed = 1; seed <= runs; seed++) {
      const r = play(seed, 7, 3, empty);
      if (r.owner === 0) annWins++;
      if (/Ann and Bo arrived together, so the world went by lot, weighted by fleet value: Ann 70% .*Bo 30%/.test(r.text)) texts++;
    }
    ok(annWins / runs > 0.58 && annWins / runs < 0.82, `${empty ? 'empty world' : 'after a battle'}: Ann (70% of the value) takes it ${annWins} of ${runs} times`);
    ok(texts === runs, `${empty ? 'empty world' : 'after a battle'}: the log says it went by lot, with the odds (${texts} of ${runs})`);
  }
  // Not together: Bo got there first (an hour ahead), so Bo started the siege and keeps it as before.
  let boWins = 0;
  for (let seed = 1; seed <= 30; seed++) { const r = play(seed, 7, 3, true, HOUR_MS); if (r.owner === 1 && !/by lot/.test(r.text)) boWins++; }
  ok(boWins === 30, `an ally who arrives first still takes the world (${boWins} of 30)`);
}

// ---- 25 Nov 2026 (owner, a player's request): fleet stances. A design's stance and start position
// change for every ship of it in play at once, from the next battle.
{
  const w = createWorld({ players: [{ name: 'Ann' }, { name: 'Bo' }], seed: 6 });
  const home = w.players[0].home, H = w.planets[home];
  const did = registerDesign(w, 0, { ...makeDesign('destroyer', 4), name: 'Runner', stance: 'line' });
  const fort = { ...makeDesign('cruiser', 2), name: 'Wall' };
  fort.cells = fort.cells.map((c) => (c === BT.THRUSTER ? BT.ARMOR : c));
  const fid = registerDesign(w, 0, fort, true);
  addShips(H, 0, did, 6); addShips(H, 0, fid, 2, undefined);
  const T = w.planets.filter((p) => p.owner === null).sort((a, b) => Math.hypot(a.x - H.x, a.y - H.y) - Math.hypot(b.x - H.x, b.y - H.y))[0];
  const f = sendFleet(w, 0, home, T.id, { [did]: 3 });
  ok(f.ok, 'fleet sent');
  ok(designOf(w, did).stance === 'line', 'starts as Front line');
  const r = setDesignOrders(w, 0, did, { stance: 'flank', place: 'top' });
  ok(r.ok && r.stance === 'flank' && r.place === 'top', `stance and start set (${r.error || ''})`);
  ok(designOf(w, did).stance === 'flank' && designOf(w, did).place === 'top', 'the decoded design has the new orders (cache cleared)');
  ok(w.designs[did].data.stance === 'flank' && w.designs[did].data.place === 'top', 'stored in the world');
  ok(setDesignOrders(w, 0, did, { place: 'auto' }).ok && !('place' in w.designs[did].data) && designOf(w, did).stance === 'flank', 'Auto stored as no place; stance kept');
  // The fleet already flying fights with the new orders: the battle reads the design when it starts.
  runWorld(w, f.fleet.arrive + 1, resolve);
  const sg = w.sieges.find((x) => x.planet === T.id);
  const plan = planEvent(w, { kind: 'siege', siege: sg });
  const scenD = plan.battle.designs.find((d) => d.name === 'Runner');
  ok(scenD && scenD.stance === 'flank', 'a fleet already in flight fights with the new stance');
  ok(!setDesignOrders(w, 1, did, { stance: 'raid' }).ok, "can't change another player's design");
  ok(!setDesignOrders(w, 0, did, { stance: 'dance' }).ok && !setDesignOrders(w, 0, did, { place: 'left' }).ok && !setDesignOrders(w, 0, did, { stance: 'constructor' }).ok, 'unknown stances and positions refused');
  ok(!setDesignOrders(w, 0, 'nope', { stance: 'raid' }).ok, 'unknown design refused');
  ok(!setDesignOrders(w, 0, fid, { stance: 'raid' }).ok, 'defences have no stance');
  ok(setDesignOrders(w, 0, fid, { place: 'back' }).ok && designOf(w, fid).place === 'back', 'a defence can change where it stands');
  ok(!w.log.some((e) => /stance/i.test(e.text)), 'nothing logged (orders are private)');
  const re = upgradeWorld(JSON.parse(JSON.stringify(w)));
  ok(designOf(re, did).stance === 'flank' && designOf(re, fid).place === 'back', 'the save keeps the new orders');
}

// ---- 26 Nov 2026 (owner: "a friend who wants to join late… create a new planet for him… doesn't have any
// hyperlanes… then i can use the add hyperlane ability when he is ready"): a late player in a 10-player game.
{
  const g = createAutoWorld({ players: Array.from({ length: 10 }, (_, k) => `P${k}`), seed: 7 });
  for (let k = 0; k < 10; k++) makeBot(g, k);
  const half = (scen) => ({ groups: scen.groups.map((q) => ({ ...q, survived: Math.floor(q.n / 2) })), routed: [], seconds: 60 });
  runWorld(g, 12 * HOUR_MS, half);
  // a free spot just outside the rim
  let spot = null;
  for (let a = 0; a < 64 && !spot; a++) for (const f of [1.05, 1.15, 1.25]) {
    const x = Math.cos(a / 64 * Math.PI * 2) * g.radius * f, y = Math.sin(a / 64 * Math.PI * 2) * g.radius * f;
    if (!lateSpotProblem(g, x, y)) { spot = { x, y }; break; }
  }
  ok(spot, 'found a free spot at the edge');
  const busy = g.planets.find((P) => P.home < 0);
  ok(!addLatePlayer(g, { x: busy.x + 10, y: busy.y, credits: 1000 }).ok, 'not on top of another world');
  ok(!addLatePlayer(g, { x: g.radius * 3, y: 0, credits: 1000 }).ok && !addLatePlayer(g, { ...spot, credits: -5 }).ok, 'not far off the map, credits checked');
  const r = addLatePlayer(g, { ...spot, credits: 100000 });
  ok(r.ok && r.player === 10 && g.players.length === 11, 'player 11 added');
  const L = g.planets[r.planet], me = g.players[10];
  ok(L.owner === 10 && L.home === 10 && me.home === L.id && me.credits === 100000 && me.claimed === false && me.name === 'Player 11', 'home world, credits, open seat');
  ok(!g.players.slice(0, 10).some((p) => p.color === me.color), 'a colour nobody has');
  ok(!g.lanes.some(([a, b]) => a === L.id || b === L.id), 'no hyperlanes');
  ok(Math.hypot(L.x, L.y) < g.radius, 'the map grows to show it');
  ok(g.log.at(-1).text.includes(L.name), 'everyone is told');
  const save = upgradeWorld(JSON.parse(JSON.stringify(g)));
  ok(!save.lanes.some(([a, b]) => a === L.id || b === L.id), 'loading the save gives it no lane by itself');
  const des = { ...makeDesign('destroyer', 5), name: 'Late destroyer' };
  ok(buildShipyard(g, 10, L.id, des).ok && buildShipyard(g, 10, L.id, des).ok, 'he can buy shipyards');
  // another player points every fleet at the unreachable world: they mustn't freeze
  const P0home = g.planets[g.players[0].home];
  ok(setDestination(g, 0, P0home.id, L.id).ok, 'a destination can be the late world');
  const t0 = g.clock;
  let left0 = 0, touched = 0;
  for (let h = 1; h <= 48; h++) {
    runWorld(g, t0 + h * HOUR_MS, half);
    left0 = Math.max(left0, g.fleets.filter((f) => f.owner === 0).length);
    touched += g.fleets.filter((f) => f.to === L.id || f.from === L.id || f.owner === 10).length + g.sieges.filter((s) => s.planet === L.id).length;
  }
  ok(touched === 0, 'two days: no fleet flies to or from it, no siege');
  ok(left0 > 0, "player 1's fleets still go out (the unreachable destination falls back to the nearest enemy)");
  const piled = countShips(shipsAt(L, 10));
  ok(piled >= 2 * 5 * 30, `his ships pile up at home (${piled})`);
  ok(!me.eliminated && g.winner === null, 'still in the game');
  // the admin links him in: his ships set off
  const near = g.planets.filter((P) => P.id !== L.id).sort((a, b) => Math.hypot(a.x - L.x, a.y - L.y) - Math.hypot(b.x - L.x, b.y - L.y));
  let linked = null;
  for (const P of near) if (addLane(g, L.id, P.id).ok) { linked = P; break; }
  ok(linked && L.income === HOME_INCOME, 'a hyperlane joins it (home income unchanged)');
  ok(g.fleets.some((f) => f.owner === 10), 'his ships set off at once');
  runWorld(g, g.clock + 24 * HOUR_MS, half);
  ok(g.log.some((e) => e.battle && (e.players || []).includes(10)), 'and fight');
  // up to one player per choosable colour
  while (g.players.length < MAX_SEATS) {
    let s2 = null;
    for (let a = 0; a < 256 && !s2; a++) for (const f of [1.05, 1.15, 1.25, 1.35]) { const x = Math.cos(a / 256 * Math.PI * 2) * g.radius * f, y = Math.sin(a / 256 * Math.PI * 2) * g.radius * f; if (!lateSpotProblem(g, x, y)) { s2 = { x, y }; break; } }
    ok(s2 && addLatePlayer(g, { ...s2, credits: 0 }).ok, `player ${g.players.length + 1} added`);
  }
  ok(new Set(g.players.map((p) => p.color)).size === MAX_SEATS, 'everyone has their own colour');
  // owner, 26 Nov 2026: "put him in the middle of the map": ordinary world spacing leaves room near the centre of a fresh map
  {
    const m = createAutoWorld({ players: Array.from({ length: 10 }, (_, k) => `Q${k}`), seed: 7 });
    let mid = null;
    for (let r = 0; r < m.radius * 0.5 && !mid; r += 4) for (let a = 0; a < 72 && !mid; a++) { const x = Math.cos(a / 72 * Math.PI * 2) * r, y = Math.sin(a / 72 * Math.PI * 2) * r; if (!lateSpotProblem(m, x, y)) mid = { x, y }; }
    ok(mid && Math.hypot(mid.x, mid.y) < m.radius * 0.4, `a spot near the middle (${mid && (Math.hypot(mid.x, mid.y) / m.radius).toFixed(2)} × radius)`);
    const rr = addLatePlayer(m, { ...mid, credits: 1 });
    const near = m.planets.filter((P) => P.id !== rr.planet).sort((p, q) => Math.hypot(p.x - mid.x, p.y - mid.y) - Math.hypot(q.x - mid.x, q.y - mid.y));
    ok(rr.ok && near.slice(0, 6).filter((P) => addLane(m, rr.planet, P.id).ok).length >= 2, 'and it can be joined to its neighbours');
  }
  ok(!addLatePlayer(g, { x: 0, y: g.radius * 1.3, credits: 0 }).ok, `no more than ${MAX_SEATS}`);
}

console.log(`world: ${checks} checks passed`);
