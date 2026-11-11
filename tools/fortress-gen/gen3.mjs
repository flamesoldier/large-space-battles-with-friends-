// "Aegis Star Citadel III": every gun faces the enemy.
//   Five spear-arms fan out forward (0°, ±40°, ±80°), the front three long enough to carry extra
//   cross-walls, so the guns sit in up to four rings, all aimed forward. Open lanes between the arms
//   run down to the keep. The back is a great curved shield (the "aegis") that is also the carrier
//   deck: hangar halls cut into it, since fighters fly to the enemy whichever way they launch.
// Usage: node gen3.mjs [out.json]
import { writeFileSync } from 'node:fs';
const R = new URL('../../src/', import.meta.url).href;
const { BT, BLOCKS } = await import(R + 'shared/blocks.js');
const { analyzeDesign, encodeDesign, designCost, cropDesign } = await import(R + 'shared/shipStats.js');
const P = (k, d) => (process.env[k] !== undefined ? +process.env[k] : d);

const TARGET = 750000, NAME = process.env.NAME || 'Aegis Star Citadel III';
const RC = P('RC', 176);                         // rear shield radius
const ARMS = [[0, P('T0', 560)], [40, P('T1', 486)], [-40, P('T1', 486)], [80, P('T2', 318)], [-80, P('T2', 318)]]
  .map(([deg, tip]) => ({ a: deg * Math.PI / 180, tip, bg: tip - 140 }));
const SHIELD_FROM = P('SHF', 104) * Math.PI / 180; // shield covers |angle| >= this
const LANES = [20, -20, 60, -60, 100, -100].map((d) => d * Math.PI / 180);
const W = P('W', Math.ceil(RC + 8 + ARMS[0].tip + 8)), H = 640, cx = RC + 8, cy = 320;
const g = new Uint8Array(W * H), part = new Uint8Array(W * H);
const inG = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const at = (x, y) => (inG(x, y) ? g[y * W + x] : 0);
const set = (x, y, t) => { if (inG(x, y)) g[y * W + x] = t; };
const I = (x, y) => y * W + x;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const D = Math.PI / 180;
const loc = (x, y, a) => { const dx = x + 0.5 - cx, dy = y + 0.5 - cy; return [dx * Math.cos(a) + dy * Math.sin(a), -dx * Math.sin(a) + dy * Math.cos(a)]; };
const wrld = (u, v, a) => [cx + u * Math.cos(a) - v * Math.sin(a), cy + u * Math.sin(a) + v * Math.cos(a)];
function inPoly(px, py, Q) { let c = false; for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) { const [xi, yi] = Q[i], [xj, yj] = Q[j]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c; } return c; }

const RK = P('RK', 80), RM0 = P('RM0', 130), RM1 = P('RM1', 192), GAP = P('GAP', 60);
const SP_IN = 6, SP_OUT = 18, NK_IN = 5, NK_OUT = 17;
const FL = P('FL', 38), OR_V = P('OR_V', 74);
const bastionPoly = (A) => { const B = A.bg, S = B + 26, O = B + 38; return [[B, -FL], [S, -FL], [S, -OR_V], [O, -OR_V], [A.tip, 0], [O, OR_V], [S, OR_V], [S, FL], [B, FL]]; };
ARMS.forEach((A) => { A.poly = bastionPoly(A); A.oru = A.bg + 38; });
// cross-walls along long necks: chevrons pointing outward
const XW = P('XW', 44), XD = P('XD', 26);
ARMS.forEach((A) => { A.cross = []; const len = A.bg - RM1; const n = Math.floor(len / P('XEVERY', 105)); for (let j = 1; j <= n; j++) A.cross.push(RM1 + len * j / (n + 1)); });
const PART = { keep: 1, spoke: 2, mid: 3, neck: 4, bastion: 5, shield: 6, cross: 7 };
const inLane = (x, y, from = 0) => LANES.some((a) => { const [u, v] = loc(x, y, a); return u > from && Math.abs(v) < GAP / 2; });

