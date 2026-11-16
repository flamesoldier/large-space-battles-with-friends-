// The victory picture (owner, 16 Nov 2026): whoever holds the most worlds when the galaxy is won
// sits on a throne, their allies kneel at the foot of it, and the fallen players' banners hang torn
// at the sides of the hall. Pure SVG built from a few names and colours, so it costs nothing on
// the server and looks the same in every browser. Original artwork: no outside images.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** '#rrggbb' → [r, g, b]; anything else falls back to azure. */
function rgb(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (!m) return [134, 232, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (c, d, k) => { const a = rgb(c), b = rgb(d); return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`; };
const hex = (c) => { const [r, g, b] = rgb(c); return `rgb(${r},${g},${b})`; };

const W = 1200, CX = 600;
const FONT = `'Chakra Petch', 'Bahnschrift', 'Segoe UI', sans-serif`;

/** A figure kneeling in profile, facing +x, feet on y = 0. */
function kneeler(color, k) {
  const C = hex(color), dark = mix(color, '#0b0f17', 0.72), mid = mix(color, '#0b0f17', 0.42), lit = mix(color, '#ffffff', 0.4);
  return `
  <g>
    <ellipse cx="0" cy="2" rx="70" ry="7" fill="#000" opacity="0.6"/>
    <path d="M -4 -100 C -34 -94 -58 -60 -72 0 L -22 0 C -18 -30 -10 -62 8 -90 Z" fill="${mid}"/>
    <path d="M -4 -100 C -28 -92 -44 -62 -56 0 L -40 0 C -34 -36 -20 -64 4 -88 Z" fill="${C}"/>
    <path d="M -46 0 L -8 0 L -4 -14 L -44 -14 Z" fill="${dark}"/>
    <path d="M -12 -6 L -6 -54 L 32 -54 L 34 -40 L 8 -40 L 4 -4 Z" fill="${dark}"/>
    <path d="M 22 -50 L 36 -50 L 36 -6 L 50 -4 L 50 3 L 20 3 L 22 -8 Z" fill="${dark}"/>
    <path d="M -14 -52 L 16 -52 L 24 -98 L -8 -102 Z" fill="${dark}"/>
    <path d="M -8 -102 L 24 -98 L 22 -86 L -10 -90 Z" fill="${mid}"/>
    <path d="M -8 -102 L 24 -98" stroke="${lit}" stroke-width="2"/>
    <path d="M 4 -6 L 8 -40 L 34 -40" stroke="${C}" stroke-width="1.5" fill="none" opacity="0.8"/>
    <rect x="58" y="-66" width="4" height="66" fill="url(#tGold)"/>
    <rect x="49" y="-62" width="22" height="4" fill="url(#tGold)"/>
    <circle cx="60" cy="-70" r="4" fill="url(#tGold)"/>
    <path d="M 4 -94 C 16 -84 30 -72 44 -66 L 56 -66 L 56 -58 L 40 -58 C 24 -64 8 -74 -2 -86 Z" fill="${mid}"/>
    <path d="M 4 -94 C 16 -84 30 -72 44 -66" stroke="${lit}" stroke-width="1.5" fill="none" opacity="0.7"/>
    <g transform="translate(24 -106) rotate(32)">
      <path d="M -12 -2 C -12 -18 12 -18 12 -2 L 11 10 L -11 10 Z" fill="${dark}"/>
      <path d="M 1 1 L 11 1 L 11 4.5 L 1 4.5 Z" fill="${C}" filter="url(#tGlow)"/>
      <path d="M -12 -2 C -12 -18 12 -18 12 -2" stroke="${lit}" stroke-width="1.5" fill="none" opacity="0.7"/>
    </g>
  </g>`;
}

/** The figure on the throne, seen from the front, centred on x = 0; seat at y = 0. */
function sovereign(color) {
  const C = hex(color), dark = mix(color, '#05070c', 0.8), mid = mix(color, '#05070c', 0.5), lit = mix(color, '#ffffff', 0.45);
  return `
  <g>
    <path d="M -58 -110 C -86 -40 -96 30 -104 72 L 104 72 C 96 30 86 -40 58 -110 Z" fill="${mid}"/>
    <path d="M -58 -110 C -78 -40 -84 30 -90 72 L -70 72 C -64 20 -56 -40 -40 -100 Z" fill="${C}" opacity="0.7"/>
    <path d="M 58 -110 C 78 -40 84 30 90 72 L 70 72 C 64 20 56 -40 40 -100 Z" fill="${C}" opacity="0.7"/>
    <path d="M -30 -2 L 30 -2 L 34 22 L -34 22 Z" fill="${dark}"/>
    <path d="M -32 18 L -10 18 L -12 70 L -34 70 Z" fill="${dark}"/>
    <path d="M 10 18 L 32 18 L 34 70 L 12 70 Z" fill="${dark}"/>
    <path d="M -38 66 L -8 66 L -6 76 L -42 76 Z" fill="${mid}"/>
    <path d="M 8 66 L 38 66 L 42 76 L 6 76 Z" fill="${mid}"/>
    <path d="M -34 -96 L 34 -96 L 28 -4 L -28 -4 Z" fill="${dark}"/>
    <path d="M -34 -96 L 34 -96 L 22 -60 L 0 -50 L -22 -60 Z" fill="${mid}"/>
    <path d="M 0 -88 L 8 -74 L 0 -60 L -8 -74 Z" fill="${C}" filter="url(#tGlow)"/>
    <path d="M -60 -104 C -60 -118 -40 -122 -26 -112 L -30 -86 L -58 -84 Z" fill="${mid}"/>
    <path d="M 60 -104 C 60 -118 40 -122 26 -112 L 30 -86 L 58 -84 Z" fill="${mid}"/>
    <path d="M -60 -104 C -60 -118 -40 -122 -26 -112" stroke="${lit}" stroke-width="2" fill="none"/>
    <path d="M 60 -104 C 60 -118 40 -122 26 -112" stroke="${lit}" stroke-width="2" fill="none"/>
    <path d="M -58 -86 L -44 -86 L -50 -24 L -76 -16 L -76 -28 L -62 -34 Z" fill="${dark}"/>
    <path d="M 58 -86 L 44 -86 L 50 -24 L 76 -16 L 76 -28 L 62 -34 Z" fill="${dark}"/>
    <circle cx="-80" cy="-22" r="8" fill="${mid}"/>
    <circle cx="80" cy="-22" r="8" fill="${mid}"/>
    <rect x="-16" y="-120" width="32" height="18" fill="${dark}"/>
    <path d="M -22 -150 C -22 -176 22 -176 22 -150 L 20 -124 C 10 -114 -10 -114 -20 -124 Z" fill="${dark}"/>
    <path d="M -16 -146 L 16 -146 L 13 -138 L -13 -138 Z" fill="${C}" filter="url(#tGlow)"/>
    <path d="M -24 -164 L -24 -184 L -14 -172 L -7 -192 L 0 -174 L 7 -192 L 14 -172 L 24 -184 L 24 -164 Z" fill="url(#tGold)"/>
    <circle cx="0" cy="-178" r="3.5" fill="${C}" filter="url(#tGlow)"/>
    <g transform="translate(88 0)">
      <rect x="-3" y="-170" width="6" height="248" fill="url(#tGold)"/>
      <path d="M -12 -176 L 0 -196 L 12 -176 L 0 -168 Z" fill="url(#tGold)"/>
      <circle cx="0" cy="-206" r="13" fill="${C}" filter="url(#tGlow)"/>
      <circle cx="0" cy="-206" r="7" fill="#fff" opacity="0.85"/>
    </g>
  </g>`;
}

/** A hanging banner, top centre at (0, 0). torn: ragged and dimmed (a fallen player's). */
function banner(color, h, torn, r) {
  const C = hex(color), dark = mix(color, '#05070c', torn ? 0.75 : 0.45);
  const w = 64;
  let bottom;
  if (torn) {
    const pts = [];
    for (let k = 0; k <= 6; k++) pts.push(`${(w / 2 - (k * w) / 6).toFixed(1)} ${(h - 30 + r() * 40 - (k % 2) * 22).toFixed(1)}`);
    bottom = pts.join(' L ');
  } else bottom = `${w / 2} ${h} L 0 ${h - 26} L ${-w / 2} ${h}`;
  const emblem = torn ? '' : `<path d="M 0 ${h * 0.3} L 12 ${h * 0.3 + 20} L 0 ${h * 0.3 + 40} L -12 ${h * 0.3 + 20} Z" fill="url(#tGold)"/>
      <path d="M 0 ${h * 0.3 + 9} L 6 ${h * 0.3 + 20} L 0 ${h * 0.3 + 31} L -6 ${h * 0.3 + 20} Z" fill="${C}"/>`;
  return `<g opacity="${torn ? 0.75 : 1}">
      <rect x="${-w / 2 - 8}" y="-6" width="${w + 16}" height="6" fill="url(#tGold)"/>
      <path d="M ${-w / 2} 0 L ${w / 2} 0 L ${bottom} Z" fill="${dark}"/>
      <path d="M ${-w / 2 + 6} 0 L ${-w / 2 + 6} ${h * (torn ? 0.6 : 0.85)}" stroke="${C}" stroke-width="2" opacity="0.8"/>
      <path d="M ${w / 2 - 6} 0 L ${w / 2 - 6} ${h * (torn ? 0.5 : 0.85)}" stroke="${C}" stroke-width="2" opacity="0.8"/>
      ${emblem}
    </g>`;
}

/**
 * The picture as an SVG string.
 * sovereign: { name, color }, allies / fallen: [{ name, color }], caption: line under the name.
 */
export function throneSVG({ sovereign: S, allies = [], fallen = [], caption = '', seed = 1 }) {
  const H = allies.length > 4 ? 750 : 704; // the front row is only needed for 5 or more allies
  const r = rng(seed * 7919 + 17);
  const C = hex(S.color), soft = mix(S.color, '#05070c', 0.55);
  const stars = [];
  for (let k = 0; k < 260; k++) {
    const x = r() * W, y = r() * 520, s = r();
    stars.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.4 + s * s * 1.6).toFixed(2)}" fill="#fff" opacity="${(0.25 + r() * 0.7).toFixed(2)}"/>`);
  }
  // Light rays fanning down from behind the throne.
  const rays = [];
  for (let k = 0; k < 13; k++) {
    const a = -Math.PI / 2 + (k - 6) * 0.2 + (r() - 0.5) * 0.06, len = 800, sp = 0.02 + r() * 0.035;
    const p = (t) => `${(CX + Math.cos(a + t) * len).toFixed(0)} ${(250 + Math.sin(a + t) * len).toFixed(0)}`;
    rays.push(`<path d="M ${CX} 250 L ${p(-sp)} L ${p(sp)} Z" fill="url(#tRay)" opacity="${(0.25 + r() * 0.35).toFixed(2)}"/>`);
  }
  // Dais: steps from the floor up to the throne platform.
  const steps = [];
  const STEPS = 5, base = 612, sh = 24;
  for (let k = 0; k < STEPS; k++) {
    const w = 600 - k * 80, y = base - (k + 1) * sh;
    steps.push(`<rect x="${CX - w / 2}" y="${y}" width="${w}" height="${sh}" fill="url(#tStone)"/>
      <rect x="${CX - w / 2}" y="${y}" width="${w}" height="2" fill="url(#tGold)" opacity="0.8"/>`);
  }
  const top = base - STEPS * sh; // 492
  const carpet = `<path d="M ${CX - 46} ${top} L ${CX + 46} ${top} L ${CX + 70} ${base} L ${CX - 70} ${base} Z" fill="${soft}"/>
    <path d="M ${CX - 46} ${top} L ${CX - 40} ${top} L ${CX - 62} ${base} L ${CX - 70} ${base} Z" fill="url(#tGold)" opacity="0.7"/>
    <path d="M ${CX + 46} ${top} L ${CX + 40} ${top} L ${CX + 62} ${base} L ${CX + 70} ${base} Z" fill="url(#tGold)" opacity="0.7"/>`;
  // Throne.
  const seatY = top - 62;
  const throne = `<g>
      <path d="M ${CX - 120} ${top} L ${CX - 104} ${seatY - 210} L ${CX - 70} ${seatY - 270} L ${CX - 36} ${seatY - 300} L ${CX} ${seatY - 360} L ${CX + 36} ${seatY - 300} L ${CX + 70} ${seatY - 270} L ${CX + 104} ${seatY - 210} L ${CX + 120} ${top} Z" fill="url(#tMetal)"/>
      <path d="M ${CX - 96} ${top} L ${CX - 84} ${seatY - 196} L ${CX - 56} ${seatY - 248} L ${CX} ${seatY - 320} L ${CX + 56} ${seatY - 248} L ${CX + 84} ${seatY - 196} L ${CX + 96} ${top} Z" fill="#0b0f17"/>
      <path d="M ${CX - 96} ${top} L ${CX - 84} ${seatY - 196} L ${CX - 56} ${seatY - 248} L ${CX} ${seatY - 320} L ${CX + 56} ${seatY - 248} L ${CX + 84} ${seatY - 196} L ${CX + 96} ${top}" stroke="${C}" stroke-width="3" fill="none" filter="url(#tGlow)"/>
      <path d="M ${CX - 104} ${seatY - 210} L ${CX - 150} ${seatY - 250} L ${CX - 112} ${seatY - 150} Z" fill="url(#tGold)"/>
      <path d="M ${CX + 104} ${seatY - 210} L ${CX + 150} ${seatY - 250} L ${CX + 112} ${seatY - 150} Z" fill="url(#tGold)"/>
      <path d="M ${CX - 70} ${seatY - 270} L ${CX - 96} ${seatY - 330} L ${CX - 60} ${seatY - 262} Z" fill="url(#tGold)"/>
      <path d="M ${CX + 70} ${seatY - 270} L ${CX + 96} ${seatY - 330} L ${CX + 60} ${seatY - 262} Z" fill="url(#tGold)"/>
      <path d="M ${CX} ${seatY - 388} L ${CX + 18} ${seatY - 360} L ${CX} ${seatY - 332} L ${CX - 18} ${seatY - 360} Z" fill="url(#tGold)"/>
      <circle cx="${CX}" cy="${seatY - 360}" r="8" fill="${C}" filter="url(#tGlow)"/>
      <circle cx="${CX}" cy="${seatY - 260}" r="46" fill="${C}" opacity="0.16" filter="url(#tBlur)"/>
      <rect x="${CX - 140}" y="${seatY - 30}" width="46" height="92" fill="url(#tMetal)"/>
      <rect x="${CX + 94}" y="${seatY - 30}" width="46" height="92" fill="url(#tMetal)"/>
      <rect x="${CX - 150}" y="${seatY - 40}" width="66" height="14" fill="url(#tGold)"/>
      <rect x="${CX + 84}" y="${seatY - 40}" width="66" height="14" fill="url(#tGold)"/>
      <rect x="${CX - 134}" y="${seatY - 10}" width="34" height="4" fill="${C}" filter="url(#tGlow)"/>
      <rect x="${CX + 100}" y="${seatY - 10}" width="34" height="4" fill="${C}" filter="url(#tGlow)"/>
      <rect x="${CX - 96}" y="${seatY}" width="192" height="62" fill="url(#tMetal)"/>
      <rect x="${CX - 96}" y="${seatY}" width="192" height="5" fill="url(#tGold)"/>
    </g>`;
  // Hall: pillars, banners (the sovereign's inside, fallen players' torn ones further out).
  const pillar = (x) => `<rect x="${x - 34}" y="0" width="68" height="612" fill="url(#tPillar)"/>
    <rect x="${x - 44}" y="596" width="88" height="16" fill="url(#tStone)"/><rect x="${x - 44}" y="596" width="88" height="2" fill="url(#tGold)" opacity="0.7"/>
    <rect x="${x - 2}" y="0" width="4" height="596" fill="${C}" opacity="0.25"/>`;
  const halls = [];
  const inner = [330, 870], outer = [130, 1070];
  for (const x of [...outer, ...inner]) halls.push(pillar(x));
  for (const x of inner) halls.push(`<g transform="translate(${x} 70)">${banner(S.color, 260, false, r)}</g>`);
  fallen.slice(0, 6).forEach((f, k) => {
    const x = outer[k % 2] + (k >= 2 ? (k % 2 ? -1 : 1) * (k >= 4 ? 120 : 64) * (k % 2 ? 1 : 1) : 0);
    const tilt = (k % 2 ? 1 : -1) * (4 + r() * 5);
    halls.push(`<g transform="translate(${x} ${60 + (k >> 1) * 26}) rotate(${tilt.toFixed(1)})">${banner(f.color, 200 - (k >> 1) * 20, true, r)}</g>`);
  });
  // Floor with lines running to the throne.
  const floor = [`<rect x="0" y="${base}" width="${W}" height="${H - base}" fill="url(#tFloor)"/>`];
  for (let k = -9; k <= 9; k++) floor.push(`<path d="M ${CX + k * 22} ${base} L ${CX + k * 190} ${H}" stroke="${C}" stroke-width="1" opacity="0.10"/>`);
  for (const y of [632, 660, 696, 738]) floor.push(`<path d="M 0 ${y} L ${W} ${y}" stroke="${C}" stroke-width="1" opacity="0.07"/>`);
  // Allies kneel at the foot of the dais, facing it.
  const slots = [[236, 648, 1], [964, 648, -1], [88, 678, 1], [1112, 678, -1], [330, 724, 1], [870, 724, -1], [180, 728, 1], [1020, 728, -1], [40, 730, 1]];
  const kneelers = allies.slice(0, slots.length).map((a, k) => {
    const [x, y, d] = slots[k], s = 1.12 + (y - 648) / 420;
    return `<g transform="translate(${x} ${y}) scale(${(d * s).toFixed(3)} ${s.toFixed(3)})">${kneeler(a.color, k)}</g>`;
  });
  const labels = allies.slice(0, slots.length).map((a, k) => {
    const [x, y] = slots[k], s = 1.12 + (y - 648) / 420;
    return `<text x="${x}" y="${y + 20}" text-anchor="middle" font-family="${FONT}" font-weight="600" font-size="${(15 * s).toFixed(1)}" fill="${hex(a.color)}" letter-spacing="1.5" stroke="#05070c" stroke-width="4" paint-order="stroke">${esc(a.name.toUpperCase())}</text>`;
  });
  const fig = `<g transform="translate(${CX} ${seatY})">${sovereign(S.color)}</g>`;
  const name = S.name.toUpperCase();
  const plaque = `<g>
      <text x="${CX}" y="${base - 30}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${name.length > 14 ? 26 : 32}" letter-spacing="5" fill="url(#tGold)" stroke="#05070c" stroke-width="5" paint-order="stroke">${esc(name)}</text>
      ${caption ? `<text x="${CX}" y="${base - 8}" text-anchor="middle" font-family="${FONT}" font-weight="600" font-size="13" letter-spacing="3" fill="${C}" stroke="#05070c" stroke-width="4" paint-order="stroke">${esc(caption.toUpperCase())}</text>` : ''}
    </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(S.name)} on the throne of the galaxy as emperor${allies.length ? `, with ${esc(allies.map((a) => a.name).join(', '))} kneeling before it` : ''}">
  <defs>
    <radialGradient id="tSky" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="${mix(S.color, '#05070c', 0.72)}"/><stop offset="0.55" stop-color="#070a12"/><stop offset="1" stop-color="#030409"/></radialGradient>
    <radialGradient id="tNeb" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${C}" stop-opacity="0.35"/><stop offset="1" stop-color="${C}" stop-opacity="0"/></radialGradient>
    <radialGradient id="tNeb2" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#9a6bff" stop-opacity="0.22"/><stop offset="1" stop-color="#9a6bff" stop-opacity="0"/></radialGradient>
    <radialGradient id="tPlanet" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="${mix(S.color, '#ffffff', 0.15)}"/><stop offset="0.5" stop-color="${mix(S.color, '#05070c', 0.55)}"/><stop offset="1" stop-color="#05070c"/></radialGradient>
    <linearGradient id="tRay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C}" stop-opacity="0.55"/><stop offset="1" stop-color="${C}" stop-opacity="0"/></linearGradient>
    <linearGradient id="tGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1c4"/><stop offset="0.45" stop-color="#e8c46a"/><stop offset="1" stop-color="#8a6420"/></linearGradient>
    <linearGradient id="tMetal" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1b2432"/><stop offset="0.5" stop-color="#3a4658"/><stop offset="1" stop-color="#151c28"/></linearGradient>
    <linearGradient id="tPillar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#080b12"/><stop offset="0.35" stop-color="#1d2533"/><stop offset="0.6" stop-color="#121822"/><stop offset="1" stop-color="#06080d"/></linearGradient>
    <linearGradient id="tStone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#263042"/><stop offset="1" stop-color="#0e131c"/></linearGradient>
    <linearGradient id="tFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#101622"/><stop offset="1" stop-color="#04060a"/></linearGradient>
    <linearGradient id="tFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.7" stop-color="#05070c" stop-opacity="0"/><stop offset="1" stop-color="#05070c" stop-opacity="0.85"/></linearGradient>
    <filter id="tGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="tBlur" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#tSky)"/>
  <ellipse cx="${CX}" cy="230" rx="520" ry="240" fill="url(#tNeb)"/>
  <ellipse cx="260" cy="140" rx="300" ry="140" fill="url(#tNeb2)"/>
  ${stars.join('')}
  <g transform="translate(980 150)">
    <ellipse rx="150" ry="26" fill="none" stroke="${C}" stroke-width="3" opacity="0.28" transform="rotate(-14)"/>
    <circle r="78" fill="url(#tPlanet)"/>
    <path d="M -150 0 A 150 26 0 0 0 150 0" fill="none" stroke="${C}" stroke-width="3" opacity="0.5" transform="rotate(-14)"/>
  </g>
  <circle cx="${CX}" cy="250" r="190" fill="${C}" opacity="0.18" filter="url(#tBlur)"/>
  ${rays.join('')}
  ${halls.join('')}
  ${floor.join('')}
  ${steps.join('')}
  ${carpet}
  ${throne}
  ${fig}
  <rect width="${W}" height="${H}" fill="url(#tFade)"/>
  ${plaque}
  ${kneelers.join('')}
  ${labels.join('')}
</svg>`;
}
