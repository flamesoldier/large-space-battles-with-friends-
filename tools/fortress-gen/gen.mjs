// Generates "Aegis Star Citadel": a Vauban-style star fortress defence for Large Space Battles with Friends.
// Usage: node gen.mjs [out.json] [skinFront] [skinOther]
import { writeFileSync } from 'node:fs';
const R = new URL('../../src/', import.meta.url).href;
const { BT, BLOCKS } = await import(R + 'shared/blocks.js');
const { analyzeDesign, encodeDesign, designCost, cropDesign } = await import(R + 'shared/shipStats.js');

const TARGET = 750000;
const W = 660, H = 640;
const cx = 330, cy = 320;
const g = new Uint8Array(W * H);
const inG = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const at = (x, y) => (inG(x, y) ? g[y * W + x] : 0);
const set = (x, y, t) => { if (inG(x, y)) g[y * W + x] = t; };
const I = (x, y) => y * W + x;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const TAU = Math.PI * 2;
const loc = (x, y, a) => { const dx = x - cx, dy = y - cy; return [dx * Math.cos(a) + dy * Math.sin(a), -dx * Math.sin(a) + dy * Math.cos(a)]; };
const wrld = (u, v, a) => [cx + u * Math.cos(a) - v * Math.sin(a), cy + u * Math.sin(a) + v * Math.cos(a)];
function inPoly(px, py, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c; } return c; }

const NB = 8, R0 = 182, apo = R0 * Math.cos(Math.PI / NB);
const bastionA = (k) => k * TAU / NB, curtainA = (k) => (k + 0.5) * TAU / NB;
// Bastion outline (u along its axis, v across). Gorge inside the core, flanks, orillon shoulders, faces to the tip.
const FL = 24, SH_U = R0 + 20, OR_U = R0 + 30, OR_V = 38, TIP = R0 + 104;
const BASTION = [[R0 - 50, -FL], [SH_U, -FL], [SH_U, -OR_V], [OR_U, -OR_V], [TIP, 0], [OR_U, OR_V], [SH_U, OR_V], [SH_U, FL], [R0 - 50, FL]];
// Ravelin: arrowhead outwork in front of each curtain, on a causeway.
const RB = apo + 30, RT = apo + 96, RW = 28;
const RAVELIN = [[RB, -RW], [RB + 14, -RW], [RT, 0], [RB + 14, RW], [RB, RW]];
const CAUSE = 7; // causeway half-width

function partAt(x, y) {
  for (let k = 0; k < NB; k++) { const [u, v] = loc(x, y, bastionA(k)); if (inPoly(u, v, BASTION)) return { kind: 'bastion', k, u, v }; }
  for (let k = 0; k < NB; k++) {
    const [u, v] = loc(x, y, curtainA(k));
    if (inPoly(u, v, RAVELIN)) return { kind: 'ravelin', k, u, v };
    if (u > apo - 4 && u < RB + 1 && Math.abs(v) <= CAUSE) return { kind: 'causeway', k, u, v };
  }
  // octagon core
  const dx = x - cx, dy = y - cy;
  for (let k = 0; k < NB; k++) { const a = curtainA(k); if (dx * Math.cos(a) + dy * Math.sin(a) > apo) return null; }
  return { kind: 'core' };
}

const hubX = cx - 20, hubY = cy;
const skinFront = +(process.argv[3] || 6), skinOther = +(process.argv[4] || 4);

