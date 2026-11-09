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
 * groups: [{ side: 0 | 1, team?, owner, design (world design id), n }]
 * designOf(id) → decoded design.
 * opts (free-for-all, optional): { teams, campOf: camp index per team, camps } where camp 0 holds
 * the world and the others are attackers coming in from round it (allies share a camp). Without
 * opts, team = side and side 0 attacks side 1, as before.
 * Returns { designs, ships, groups (with start), seed, teams }.
 */
export function makeBattleScenario(groups, designOf, seed, opts = null) {
  const r = mulberry32(seed * 7703 + 11);
  const designs = [], index = new Map();
  const out = [], ships = [];
  for (const g of groups) {
    if (g.n <= 0) continue;
    if (!index.has(g.design)) { index.set(g.design, designs.length); designs.push(designOf(g.design)); }
    const team = g.team ?? g.side;
    out.push({ ...g, team, start: ships.length });
    for (let k = 0; k < g.n; k++) ships.push(g.fixed ? { design: index.get(g.design), team, fixed: true } : { design: index.get(g.design), team });
  }
  // Camps: where each team starts. Two sides: attackers (camp 1) on the left, defenders (camp 0)
  // on the right. More: the attacking camps spread evenly round the world, at the same distance.
  const nCamps = opts ? Math.max(1, opts.camps) : 2;
  const campOf = (team) => (opts ? opts.campOf[team] : team === 0 ? 1 : 0);
  // Defences (fixed) stand in rows at the world (owner, Nov 2026: rows, not a circle), facing
  // the attackers: one block of rows per attacking camp, the defences shared out between them.
  // Biggest in the back row by the world, smaller ones in front, with gaps to shoot through. They can never turn in battle.
  // Every fleet then starts clear of the rows. No random draws, so battles without defences start
  // exactly as before.
  const attackAngles = [];
  for (let c = 1; c < nCamps; c++) attackAngles.push((2 * Math.PI * c) / nCamps);
  if (!attackAngles.length) attackAngles.push(Math.PI);
  const ringOut = layoutDefences(ships.filter((s) => s.fixed), designs, attackAngles, nCamps);
  const order = [];
  for (let c = 1; c < nCamps; c++) order.push(c);
  order.push(0); // same draw order as before for two sides: attackers first
  for (const camp of order) {
    const list = ships.filter((s) => campOf(s.team) === camp && !s.fixed);
    if (!list.length) continue;
    // Camp direction from the world: camp 0 at angle 0 (right), the others round the circle.
    const phi = nCamps <= 1 ? 0 : (2 * Math.PI * camp) / nCamps;
    const c = Math.cos(phi), sn = Math.sin(phi);
    const spanY = Math.max(160, Math.sqrt(list.length) * 45);
    const k = c < 0 ? -1 : 1; // spread sideways (same layout as before for two sides)
    for (const s of list) {
      // k is also which way "top" is across this camp, for the flank start positions.
      const { depth, across } = startSpot(designs[s.design], list.length, spanY, r(), r(), k);
      const along = Math.max(220, ringOut + 60) + depth;
      s.x = c * along - k * sn * across; s.y = sn * along + k * c * across;
      s.a = (phi + Math.PI) % (2 * Math.PI); // facing the world
    }
  }
  return { designs, ships, groups: out, seed, teams: opts ? opts.teams : 2 };
}

/**
 * Where a ship starts within its fleet, from its design's start position (`place`, picked in the
 * designer; owner, Nov 2026). Returns { depth, across }: depth is how far back from the front of
 * the fleet (bigger = further from the enemy), across is sideways from the fleet's middle line.
 * r1, r2 are the two random draws every ship always takes, so a battle where every design is on
 * Auto starts exactly as before. `top` is +1 or −1: which sign of `across` is the fleet's top wing
 * (the top of the ship as drawn in the designer, nose toward the enemy).
 */
export function startSpot(d, n, spanY, r1, r2, top) {
  const size = Math.hypot(d.w, d.h) * 0.6, spread = 30 + Math.sqrt(n) * 10;
  switch (d.place) {
    case 'front': return { depth: size - 40 + r1 * spread * 0.25, across: (r2 - 0.5) * spanY };
    case 'middle': return { depth: size + spread * (0.375 + r1 * 0.25), across: (r2 - 0.5) * spanY };
    case 'back': return { depth: size + 60 + spread * (0.8 + r1 * 0.3), across: (r2 - 0.5) * spanY };
    // Flanks: out beyond the edge of the main body, on that wing, anywhere front to back.
    case 'top': return { depth: size + r1 * spread, across: top * (spanY / 2 + 60 + r2 * spanY * 0.4) };
    case 'bottom': return { depth: size + r1 * spread, across: -top * (spanY / 2 + 60 + r2 * spanY * 0.4) };
    default: return { depth: size + r1 * spread, across: (r2 - 0.5) * spanY }; // Auto: as always
  }
}

/** Defence order front to back: Back first (it fills the rows by the world), Front last. */
const PLACE_RANK = { back: 0, front: 2 };

/**
 * Stand defences (fixed ships) in staggered rows, one block of rows per direction in
 * attackAngles, facing out that way (sets x, y, a on each ship). nCamps sets how far out each
 * block stands when there are several. Returns how far out the rows reach from (0, 0), so fleets
 * can start clear of them. Used by world battles and the designer's defence test battle.
 */