function partAt(x, y) {
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy), th = Math.abs(Math.atan2(dy, dx));
  if (r <= RK) return PART.keep;
  for (const A of ARMS) {
    const [u, v] = loc(x, y, A.a), av = Math.abs(v);
    if (u > 0 && inPoly(u, v, A.poly)) return PART.bastion;
    for (const uc of A.cross) { const du = u - uc; if (av <= XW && du >= -XD / 2 - av * 0.45 && du <= XD / 2 - av * 0.45) return PART.cross; }
    if (u >= RK - 3 && u <= RM0 + 3 && ((av >= SP_IN && av <= SP_OUT) || (av < SP_IN && ((u | 0) % 14) < 3))) return PART.spoke;
    if (u >= RM1 - 3 && u <= A.bg + 2 && ((av >= NK_IN && av <= NK_OUT) || (av < NK_IN && ((u | 0) % 12) < 3))) return PART.neck;
  }
  if (th >= SHIELD_FROM && r <= RC && !inLane(x, y)) return PART.shield;
  if (th < SHIELD_FROM && r >= RM0 && r <= RM1 && !inLane(x, y)) return PART.mid;
  return 0;
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = partAt(x, y); if (p) { part[I(x, y)] = p; g[I(x, y)] = BT.FRAME; } }

// ---------------- materials ----------------
function depthMap() {
  const dep = new Int16Array(W * H).fill(-1); let q = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (at(x, y) && N4.some(([a, b]) => !at(x + a, y + b))) { dep[I(x, y)] = 0; q.push(I(x, y)); }
  for (let d = 1; q.length; d++) { const nq = []; for (const i of q) { const x = i % W, y = (i / W) | 0; for (const [a, b] of N4) { if (!inG(x + a, y + b)) continue; const j = I(x + a, y + b); if (g[j] && dep[j] < 0) { dep[j] = d; nq.push(j); } } } q = nq; }
  return dep;
}
let dep = depthMap();
const hubX = Math.round(cx), hubY = cy;
const SKIN = P('SKIN', 4), LAT = 6;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = I(x, y); if (!g[i]) continue;
  const p = part[i], d = dep[i];
  const lattice = ((x + y) % LAT === 0 || (x - y + 6000) % LAT === 0);
  if (p === PART.keep) {
    const rh = Math.hypot(x - hubX, y - hubY), ah = Math.atan2(y - hubY, x - hubX);
    const starR = 8 + 20 * Math.pow(Math.abs(Math.cos(4 * ah)), 6), CIT = 34;
    if (rh < CIT) g[i] = (rh > 4 && Math.abs(rh - starR) < 1.2) || (rh > 4 && rh < 6) ? BT.ARMOR : BT.HEAVY;
    else if (Math.abs(rh - CIT - 2) < 2) g[i] = BT.HEAVY;
    else if (d <= SKIN) g[i] = BT.HEAVY;
    else g[i] = lattice ? BT.ARMOR : BT.FRAME;
  } else if (p === PART.spoke || p === PART.neck) g[i] = BT.HEAVY;
  else if (d <= SKIN) g[i] = BT.HEAVY;
  else if (d <= SKIN + 2) g[i] = BT.ARMOR;
  else g[i] = lattice ? BT.ARMOR : BT.FRAME;
}
// keels, the mid-ring beam, and the shield's ribs (radial heavy ribs + two heavy arcs: the aegis pattern)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = I(x, y); if (!g[i]) continue;
  const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy), th = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
  if (part[i] === PART.bastion) for (const A of ARMS) { const [u, v] = loc(x, y, A.a); if (u > A.bg - 5 && Math.abs(v) < 2) g[i] = BT.HEAVY; }
  if (part[i] === PART.mid && Math.abs(r - (RM0 + RM1) / 2) < 1.5) g[i] = BT.HEAVY;
  if (part[i] === PART.shield) {
    if (Math.abs(r - 118) < 2 || Math.abs(r - 150) < 2) g[i] = BT.HEAVY;
    const rib = Math.abs((((th / (9 * D)) % 1) + 1) % 1 - 0.5) * 9 * D * r; if (rib < 1.5 && r > RK) g[i] = BT.HEAVY;
  }
}