// ---------------- 1. silhouette + interior structure ----------------
const kind = new Uint8Array(W * H); // 1 core 2 bastion 3 ravelin 4 causeway
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const p = partAt(x, y); if (!p) continue;
  const r = Math.hypot(x - cx, y - cy), rh = Math.hypot(x - hubX, y - hubY);
  let t = BT.FRAME;
  if (p.kind === 'core') {
    kind[I(x, y)] = 1;
    const ang = Math.atan2(y - cy, x - cx);
    const sp = Math.abs((((ang / (TAU / 32)) % 1) + 1) % 1 - 0.5) * (TAU / 32) * r; // 32 spokes
    if (rh < 34) {                                               // the citadel round the hub: heavy, with an 8-point star inlaid in armour
      const ah = Math.atan2(y - hubY, x - hubX), spike = Math.abs(Math.cos(4 * ah));
      const starR = 8 + 20 * Math.pow(spike, 6);
      t = (rh > 4 && Math.abs(rh - starR) < 1.2) || (rh > 4 && rh < 6) ? BT.ARMOR : BT.HEAVY;
    }
    else if (rh < 40) t = BT.ARMOR;
    else if (Math.abs(rh - 44) < 3.5) t = BT.HEAVY;             // keep wall
    else if (Math.abs(r - 92) < 3) t = BT.HEAVY;                // inner ring road
    else if (Math.abs(r - 128) < 2.5) t = BT.HEAVY;             // outer ring
    else if (sp < 1.6 && r > 40) t = BT.HEAVY;                  // spokes
    else t = ((x + y) % 6 === 0 || (x - y + 6000) % 6 === 0) ? BT.ARMOR : BT.FRAME; // armour lattice in frame
  } else if (p.kind === 'bastion') {
    kind[I(x, y)] = 2;
    t = Math.abs(p.v) < 2 ? BT.HEAVY : (Math.abs(p.u - (R0 + 60)) < 2 ? BT.HEAVY : (((x + y) % 6 === 0 || (x - y + 6000) % 6 === 0) ? BT.ARMOR : BT.FRAME));
  } else if (p.kind === 'ravelin') {
    kind[I(x, y)] = 3;
    t = Math.abs(p.v) < 2 ? BT.HEAVY : (((x + y) % 6 === 0 || (x - y + 6000) % 6 === 0) ? BT.ARMOR : BT.FRAME);
  } else { kind[I(x, y)] = 4; t = BT.HEAVY; }
  set(x, y, t);
}

// ---------------- 2. depth from space, heavy skin ----------------
function depthMap() {
  const dep = new Int16Array(W * H).fill(-1); let q = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (at(x, y) && N4.some(([a, b]) => !at(x + a, y + b))) { dep[I(x, y)] = 0; q.push(I(x, y)); }
  for (let d = 1; q.length; d++) { const nq = []; for (const i of q) { const x = i % W, y = (i / W) | 0; for (const [a, b] of N4) { if (!inG(x + a, y + b)) continue; const j = I(x + a, y + b); if (g[j] && dep[j] < 0) { dep[j] = d; nq.push(j); } } } q = nq; }
  return dep;
}
let dep = depthMap();
const facing = (x, y) => Math.cos(Math.atan2(y - cy, x - cx));
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = I(x, y); if (!g[i]) continue; const d = dep[i], f = facing(x, y);
  const hn = f > 0.35 ? skinFront : skinOther;
  if (d <= hn) g[i] = BT.HEAVY; else if (d <= hn + 3 && g[i] === BT.FRAME) g[i] = BT.ARMOR;
}

