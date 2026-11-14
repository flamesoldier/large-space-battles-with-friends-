// Ship analysis shared by the ship designer, the server and (later) shipyards and fleets:
// price, mobility, firepower, weapon arcs and design validation.
//
// Mobility mirrors Battle.refit() in src/sim/battle.js exactly, and arcs use the same
// lineOfFire() as Battle.facing(), so
// what the designer shows is what the ship does in battle. tools/test-designer.mjs checks that
// the two agree; if you change the formulas in battle.js, change them here too.

import { bayRoute } from './bayRoute.js';
import { BT, BLOCKS, WEAPON, MULTIBLOCK, HULL_CLASSES, MAX_BLOCKS, MAX_W, MAX_H, COOKOFF, isWeapon } from './blocks.js';
import { lineOfFire, openDegrees } from './arcs.js';

// Escort and Brawler were taken out (owner, Nov 2026). A design saved with either loads as Front
// line (decodeDesign, the editor), so ships already in play fight as Front line too. The sim
// still knows both stances (STANCES in battle.js).
export const STANCE_INFO = {
  standoff: { label: 'Artillery', hint: 'Moves up to 60% of its longest weapon\'s range, then holds there, turned so its guns face the enemy. If enemies get very close it backs away slowly, still facing them.' },
  skirmish: { label: 'Skirmisher', hint: 'Keeps at 60% of its longest weapon\'s range like Artillery, but when enemies close in it turns and runs to open the range again (kiting). Its guns only fire while they still face the enemy, so put some guns on the back or sides.' },
  line: { label: 'Front line', hint: 'Moves up to 45% of its main gun range, where all its guns reach, then holds the front, turned so its guns face the enemy.' },
  flank: { label: 'Flanker', hint: 'Charges through the enemy line to their biggest ship and circles it close in at full speed. Point defence shreds hulls up close.' },
  raid: { label: 'Raider', hint: 'Attack runs: flies straight through the enemy at full speed skimming a big ship, out the far side, turns and comes back.' },
  charge: { label: 'Charge', hint: 'Dives straight at the nearest enemy to point blank. For small, fast, cheap ships.' },
};

// Where a ship or defence starts a battle within its own side (owner, Nov 2026: more strategy).
// Picked per design in the designer, saved as `place`; 'auto' (and every design saved before this)
// starts exactly where it always did. "Top" is the top of the design as drawn in the designer, with
// the fleet facing the enemy (its nose, the right-hand side in the designer). Used by
// src/world/battleSetup.js (startSpot, layoutDefences).
export const PLACE_INFO = {
  auto: { label: 'Auto', hint: 'The game decides: spread through the fleet as usual.', defHint: 'The game decides: biggest defences in the back rows, smaller ones in front.' },
  front: { label: 'Front', hint: 'Starts at the very front of the fleet, closest to the enemy.', defHint: 'Stands in the front rows, closest to the enemy.' },
  middle: { label: 'Middle', hint: 'Starts in the middle of the fleet.', defHint: 'Stands in the middle rows.' },
  back: { label: 'Back', hint: 'Starts behind the rest of the fleet, furthest from the enemy.', defHint: 'Stands in the back rows, by the world, furthest from the enemy.' },
  top: { label: 'Top flank', hint: 'Starts out on the fleet\'s top wing (the top side as you see the ship here, nose toward the enemy).', defHint: 'Stands in its own block of rows out on the top wing (the top side as you see it here, front toward the enemy).' },
  bottom: { label: 'Bottom flank', hint: 'Starts out on the fleet\'s bottom wing (the bottom side as you see the ship here, nose toward the enemy).', defHint: 'Stands in its own block of rows out on the bottom wing (the bottom side as you see it here, front toward the enemy).' },
};
export const placeOf = (p) => (PLACE_INFO[p] ? p : 'auto');

export const hullClassFor =(blocks) => HULL_CLASSES.find((c) => blocks <= c.maxBlocks) || null;

