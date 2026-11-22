// Doomsday Interdimensional Rift Engine (owner, 22 Nov 2026): where each green projectile is while a
// rift swirls. Shared by the battle sim (which releases the projectiles from these positions) and the
// replay viewer (which draws the swirl from them), so the swirl is never recorded: a rift record
// (centre, open and release ticks, count, seed) is enough, and the viewer stays a pure function of time.
//
// Projectile k of n comes out of the rift's centre at spawnAt(k), spirals out to its own orbit over
// GROW_S seconds and circles there, every one the same way round; the whole vortex speeds up as it
// fills (ACCEL), so by release they are whipping round at 2.5× their first speed. At release each flies
// off along its orbit bent outward by OUT_BEND, so they burst out in every direction like a pinwheel.

import { WEAPON, BT } from './blocks.js';

export const RIFT_W = WEAPON[BT.RIFT];
const GROW_S = 1.6, ACCEL = 1.5, OUT_BEND = 0.75;

/** Cheap repeatable hash in [0, 1). */
export function riftHash(seed, k, j) {
  let h = (seed * 374761393 + k * 668265263 + j * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Seconds after the rift opens that projectile k of n appears (the last at 92% of the swirl). */
export function riftSpawnAt(k, n, W = RIFT_W) {
  return W.swirl * 0.92 * (k / Math.max(1, n));
}

/**
 * Where projectile k of n is, `a` seconds after its rift opened, relative to the rift's centre.
 * Fills out { x, y, vx, vy, r, rr, grow } and returns true, or false if it hasn't appeared yet.
 * (vx, vy) is the direction it flies off in if released now (unit length); `rr` its orbit radius.
 */
export function riftParticle(k, n, seed, a, out, W = RIFT_W) {
  const s = riftSpawnAt(k, n, W);
  if (a < s) return false;
  const T = W.swirl, h1 = riftHash(seed, k, 1), h2 = riftHash(seed, k, 2), h3 = riftHash(seed, k, 3);
  const rr = W.radius * (0.22 + 0.78 * Math.sqrt(h1)); // more of them out towards the rim
  const tau = a - s, g = Math.min(1, tau / GROW_S), grow = 1 - (1 - g) ** 3;
  const r = Math.max(0.5, rr * grow * (1 + 0.07 * Math.sin(tau * 2.1 + h3 * 6.283)));
  const w0 = W.orbit / rr; // starting angular speed; the vortex speeds up as it fills: w(t) = w0 (1 + ACCEL t / T)
  const th = h2 * 6.283 + w0 * (tau + (ACCEL * (a * a - s * s)) / (2 * T));
  const c = Math.cos(th), sn = Math.sin(th);
  out.x = c * r; out.y = sn * r; out.r = r; out.rr = rr; out.grow = grow;
  const d = th + Math.PI / 2 - OUT_BEND; // counter-clockwise, bent outward
  out.vx = Math.cos(d); out.vy = Math.sin(d);
  return true;
}

/** Release speed of projectile k, as a share of W.speed (85–115%, in 0.5% steps so the replay holds it exactly). */
export function riftSpeedStep(seed, k) {
  return 170 + Math.floor(riftHash(seed, k, 4) * 61); // × W.speed / 200
}