// ---------------- 3. multiblock units ----------------
function canUnit(x0, y0, s) {
  for (let y = y0 - 1; y <= y0 + s; y++) for (let x = x0 - 1; x <= x0 + s; x++) { const t = at(x, y); if (t === BT.LANCE || t === BT.BAY || t === BT.HUB) return false; }
  for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) if (!at(x, y)) return false;
  return true;
}
function stamp(x0, y0, s, t) { for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) set(x, y, t); }
// Push a unit centred near (px,py) outward along direction a until it would stick out: place it at the last fit.
function seat(px, py, a, s, t, maxSteps = 40) {
  let last = null;
  for (let st = -6; st < maxSteps; st++) {
    const x0 = Math.round(px + Math.cos(a) * st - s / 2), y0 = Math.round(py + Math.sin(a) * st - s / 2);
    if (canUnit(x0, y0, s)) last = [x0, y0]; else if (last) break;
  }
  if (last) stamp(last[0], last[1], s, t);
  return last;
}
// Plasma: 16 turrets set half out of the bastion faces (one per face), so each sees a wide arc,
// plus 4 on the tips of the front ravelins. Forced stamp: the part sticking out is new hull.
const plasma = [];
function force(cxu, cyu, s, t) {
  const x0 = Math.round(cxu - s / 2), y0 = Math.round(cyu - s / 2);
  for (let y = y0 - 1; y <= y0 + s; y++) for (let x = x0 - 1; x <= x0 + s; x++) { const q = at(x, y); if (q === BT.LANCE || q === BT.BAY) return null; }
  stamp(x0, y0, s, t); return [x0, y0];
}
const FACE_T = +(process.env.FACE_T || 0.42), FACE_OUT = +(process.env.FACE_OUT || -3);
for (let k = 0; k < NB; k++) for (const sd of [-1, 1]) {
  const a = bastionA(k);
  const u = OR_U + FACE_T * (TIP - OR_U), v = sd * OR_V * (1 - FACE_T);
  const nu = OR_V, nv = sd * (TIP - OR_U), nl = Math.hypot(nu, nv);
  const [px, py] = wrld(u + nu / nl * FACE_OUT, v + nv / nl * FACE_OUT, a);
  const p = force(px, py, 10, BT.LANCE); if (p) plasma.push(p);
}
for (const k of [0, 7, 1, 6]) {
  const a = curtainA(k); const [px, py] = wrld(RT - 3, 0, a);
  const p = force(px, py, 10, BT.LANCE); if (p) plasma.push(p);
}
// Fighter bays: 2 per flank, opening sideways into the ditch beside the curtain.
const bays = [];
for (let k = 0; k < NB; k++) for (const sd of [-1, 1]) for (const u of [R0 - 4, R0 + 8]) {
  const a = bastionA(k), side = a + sd * Math.PI / 2;
  const [px, py] = wrld(u, sd * (FL - 4), a);
  const p = seat(px, py, side, 6, BT.BAY, 20); if (p) bays.push(p);
}

// ---------------- 4. guns on the skin ----------------
// Crenellate faces: every 4th skin cell along a face is cut so guns stick out. Then guns in batteries.
dep = depthMap();
const skin = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = at(x, y); if (t && t !== BT.LANCE && t !== BT.BAY && dep[I(x, y)] === 0) skin.push([x, y]); }
for (const [x, y] of skin) { if (((x * 3 + y * 5) % 8) === 0 && kind[I(x, y)] !== 4) set(x, y, 0); }
const hash = (a) => { a = (a ^ 61) ^ (a >>> 16); a = a + (a << 3); a ^= a >>> 4; a = Math.imul(a, 0x27d4eb2d); return (a ^ (a >>> 15)) >>> 0; };
for (const [x, y] of skin) {
  if (!at(x, y)) continue;
  const f = facing(x, y);
  // battery = 7-cell stretch of the outline, same gun type
  const seg = hash(((x / 7) | 0) * 911 + ((y / 7) | 0) * 7919) % 100;
  const pd = ((x * 7 + y * 11) % 5) === 0; // point defence sprinkled through every battery
  let t;
  const V = process.env.MIX || 'a';
  if (V === 'a') {
    if (pd) t = BT.PD;
    else if (f > 0.5) t = seg < 38 ? BT.CANNON : seg < 62 ? BT.LASER : seg < 84 ? BT.GUIDED : BT.MISSILE;
    else if (f > -0.3) t = seg < 46 ? BT.CANNON : seg < 66 ? BT.LASER : seg < 82 ? BT.GUIDED : BT.MISSILE;
    else t = seg < 55 ? BT.CANNON : seg < 70 ? BT.LASER : seg < 80 ? BT.GUIDED : seg < 88 ? BT.MISSILE : BT.PD;
  } else {
    // front-weighted: the front always faces the enemy, so the rear is a PD-and-armour shell
    if (f > 0.4) t = pd ? BT.PD : seg < 34 ? BT.CANNON : seg < 56 ? BT.LASER : seg < 86 ? BT.GUIDED : BT.MISSILE;
    else if (f > -0.4) t = pd ? BT.PD : seg < 50 ? BT.CANNON : seg < 70 ? BT.LASER : seg < 85 ? BT.GUIDED : BT.MISSILE;
    else t = (pd || seg < 30) ? BT.PD : seg < 70 ? BT.CANNON : BT.HEAVY;
  }
  set(x, y, t);
}
set(hubX, hubY, BT.HUB);

