// Ship designer page: grid editor, live stats and price, validation, save/load and test battles.
// All game numbers come from src/shared (blocks.js, shipStats.js, economy.js), the same code the
// battle sim and server use.

import { BT, BLOCKS, WEAPON, MULTIBLOCK, HULL_CLASSES, ARC_DEG } from '../shared/blocks.js';
import { analyzeDesign, encodeDesign, decodeDesign, designCost, STANCE_INFO } from '../shared/shipStats.js';
import { shipyardPrice, SHIPYARD_INTERVAL_MIN, SHIPYARD_PRICE_MULT } from '../shared/economy.js';
import { makeDesign, CLASSES } from '../shared/designs.js';
import { Battle, DT } from '../sim/battle.js';
import { packReplay } from '../shared/replayFormat.js';
import { ShipEditor } from './editor.js';
import { makeTestScenario, summarise, DEFAULT_COPIES } from './testBattle.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString();

// Same colours as the replay viewer's Azure side, so a design looks like it will in battle.
const COLOR = {
  [BT.HUB]: '#86e8ff', [BT.ARMOR]: '#5c7ea3', [BT.HEAVY]: '#41597a', [BT.FRAME]: '#90a6c0', [BT.THRUSTER]: '#3d434f',
  [BT.LASER]: '#d8f4ff', [BT.CANNON]: '#9aa1ab', [BT.MISSILE]: '#b9b16c', [BT.PD]: '#7fc4e0', [BT.LANCE]: '#5b5f9c',
};
// Palette order and number keys.
const PALETTE = [
  [BT.FRAME, '1'], [BT.ARMOR, '2'], [BT.HEAVY, '3'], [BT.THRUSTER, '4'], [BT.LASER, '5'],
  [BT.CANNON, '6'], [BT.PD, '7'], [BT.MISSILE, '8'], [BT.LANCE, '9'], [BT.HUB, '0'], [0, 'x'],
];
const WEAPON_ORDER = [BT.LASER, BT.CANNON, BT.PD, BT.MISSILE, BT.LANCE];
const ARC = (ARC_DEG * Math.PI) / 180;

const ed = new ShipEditor();
let block = BT.ARMOR, tool = 'pencil', showArcs = false;
let design = null, info = null, seenVersion = -1;
const canvas = $('grid'), g = canvas.getContext('2d');
const cam = { x: ed.w / 2, y: ed.h / 2, zoom: 12 };
let dirty = true, hover = null;

// ------------------------------------------------------------ storage (never fatal)
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const LIB_KEY = 'lsb.designs.v1', CUR_KEY = 'lsb.designer.current.v1';

// ------------------------------------------------------------ UI setup
function blockTitle(t) {
  if (!t) return 'Erase blocks (right drag also erases)';
  const B = BLOCKS[t], W = WEAPON[t];
  let s = `${B.name}: ${B.cost} cr, ${B.hp} hp, mass ${B.mass}`;
  if (MULTIBLOCK[t]) s = `${B.name}: one 10×10 unit, ${B.cost * 100} cr, ${B.hp} hp per block, keeps firing while half survives`;
  if (t === BT.THRUSTER) s += `, thrust ${B.thrust}`;
  if (W) s += `. Range ${W.range}, ${W.damage} damage every ${W.cooldown} s`;
  if (t === BT.HUB) s += '. One per ship; placing it moves it. Lose it and the ship breaks apart.';
  return s;
}
for (const [t, key] of PALETTE) {
  const b = document.createElement('button');
  b.className = 'blk'; b.dataset.block = t; b.title = `${blockTitle(t)} (${key.toUpperCase()})`;
  const cost = !t ? '' : MULTIBLOCK[t] ? `${BLOCKS[t].cost * 100}` : `${BLOCKS[t].cost}`;
  b.innerHTML = `<i style="background:${t ? COLOR[t] : 'transparent'};${t ? '' : 'box-shadow:inset 0 0 0 1px var(--bad)'}"></i><span>${t ? BLOCKS[t].name + (MULTIBLOCK[t] ? ' 10×10' : '') : 'Erase'}</span><em>${cost ? cost + ' cr' : ''}</em>`;
  b.addEventListener('click', () => setBlock(t));
  $('blocks').append(b);
}
function setBlock(t) {
  block = t;
  if ((t === BT.LANCE || t === BT.HUB) && tool !== 'pencil') setTool('pencil');
  document.querySelectorAll('.blk').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.block) === t)));
  dirty = true;
}
function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  if (t !== 'pencil' && (block === BT.LANCE || block === BT.HUB)) setBlock(BT.ARMOR);
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