// ---------------- multiblock units, rooms and tunnels ----------------
function free(x0, y0, s, needSolid = true) {
  for (let y = y0 - 1; y <= y0 + s; y++) for (let x = x0 - 1; x <= x0 + s; x++) { const t = at(x, y); if (t === BT.LANCE || t === BT.BAY || t === BT.HUB) return false; }
  if (needSolid) for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) if (!at(x, y)) return false;
  return true;
}
function stamp(x0, y0, s, t) { for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) set(x, y, t); }
function unitAt(px, py, s, t, solid = true) { const x0 = Math.round(px - s / 2), y0 = Math.round(py - s / 2); if (!free(x0, y0, s, solid)) return null; stamp(x0, y0, s, t); return [x0, y0]; }
function carve(pts, w = 3) {
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, ay] = pts[s], [bx, by] = pts[s + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for (let j = 0; j <= n; j++) { const px = ax + (bx - ax) * j / n, py = ay + (by - ay) * j / n;
      for (let oy = -w; oy <= w; oy++) for (let ox = -w; ox <= w; ox++) { if (Math.hypot(ox, oy) > w / 2 + 0.3) continue; const X = Math.round(px + ox), Y = Math.round(py + oy); const t = at(X, Y); if (t && t !== BT.LANCE && t !== BT.BAY && t !== BT.HUB) set(X, Y, 0); } }
  }
}
// a hall along direction a from u0 to u1 (half width hw), bays down both sides with short passages in
function hall(a, u0, u1, hw, step, list) {
  for (let u = u0; u <= u1; u += 0.5) for (let v = -hw; v <= hw; v += 0.5) { const [x, y] = wrld(u, v, a); const X = Math.round(x), Y = Math.round(y); if (at(X, Y) && at(X, Y) !== BT.LANCE && at(X, Y) !== BT.BAY && at(X, Y) !== BT.HUB) set(X, Y, 0); }
  for (const sd of [-1, 1]) for (let uc = u0 + 7; uc <= u1 - 3; uc += step) {
    let u = null;
    for (const off of [4, 5, 6, 7, 8]) { const [px, py] = wrld(uc, sd * (hw + off), a); u = unitAt(px, py, 6, BT.BAY); if (u) break; }
    if (u) { list.push(u); carve([[u[0] + 3, u[1] + 3], wrld(uc, 0, a)], 3); }
  }
}
const units = { plasma: [], bays: [] };
// keep plasma at every lane mouth
for (const a of LANES) { const [px, py] = wrld(RK - 2, 0, a); const u = unitAt(px, py, 10, BT.LANCE, false); if (u) units.plasma.push(u); }
// bastion face plasma (recessed 3)
for (const A of ARMS) for (const sd of [-1, 1]) {
  const t = 0.42, u = A.oru + t * (A.tip - A.oru), v = sd * OR_V * (1 - t);
  const nu = OR_V, nv = sd * (A.tip - A.oru), nl = Math.hypot(nu, nv);
  const [px, py] = wrld(u - nu / nl * 3, v - nv / nl * 3, A.a);
  const r = unitAt(px, py, 10, BT.LANCE, false); if (r) units.plasma.push(r);
}
// cross-wall plasma: one in the nose of each chevron
for (const A of ARMS) for (const uc of A.cross) for (const sd of [-1, 1]) { const v = XW - 9; const [px, py] = wrld(uc + XD / 2 - v * 0.45 - 4, sd * v, A.a); const r = unitAt(px, py, 10, BT.LANCE, false); if (r) units.plasma.push(r); }
// keep hangars, dog-leg tunnels into the courtyard (front lanes only)
LANES.forEach((a, k) => {
  if (Math.abs(a) > 90 * D) return;
  const sd = (k % 2) ? 1 : -1; const [px, py] = wrld(RK - 22, sd * 16, a);
  const u = unitAt(px, py, 6, BT.BAY); if (!u) return; units.bays.push(u);
  carve([[u[0] + 3, u[1] + 3], wrld(RK - 22, sd * 26, a), wrld(RK + 3, sd * 26, a)], 3);
});
// middle-ring hangar rooms
for (const A of ARMS) for (const sd of [-1, 1]) {
  const a = A.a, rm = (RM0 + RM1) / 2; const [px, py] = wrld(rm, sd * 14, a);
  const u = unitAt(px, py, 6, BT.BAY); if (!u) continue; units.bays.push(u);
  const ang = a + sd * 11 * D, p1 = [cx + Math.cos(a + sd * 8 * D) * (RM0 + 8), cy + Math.sin(a + sd * 8 * D) * (RM0 + 8)];
  carve([[u[0] + 3, u[1] + 3], p1, [cx + Math.cos(ang) * (RM0 + 8), cy + Math.sin(ang) * (RM0 + 8)], [cx + Math.cos(ang) * (RM0 - 4), cy + Math.sin(ang) * (RM0 - 4)]], 3);
}
// bastion flank hangars + keel halls
for (const A of ARMS) {
  for (const sd of [-1, 1]) for (const u0 of [A.bg + 6, A.bg + 16]) { const [px, py] = wrld(u0 + 2, sd * (FL - 3), A.a); const u = unitAt(px, py, 6, BT.BAY); if (u) units.bays.push(u); }
  hall(A.a, A.bg + 40, A.bg + 84, 4, 8, units.bays);
  carve([wrld(A.bg + 41, 0, A.a), wrld(A.bg + 12, 0, A.a), wrld(A.bg + 12, (A.a >= 0 ? 1 : -1) * (FL + 6), A.a)], 3);
}
// the carrier deck: radial hangar halls cut into the rear shield, open to space at the back
const DECK = P('DECK', 9);
for (let j = 0; j < DECK; j++) {
  const a = Math.PI + (j - (DECK - 1) / 2) * P('DECKSTEP', 15) * D;
  if (Math.abs(Math.abs(a > Math.PI ? a - 2 * Math.PI : a)) < SHIELD_FROM + 10 * D) continue;
  hall(a, RK + 26, RC + 4, 4, 9, units.bays);
}

