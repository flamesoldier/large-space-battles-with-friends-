// "Aegis Star Citadel II": a hollow, concentric star fortress with three rings of guns.
//   keep (hub, plasma + missiles firing down the avenues, deep hangars with dog-leg tunnels)
//   -> open courtyard crossed by twin laddered spokes
//   -> middle ring of 8 wall segments (guns on the outside and on the avenue sides, hangar rooms)
//   -> twin laddered necks -> 8 bastions (outer gun ring, plasma on the faces, flank hangars)
// Eight open avenues (between the arms) run from space right down to the keep, so the inner rings
// can shoot out and fighters can fly out.
// Usage: node gen2.mjs [out.json]
import { writeFileSync } from 'node:fs';
const R = new URL('../../src/', import.meta.url).href;
const { BT, BLOCKS } = await import(R + 'shared/blocks.js');
const { analyzeDesign, encodeDesign, designCost, cropDesign } = await import(R + 'shared/shipStats.js');
const P = (k, d) => (process.env[k] !== undefined ? +process.env[k] : d);

const TARGET = 750000, NAME = process.env.NAME || 'Aegis Star Citadel II';
const W = P('W', 640), H = 640, cx = W / 2, cy = 320;
const g = new Uint8Array(W * H), part = new Uint8Array(W * H);
const inG = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const at = (x, y) => (inG(x, y) ? g[y * W + x] : 0);
const set = (x, y, t) => { if (inG(x, y)) g[y * W + x] = t; };
const I = (x, y) => y * W + x;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const TAU = Math.PI * 2, D = Math.PI / 180;
const loc = (x, y, a) => { const dx = x + 0.5 - cx, dy = y + 0.5 - cy; return [dx * Math.cos(a) + dy * Math.sin(a), -dx * Math.sin(a) + dy * Math.cos(a)]; };
const wrld = (u, v, a) => [cx + u * Math.cos(a) - v * Math.sin(a), cy + u * Math.sin(a) + v * Math.cos(a)];
function inPoly(px, py, Q) { let c = false; for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) { const [xi, yi] = Q[i], [xj, yj] = Q[j]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c; } return c; }

const NA = P('NA', 8), armA = (k) => k * TAU / NA, aveA = (k) => (k + 0.5) * TAU / NA;
// radii
const RK = P('RK', 62);           // keep
const RM0 = P('RM0', 112), RM1 = P('RM1', 154); // middle ring
const GAP = P('GAP', 44);         // avenue width through the middle ring
const SP_IN = 6, SP_OUT = 18;     // twin spokes: |v| in [6, 18]
const NK_IN = 5, NK_OUT = 17;     // twin necks
const B_G = P('B_G', 196), FL = P('FL', 26), SH_U = B_G + 26, OR_U = B_G + 38, OR_V = P('OR_V', 46), TIP = P('TIP', 316); // bastion
const BASTION = [[B_G, -FL], [SH_U, -FL], [SH_U, -OR_V], [OR_U, -OR_V], [TIP, 0], [OR_U, OR_V], [SH_U, OR_V], [SH_U, FL], [B_G, FL]];
const PART = { keep: 1, spoke: 2, mid: 3, neck: 4, bastion: 5 };