for (const [id, s] of Object.entries(STANCE_INFO)) $('stance').add(new Option(s.label, id));
$('stance').addEventListener('change', () => { ed.stance = $('stance').value; ed.changed(); });
$('name').addEventListener('input', () => { ed.name = $('name').value; ed.changed(); });

const tpl = $('template');
tpl.add(new Option('Start from…', ''));
tpl.add(new Option('Blank (hub only)', 'blank'));
for (const cls of Object.keys(CLASSES)) tpl.add(new Option(`Sample ${cls}`, cls));
tpl.addEventListener('change', () => {
  const v = tpl.value;
  tpl.value = '';
  if (!v) return;
  if (v === 'blank') { ed.clear(); ed.name = 'New design'; ed.stance = 'line'; toast('Cleared. Undo to get your design back.'); }
  else { const d = makeDesign(v, 7 + Math.floor(Math.random() * 1000)); ed.load({ ...d, name: `My ${v}` }); toast(`Loaded a sample ${v}. Undo to go back.`); }
  syncFields(); fit();
});

const toggle = (id, get, set) => {
  const b = $(id);
  const sync = () => b.setAttribute('aria-pressed', String(get()));
  b.addEventListener('click', () => { set(!get()); sync(); dirty = true; });
  sync();
  return sync;
};
const syncMirror = toggle('mirror', () => ed.mirror, (v) => { ed.mirror = v; });
const syncArcs = toggle('arcs', () => showArcs, (v) => { showArcs = v; });
$('undo').addEventListener('click', () => { ed.undo() && syncFields(); });
$('redo').addEventListener('click', () => { ed.redo() && syncFields(); });
$('fitbtn').addEventListener('click', fit);

function syncFields() { $('name').value = ed.name; $('stance').value = ed.stance; dirty = true; }

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

// ------------------------------------------------------------ analysis -> stats panel
function refresh() {
  if (ed.version === seenVersion) return;
  seenVersion = ed.version;
  design = ed.toDesign();
  info = analyzeDesign(design);
  dirty = true;
  const a = info;
  $('cost').textContent = fmt(a.cost);
  $('yard').textContent = fmt(shipyardPrice(design));
  $('yard-hint').textContent = `A shipyard costs ${SHIPYARD_PRICE_MULT}× the ship and builds one free every ${SHIPYARD_INTERVAL_MIN} min until the world falls. It pays for itself in ${(SHIPYARD_PRICE_MULT * SHIPYARD_INTERVAL_MIN / 60).toFixed(0)} h.`;
  const cls = a.hullClass || HULL_CLASSES[HULL_CLASSES.length - 1];
  $('cls').textContent = a.hullClass ? cls.name : 'Too big';
  $('cls').style.color = a.hullClass ? '' : 'var(--bad)';
  $('blocks-count').textContent = `${fmt(a.blocks)} / ${fmt(cls.maxBlocks)} blocks`;
  const prev = HULL_CLASSES[HULL_CLASSES.indexOf(cls) - 1]?.maxBlocks ?? 0;
  $('cls-meter').style.width = `${Math.min(100, ((a.blocks - prev) / (cls.maxBlocks - prev)) * 100)}%`;
  $('s-size').textContent = `${design.w} × ${design.h}`;
  $('s-mass').textContent = fmt(a.mass);
  $('s-speed').textContent = `${a.maxSpeed.toFixed(1)} /s${a.maxSpeed >= 22 ? ' (max)' : ''}`;
  $('s-turn').textContent = `${a.turnDeg.toFixed(0)}°/s`;
  $('s-hp').textContent = fmt(a.hp);
  $('s-dps').textContent = a.dps ? `${a.dps.toFixed(0)} (${fmt(a.alpha)} volley)` : '—';
  $('s-range').textContent = a.maxRange ? (a.minRange === a.maxRange ? `${a.maxRange}` : `${a.minRange}–${a.maxRange}`) : '—';
  $('weapons').innerHTML = WEAPON_ORDER.filter((t) => a.fire[t]).map((t) => {
    const f = a.fire[t];
    return `<tr><td>${BLOCKS[t].name}</td><td>${f.count}${f.buried ? ` <small title="buried">(${f.buried} buried)</small>` : ''}</td><td>${f.dps.toFixed(t === BT.MISSILE ? 1 : 0)}</td><td>${f.range}</td></tr>`;
  }).join('') || '<tr><td colspan="4" style="color:var(--dim)">No weapons yet</td></tr>';
  $('stance-hint').textContent = STANCE_INFO[ed.stance].hint;
  const items = [...a.errors.map((s) => `<li class="err">${s}</li>`), ...a.warnings.map((s) => `<li class="warn">${s}</li>`)];
  $('issues').innerHTML = items.join('') || '<li class="ok">Ready for battle.</li>';
  $('test-btn').disabled = !a.ok;
  $('test-btn').title = a.ok ? '' : 'Fix the red issues first';
  saveCurrent();
}