// ---------------- 5. tidy: connected to hub, buried guns -> heavy ----------------
function prune() {
  const seen = new Uint8Array(W * H), st = [I(hubX, hubY)]; seen[st[0]] = 1;
  while (st.length) { const i = st.pop(), x = i % W, y = (i / W) | 0; for (const [a, b] of N4) { if (!inG(x + a, y + b)) continue; const j = I(x + a, y + b); if (g[j] && !seen[j]) { seen[j] = 1; st.push(j); } } }
  let n = 0; for (let i = 0; i < g.length; i++) if (g[i] && !seen[i]) { g[i] = 0; n++; } return n;
}
console.log('pruned', prune());
const crop = () => cropDesign({ w: W, h: H, cells: g, hub: I(hubX, hubY), name: 'Aegis Star Citadel', stance: 'line', place: 'auto' });
let d = crop(), info = analyzeDesign(d);
for (const wp of info.weapons) if (wp.buried && wp.group) for (const c of wp.group.cells) set(c % d.w + d.x0, ((c / d.w) | 0) + d.y0, BT.HEAVY); // sealed bays / blind plasma -> armour
for (const wp of info.weapons) if (wp.buried && !wp.group) set(wp.cell % d.w + d.x0, ((wp.cell / d.w) | 0) + d.y0, BT.HEAVY);
for (const wp of info.weapons) if (!wp.buried && !wp.group && wp.arcDeg < 30) set(wp.cell % d.w + d.x0, ((wp.cell / d.w) | 0) + d.y0, BT.HEAVY); // too narrow to be worth it

// ---------------- 6. exact budget ----------------
let cost = designCost({ cells: g });
console.log('cost before trim', cost);
dep = depthMap();
const inner = [];
for (let i = 0; i < g.length; i++) if ((g[i] === BT.FRAME || g[i] === BT.ARMOR) && dep[i] > 12) inner.push(i);
inner.sort((a, b) => Math.hypot((a % W) - hubX, ((a / W) | 0) - hubY) - Math.hypot((b % W) - hubX, ((b / W) | 0) - hubY));
if (cost > TARGET) for (let k = inner.length - 1; k >= 0 && cost > TARGET + 1; k--) { const i = inner[k]; if (g[i] === BT.ARMOR) { g[i] = BT.FRAME; cost -= 2; } }
if (cost < TARGET) for (const i of inner) { if (cost >= TARGET - 1) break; if (g[i] === BT.FRAME) { g[i] = BT.ARMOR; cost += 2; } }
// parity: swapping frame/armour/heavy always moves the price by an even amount, so fix an odd gap by
// hollowing out one deep interior frame cell (-1 cr) and paying the rest back in armour.
if ((TARGET - cost) % 2 !== 0) { const k = inner.findIndex((i) => g[i] === BT.FRAME); g[inner[k]] = 0; cost -= 1; inner.splice(k, 1); }
for (const i of inner) { if (cost >= TARGET) break; if (g[i] === BT.FRAME) { g[i] = BT.ARMOR; cost += 2; } }
for (let k = inner.length - 1; k >= 0 && cost > TARGET; k--) { const i = inner[k]; if (g[i] === BT.ARMOR) { g[i] = BT.FRAME; cost -= 2; } }

d = crop(); info = analyzeDesign(d);
const by = {}; for (const [t, n] of Object.entries(info.byType)) by[BLOCKS[t].name] = n;
console.log({ w: d.w, h: d.h, blocks: info.blocks, cost: info.cost, cls: info.hullClass?.name, hp: info.hp, dps: Math.round(info.dps), errors: info.errors, warnings: info.warnings.map((s) => s.slice(0, 90)), by });
const fire = {}; for (const [t, f] of Object.entries(info.fire)) fire[BLOCKS[t].name] = { n: f.count, buried: f.buried };
console.log(fire);
const arcs = info.weapons.filter((w) => !w.buried).map((w) => w.arcDeg).sort((a, b) => a - b);
console.log('arc median', arcs[arcs.length >> 1], 'p10', arcs[(arcs.length * 0.1) | 0], 'plasma placed', plasma.length, 'bays', bays.length);
const out = process.argv[2] || '/home/claude/fortress/aegis.json';
writeFileSync(out, JSON.stringify(encodeDesign(d)));
console.log('wrote', out);