function partAt(x, y) {
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy);
  if (r <= RK) return PART.keep;
  for (let k = 0; k < NA; k++) {
    const [u, v] = loc(x, y, armA(k)), av = Math.abs(v);
    if (u > 0 && inPoly(u, v, BASTION)) return PART.bastion;
    if (u >= RK - 3 && u <= RM0 + 3 && ((av >= SP_IN && av <= SP_OUT) || (av < SP_IN && ((u | 0) % 14) < 3))) return PART.spoke;
    if (u >= RM1 - 3 && u <= B_G + 2 && ((av >= NK_IN && av <= NK_OUT) || (av < NK_IN && ((u | 0) % 12) < 3))) return PART.neck;
  }
  if (r >= RM0 && r <= RM1) {
    for (let k = 0; k < NA; k++) { const [u, v] = loc(x, y, aveA(k)); if (u > 0 && Math.abs(v) < GAP / 2) return 0; }
    return PART.mid;
  }
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
const hubX = cx - 6, hubY = cy;
const SKIN = P('SKIN', 6), LAT = P('LAT', 6);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = I(x, y); if (!g[i]) continue;
  const p = part[i], d = dep[i];
  const lattice = ((x + y) % LAT === 0 || (x - y + 6000) % LAT === 0);
  if (p === PART.keep) {
    const rh = Math.hypot(x - hubX, y - hubY), ah = Math.atan2(y - hubY, x - hubX);
    const starR = 8 + 20 * Math.pow(Math.abs(Math.cos(4 * ah)), 6);
    const CIT = P('CIT', 34);
    if (rh < CIT) g[i] = (rh > 4 && Math.abs(rh - starR) < 1.2) || (rh > 4 && rh < 6) ? BT.ARMOR : BT.HEAVY; // citadel round the hub
    else if (Math.abs(rh - CIT - 2) < 2) g[i] = BT.HEAVY;
    else if (d <= SKIN) g[i] = BT.HEAVY;
    else g[i] = lattice ? BT.ARMOR : BT.FRAME;
  } else if (p === PART.spoke || p === PART.neck) g[i] = BT.HEAVY;
  else if (d <= SKIN) g[i] = BT.HEAVY;
  else if (d <= SKIN + 2) g[i] = BT.ARMOR;
  else g[i] = lattice ? BT.ARMOR : BT.FRAME;
}
// bastion keel + rib, mid-ring ring-beam (visual + structure)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = I(x, y); if (!g[i]) continue;
  if (part[i] === PART.bastion) { for (let k = 0; k < NA; k++) { const [u, v] = loc(x, y, armA(k)); if (u > B_G - 5 && Math.abs(v) < 2) g[i] = BT.HEAVY; } }
  if (part[i] === PART.mid && Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - (RM0 + RM1) / 2) < 1.5) g[i] = BT.HEAVY;
}