export function countBlocks(d) {
  let n = 0;
  for (let i = 0; i < d.cells.length; i++) if (d.cells[i]) n++;
  return n;
}

export function designCost(d) {
  let c = 0;
  for (let i = 0; i < d.cells.length; i++) if (d.cells[i]) c += BLOCKS[d.cells[i]].cost;
  return c;
}

/**
 * A weapon's line of fire for an undamaged ship, exactly as Battle.facing() works it out:
 * { omni, buried, m0, m1, arcDeg }. m0/m1 is the open-direction mask from arcs.js.
 */
export function weaponFacing(cells, w, h, cell, group = null) {
  const out = lineOfFire(cells, null, w, h, cell, { m0: 0, m1: 0, buried: false }, group);
  return { omni: false, buried: out.buried, m0: out.m0, m1: out.m1, arcDeg: openDegrees(out.m0, out.m1) };
}

/** Connected groups of multi-block weapon cells (the sim treats each group as one gun). */
export function multiblockGroups(cells, w, h) {
  const seen = new Uint8Array(cells.length), groups = [];
  for (let i = 0; i < cells.length; i++) {
    const t = cells[i];
    if (!MULTIBLOCK[t] || seen[i]) continue;
    const g = [i];
    seen[i] = 1;
    for (let k = 0; k < g.length; k++) {
      const c = g[k], x = c % w;
      for (const n of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c - w, c + w])
        if (n >= 0 && n < cells.length && !seen[n] && cells[n] === t) { seen[n] = 1; g.push(n); }
    }
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (const c of g) { const x = c % w, y = (c / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const size = MULTIBLOCK[t].size;
    const ok = g.length === size * size && x1 - x0 + 1 === size && y1 - y0 + 1 === size;
    groups.push({ type: t, cells: g, x0, y0, x1, y1, ok });
  }
  return groups;
}

/** Cells 4-connected to the hub (the sim's break-up flood fill uses the same rule). */
export function connectedToHub(cells, w, h, hub) {
  const on = new Uint8Array(cells.length);
  if (hub < 0 || !cells[hub]) return on;
  const q = [hub];
  on[hub] = 1;
  for (let k = 0; k < q.length; k++) {
    const c = q[k], x = c % w;
    for (const n of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c - w, c + w])
      if (n >= 0 && n < cells.length && cells[n] && !on[n]) { on[n] = 1; q.push(n); }
  }
  return on;
}

/**
 * Everything the designer shows about a design, plus whether it can be saved.
 * `d` is a saved-format design: { name, w, h, cells, hub, stance }. Analyse the cropped design
 * (see cropDesign) because turn rate depends on the grid width.
 */