let saveTimer = 0;
function saveCurrent() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(CUR_KEY, encodeDesign(design)), 400);
}

// ------------------------------------------------------------ drawing
function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1), r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, r.width * dpr); canvas.height = Math.max(1, r.height * dpr);
  dirty = true;
}
const sx = (x) => (x - cam.x) * cam.zoom * dpr() + canvas.width / 2;
const sy = (y) => (y - cam.y) * cam.zoom * dpr() + canvas.height / 2;
const dpr = () => canvas.width / Math.max(1, canvas.clientWidth);
const toCell = (clientX, clientY) => {
  const r = canvas.getBoundingClientRect();
  return [Math.floor(cam.x + (clientX - r.left - r.width / 2) / cam.zoom), Math.floor(cam.y + (clientY - r.top - r.height / 2) / cam.zoom)];
};

function draw() {
  const W = canvas.width, H = canvas.height, z = cam.zoom * dpr();
  g.clearRect(0, 0, W, H);
  // Build area and grid lines.
  g.fillStyle = 'rgba(134,170,220,0.035)';
  g.fillRect(sx(0), sy(0), ed.w * z, ed.h * z);
  if (z >= 6) {
    g.beginPath();
    for (let x = 0; x <= ed.w; x++) { g.moveTo(sx(x) + 0.5, sy(0)); g.lineTo(sx(x) + 0.5, sy(ed.h)); }
    for (let y = 0; y <= ed.h; y++) { g.moveTo(sx(0), sy(y) + 0.5); g.lineTo(sx(ed.w), sy(y) + 0.5); }
    g.strokeStyle = 'rgba(140,170,210,0.07)'; g.lineWidth = 1; g.stroke();
  }
  g.strokeStyle = 'rgba(140,170,210,0.3)'; g.lineWidth = 1;
  g.strokeRect(sx(0) + 0.5, sy(0) + 0.5, ed.w * z, ed.h * z);
  // Forward marker.
  const ay = sy(ed.h / 2), axx = sx(ed.w) + 14 * dpr();
  g.fillStyle = 'rgba(134,232,255,0.6)';
  g.beginPath(); g.moveTo(axx + 14 * dpr(), ay); g.lineTo(axx, ay - 8 * dpr()); g.lineTo(axx, ay + 8 * dpr()); g.fill();
  g.font = `${11 * dpr()}px "Chakra Petch", sans-serif`; g.textAlign = 'center';
  g.fillText('FORWARD', axx + 7 * dpr(), ay + 22 * dpr());
  // Mirror axis.
  if (ed.mirror) {
    const y = sy(ed.axis() + 0.5);
    g.setLineDash([6 * dpr(), 6 * dpr()]);
    g.strokeStyle = 'rgba(134,232,255,0.35)';
    g.beginPath(); g.moveTo(sx(0), y); g.lineTo(sx(ed.w), y); g.stroke();
    g.setLineDash([]);
  }

  // Blocks.
  const gap = z >= 8 ? Math.max(1, z * 0.06) : 0;
  const cells = ed.cells;
  for (let i = 0; i < cells.length; i++) {
    const t = cells[i];
    if (!t || t === BT.LANCE) continue;
    const x = sx(i % ed.w), y = sy((i / ed.w) | 0);
    g.fillStyle = COLOR[t];
    g.fillRect(x + gap, y + gap, z - gap * 2, z - gap * 2);
    if (z >= 7) glyph(t, x, y, z);
  }
  // Heavy lasers: one turret per unit.
  if (info) {
    const ox = design.x0, oy = design.y0;
    for (const w of info.weapons) {
      if (!w.group) continue;
      const gr = w.group, x = sx(gr.x0 + ox), y = sy(gr.y0 + oy), ww = (gr.x1 - gr.x0 + 1) * z, hh = (gr.y1 - gr.y0 + 1) * z;
      g.fillStyle = COLOR[BT.LANCE];
      for (const c of gr.cells) g.fillRect(sx((c % design.w) + ox) - 0.5, sy(((c / design.w) | 0) + oy) - 0.5, z + 1, z + 1);
      if (gr.ok) {
        const cx = x + ww / 2, cy = y + hh / 2;
        g.strokeStyle = 'rgba(200,205,255,0.55)'; g.lineWidth = Math.max(1, z * 0.25);
        g.beginPath(); g.arc(cx, cy, ww * 0.32, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#c9ccff'; g.fillRect(cx, cy - z * 0.45, ww * 0.5, z * 0.9);
        g.beginPath(); g.arc(cx, cy, ww * 0.15, 0, Math.PI * 2); g.fill();
      }
      g.strokeStyle = gr.ok ? 'rgba(200,205,255,0.4)' : '#ff6b6b'; g.lineWidth = Math.max(1, dpr());
      g.strokeRect(x + 0.5, y + 0.5, ww - 1, hh - 1);
    }
    // Problems: loose blocks and buried weapons.
    g.fillStyle = 'rgba(255,80,80,0.45)';
    for (const c of info.loose) g.fillRect(sx((c % design.w) + ox), sy(((c / design.w) | 0) + oy), z, z);
    g.strokeStyle = '#ff6b6b'; g.lineWidth = Math.max(1.5, z * 0.12);
    for (const w of info.weapons) {
      if (!w.buried) continue;
      const x = sx(w.x - 0.5 + ox), y = sy(w.y - 0.5 + oy), m = z * 0.22;
      g.beginPath(); g.moveTo(x + m, y + m); g.lineTo(x + z - m, y + z - m); g.moveTo(x + z - m, y + m); g.lineTo(x + m, y + z - m); g.stroke();
    }
    // Firing arcs: all of them, or just the weapon under the cursor.
    const hoverCell = hover ? ed.idx(hover[0], hover[1]) : -1;
    for (const w of info.weapons) {
      const at = ((w.y - 0.5 + oy) | 0) * ed.w + ((w.x - 0.5 + ox) | 0);
      const mine = w.group ? w.group.cells.some((c) => ((c / design.w) | 0) + oy === hover?.[1] && (c % design.w) + ox === hover?.[0]) : at === hoverCell;
      if (!showArcs && !mine) continue;
      drawArc(w, sx(w.x + ox), sy(w.y + oy), z, mine);
    }
  }

  // Cursor preview.
  if (hover && !panning) {
    const [hx, hy] = hover;
    if (drag && tool === 'rect') {
      const x0 = Math.min(drag.x, hx), y0 = Math.min(drag.y, hy), x1 = Math.max(drag.x, hx), y1 = Math.max(drag.y, hy);
      previewRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1, drag.type);
      if (ed.mirror) { const my0 = ed.mirrorY(y1), my1 = ed.mirrorY(y0); previewRect(x0, my0, x1 - x0 + 1, my1 - my0 + 1, drag.type, true); }
    } else if (block === BT.LANCE) {
      const [x0, y0] = ShipEditor.stampOrigin(hx, hy);
      previewRect(x0, y0, 10, 10, BT.LANCE);
      if (ed.mirror) { const my0 = ed.mirrorY(y0 + 9); if (my0 >= y0 + 10 || my0 + 10 <= y0) previewRect(x0, my0, 10, 10, BT.LANCE, true); }
    } else {
      previewRect(hx, hy, 1, 1, block);
      if (ed.mirror && block !== BT.HUB && ed.mirrorY(hy) !== hy) previewRect(hx, ed.mirrorY(hy), 1, 1, block, true);
    }
  }
}

