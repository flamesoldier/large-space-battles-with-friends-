// Ship analysis shared by the ship designer, the server and (later) shipyards and fleets:
// price, mobility, firepower, weapon arcs and design validation.
//
// Mobility mirrors Battle.refit() in src/sim/battle.js exactly, and arcs use the same
// lineOfFire() as Battle.facing(), so
// what the designer shows is what the ship does in battle. tools/test-designer.mjs checks that
// the two agree; if you change the formulas in battle.js, change them here too.

import { BT, BLOCKS, WEAPON, MULTIBLOCK, HULL_CLASSES, MAX_BLOCKS, MAX_W, MAX_H, isWeapon } from './blocks.js';
import { lineOfFire, openDegrees } from './arcs.js';

export const STANCE_INFO = {
  charge: { label: 'Charge', hint: 'Dives straight in to point blank. For small, fast, cheap ships.' },
  brawl: { label: 'Brawler', hint: 'Fights at 40% of its shortest gun range, inside the enemy\'s big guns.' },
  line: { label: 'Line', hint: 'Holds at 60% of its main gun range and trades broadsides.' },
  standoff: { label: 'Standoff', hint: 'Hangs at the edge of gun range and backs off if pressed. For long-range ships.' },
  escort: { label: 'Escort', hint: 'Screens a friendly ship 3× its mass or more, breaking off to hit enemies that come close.' },
};

export const hullClassFor = (blocks) => HULL_CLASSES.find((c) => blocks <= c.maxBlocks) || null;

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
export function weaponFacing(cells, w, h, cell) {
  const t = cells[cell];
  if (t === BT.MISSILE || t === BT.LANCE) return { omni: true, buried: false, m0: 0, m1: 0, arcDeg: 360 };
  const out = lineOfFire(cells, null, w, h, cell, { m0: 0, m1: 0, buried: false });
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
    weapons.push({ type: g.type, cell: g.cells[0], x: sx / g.cells.length, y: sy / g.cells.length, omni: true, buried: false, m0: 0, m1: 0, arcDeg: 360, group: g });
  }

  const fire = {};
  let dps = 0, alpha = 0;
  for (const wp of weapons) {
    const W = WEAPON[wp.type], f = (fire[wp.type] ||= { count: 0, buried: 0, dps: 0, alpha: 0, range: W.range });
    f.count++;
    if (wp.buried) { f.buried++; continue; }
    f.dps += W.damage / W.cooldown; f.alpha += W.damage;
    if (wp.type !== BT.PD) { dps += W.damage / W.cooldown; alpha += W.damage; }
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
  if (badGroups.length) errors.push('Heavy lasers must be whole 10×10 units, not touching each other.');

  if (!weapons.length) warnings.push('No weapons: the ship counts as a disarmed hulk in battle.');
  else if (!weapons.some((x) => x.type !== BT.PD)) warnings.push('Only point defence: it can only hit things within 30.');
  const buried = weapons.filter((x) => x.buried);
  if (buried.length) warnings.push(`${buried.length} weapon${buried.length > 1 ? 's are' : ' is'} buried: every shot would hit your own hull, so ${buried.length > 1 ? 'they' : 'it'} can't fire until the armour around ${buried.length > 1 ? 'them' : 'it'} is shot away.`);
  const narrow = weapons.filter((x) => !x.omni && !x.buried && x.arcDeg < 45);
  if (narrow.length) warnings.push(`${narrow.length} weapon${narrow.length > 1 ? 's have' : ' has'} a firing arc under 45°. Guns that stick out of the hull can cover more.`);
  if (!thrust && blocks > 1) warnings.push('No thrusters: the ship crawls on hub jets (2.5 speed).');
  if (d.stance === 'escort' && cls && cls.id !== 'corvette' && cls.id !== 'frigate' && cls.id !== 'destroyer')
    warnings.push('Escorts only screen ships 3× their mass, so big escorts rarely find a ship to guard.');

  return {
    blocks, cost, mass, hp, thrust, maxSpeed, turn, turnDeg: (turn * 180) / Math.PI,
    hullClass: cls, byType, weapons, fire, dps, alpha,
    minRange: ranges.length ? Math.min(...ranges) : 0, maxRange: ranges.length ? Math.max(...ranges) : 0,
    loose, badGroups, errors, warnings, ok: errors.length === 0,
  };
}

/**
 * Crop an editor grid to the blocks actually placed and return a saved-format design.
 * `grid` is { w, h, cells, hub, name, stance } at editor size.
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
  if (x1 < 0) return { name: grid.name, cls: 'corvette', w: 1, h: 1, cells: new Uint8Array(1), hub: 0, stance: grid.stance, x0: 0, y0: 0 };
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = cells[(y + y0) * w + x + x0];
  const hubC = hub < 0 ? -1 : (((hub / w) | 0) - y0) * cw + (hub % w) - x0;
  const cls = hullClassFor(countBlocks({ cells: out }));
  return { name: grid.name, cls: cls ? cls.id : 'titan', w: cw, h: ch, cells: out, hub: hubC, stance: grid.stance, x0, y0 };
}

// ---------------------------------------------------------------- save / load (JSON)
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Design -> plain JSON object (cells as base64). Round-trips with decodeDesign. */
export function encodeDesign(d) {
  return { format: 'lsb-design', version: 1, name: d.name, cls: d.cls, stance: d.stance, w: d.w, h: d.h, hub: d.hub, cells: toB64(d.cells) };
}

/** JSON object (cells as base64 or a plain array) -> design with a Uint8Array. Throws if malformed. */
export function decodeDesign(o) {
  if (!o || typeof o !== 'object') throw new Error('Not a ship design.');
  const w = o.w | 0, h = o.h | 0;
  if (w < 1 || h < 1 || w > MAX_W || h > MAX_H) throw new Error('Design size is out of range.');
  const cells = typeof o.cells === 'string' ? fromB64(o.cells) : Uint8Array.from(o.cells || []);
  if (cells.length !== w * h) throw new Error('Design cells don\'t match its size.');
  for (const t of cells) if (t && !BLOCKS[t]) throw new Error(`Unknown block type ${t}.`);
  return { name: String(o.name || 'Unnamed').slice(0, 40), cls: o.cls, stance: STANCE_INFO[o.stance] ? o.stance : 'line', w, h, cells, hub: o.hub | 0 };
}