// ---------------- multiblock units ----------------
function free(x0, y0, s, needSolid = true) {
  for (let y = y0 - 1; y <= y0 + s; y++) for (let x = x0 - 1; x <= x0 + s; x++) { const t = at(x, y); if (t === BT.LANCE || t === BT.BAY || t === BT.HUB) return false; }
  if (needSolid) for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) if (!at(x, y)) return false;
  return true;
}
function stamp(x0, y0, s, t) { for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) set(x, y, t); }
function unitAt(px, py, s, t, solid = true) { const x0 = Math.round(px - s / 2), y0 = Math.round(py - s / 2); if (!free(x0, y0, s, solid)) return null; stamp(x0, y0, s, t); return [x0, y0]; }
// carve a corridor (width w) along a polyline of world points
function carve(pts, w = 3) {
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, ay] = pts[s], [bx, by] = pts[s + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for (let j = 0; j <= n; j++) { const px = ax + (bx - ax) * j / n, py = ay + (by - ay) * j / n;
      for (let oy = -w; oy <= w; oy++) for (let ox = -w; ox <= w; ox++) { if (Math.hypot(ox, oy) > w / 2 + 0.3) continue; const X = Math.round(px + ox), Y = Math.round(py + oy); const t = at(X, Y); if (t && t !== BT.LANCE && t !== BT.BAY && t !== BT.HUB) set(X, Y, 0); } }
  }
}
const units = { plasma: [], bays: [] };
// (a) keep plasma: one at the mouth of each avenue, half out of the keep wall, firing down it
const KP_R = P('KP_R', RK - 2);
for (let k = 0; k < NA; k++) { const [px, py] = wrld(KP_R, 0, aveA(k)); const u = unitAt(px, py, 10, BT.LANCE, false); if (u) units.plasma.push(u); }
// (b) bastion face plasma, recessed 3 into each face
for (let k = 0; k < NA; k++) for (const sd of [-1, 1]) {
  const a = armA(k), t = 0.42, u = OR_U + t * (TIP - OR_U), v = sd * OR_V * (1 - t);
  const nu = OR_V, nv = sd * (TIP - OR_U), nl = Math.hypot(nu, nv);
  const [px, py] = wrld(u - nu / nl * 3, v - nv / nl * 3, a);
  const r = unitAt(px, py, 10, BT.LANCE, false); if (r) units.plasma.push(r);
}
// (c) keep hangars: deep rooms either side of each keep plasma, dog-leg tunnel out into the courtyard
for (let k = 0; k < NA; k++) {
  const a = aveA(k), sd = (k % 2) ? 1 : -1; // alternate sides so the keep stays balanced
  const [px, py] = wrld(RK - 22, sd * 16, a);
  const u = unitAt(px, py, 6, BT.BAY); if (!u) continue; units.bays.push(u);
  const c0 = [u[0] + 3, u[1] + 3];
  const p1 = wrld(RK - 22, sd * 26, a), p2 = wrld(RK + 3, sd * 26, a);
  carve([c0, p1, p2], 3);
}
// (d) middle-ring hangar rooms: two per segment, tunnels running round inside the wall and out the avenue side
for (let k = 0; k < NA; k++) for (const sd of [-1, 1]) {
  const a = armA(k), rm = (RM0 + RM1) / 2;
  const [px, py] = wrld(rm, sd * 14, a);
  const u = unitAt(px, py, 6, BT.BAY); if (!u) continue; units.bays.push(u);
  // tunnel: from the room, inward a bit, then round toward the avenue at the inner face, then out into the courtyard
  const c0 = [u[0] + 3, u[1] + 3];
  const ang = a + sd * 11 * D, p1 = [cx + Math.cos(a + sd * 8 * D) * (RM0 + 8), cy + Math.sin(a + sd * 8 * D) * (RM0 + 8)];
  const p2 = [cx + Math.cos(ang) * (RM0 + 8), cy + Math.sin(ang) * (RM0 + 8)], p3 = [cx + Math.cos(ang) * (RM0 - 4), cy + Math.sin(ang) * (RM0 - 4)];
  carve([c0, p1, p2, p3], 3);
}
// (e) bastion flank hangars: two per flank, opening straight out into the avenue
for (let k = 0; k < NA; k++) for (const sd of [-1, 1]) for (const u0 of [B_G + 6, B_G + 16]) {
  const a = armA(k); const [px, py] = wrld(u0 + 2, sd * (FL - 3), a);
  const u = unitAt(px, py, 6, BT.BAY); if (u) units.bays.push(u);
}

// (f) bastion hangar halls: a long room down each bastion's keel with bays either side,
// a corridor back toward the gorge, then out through a flank into the avenue
const HALL = P('HALL', 1);
if (HALL) for (let k = 0; k < NA; k++) {
  const a = armA(k), u0 = B_G + 40, u1 = B_G + 84, hw = 4;
  for (let u = u0; u <= u1; u += 0.5) for (let v = -hw; v <= hw; v += 0.5) { const [x, y] = wrld(u, v, a); const X = Math.round(x), Y = Math.round(y); if (at(X, Y) && at(X, Y) !== BT.LANCE) set(X, Y, 0); }
  for (const sd of [-1, 1]) for (const uc of [u0 + 7, u0 + 15, u0 + 23, u0 + 31]) {
    let u = null;
    for (const off of [4, 5, 6, 7, 8]) { const [px, py] = wrld(uc, sd * (hw + off), a); u = unitAt(px, py, 6, BT.BAY); if (u) break; }
    if (u) { units.bays.push(u); carve([[u[0] + 3, u[1] + 3], wrld(uc, 0, a)], 3); } // short passage from the bay into the hall
  }
  const side = (k % 2) ? 1 : -1;
  carve([wrld(u0 + 1, 0, a), wrld(B_G + 12, 0, a), wrld(B_G + 12, side * (FL + 6), a)], 3);
}