function previewRect(x, y, w, h, t, faint) {
  const z = cam.zoom * dpr();
  g.globalAlpha = faint ? 0.18 : 0.35;
  g.fillStyle = t ? COLOR[t] : '#ff6b6b';
  g.fillRect(sx(x), sy(y), w * z, h * z);
  g.globalAlpha = faint ? 0.4 : 0.9;
  g.strokeStyle = t ? '#e6eeff' : '#ff6b6b'; g.lineWidth = Math.max(1, dpr());
  g.strokeRect(sx(x) + 0.5, sy(y) + 0.5, w * z - 1, h * z - 1);
  g.globalAlpha = 1;
}

function glyph(t, x, y, z) {
  const c = z / 2;
  g.fillStyle = 'rgba(5,7,12,0.55)';
  if (t === BT.HUB) { g.strokeStyle = 'rgba(5,7,12,0.6)'; g.lineWidth = Math.max(1, z * 0.12); g.beginPath(); g.arc(x + c, y + c, z * 0.26, 0, Math.PI * 2); g.stroke(); }
  else if (t === BT.CANNON) { g.beginPath(); g.arc(x + c, y + c, z * 0.22, 0, Math.PI * 2); g.fill(); }
  else if (t === BT.LASER) { g.fillRect(x + z * 0.2, y + c - z * 0.08, z * 0.6, z * 0.16); }
  else if (t === BT.PD) { g.fillRect(x + c - z * 0.12, y + c - z * 0.12, z * 0.24, z * 0.24); }
  else if (t === BT.MISSILE) { g.beginPath(); g.moveTo(x + c, y + z * 0.18); g.lineTo(x + z * 0.82, y + c); g.lineTo(x + c, y + z * 0.82); g.lineTo(x + z * 0.18, y + c); g.fill(); }
  else if (t === BT.THRUSTER) { g.fillStyle = 'rgba(88,184,255,0.55)'; g.fillRect(x + z * 0.12, y + z * 0.3, z * 0.22, z * 0.4); }
  else if (t === BT.HEAVY) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x + z * 0.2, y + z * 0.2, z * 0.6, z * 0.6); }
}

