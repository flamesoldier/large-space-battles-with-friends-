// Quick test battles for the ship designer: N copies of your design against an opponent fleet
// worth the same number of credits, resolved with the real battle sim.

import { makeDesign, CLASS_MIX } from '../shared/designs.js';
import { designCost } from '../shared/shipStats.js';
import { mulberry32 } from '../shared/rng.js';

// How many copies to field by default, so a test is a proper fleet fight but stays quick.
export const DEFAULT_COPIES = { corvette: 30, frigate: 20, destroyer: 12, cruiser: 6, battleship: 3, titan: 1 };

/**
 * Build a Battle scenario. `opponent` is null for a generated mixed fleet, or a design to
 * field as many copies of as the budget buys (at least one).
 * Returns { designs, ships, budget, enemyCost, enemyCount }.
 */
export function makeTestScenario(design, copies, opponent = null, seed = 1) {
  const r = mulberry32(seed * 977 + 5);
  const budget = designCost(design) * copies;
  const designs = [design];
  const enemy = []; // design indexes for team 1
  let spent = 0;

  if (opponent) {
    designs.push(opponent);
    const n = Math.max(1, Math.round(budget / Math.max(1, designCost(opponent))));
    for (let k = 0; k < n; k++) enemy.push(1);
    spent = n * designCost(opponent);
  } else {
    // A mixed fleet in the usual class proportions, filled until the money runs out.
    const pool = CLASS_MIX.map(([cls, p], k) => {
      const d = makeDesign(cls, seed * 100 + k * 7 + 3);
      designs.push(d);
      return { index: designs.length - 1, cost: designCost(d), p };
    });
    for (let guard = 0; guard < 5000; guard++) {
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
  const place = (team, list) => {
    const dir = team === 0 ? 1 : -1, spanY = Math.max(160, Math.sqrt(list.length) * 45);
    for (const di of list) {
      const d = designs[di], depth = Math.hypot(d.w, d.h) * 0.6 + r() * (30 + Math.sqrt(list.length) * 10);
      ships.push({ design: di, team, x: -dir * (220 + depth), y: (r() - 0.5) * spanY, a: team === 0 ? 0 : Math.PI });
    }
  };
  place(0, new Array(copies).fill(0));
  place(1, enemy);
  return { designs, ships, budget, enemyCost: spent, enemyCount: enemy.length };
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