export function analyzeDesign(d) {
  const { w, h, cells } = d;
  const errors = [], warnings = [];
  let blocks = 0, cost = 0, mass = 0, thrust = 0, hp = 0, hubs = 0;
  const byType = {};
  for (let i = 0; i < cells.length; i++) {
    const t = cells[i];
    if (!t) continue;
    const B = BLOCKS[t];
    blocks++; cost += B.cost; mass += B.mass; hp += B.hp;
    if (t === BT.THRUSTER) thrust += B.thrust;
    if (t === BT.HUB) hubs++;
    byType[t] = (byType[t] || 0) + 1;
  }

  // Mobility, exactly as Battle.refit() computes it.
  mass = Math.max(1, mass);
  const maxSpeed = Math.max(2.5, Math.min(22, (30 * thrust) / mass));
  const turn = Math.max(0.05, Math.min(2.5, (1.6 * maxSpeed) / w));

  // Weapons: single-block guns, then one gun per heavy-laser unit.
  const weapons = [];
  for (let i = 0; i < cells.length; i++) {
    const t = cells[i];
    if (!isWeapon(t) || MULTIBLOCK[t]) continue;
    weapons.push({ type: t, cell: i, x: (i % w) + 0.5, y: ((i / w) | 0) + 0.5, ...weaponFacing(cells, w, h, i) });
  }
  const groups = multiblockGroups(cells, w, h);
  for (const g of groups) {
    let sx = 0, sy = 0;
    for (const c of g.cells) { sx += (c % w) + 0.5; sy += ((c / w) | 0) + 0.5; }
    const wf = weaponFacing(cells, w, h, g.cells[0], g.cells);
    // A fighter bay with no straight line out can still launch along a path with corners (bayRoute).
    if (g.type === BT.BAY && wf.buried) { wf.route = bayRoute(cells, null, w, h, g.cells); if (wf.route) wf.buried = false; }
    weapons.push({ type: g.type, cell: g.cells[0], x: sx / g.cells.length, y: sy / g.cells.length, ...wf, group: g });
  }

  const fire = {};
  let dps = 0, alpha = 0;
  for (const wp of weapons) {
    const W = WEAPON[wp.type], f = (fire[wp.type] ||= { count: 0, buried: 0, dps: 0, alpha: 0, range: W.range });
    f.count++;
    if (wp.buried) { f.buried++; continue; }
    const shot = W.damage * (W.fragments || 1) * (W.salvo || 1); // flak: a whole salvo of shrapnel bursts
    f.dps += shot / W.cooldown; f.alpha += shot;
    dps += shot / W.cooldown; alpha += shot; // point defence counts too: it's a real anti-ship gun now (32 every 0.2 s)
  }
  const ranges = weapons.filter((x) => x.type !== BT.PD && !x.buried).map((x) => WEAPON[x.type].range);

  // ---- validation
  const cls = hullClassFor(blocks);
  if (hubs === 0) errors.push('The ship needs a hub.');
  else if (hubs > 1) errors.push('A ship can only have one hub.');
  else if (cells[d.hub] !== BT.HUB) errors.push('Hub position is out of date.');
  if (blocks > MAX_BLOCKS) errors.push(`Too many blocks: ${blocks} (titan limit is ${MAX_BLOCKS}).`);
  if (w > MAX_W || h > MAX_H) errors.push(`Too big: ${w}×${h} (limit ${MAX_W}×${MAX_H}).`);
  const linked = connectedToHub(cells, w, h, hubs === 1 ? d.hub : -1);
  const loose = [];
  if (hubs === 1) for (let i = 0; i < cells.length; i++) if (cells[i] && !linked[i]) loose.push(i);
  if (loose.length) errors.push(`${loose.length} block${loose.length > 1 ? 's are' : ' is'} not connected to the hub.`);
  const badGroups = groups.filter((g) => !g.ok);
  if (badGroups.some((g) => g.type === BT.LANCE)) errors.push('Plasma cannons must be whole 10×10 units, not touching each other.');
  if (badGroups.some((g) => g.type === BT.FLAK)) errors.push('Flak cannons must be whole 10×10 units, not touching each other.');
  if (badGroups.some((g) => g.type === BT.BAY)) errors.push(`Fighter bays must be whole ${MULTIBLOCK[BT.BAY].size}×${MULTIBLOCK[BT.BAY].size} units, not touching each other.`);

  if (!weapons.length) warnings.push('No weapons: the ship counts as a disarmed hulk in battle.');
  else if (!weapons.some((x) => x.type !== BT.PD)) warnings.push(`Only point defence: it can only hit ships within ${WEAPON[BT.PD].range}.`);
  else if (!weapons.some((x) => x.type !== BT.PD && x.type !== BT.BAY)) warnings.push('Only fighter bays (and point defence): the ship fights through its fighters alone.');
  const sealed = weapons.filter((x) => x.buried && x.type === BT.BAY);
  if (sealed.length) warnings.push(`${sealed.length} fighter bay${sealed.length > 1 ? 's are' : ' is'} sealed in: fighters need a way out, so give ${sealed.length > 1 ? 'each' : 'it'} a side on the hull edge or a tunnel of empty cells to space (it can turn corners).`);
  const buried = weapons.filter((x) => x.buried && x.type !== BT.BAY);
  if (buried.length) warnings.push(`${buried.length} weapon${buried.length > 1 ? 's are' : ' is'} buried: every shot would hit your own hull, so ${buried.length > 1 ? 'they' : 'it'} can't fire until the armour around ${buried.length > 1 ? 'them' : 'it'} is shot away.`);
  const narrow = weapons.filter((x) => !x.omni && !x.buried && x.arcDeg < 45 && x.type !== BT.BAY);
  if (narrow.length) warnings.push(`${narrow.length} weapon${narrow.length > 1 ? 's have' : ' has'} a firing arc under 45°. Guns that stick out of the hull can cover more.`);
  if (!thrust && blocks > 1) warnings.push('No thrusters: the ship crawls on hub jets (2.5 speed).');
  if (groups.some((g) => g.type === BT.LANCE)) warnings.push(`FRIENDLY FIRE: plasma bolts carve through your own ships too. Plasma cannon blocks also explode when destroyed and chain-react, wrecking everything within about ${COOKOFF.radius} blocks of the gun, your own ship included. Armour it well.`);

  return {
    blocks, cost, mass, hp, thrust, maxSpeed, turn, turnDeg: (turn * 180) / Math.PI,
    hullClass: cls, byType, weapons, fire, dps, alpha,
    minRange: ranges.length ? Math.min(...ranges) : 0, maxRange: ranges.length ? Math.max(...ranges) : 0,
    loose, badGroups, errors, warnings, ok: errors.length === 0,
  };
}

