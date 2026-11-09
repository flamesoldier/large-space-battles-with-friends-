// Quick test battles for the ship designer: N copies of your design against an opponent fleet
// worth the same number of credits, resolved with the real battle sim.

import { makeDesign, CLASS_MIX } from '../shared/designs.js';
import { designCost } from '../shared/shipStats.js';
import { mulberry32 } from '../shared/rng.js';
import { layoutDefences, startSpot } from '../world/battleSetup.js';

// How many copies to field by default, so a test is a proper fleet fight but stays quick.
export const DEFAULT_COPIES = { corvette: 30, frigate: 20, destroyer: 12, cruiser: 6, battleship: 3, titan: 1, dreadnought: 1, leviathan: 1, colossus: 1, worldbreaker: 1 };
// The enemy fleet stops growing here, so a giant design's test stays quick in the browser.
const MAX_ENEMY_SHIPS = 2500;

/**
 * Build a Battle scenario. `opponent` is null for a generated mixed fleet, or a design to
 * field as many copies of as the budget buys (at least one).
 * `fixed`: your copies are defences. They stand in the same staggered rows as at a real world
 * (they can't move, so scattered at random they'd sit inside each other), fronts toward the
 * enemy, and the enemy starts clear of the rows.
 * `extras`: more of your designs on your side (owner, Nov 2026: test a new design with the rest of
 * your fleet), as [{ design, count, fixed }]; `fixed` ones are defences and join the rows. The
 * enemy is worth your whole side. Your designs are designs[0] (this one) and designs[1..extras].
 * Returns { designs, ships, budget, enemyCost, enemyCount, mineDesigns }.
 */
export function makeTestScenario(design, copies, opponent = null, seed = 1, fixed = false, extras = []) {
  const r = mulberry32(seed * 977 + 5);
  extras = extras.filter((x) => x.count > 0);
  const budget = designCost(design) * copies + extras.reduce((t, x) => t + designCost(x.design) * x.count, 0);
  const designs = [design, ...extras.map((x) => x.design)];
  const enemy = []; // design indexes for team 1
  let spent = 0;

  if (opponent) {
    designs.push(opponent);
    const oi = designs.length - 1;
    const n = Math.min(MAX_ENEMY_SHIPS, Math.max(1, Math.round(budget / Math.max(1, designCost(opponent)))));
    for (let k = 0; k < n; k++) enemy.push(oi);
    spent = n * designCost(opponent);
  } else {
    // A mixed fleet in the usual class proportions, filled until the money runs out.
    const pool = CLASS_MIX.map(([cls, p], k) => {
      const d = makeDesign(cls, seed * 100 + k * 7 + 3);
      designs.push(d);
      return { index: designs.length - 1, cost: designCost(d), p };
    });
    for (let guard = 0; guard < 20000 && enemy.length < MAX_ENEMY_SHIPS; guard++) {
      const fits = pool.filter((o) => spent + o.cost <= budget * 1.02);
      if (!fits.length) break;
      // Weight by cost too, so a big budget buys some big ships instead of a swarm of corvettes.
      const wsum = fits.reduce((s, o) => s + o.p * Math.sqrt(o.cost), 0);
      let roll = r() * wsum, pick = fits[0];
      for (const o of fits) { roll -= o.p * Math.sqrt(o.cost); if (roll <= 0) { pick = o; break; } }
      enemy.push(pick.index); spent += pick.cost;
    }
    if (!enemy.length) { enemy.push(pool[0].index); spent = pool[0].cost; }
  }

  const ships = [];
  let clear = 0; // how far the defence rows reach toward the enemy
  const place = (team, list) => {
    const dir = team === 0 ? 1 : -1, spanY = Math.max(160, Math.sqrt(list.length) * 45);
    // Start positions picked in the designer (startSpot). Your side faces right, so its top wing is
    // −y; the enemy faces left, so theirs is +y.
    for (const di of list) {
      const { depth, across } = startSpot(designs[di], list.length, spanY, r(), r(), team === 0 ? -1 : 1);
      ships.push({ design: di, team, x: -dir * (Math.max(220, clear + 60) + depth), y: across, a: team === 0 ? 0 : Math.PI });
    }
  };
  // Your side: defences stand at the origin in rows facing right (angle 0), the enemy coming in
  // from the right; ships start behind them (or on their own, with no defences, as before).
  const rows = [], flying = [];
  for (let k = 0; k < copies; k++) (fixed ? rows : flying).push(0);
  extras.forEach((x, j) => { for (let k = 0; k < x.count; k++) (x.fixed ? rows : flying).push(j + 1); });
  if (rows.length) {
    const mine = rows.map((di) => ({ design: di, team: 0, fixed: true }));
    clear = layoutDefences(mine, designs, [0], 2);
    ships.push(...mine);
  }
  place(0, flying);
  place(1, enemy);
  return { designs, ships, budget, enemyCost: spent, enemyCount: enemy.length, mineDesigns: 1 + extras.length };
}

/** Summarise a finished Battle for the designer (credits lost per side, winner). */
export function summarise(battle, scen) {
  const lost = [0, 0], start = [0, 0];
  for (let k = 0; k < scen.ships.length; k++) {
    const s = scen.ships[k], e = battle.byId[k], c = designCost(scen.designs[s.design]);
    start[s.team] += c;
    // A ship that lost its hub or every weapon is out of the fight: count it as lost.
    if (e.dead || e.hubDead || !e.weapons.length) lost[s.team] += c;
  }
  const alive = battle.teamAlive;
  const winner = alive[0] && !alive[1] ? 0 : alive[1] && !alive[0] ? 1 : lost[1] / start[1] > lost[0] / start[0] ? 0 : lost[0] / start[0] > lost[1] / start[1] ? 1 : -1;
  return { winner, alive: [...alive], startCount: [...battle.teamStart], lost, start, seconds: battle.tick * 0.1 };
}