function drawArc(w, x, y, z, strong) {
  // Direction only: real ranges (30 to 700 blocks) dwarf the ship, so arcs are drawn short.
  const R = Math.min(110 * dpr(), Math.max(28 * dpr(), (strong ? 4 : 2.5) * z));
  g.lineWidth = Math.max(1, dpr());
  if (w.buried) return;
  if (w.omni) {
    g.setLineDash([4 * dpr(), 4 * dpr()]);
    g.strokeStyle = strong ? 'rgba(255,179,92,0.9)' : 'rgba(255,179,92,0.35)';
    g.beginPath(); g.arc(x, y, R * (w.group ? 1.6 : 0.8), 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    return;
  }
  const a = Math.atan2(w.fy, w.fx);
  g.beginPath(); g.moveTo(x, y); g.arc(x, y, R, a - ARC, a + ARC); g.closePath();
  g.fillStyle = strong ? 'rgba(134,232,255,0.16)' : 'rgba(134,232,255,0.05)'; g.fill();
  g.strokeStyle = strong ? 'rgba(134,232,255,0.8)' : 'rgba(134,232,255,0.2)'; g.stroke();
}

// ------------------------------------------------------------ hover readout
const SIDES = ['forward', 'forward-starboard', 'starboard', 'aft-starboard', 'aft', 'aft-port', 'port', 'forward-port'];
function describe(x, y) {
  const i = ed.idx(x, y), t = i < 0 ? 0 : ed.cells[i];
  if (!t) return `${x}, ${y}`;
  let s = `${BLOCKS[t].name} · ${BLOCKS[t].hp} hp · ${MULTIBLOCK[t] ? BLOCKS[t].cost * 100 + ' cr (unit)' : BLOCKS[t].cost + ' cr'}`;
  if (info && design) {
    const ox = design.x0, oy = design.y0;
    const w = info.weapons.find((v) => v.group ? v.group.cells.some((c) => (c % design.w) + ox === x && ((c / design.w) | 0) + oy === y) : (v.x - 0.5 + ox) === x && (v.y - 0.5 + oy) === y);
    if (w) {
      if (w.buried) s += ' · buried: can\'t fire until exposed';
      else if (w.omni) s += ' · fires in any direction';
      else s += ` · fires ${SIDES[(Math.round(Math.atan2(w.fy, w.fx) / (Math.PI / 4)) + 8) % 8]} ±${ARC_DEG}°`;
    }
    if (info.loose.includes((y - oy) * design.w + (x - ox))) s += ' · not connected to the hub';
  }
  return s;
}

// ------------------------------------------------------------ input
let drag = null, panning = false, spaceDown = false, last = null;
const pointers = new Map();

function zoomAt(clientX, clientY, k) {
  const r = canvas.getBoundingClientRect();
  const px = clientX - r.left - r.width / 2, py = clientY - r.top - r.height / 2;
  const wx = cam.x + px / cam.zoom, wy = cam.y + py / cam.zoom;
  cam.zoom = Math.max(2, Math.min(48, cam.zoom * k));
  cam.x = wx - px / cam.zoom; cam.y = wy - py / cam.zoom;
  dirty = true;
}

function fit() {
  refresh();
  const r = canvas.getBoundingClientRect();
  const has = info && info.blocks > 1;
  const w = has ? design.w : 24, h = has ? design.h : 16;
  cam.x = (has ? design.x0 : ed.w / 2 - 12) + w / 2;
  cam.y = (has ? design.y0 : ed.h / 2 - 8) + h / 2;
  cam.zoom = Math.max(2, Math.min(40, Math.min((r.width - 90) / w, (r.height - 60) / h) * 0.9));
  dirty = true;
}

// Paint along a line between two cells so fast strokes don't leave gaps.
function strokeTo(x, y, type) {
  if (!last) { ed.paint(x, y, type); last = [x, y]; return; }
  let [x0, y0] = last;
  const dx = Math.abs(x - x0), dy = -Math.abs(y - y0), stx = x0 < x ? 1 : -1, sty = y0 < y ? 1 : -1;
  let err = dx + dy;
  for (let n = 0; n < 512; n++) {
    ed.paint(x0, y0, type);
    if (x0 === x && y0 === y) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += stx; }
    if (e2 <= dx) { err += dx; y0 += sty; }
  }
  last = [x, y];
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // Second finger: this is a pan/zoom gesture, so undo any stroke the first finger started.
    if (drag && drag.started) ed.undo();
    drag = null; panning = true;
    return;
  }
  if (e.button === 1 || spaceDown) { panning = true; return; }
  const [x, y] = toCell(e.clientX, e.clientY);
  const type = e.button === 2 ? 0 : block;
  drag = { x, y, type, started: false };
  last = null;
  if (tool === 'pencil' || type === BT.LANCE || type === BT.HUB) {
    ed.checkpoint(); drag.started = true;
    if (type === BT.LANCE) { if (!ed.stamp(x, y)) toast('A heavy laser needs a clear 10×10 space inside the grid, away from the hub.'); drag.once = true; }
    else if (type === BT.HUB) { ed.setCell(x, y, BT.HUB); drag.once = true; }
    else strokeTo(x, y, type);
  } else if (tool === 'fill') {
    ed.checkpoint();
    if (!ed.fill(x, y, type)) { ed.undoStack.pop(); toast(ed.get(x, y) ? 'Nothing to fill there.' : 'Fill only works inside a closed outline.'); }
    drag = null;
  }
  dirty = true;
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (panning && p) {
    if (pointers.size === 2) {
      // Two fingers: pan with the midpoint, zoom with the spread.
      const [a, b] = [...pointers.values()];
      const m0x = (a.x + b.x) / 2, m0y = (a.y + b.y) / 2, d0 = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const m1x = (a.x + b.x) / 2, m1y = (a.y + b.y) / 2, d1 = Math.hypot(a.x - b.x, a.y - b.y);
      cam.x -= (m1x - m0x) / cam.zoom; cam.y -= (m1y - m0y) / cam.zoom;
      if (d0 > 0) zoomAt(m1x, m1y, d1 / d0);
    } else {
      cam.x -= (e.clientX - p.x) / cam.zoom; cam.y -= (e.clientY - p.y) / cam.zoom;
      p.x = e.clientX; p.y = e.clientY;
    }
    dirty = true;
    return;
  }
  if (p) { p.x = e.clientX; p.y = e.clientY; }
  const [x, y] = toCell(e.clientX, e.clientY);
  if (!hover || hover[0] !== x || hover[1] !== y) {
    hover = [x, y]; dirty = true;
    const el = $('hover');
    el.hidden = x < 0 || y < 0 || x >= ed.w || y >= ed.h;
    if (!el.hidden) el.textContent = describe(x, y);
    if (drag && drag.started && !drag.once && tool === 'pencil') strokeTo(x, y, drag.type);
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (panning) { if (!pointers.size) panning = false; return; }
  if (drag && tool === 'rect' && !drag.started && hover) {
    ed.checkpoint();
    ed.rect(drag.x, drag.y, hover[0], hover[1], drag.type);
  }
  drag = null; last = null; dirty = true;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; $('hover').hidden = true; dirty = true; } });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); (e.shiftKey ? ed.redo() : ed.undo()) && syncFields(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); ed.redo() && syncFields(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveToLibrary(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault(); return; }
  const p = PALETTE.find(([, key]) => key === k);
  if (p) return setBlock(p[0]);
  if (k === 'b') setTool('pencil');
  if (k === 'r') setTool('rect');
  if (k === 'f') setTool('fill');
  if (k === 'm') { ed.mirror = !ed.mirror; syncMirror(); dirty = true; }
  if (k === 'a') { showArcs = !showArcs; syncArcs(); dirty = true; }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; canvas.style.cursor = ''; } });

