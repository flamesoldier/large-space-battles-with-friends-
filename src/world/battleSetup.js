// Turns a fleet arriving at a defended world into a Battle scenario for src/sim/battle.js, and
// reads the finished Battle back into ship counts.
//
// The attacking fleet is team 0 and comes in from the left; every defending stack (the world's
// owner, its allies, or militia on an unclaimed world) is team 1, holding around the world.
// Ships are spawned in group order, so ship k of the scenario is Battle entity k, and each
// group's survivors are counted over its index range.
//
// A ship survives if it still has its hub and at least one working weapon (the same rule the
// designer's test battle uses for "lost"). Survivors come back at full strength: there is no
// damage carried between battles yet.

import { mulberry32 } from '../shared/rng.js';

/**
 * groups: [{ side: 0 | 1, owner, design (world design id), n }]
 * designOf(id) → decoded design.
 * Returns { designs, ships, groups (with start), seed }.
 */
export function makeBattleScenario(groups, designOf, seed) {
  const r = mulberry32(seed * 7703 + 11);
  const designs = [], index = new Map();
  const out = [], ships = [];
  for (const g of groups) {
    if (g.n <= 0) continue;
    if (!index.has(g.design)) { index.set(g.design, designs.length); designs.push(designOf(g.design)); }
    out.push({ ...g, start: ships.length });
    for (let k = 0; k < g.n; k++) ships.push({ design: index.get(g.design), team: g.side });
  }
  // Positions: each side spread over a band that grows with its size (as in the designer's test).
  for (const team of [0, 1]) {
    const list = ships.filter((s) => s.team === team);
    const dir = team === 0 ? 1 : -1, spanY = Math.max(160, Math.sqrt(list.length) * 45);
    for (const s of list) {
      const d = designs[s.design], depth = Math.hypot(d.w, d.h) * 0.6 + r() * (30 + Math.sqrt(list.length) * 10);
      s.x = -dir * (220 + depth); s.y = (r() - 0.5) * spanY; s.a = team === 0 ? 0 : Math.PI;
    }
  }
  return { designs, ships, groups: out, seed };
}

/** For the replay: [start, n, colour] per group, so the viewer draws each ship in its owner's colour. */
export function shipColors(scen) {
  return scen.groups.filter((g) => g.color).map((g) => [g.start, g.n, g.color]);
}

/**
 * Read a finished Battle. Returns { attackerWon, routed, groups: [{ ...group, survived }], seconds }.
 * The attacker wins if it still has armed ships and the defenders either have none or were routed
 * (under 20% of their ships left and outgunned 2:1: the battle stops there, so the few defenders
 * still armed have lost and flee). A stalemate or the time limit leaves the world with its holder.
 */
export function readBattle(battle, scen) {
  const alive = [0, 0];
  const groups = scen.groups.map((g) => {
    let survived = 0;
    for (let k = g.start; k < g.start + g.n; k++) {
      const e = battle.byId[k];
      if (!e.dead && e.weapons.length) survived++;
    }
    alive[g.side] += survived;
    return { ...g, survived };
  });
  const routed = battle.routed ?? -1;
  const attackerWon = alive[0] > 0 && (alive[1] === 0 || routed === 1);
  return { attackerWon, routed, groups, seconds: Math.round(battle.tick * 0.1) };
}