// ---------------- guns ----------------
dep = depthMap();
const hash = (a) => { a = (a ^ 61) ^ (a >>> 16); a = a + (a << 3); a ^= a >>> 4; a = Math.imul(a, 0x27d4eb2d); return (a ^ (a >>> 15)) >>> 0; };
const skin = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = at(x, y); if (t && t !== BT.LANCE && t !== BT.BAY && dep[I(x, y)] === 0) skin.push([x, y]); }
for (const [x, y] of skin) { const p = part[I(x, y)]; if ((p === PART.bastion || p === PART.mid || p === PART.cross) && ((x * 3 + y * 5) % 8) === 0) set(x, y, 0); }
const MIX = {
  [PART.bastion]: [[BT.CANNON, 36], [BT.LASER, 20], [BT.GUIDED, 16], [BT.MISSILE, 10], [BT.PD, 18]],
  [PART.cross]: [[BT.CANNON, 32], [BT.LASER, 24], [BT.GUIDED, 18], [BT.MISSILE, 12], [BT.PD, 14]],
  [PART.mid]: [[BT.CANNON, 30], [BT.LASER, 24], [BT.GUIDED, 18], [BT.MISSILE, 14], [BT.PD, 14]],
  [PART.keep]: [[BT.GUIDED, 36], [BT.LASER, 30], [BT.MISSILE, 22], [BT.PD, 12]],
  [PART.spoke]: [[BT.PD, 50], [BT.CANNON, 50]],
  [PART.neck]: [[BT.PD, 40], [BT.CANNON, 40], [BT.LASER, 20]],
};
const facing = (x, y) => Math.cos(Math.atan2(y + 0.5 - cy, x + 0.5 - cx));
for (const [x, y] of skin) {
  if (!at(x, y)) continue;
  const p = part[I(x, y)];
  if (p === PART.shield) { // the back: only a sprinkling of point defence (fighters and stray missiles), the rest stays armour
    if (((x * 7 + y * 11) % P('SHPD', 5)) === 0) set(x, y, BT.PD);
    continue;
  }
  const mix = MIX[p], pd = ((x * 7 + y * 11) % 6) === 0;
  let roll = hash(((x / 6) | 0) * 911 + ((y / 6) | 0) * 7919 + p * 13) % 100, t = mix[0][0];
  const tot = mix.reduce((s, m) => s + m[1], 0); roll = roll * tot / 100;
  for (const [tt, w] of mix) { if (roll < w) { t = tt; break; } roll -= w; }
  if (pd && p !== PART.keep) t = BT.PD;
  if (facing(x, y) < -0.5 && t !== BT.PD) t = BT.HEAVY; // nothing but PD faces straight back
  set(x, y, t);
}
set(hubX, hubY, BT.HUB);

