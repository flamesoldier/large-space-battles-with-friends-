// Procedural planet sprites for the galaxy map (cosmetic only: nothing here touches game state).
//
// Each world gets a type from a hash of the galaxy seed and its id (home worlds are always
// Earth-like). The surface is 3D value noise sampled on the sphere itself, so there is no seam
// or pole pinch, lit from the upper left with a soft terminator and an atmosphere rim. Sprites are
// rendered once per world and resolution and cached; the map asks for the size it needs.

import { hash32, mulberry32 } from '../shared/rng.js';

// ---------------------------------------------------------------- noise
function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (a, b, c) => hash32(Math.imul(a, 0x8da6b343) ^ Math.imul(b, 0xd8163841) ^ Math.imul(c, 0xcb1ab31f) ^ seed) / 4294967296;
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}
function fbm(x, y, z, seed, oct = 5) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let k = 0; k < oct; k++) { s += a * noise3(x * f, y * f, z * f, seed + k * 1013); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
const smooth = (a, b, t) => { const x = Math.max(0, Math.min(1, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Pick from a list of [stop, colour] by t in 0..1. */
function ramp(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) if (t <= stops[k][0]) return mixc(stops[k - 1][1], stops[k][1], (t - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0]));
  return stops[stops.length - 1][1];
}

// ---------------------------------------------------------------- planet types
// Each type: surface(p, n) → [r, g, b] (0..255), plus emissive glow, clouds and atmosphere colour.
const TYPES = {
  terran: {
    atmo: '#7cc4ff', atmoStrength: 0.9, clouds: 0.55,
    surface(x, y, z, s) {
      const e = fbm(x * 1.6, y * 1.6, z * 1.6, s) + 0.12 * fbm(x * 6, y * 6, z * 6, s + 9);
      const lat = Math.abs(y);
      if (lat + 0.08 * fbm(x * 5, y * 5, z * 5, s + 3) > 0.86) return hex('#e9f2fb');
      if (e < 0.575) return ramp([[0.3, hex('#0c2752')], [0.53, hex('#1d5aa0')], [0.575, hex('#3b8fc4')]], e);
      return ramp([[0.575, hex('#c9b98a')], [0.59, hex('#4f8a3a')], [0.65, hex('#2f6a2c')], [0.71, hex('#7a6a48')], [0.77, hex('#d9d3c7')]], e);
    },
  },
  ocean: {
    atmo: '#68d8ff', atmoStrength: 0.9, clouds: 0.62,
    surface(x, y, z, s) {
      const e = fbm(x * 2, y * 2, z * 2, s);
      if (e > 0.66) return ramp([[0.66, hex('#d8c99a')], [0.72, hex('#3f7f52')]], e);
      return ramp([[0.25, hex('#06213f')], [0.5, hex('#0e4f86')], [0.66, hex('#2a9cc4')]], e);
    },
  },
  desert: {
    atmo: '#ffc98a', atmoStrength: 0.6,
    surface(x, y, z, s) {
      const e = fbm(x * 2.2, y * 2.2, z * 2.2, s), d = fbm(x * 9, y * 4, z * 9, s + 7);
      return ramp([[0.3, hex('#7a4521')], [0.45, hex('#b8743c')], [0.6, hex('#dcae6a')], [0.75, hex('#f0d29a')]], e * 0.8 + d * 0.2);
    },
  },
  ice: {
    atmo: '#cfeaff', atmoStrength: 0.55,
    surface(x, y, z, s) {
      const e = fbm(x * 2.4, y * 2.4, z * 2.4, s);
      const crack = Math.abs(fbm(x * 4, y * 4, z * 4, s + 5) - 0.5) < 0.018;
      return crack ? hex('#5f8fbf') : ramp([[0.3, hex('#9cc2e4')], [0.55, hex('#dbeaf7')], [0.75, hex('#ffffff')]], e);
    },
  },
  lava: {
    atmo: '#ff7a3c', atmoStrength: 0.5,
    surface(x, y, z, s) {
      const e = fbm(x * 2.5, y * 2.5, z * 2.5, s);
      return ramp([[0.3, hex('#120c0b')], [0.55, hex('#2b1d19')], [0.75, hex('#4a3a33')]], e);
    },
    glow(x, y, z, s) {
      const c = Math.abs(fbm(x * 3, y * 3, z * 3, s + 11) - 0.5);
      return smooth(0.045, 0.0, c) * 1.0 + smooth(0.62, 0.8, fbm(x * 2, y * 2, z * 2, s + 2)) * 0.6;
    },
    glowColor: '#ff6a1f',
  },
  barren: {
    atmo: '#b8c2d0', atmoStrength: 0.15, craters: 14,
    surface(x, y, z, s) {
      const e = fbm(x * 2.5, y * 2.5, z * 2.5, s);
      return ramp([[0.3, hex('#3d3f45')], [0.55, hex('#77777a')], [0.75, hex('#a9a6a0')]], e);
    },
  },
  gas: {
    atmo: '#ffd9a8', atmoStrength: 0.45, bands: true,
    surface(x, y, z, s, pal) {
      const t = y * 3.2 + 0.35 * fbm(x * 1.5, y * 6, z * 1.5, s) + 0.08 * fbm(x * 5, y * 18, z * 5, s + 4);
      const k = 0.5 + 0.5 * Math.sin(t * 4.2 + (s % 7));
      return ramp(pal, k);
    },
  },
  toxic: {
    atmo: '#c8ff6a', atmoStrength: 0.85, bands: true,
    surface(x, y, z, s) {
      const t = y * 2.2 + 0.4 * fbm(x * 2, y * 5, z * 2, s);
      return ramp([[0, hex('#4e5a17')], [0.5, hex('#9aa72c')], [1, hex('#d9d76a')]], 0.5 + 0.5 * Math.sin(t * 5));
    },
  },
};
const GAS_PALETTES = [
  [[0, hex('#7a4a2a')], [0.4, hex('#c99a63')], [0.7, hex('#ead6b0')], [1, hex('#a5643a')]],
  [[0, hex('#24486e')], [0.45, hex('#5d8fb8')], [0.75, hex('#bfd9e8')], [1, hex('#33607f')]],
  [[0, hex('#5d3e6e')], [0.45, hex('#a07fb5')], [0.8, hex('#e2d3e8')], [1, hex('#6b4a7a')]],
];
const WEIGHTS = [['barren', 18], ['desert', 15], ['gas', 18], ['ice', 13], ['ocean', 11], ['lava', 10], ['toxic', 8], ['terran', 5]];

/** Cosmetic look of a world: { type, seed, tilt, ring, palette }. Deterministic. */
export function planetLook(galaxySeed, planet) {
  const r = mulberry32(hash32(galaxySeed * 7919 + planet.id * 104729 + 17));
  let type = 'terran';
  if (planet.home < 0) {
    let roll = r() * WEIGHTS.reduce((a, [, w]) => a + w, 0);
    for (const [t, w] of WEIGHTS) { roll -= w; if (roll <= 0) { type = t; break; } }
  }
  return {
    type, seed: (r() * 1e9) | 0, tilt: (r() - 0.5) * 0.9, spin: r() * Math.PI * 2,
    ring: type === 'gas' ? r() < 0.6 : type === 'ice' ? r() < 0.15 : false,
    ringAngle: (r() - 0.5) * 0.8, palette: GAS_PALETTES[(r() * GAS_PALETTES.length) | 0],
  };
}

// ---------------------------------------------------------------- rendering
const LIGHT = (() => { const v = [-0.55, -0.5, 0.67], l = Math.hypot(...v); return v.map((c) => c / l); })();

/** Render the lit planet body into a size×size canvas. */
function renderBody(look, size) {
  const c = new OffscreenCanvasOr(size, size), x = c.getContext('2d');
  const img = x.createImageData(size, size), d = img.data;
  const T = TYPES[look.type], s = look.seed;
  const ct = Math.cos(look.tilt), st = Math.sin(look.tilt), cs = Math.cos(look.spin), ss = Math.sin(look.spin);
  const atmo = hex(T.atmo), glowC = T.glowColor ? hex(T.glowColor) : null;
  // Crater centres on the unit sphere.
  const craters = [];
  if (T.craters) { const r = mulberry32(s); for (let k = 0; k < T.craters; k++) { const u = r() * 2 - 1, a = r() * Math.PI * 2, q = Math.sqrt(1 - u * u); craters.push([q * Math.cos(a), u, q * Math.sin(a), 0.06 + r() * r() * 0.22]); } }
  const half = size / 2;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const nx = (i + 0.5 - half) / half, ny = (j + 0.5 - half) / half, d2 = nx * nx + ny * ny;
    if (d2 > 1) continue;
    const nz = Math.sqrt(1 - d2);
    // Rotate the view normal into planet space (spin about y, then axial tilt about z).
    let px = nx * cs + nz * ss, pz = -nx * ss + nz * cs, py = ny;
    const tx = px * ct - py * st; py = px * st + py * ct; px = tx;
    let col = T.surface(px, py, pz, s, look.palette);
    for (const [cx, cy, cz, cr] of craters) {
      const dd = Math.acos(Math.max(-1, Math.min(1, px * cx + py * cy + pz * cz)));
      if (dd < cr) { const t = dd / cr; col = mixc(col, t > 0.8 ? [190, 188, 182] : [40, 40, 44], t > 0.8 ? (t - 0.8) * 2.5 : 0.45 * (1 - t)); }
    }
    if (T.clouds) {
      const cl = smooth(T.clouds, T.clouds + 0.16, fbm(px * 2.6 + 9, py * 4.2, pz * 2.6, s + 77));
      col = mixc(col, [245, 248, 255], cl * 0.9);
    }
    // Light: soft terminator, faint ambient, a little specular on water worlds.
    const lam = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
    const lit = 0.05 + 0.95 * smooth(-0.15, 0.55, lam);
    let r = col[0] * lit, g = col[1] * lit, b = col[2] * lit;
    if (look.type === 'ocean' || look.type === 'terran') { const sp = Math.pow(Math.max(0, lam), 28) * 70; r += sp; g += sp; b += sp; }
    // Atmosphere: brighter towards the limb on the lit side.
    const rim = Math.pow(1 - nz, 2.2) * T.atmoStrength * (0.25 + 0.75 * smooth(-0.3, 0.4, lam));
    r += (atmo[0] - r) * rim * 0.8; g += (atmo[1] - g) * rim * 0.8; b += (atmo[2] - b) * rim * 0.8;
    if (T.glow) { const gl = T.glow(px, py, pz, s) * (0.55 + 0.45 * (1 - lit)); r += glowC[0] * gl; g += glowC[1] * gl; b += glowC[2] * gl; }
    // Anti-aliased edge.
    const edge = Math.min(1, (1 - Math.sqrt(d2)) * half * 1.5);
    const o = (j * size + i) * 4;
    d[o] = Math.min(255, r); d[o + 1] = Math.min(255, g); d[o + 2] = Math.min(255, b); d[o + 3] = 255 * edge;
  }
  x.putImageData(img, 0, 0);
  return c;
}

function OffscreenCanvasOr(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/** Sprite: body plus halo and rings. The body's radius is size/2 and it sits in the middle of a canvas PAD×size wide. */
export const SPRITE_PAD = 2.4;
function renderSprite(look, size) {
  const C = Math.ceil(size * SPRITE_PAD), c = new OffscreenCanvasOr(C, C), x = c.getContext('2d'), m = C / 2, pr = size / 2;
  const T = TYPES[look.type];
  // Halo.
  const atmo = hex(T.atmo), halo = x.createRadialGradient(m, m, pr * 0.95, m, m, pr * (1.18 + T.atmoStrength * 0.18));
  halo.addColorStop(0, `rgba(${atmo.join(',')},${0.32 * T.atmoStrength + 0.05})`); halo.addColorStop(1, `rgba(${atmo.join(',')},0)`);
  x.fillStyle = halo; x.fillRect(0, 0, C, C);
  const ring = (front) => {
    if (!look.ring) return;
    x.save(); x.translate(m, m); x.rotate(look.ringAngle); x.scale(1, 0.28);
    x.beginPath(); x.rect(-C, front ? 0 : -C, 2 * C, C); x.clip();
    const r = mulberry32(look.seed + 5);
    for (let k = 0; k < 26; k++) {
      const rr = pr * (1.32 + k * 0.026), a = (0.12 + r() * 0.4) * (k > 9 && k < 12 ? 0.15 : 1);
      x.strokeStyle = look.type === 'ice' ? `rgba(200,225,245,${a})` : `rgba(${ramp(look.palette, 0.55 + 0.4 * r()).map((v) => v | 0).join(',')},${a})`;
      x.lineWidth = pr * 0.03 / 0.28 * 0.35;
      x.beginPath(); x.arc(0, 0, rr, 0, Math.PI * 2); x.stroke();
    }
    x.restore();
  };
  ring(false);
  x.drawImage(renderBody(look, size), m - pr, m - pr);
  ring(true);
  return c;
}

// ---------------------------------------------------------------- cache with levels of detail
const LEVELS = [48, 112, 256];
export class PlanetSprites {
  constructor() { this.cache = new Map(); this.budgetUntil = 0; }
  reset() { this.cache.clear(); }
  /**
   * Best sprite for a world drawn at `px` device pixels across (the body). Renders missing levels
   * within a small time budget per frame, falling back to a smaller level meanwhile.
   * Returns { canvas, bodyPx } or null if nothing is ready yet.
   */
  get(key, look, px, now) {
    let e = this.cache.get(key);
    if (!e) this.cache.set(key, (e = { look, levels: [] }));
    const want = LEVELS.findIndex((s) => s >= px * 0.9);
    const lvl = want < 0 ? LEVELS.length - 1 : want;
    if (!e.levels[lvl] && performance.now() < this.budgetUntil) e.levels[lvl] = renderSprite(look, LEVELS[lvl]);
    for (let k = lvl; k >= 0; k--) if (e.levels[k]) return { canvas: e.levels[k], bodyPx: LEVELS[k] };
    for (let k = lvl + 1; k < LEVELS.length; k++) if (e.levels[k]) return { canvas: e.levels[k], bodyPx: LEVELS[k] };
    if (!e.levels[0]) { e.levels[0] = renderSprite(look, LEVELS[0]); return { canvas: e.levels[0], bodyPx: LEVELS[0] }; }
    return null;
  }
  /** Allow `ms` of sprite rendering from now (call once per frame). */
  budget(ms) { this.budgetUntil = performance.now() + ms; }
}