export function layoutDefences(fixed, designs, attackAngles, nCamps = attackAngles.length + 1) {
  let ringOut = 0;
  if (fixed.length) {
    const D = (s) => designs[s.design];
    // A defence's front (its nose, the right-hand side in the designer) always faces the enemy
    // (owner: players design for that, e.g. armour in front and guns on the sides), so in the row
    // it is `deep` (its length) toward the enemy and `wide` (its height) across.
    const deep = (s) => D(s).w, wide = (s) => D(s).h;
    // Spread out (owner: guns in the back rows had no gaps to fire through): each defence gets its
    // own width plus a gap about as wide again across the row, rows stand well apart, and every
    // other row is shifted half a slot so back-row guns look through the gaps in front.
    const slot = (s) => wide(s) + Math.max(16, wide(s) * 0.9);
    const rowGap = 26, wingGap = 40;
    // Start positions (owner, Nov 2026): Back defences fill the rows by the world first, Front ones
    // last; within that, biggest first, as before (so with every design on Auto nothing changes).
    const rank = (s) => PLACE_RANK[D(s).place] ?? 1;
    fixed.sort((a, b) => rank(a) - rank(b) || D(b).w * D(b).h - D(a).w * D(a).h);
    const blocks = attackAngles.map(() => []);
    fixed.forEach((s, k) => blocks[k % blocks.length].push(s));
    // Row width for a group: about three times the depth of the whole group.
    const widthOf = (list) => {
      if (!list.length) return 0;
      const span = list.reduce((t, s) => t + slot(s), 0), depth = list.reduce((t, s) => t + deep(s) + rowGap, 0) / list.length;
      return Math.max(140, Math.sqrt(3 * span * depth));
    };
    blocks.forEach((list, bi) => {
      if (!list.length) return;
      const ph = attackAngles[bi], ux = Math.cos(ph), uy = Math.sin(ph), vx = -uy, vy = ux;
      // Top / Bottom flank defences stand in their own block of rows beside the main one. The
      // defences face along ph, so their top (designer top) is the −v side.
      const top = list.filter((s) => D(s).place === 'top'), bottom = list.filter((s) => D(s).place === 'bottom');
      const main = list.filter((s) => D(s).place !== 'top' && D(s).place !== 'bottom');
      const wM = widthOf(main), wT = widthOf(top), wB = widthOf(bottom);
      const half = (w) => (w ? w / 2 : 0);
      const cT = -(half(wM) + (wT ? wingGap + wT / 2 : 0)), cB = half(wM) + (wB ? wingGap + wB / 2 : 0);
      // With several blocks, each sits out from the world far enough to clear its neighbours.
      const reach = Math.max(half(wM), wT ? -cT + wT / 2 : 0, wB ? cB + wB / 2 : 0);
      const along0 = blocks.length > 1 ? reach / Math.tan(Math.PI / nCamps) + 15 : 0;
      const lay = (group, width, centre) => {
        let along = along0;
        for (let k = 0, r = 0; k < group.length; r++) {
          const row = [];
          let used = 0;
          while (k < group.length && (!row.length || used + slot(group[k]) <= width)) { used += slot(group[k]); row.push(group[k++]); }
          const rowDepth = Math.max(...row.map(deep));
          const shift = r % 2 ? (used / row.length) / 2 : 0; // stagger alternate rows
          let across = centre - used / 2 + shift;
          for (const s of row) {
            const h = slot(s), a = along + rowDepth / 2, c = across + h / 2;
            s.x = ux * a + vx * c; s.y = uy * a + vy * c; s.a = ph;
            across += h;
            ringOut = Math.max(ringOut, Math.hypot(s.x, s.y) + Math.hypot(D(s).w, D(s).h) / 2);
          }
          along += rowDepth + rowGap;
        }
      };
      lay(main, wM, 0); lay(top, wT, cT); lay(bottom, wB, cB);
    });
  }
  return ringOut;
}

/** Battle options for a scenario: how many sides and which pairs fight (scen.hostile: [[a, b], ...]). */
export function battleOptions(scen) {
  if (!scen.hostile) return { teams: scen.teams || 2 };
  const set = new Set(scen.hostile.map(([a, b]) => `${a}|${b}`));
  return { teams: scen.teams, hostile: (a, b) => set.has(a < b ? `${a}|${b}` : `${b}|${a}`) };
}

/** For the replay: [start, n, colour] per group, so the viewer draws each ship in its owner's colour. */
export function shipColors(scen) {
  return scen.groups.filter((g) => g.color).map((g) => [g.start, g.n, g.color]);
}

/**
 * Read a finished Battle. Returns { attackerWon, routed, groups: [{ ...group, survived }], seconds }.
 * routed[team] is 1 for each side that broke and ran (its survivors flee: it doesn't hold the
 * field). attackerWon is the two-sided answer (side 0 still holds, side 1 doesn't); the world
 * rules work out free-for-all winners from groups and routed.
 */
export function readBattle(battle, scen) {
  const nT = battle.nT || 2, alive = new Array(nT).fill(0);
  const groups = scen.groups.map((g) => {
    let survived = 0;
    for (let k = g.start; k < g.start + g.n; k++) {
      const e = battle.byId[k];
      if (!e.dead && e.weapons.length) survived++;
    }
    alive[g.team ?? g.side] += survived;
    return { ...g, survived };
  });
  const routed = Array.from(battle.routedTeams || [], Number);
  const holds = (side) => groups.some((g) => g.side === side && g.survived > 0 && !routed[g.team ?? g.side]);
  const attackerWon = holds(0) && !holds(1);
  return { attackerWon, routed, groups, seconds: Math.round(battle.tick * 0.1) };
}