function prune() {
  const seen = new Uint8Array(W * H), st = [I(hubX, hubY)]; seen[st[0]] = 1;
  while (st.length) { const i = st.pop(), x = i % W, y = (i / W) | 0; for (const [a, b] of N4) { if (!inG(x + a, y + b)) continue; const j = I(x + a, y + b); if (g[j] && !seen[j]) { seen[j] = 1; st.push(j); } } }
  let n = 0; for (let i = 0; i < g.length; i++) if (g[i] && !seen[i]) { g[i] = 0; n++; } return n;
}
console.log('pruned', prune());
const crop = () => cropDesign({ w: W, h: H, cells: g, hub: I(hubX, hubY), name: NAME, stance: 'line', place: 'auto' });
let d = crop(), info = analyzeDesign(d);
const back = (c) => [c % d.w + d.x0, ((c / d.w) | 0) + d.y0];
const MINARC = P('MINARC', 11);
for (const wp of info.weapons) {
  if (wp.group) { if (wp.buried) for (const c of wp.group.cells) set(...back(c), BT.HEAVY); continue; }
  if (wp.buried || (wp.arcDeg < MINARC && wp.type !== BT.PD)) set(...back(wp.cell), BT.HEAVY);
}
// A gun whose whole arc points backwards (it can never bear on an enemy in front) is wasted: armour instead.
for (const wp of info.weapons) {
  if (wp.group || wp.buried || wp.type === BT.PD) continue;
  let fwd = 0; for (let k = 0; k < 64; k++) { const open = k < 32 ? (wp.m0 >>> k) & 1 : (wp.m1 >>> (k - 32)) & 1; if (open && Math.cos(-Math.PI + (k + 0.5) * Math.PI / 32) > P('FWD', -0.2)) fwd++; }
  if (fwd === 0) set(...back(wp.cell), BT.HEAVY);
}

// ---------------- exact budget ----------------
let cost = designCost({ cells: g });
console.log('cost after guns', cost);
if (cost > TARGET) {
  d = crop(); info = analyzeDesign(d);
  const guns = info.weapons.filter((w) => !w.group && !w.buried && w.type !== BT.PD).sort((a, b) => a.arcDeg - b.arcDeg);
  for (const w of guns) { if (cost <= TARGET) break; const [x, y] = back(w.cell); cost += BLOCKS[BT.HEAVY].cost - BLOCKS[g[I(x, y)]].cost; set(x, y, BT.HEAVY); }
}
dep = depthMap();
const inner = [];
for (let i = 0; i < g.length; i++) if ((g[i] === BT.FRAME || g[i] === BT.ARMOR) && dep[i] > SKIN) inner.push(i);
inner.sort((a, b) => dep[a] - dep[b]);
if (cost < TARGET) for (const i of inner) { if (cost >= TARGET - 3) break; if (g[i] === BT.FRAME) { g[i] = BT.ARMOR; cost += 2; } }
if (cost < TARGET) for (const i of inner) { if (cost >= TARGET - 3) break; if (g[i] === BT.ARMOR) { g[i] = BT.HEAVY; cost += 4; } }
if (cost > TARGET) for (let k = inner.length - 1; k >= 0 && cost > TARGET; k--) { const i = inner[k]; if (g[i] === BT.HEAVY) { g[i] = BT.ARMOR; cost -= 4; } }
if (cost > TARGET) for (let k = inner.length - 1; k >= 0 && cost > TARGET; k--) { const i = inner[k]; if (g[i] === BT.ARMOR) { g[i] = BT.FRAME; cost -= 2; } }
if ((TARGET - cost) % 2 !== 0) { const k = inner.findLastIndex((i) => g[i] === BT.FRAME); g[inner[k]] = 0; cost -= 1; inner.splice(k, 1); }
for (const i of inner) { if (cost >= TARGET) break; if (g[i] === BT.FRAME) { g[i] = BT.ARMOR; cost += 2; } }
prune();

d = crop(); info = analyzeDesign(d);
const by = {}; for (const [t, n] of Object.entries(info.byType)) by[BLOCKS[t].name] = n;
console.log({ w: d.w, h: d.h, blocks: info.blocks, cost: info.cost, cls: info.hullClass?.name, dps: Math.round(info.dps), errors: info.errors, warnings: info.warnings.map((s) => s.slice(0, 80)), by });
const ring = {}; for (const w of info.weapons) { const [x, y] = back(w.cell); const p = Object.keys(PART).find((k) => PART[k] === part[I(x, y)]) || '?'; ring[p] = (ring[p] || 0) + 1; }
console.log('weapons by part', ring, 'plasma', units.plasma.length, 'bays', units.bays.length, 'buried', info.weapons.filter((w) => w.buried).length);
writeFileSync(process.argv[2] || '/home/claude/fortress/aegis3.json', JSON.stringify(encodeDesign(d)));
