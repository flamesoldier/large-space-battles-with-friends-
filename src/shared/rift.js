// Doomsday Interdimensional Rift Engine (owner, 22 Nov 2026): where each green projectile is while a
// rift swirls. Shared by the battle sim (which releases the projectiles from these positions) and the
// replay viewer (which draws the swirl from them), so the swirl is never recorded: a rift record
// (centre, open and release ticks, count, seed) is enough, and the viewer stays a pure function of time.
//
// Shaped like the guided missiles that swirled in the owner's Elenris Minor replay (22 Nov 2026: "get the
// circling to look more similar to how the rockets circled"): measured there, each missile flew its own loop
// that kept passing back through the middle (loops ~40-90 blocks across, their centres 16-54 blocks off the
// middle), about half going each way round, so the loops overlap in a rosette with a bright knot at the
// centre. Here projectile k comes out of the rift's eye at spawnAt(k) and flies a circle of radius `rho`
// that passes within a quarter of rho of the eye, clockwise or anticlockwise, the circle slowly turning round
// the eye (PREC) and every projectile speeding up as the rift fills (ACCEL). At release each flies straight
// off along its circle, so they burst out in every direction.
import { WEAPON, BT } from './blocks.js';

export const RIFT_W = WEAPON[BT.RIFT];
const ACCEL = 0.6, PREC = 0.09; // speed at release = (1 + ACCEL) × W.orbit; circles turn round the eye at PREC rad/s

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
 * (vx, vy) is the direction it flies off in if released now (unit length, along its circle); `r` its
 * distance from the eye, `rr` its circle's radius, `grow` 0 → 1 over its first 0.8 s.
 */
export function riftParticle(k, n, seed, a, out, W = RIFT_W) {
  const s = riftSpawnAt(k, n, W);
  if (a < s) return false;
  const T = W.swirl, h1 = riftHash(seed, k, 1), h2 = riftHash(seed, k, 2), h3 = riftHash(seed, k, 3), h5 = riftHash(seed, k, 5);
  const rho = W.radius * (0.28 + 0.22 * h1), dir = h3 < 0.5 ? 1 : -1;
  const tau = a - s, phi = h2 * 6.283 + dir * PREC * a, cd = rho * (1 + 0.5 * (h5 - 0.5));
  const L = W.orbit * (tau + (ACCEL * (a * a - s * s)) / (2 * T)); // distance flown round its circle
  const th = phi + Math.PI + (dir * L) / rho;
  const x = Math.cos(phi) * cd + Math.cos(th) * rho, y = Math.sin(phi) * cd + Math.sin(th) * rho;
  out.x = x; out.y = y; out.r = Math.hypot(x, y); out.rr = rho; out.grow = Math.min(1, tau / 0.8);
  const d = th + (dir * Math.PI) / 2;
  out.vx = Math.cos(d); out.vy = Math.sin(d);
  return true;
}

/** Release speed of projectile k, as a share of W.speed (85–115%, in 0.5% steps so the replay holds it exactly). */
export function riftSpeedStep(seed, k) {
  return 170 + Math.floor(riftHash(seed, k, 4) * 61); // × W.speed / 200
}
