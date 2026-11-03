// Line of fire: which directions a weapon can shoot without the shot passing through its own
// ship. Used by the battle sim (src/sim/battle.js) and the ship designer, so both always agree.
//
// Directions are split into ARC_BINS equal slices around the weapon, in the ship's local frame
// (+x is the nose, +y is increasing row). A slice is open if a ray from the centre of the
// weapon's block, along the middle of the slice, leaves the ship's grid without crossing any
// other live block of the same ship. The open slices are stored as a 64-bit mask in two
// 32-bit numbers (m0 = slices 0-31, m1 = slices 32-63).
//
// Every weapon uses this, including missile launchers and the 10x10 heavy laser.

export const ARC_BINS = 64;
const STEP = (2 * Math.PI) / ARC_BINS;
export const binAngle = (k) => -Math.PI + (k + 0.5) * STEP;
const DX = new Float64Array(ARC_BINS), DY = new Float64Array(ARC_BINS);
for (let k = 0; k < ARC_BINS; k++) { DX[k] = Math.cos(binAngle(k)); DY[k] = Math.sin(binAngle(k)); }

/** Which slice the local direction (lx, ly) falls in. */
export function binOf(lx, ly) {
  const k = ((Math.atan2(ly, lx) + Math.PI) / STEP) | 0;
  return k >= ARC_BINS ? ARC_BINS - 1 : k;
}

/** Is slice k open in mask (m0, m1)? */
export const binOpen = (m0, m1, k) => ((k < 32 ? m0 >>> k : m1 >>> (k - 32)) & 1) === 1;

/**
 * Work out the open slices for the weapon in `cell` and write them to `out`
 * (sets out.m0, out.m1, out.buried). `hp` may be null to treat every block as alive.
 * `group` (optional) is the list of cells of a multi-block weapon such as the 10x10 heavy laser:
 * rays then start from the centre of the group and pass through its own blocks.
 */
export function lineOfFire(types, hp, w, h, cell, out, group = null) {
  // A multi-block gun is a solid rectangle (validated), so "its own block" is a box test.
  let ox, oy, bx0 = 1, by0 = 1, bx1 = 0, by1 = 0;
  if (group) {
    bx0 = w; by0 = h; bx1 = 0; by1 = 0;
    for (const c of group) { const x = c % w, y = (c / w) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    ox = (bx0 + bx1 + 1) / 2; oy = (by0 + by1 + 1) / 2;
  } else { ox = (cell % w) + 0.5; oy = ((cell / w) | 0) + 0.5; }
  let m0 = 0, m1 = 0;
  for (let k = 0; k < ARC_BINS; k++) {
    const dx = DX[k], dy = DY[k];
    // Grid walk (Amanatides & Woo) from the origin out of the ship's grid.
    let ix = Math.floor(ox), iy = Math.floor(oy);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx > 0 ? (ix + 1 - ox) * tdx : dx < 0 ? (ox - ix) * tdx : Infinity;
    let tmy = dy > 0 ? (iy + 1 - oy) * tdy : dy < 0 ? (oy - iy) * tdy : Infinity;
    let clear = true;
    for (;;) {
      if (tmx < tmy) { ix += sx; tmx += tdx; } else { iy += sy; tmy += tdy; }
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) break; // left the ship: clear shot
      const c = iy * w + ix;
      if (ix >= bx0 && ix <= bx1 && iy >= by0 && iy <= by1) continue; // passing through its own gun
      if (types[c] && (!hp || hp[c] > 0)) { clear = false; break; }
    }
    if (clear) { if (k < 32) m0 |= 1 << k; else m1 |= 1 << (k - 32); }
  }
  out.m0 = m0 >>> 0; out.m1 = m1 >>> 0;
  out.buried = m0 === 0 && m1 === 0; // nowhere to shoot until the hull around it is shot away
  return out;
}

/** Total open angle of a mask, in degrees. */
export function openDegrees(m0, m1) {
  let n = 0;
  for (let k = 0; k < ARC_BINS; k++) if (binOpen(m0, m1, k)) n++;
  return (n * 360) / ARC_BINS;
}