/**
 * Crop an editor grid to the blocks actually placed and return a saved-format design.
 * `grid` is { w, h, cells, hub, name, stance, place } at editor size.
 */
export function cropDesign(grid) {
  const { w, h, cells } = grid;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, hub = -1;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (cells[i] === BT.HUB && hub < 0) hub = i;
  }
  if (x1 < 0) return { name: grid.name, cls: 'corvette', w: 1, h: 1, cells: new Uint8Array(1), hub: 0, stance: grid.stance, place: placeOf(grid.place), x0: 0, y0: 0 };
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = cells[(y + y0) * w + x + x0];
  const hubC = hub < 0 ? -1 : (((hub / w) | 0) - y0) * cw + (hub % w) - x0;
  const cls = hullClassFor(countBlocks({ cells: out }));
  return { name: grid.name, cls: cls ? cls.id : 'titan', w: cw, h: ch, cells: out, hub: hubC, stance: grid.stance, place: placeOf(grid.place), x0, y0 };
}

// ---------------------------------------------------------------- save / load (JSON)
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Design -> plain JSON object (cells as base64). Round-trips with decodeDesign. */
export function encodeDesign(d) {
  // `place` only when it isn't Auto, so designs saved before start positions encode exactly as before.
  const place = placeOf(d.place);
  return { format: 'lsb-design', version: 1, name: d.name, cls: d.cls, stance: d.stance, ...(place !== 'auto' ? { place } : {}), w: d.w, h: d.h, hub: d.hub, cells: toB64(d.cells) };
}

/** JSON object (cells as base64 or a plain array) -> design with a Uint8Array. Throws if malformed. */
export function decodeDesign(o) {
  if (!o || typeof o !== 'object') throw new Error('Not a ship design.');
  const w = o.w | 0, h = o.h | 0;
  if (w < 1 || h < 1 || w > MAX_W || h > MAX_H) throw new Error('Design size is out of range.');
  const cells = typeof o.cells === 'string' ? fromB64(o.cells) : Uint8Array.from(o.cells || []);
  if (cells.length !== w * h) throw new Error('Design cells don\'t match its size.');
  for (const t of cells) if (t && !BLOCKS[t]) throw new Error(`Unknown block type ${t}.`);
  return { name: String(o.name || 'Unnamed').slice(0, 40), cls: o.cls, stance: STANCE_INFO[o.stance] ? o.stance : 'line', place: placeOf(o.place), w, h, cells, hub: o.hub | 0 };
}
