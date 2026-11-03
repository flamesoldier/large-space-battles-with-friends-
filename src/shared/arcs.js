// Line of fire: which directions a weapon can shoot without the shot passing through its own
// ship. Used by the battle sim (src/sim/battle.js) and the ship designer, so both always agree.
//
// Directions are split into ARC_BINS equal slices around the weapon, in the ship's local frame
// (+x is the nose, +y is increasing row). A slice is open if a ray from the centre of the
// weapon's block, along the middle of the slice, leaves the ship's grid without crossing any
// other live block of the same ship. The open slices are stored as a 64-bit mask in two
// 32-bit numbers (m0 = slices 0-31, m1 = slices 32-63).
//
// Missile launchers and heavy lasers don't use this: they fire in any direction.

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
 */
export function lineOfFire(types, hp, w, h, cell, out) {
  const x = cell % w, y = (cell / w) | 0;
  let m0 = 0, m1 = 0;
  for (let k = 0; k < ARC_BINS; k++) {
    const dx = DX[k], dy = DY[k];
    // Grid walk (Amanatides & Woo) from the centre of the weapon's block.
    let ix = x, iy = y;
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx !== 0 ? 0.5 * tdx : Infinity, tmy = dy !== 0 ? 0.5 * tdy : Infinity;
    let clear = true;
    for (;;) {
      if (tmx < tmy) { ix += sx; tmx += tdx; } else { iy += sy; tmy += tdy; }
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) break; // left the ship: clear shot
      const c = iy * w + ix;
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