// ---------------- guns on every face ----------------
dep = depthMap();
const hash = (a) => { a = (a ^ 61) ^ (a >>> 16); a = a + (a << 3); a ^= a >>> 4; a = Math.imul(a, 0x27d4eb2d); return (a ^ (a >>> 15)) >>> 0; };
const skin = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = at(x, y); if (t && t !== BT.LANCE && t !== BT.BAY && dep[I(x, y)] === 0) skin.push([x, y]); }
// crenellate outer faces (bastions, middle ring) so guns stick out
for (const [x, y] of skin) { const p = part[I(x, y)]; if ((p === PART.bastion || p === PART.mid) && ((x * 3 + y * 5) % 8) === 0) set(x, y, 0); }
const MIX = {
  [PART.bastion]: [[BT.CANNON, 36], [BT.LASER, 20], [BT.GUIDED, 16], [BT.MISSILE, 10], [BT.PD, 18]],
  [PART.mid]: [[BT.CANNON, 30], [BT.LASER, 24], [BT.GUIDED, 18], [BT.MISSILE, 14], [BT.PD, 14]],
  [PART.keep]: [[BT.GUIDED, 36], [BT.LASER, 30], [BT.MISSILE, 22], [BT.PD, 12]],
  [PART.spoke]: [[BT.PD, 50], [BT.CANNON, 50]],
  [PART.neck]: [[BT.PD, 40], [BT.CANNON, 40], [BT.LASER, 20]],
};
for (const [x, y] of skin) {
  if (!at(x, y)) continue;
  const p = part[I(x, y)], mix = MIX[p];
  const pd = ((x * 7 + y * 11) % 6) === 0;
  let roll = hash(((x / 6) | 0) * 911 + ((y / 6) | 0) * 7919 + p * 13) % 100, t = mix[0][0];
  const tot = mix.reduce((s, m) => s + m[1], 0); roll = roll * tot / 100;
  for (const [tt, w] of mix) { if (roll < w) { t = tt; break; } roll -= w; }
  if (pd && p !== PART.keep) t = BT.PD;
  set(x, y, t);
}
set(hubX, hubY, BT.HUB);

// ---------------- prune, then drop guns that can't shoot (or barely) ----------------
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
  if (wp.buried || wp.arcDeg < MINARC) set(...back(wp.cell), BT.HEAVY);
}

// ---------------- exact budget ----------------
let cost = designCost({ cells: g });
console.log('cost after guns', cost);
// Over budget: retire the narrowest-arc single guns first (to heavy armour). Under: thicken.
if (cost > TARGET) {
  d = crop(); info = analyzeDesign(d);
  const guns = info.weapons.filter((w) => !w.group && !w.buried && w.type !== BT.PD).sort((a, b) => a.arcDeg - b.arcDeg);
  for (const w of guns) { if (cost <= TARGET) break; const [x, y] = back(w.cell); cost += BLOCKS[BT.HEAVY].cost - BLOCKS[g[I(x, y)]].cost; set(x, y, BT.HEAVY); }
}
dep = depthMap();
const inner = [];
for (let i = 0; i < g.length; i++) if ((g[i] === BT.FRAME || g[i] === BT.ARMOR) && dep[i] > SKIN) inner.push(i);
inner.sort((a, b) => dep[a] - dep[b]); // nearest the outside first
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
// guns per ring
const ring = {}; for (const w of info.weapons) { const [x, y] = back(w.cell); const p = Object.keys(PART).find((k) => PART[k] === part[I(x, y)]) || '?'; ring[p] = (ring[p] || 0) + 1; }
console.log('weapons by ring', ring, 'plasma', units.plasma.length, 'bays', units.bays.length);
const arcs = info.weapons.filter((w) => !w.buried).map((w) => w.arcDeg).sort((a, b) => a - b);
console.log('arc median', arcs[arcs.length >> 1], 'p10', arcs[(arcs.length * 0.1) | 0]);
writeFileSync(process.argv[2] || '/home/claude/fortress/aegis2.json', JSON.stringify(encodeDesign(d)));