// ------------------------------------------------------------ library, export, import
function thumbnail(d) {
  const c = document.createElement('canvas'), s = Math.max(1, Math.min(4, Math.floor(96 / d.w)));
  c.width = d.w * s; c.height = d.h * s;
  const x = c.getContext('2d');
  for (let i = 0; i < d.cells.length; i++) if (d.cells[i]) { x.fillStyle = COLOR[d.cells[i]]; x.fillRect((i % d.w) * s, ((i / d.w) | 0) * s, s, s); }
  return c.toDataURL();
}
const library = () => store.get(LIB_KEY, []);

function saveToLibrary() {
  refresh();
  const name = (ed.name || '').trim() || 'Unnamed';
  ed.name = name; syncFields();
  const lib = library(), entry = { ...encodeDesign({ ...design, name }), savedAt: Date.now() };
  const k = lib.findIndex((o) => o.name === name);
  if (k >= 0) lib[k] = entry; else lib.unshift(entry);
  if (!store.set(LIB_KEY, lib)) return toast('Couldn\'t save: browser storage is unavailable. Use Export instead.');
  toast(info.ok ? `Saved “${name}”.` : `Saved “${name}” as a draft. Fix the red issues before building it.`);
}
$('save').addEventListener('click', saveToLibrary);

function openLibrary() {
  const lib = library(), list = $('lib-list');
  list.innerHTML = lib.length ? '' : '<p class="empty">No saved designs yet. Use Save to keep one here.</p>';
  lib.forEach((o, k) => {
    let d;
    try { d = decodeDesign(o); } catch { return; }
    const a = analyzeDesign(d);
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<img alt=""><div class="meta"><b></b><span>${a.hullClass?.name ?? 'Too big'} · ${fmt(a.cost)} cr · ${a.blocks} blocks${a.ok ? '' : ' · draft'}</span></div><div class="row"><button data-act="load">Load</button><button data-act="del" title="Delete">✕</button></div>`;
    item.querySelector('img').src = thumbnail(d);
    item.querySelector('b').textContent = d.name;
    item.querySelector('[data-act=load]').addEventListener('click', () => { ed.load(d); syncFields(); fit(); $('library').close(); toast(`Loaded “${d.name}”.`); });
    item.querySelector('[data-act=del]').addEventListener('click', () => {
      if (!confirm(`Delete “${d.name}”?`)) return;
      const l = library(); l.splice(k, 1); store.set(LIB_KEY, l); openLibrary();
    });
    list.append(item);
  });
  if (!$('library').open) $('library').showModal();
}
$('library-btn').addEventListener('click', openLibrary);
$('lib-close').addEventListener('click', () => $('library').close());

$('export').addEventListener('click', () => {
  refresh();
  const blob = new Blob([JSON.stringify(encodeDesign(design), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(design.name || 'ship').replace(/[^\w-]+/g, '_')}.ship.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { const d = decodeDesign(JSON.parse(await f.text())); ed.load(d); syncFields(); fit(); toast(`Imported “${d.name}”.`); }
  catch (err) { toast(`Couldn't import: ${err.message}`); }
});

// ------------------------------------------------------------ test battle
let lastReplay = null;
function openTest() {
  refresh();
  if (!info.ok) return;
  $('t-copies').value = DEFAULT_COPIES[design.cls] ?? 10;
  const opp = $('t-opp');
  opp.innerHTML = '';
  opp.add(new Option('Mixed fleet (sample designs)', ''));
  opp.add(new Option('A copy of this design', 'self'));
  library().forEach((o, k) => { try { const d = decodeDesign(o); if (analyzeDesign(d).ok) opp.add(new Option(`Saved: ${d.name} (${fmt(designCost(d))} cr)`, String(k))); } catch { /* skip */ } });
  $('test-result').hidden = true; $('test-progress').hidden = true; $('t-watch').hidden = true;
  $('t-run').disabled = false;
  $('test').showModal();
}
$('test-btn').addEventListener('click', openTest);
$('t-close').addEventListener('click', () => $('test').close());

let running = false;
$('t-run').addEventListener('click', async () => {
  if (running) return;
  refresh();
  running = true;
  $('t-run').disabled = true; $('t-watch').hidden = true; $('test-result').hidden = true; $('test-progress').hidden = false;
  const copies = Math.max(1, Math.min(400, Number($('t-copies').value) || 1));
  const seed = Math.max(1, Number($('t-seed').value) || 1);
  const v = $('t-opp').value;
  const mine = { ...design, name: design.name || 'Your design' };
  const opponent = v === 'self' ? { ...mine } : v ? decodeDesign(library()[Number(v)]) : null;
  const scen = makeTestScenario(mine, copies, opponent, seed);
  const b = new Battle({ designs: scen.designs, ships: scen.ships, seed });
  const t0 = performance.now();
  while (!b.done) {
    const end = performance.now() + 30;
    while (!b.done && performance.now() < end) b.step();
    $('t-status').textContent = `${(b.tick * DT).toFixed(0)} s · ${b.teamAlive[0]} vs ${b.teamAlive[1]} ships`;
    $('t-bar').style.width = `${Math.min(100, (b.tick / b.maxTicks) * 100)}%`;
    await new Promise((r) => requestAnimationFrame(r));
    if (!$('test').open) break;
  }
  const computeMs = performance.now() - t0;
  running = false;
  $('t-run').disabled = false;
  if (!b.done) { $('test-progress').hidden = true; return; }
  const s = summarise(b, scen);
  const rep = b.toReplay();
  lastReplay = { bytes: packReplay(rep.meta, rep.cols), computeMs, sides: [mine.name, opponent ? opponent.name : 'Mixed fleet'] };
  const verdict = s.winner === 0 ? ['win', 'Victory'] : s.winner === 1 ? ['loss', 'Defeat'] : ['', 'Draw'];
  const pct = (k) => `${Math.round((s.lost[k] / s.start[k]) * 100)}%`;
  $('test-result').innerHTML = `
    <div class="verdict ${verdict[0]}">${verdict[1]}</div>
    <table>
      <thead><tr><th></th><th>Ships</th><th>Survived</th><th>Fleet value</th><th>Lost</th></tr></thead>
      <tbody>
        <tr><td>You</td><td>${s.startCount[0]}</td><td>${s.alive[0]}</td><td>${fmt(s.start[0])}</td><td>${fmt(s.lost[0])} (${pct(0)})</td></tr>
        <tr><td>Enemy</td><td>${s.startCount[1]}</td><td>${s.alive[1]}</td><td>${fmt(s.start[1])}</td><td>${fmt(s.lost[1])} (${pct(1)})</td></tr>
      </tbody>
    </table>
    <p class="hint">Battle lasted ${s.seconds.toFixed(0)} s. Ships that lost every weapon count as lost. Try a few seeds: one battle can be luck.</p>`;
  $('test-result').hidden = false; $('test-progress').hidden = true; $('t-watch').hidden = false;
});

$('t-watch').addEventListener('click', () => {
  if (!lastReplay) return;
  const win = window.open('viewer.html#replay', '_blank');
  if (!win) return toast('Your browser blocked the replay window. Allow pop-ups for this page.');
  const send = (e) => {
    if (e.source !== win || e.data?.type !== 'lsb-viewer-ready') return;
    removeEventListener('message', send);
    const copy = lastReplay.bytes.slice();
    win.postMessage({ type: 'lsb-replay', bytes: copy.buffer, computeMs: lastReplay.computeMs, sides: lastReplay.sides }, '*', [copy.buffer]);
  };
  addEventListener('message', send);
});

// ------------------------------------------------------------ start
function loop() {
  refresh();
  if (dirty) { dirty = false; draw(); }
  requestAnimationFrame(loop);
}
addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
resize();
const saved = store.get(CUR_KEY, null);
let restored = false;
if (saved) { try { const d = decodeDesign(saved); if (d.cells.some((c) => c && c !== BT.HUB)) { ed.load(d); ed.undoStack.length = 0; restored = true; } } catch { /* start fresh */ } }
if (!restored) { ed.load({ ...makeDesign('destroyer', 21), name: 'My destroyer' }); ed.undoStack.length = 0; }
setBlock(BT.ARMOR); setTool('pencil'); syncFields();
requestAnimationFrame(() => { resize(); fit(); loop(); });

// Small hook for debugging and automated checks.
window.shipDesigner = { editor: ed, get design() { return design; }, get info() { return info; }, cam, fit };
