// Small, fast, seedable random helpers. Used by the sim (seeded, reproducible)
// and by the viewer (stateless hashes so effects can be scrubbed in any direction).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash32(x) {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Stateless random in [0,1) from two integers. */
export function hash01(a, b) {
  return hash32(Math.imul(a, 0x9e3779b1) ^ hash32(b + 0x632be5ab)) / 4294967296;
}

export const randRange = (r, lo, hi) => lo + (hi - lo) * r();
export const randInt = (r, lo, hi) => lo + Math.floor((hi - lo + 1) * r());
