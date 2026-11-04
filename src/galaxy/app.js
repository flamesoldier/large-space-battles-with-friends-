// Galaxy map page: the world, economy and fleets, played as a hot-seat game in one browser until
// there is a server. Every rule lives in src/world (world.js, routes.js, galaxyGen.js) and
// src/shared/economy.js; this file only draws the map, takes clicks and runs battles.
//
// Time: the world has its own clock. While the page is open it runs at the chosen speed (60× by
// default, so a 30-minute shipyard cycle takes 30 s); time spent with the page closed counts at
// 1×, as it will on the server. The clock stops while a battle is being resolved.

import { BT } from '../shared/blocks.js';
import { decodeDesign, analyzeDesign, designCost } from '../shared/shipStats.js';
import { SHIPYARD_INTERVAL_MIN, SHIPYARD_CROWDING_CR, SHIPYARD_SELL_REFUND, shipyardPrice } from '../shared/economy.js';
import { Battle, DT } from '../sim/battle.js';
import { packReplay } from '../shared/replayFormat.js';
import { mulberry32 } from '../shared/rng.js';
import {
  createWorld, advanceTo, dueFleet, arrivalPlan, completeArrival, buildShipyard, sellShipyard, quoteShipyard,
  sendFleet, previewFleet, shipsAt, incomeOf, allied, playerName, designOf, fleetValue, countShips, fmtHours,
  sellValue, yardListValue, YARD_MS,
} from '../world/world.js';
import { readBattle } from '../world/battleSetup.js';
import { fleetPosition } from '../world/routes.js';
import { HOUR_MS, PLAYER_COLORS, NEUTRAL_COLOR, MIN_PLAYERS, MAX_PLAYERS, HYPERLANE_SPEEDUP, MIN_FLEET_SPEED } from '../world/rules.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.floor(n).toLocaleString();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Same block colours as the designer, for design thumbnails.
const BLOCK_COLOR = {
  [BT.HUB]: '#86e8ff', [BT.ARMOR]: '#5c7ea3', [BT.HEAVY]: '#41597a', [BT.FRAME]: '#90a6c0', [BT.THRUSTER]: '#3d434f',
  [BT.LASER]: '#d8f4ff', [BT.CANNON]: '#9aa1ab', [BT.MISSILE]: '#b9b16c', [BT.PD]: '#7fc4e0', [BT.LANCE]: '#5b5f9c',
};
const SPEEDS = [[0, 'Pause'], [1, '1×'], [60, '60×'], [600, '600×'], [3600, '3600×']];

// ------------------------------------------------------------ storage (never fatal)
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const WORLD_KEY = 'lsb.world.v1', UI_KEY = 'lsb.galaxy.ui.v1', LIB_KEY = 'lsb.designs.v1';

let world = null;
let ui = { me: 0, speed: 60, saved: Date.now(), mine: false };
let sel = null; // { kind: 'planet' | 'fleet', id }
let move = null; // { from, ships: { designId: n }, to, lanes, picking }
let busy = false; // a battle is being resolved
let gameTarget = 0; // game time we're catching up to
const replays = new Map(); // battle id → { bytes, sides, computeMs }

function save() {
  if (!world) return;
  ui.saved = Date.now();
  if (!store.set(WORLD_KEY, world)) toast('Couldn\'t save the game: browser storage is full or unavailable.', true);
  store.set(UI_KEY, ui);
}

// ------------------------------------------------------------ toast
let toastTimer = 0;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg; t.classList.toggle('bad', bad); t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), bad ? 4500 : 3000);
}

// ------------------------------------------------------------ helpers
const colorOf = (pid) => (pid === null || pid === undefined ? NEUTRAL_COLOR : world.players[pid]?.color ?? NEUTRAL_COLOR);
const who = (pid) => `<span class="who"><span class="swatch" style="background:${colorOf(pid)}"></span>${esc(playerName(world, pid))}</span>`;
const me = () => world.players[ui.me];
const shipTotal = (P) => P.garrison.reduce((s, g) => s + g.n, 0);
const planetR = (P) => (P.home >= 0 ? 13 : 6 + P.size * 6);

function clockText(t) {
  const h = t / HOUR_MS, day = Math.floor(h / 24) + 1, hh = Math.floor(h % 24), mm = Math.floor((h * 60) % 60);
  return `Day ${day} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
const inText = (ms) => fmtHours(Math.max(0, ms) / HOUR_MS);

// ------------------------------------------------------------ map camera
const canvas = $('map'), g = canvas.getContext('2d');
const cam = { x: 0, y: 0, zoom: 1 };
let W = 0, H = 0, dpr = 1;
function resize() {
  const r = canvas.getBoundingClientRect();
  dpr = Math.min(2, devicePixelRatio || 1);
  W = r.width; H = r.height;
  canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
}
const toScreen = (x, y) => [(x - cam.x) * cam.zoom + W / 2, (y - cam.y) * cam.zoom + H / 2];
const toWorld = (sx, sy) => [(sx - W / 2) / cam.zoom + cam.x, (sy - H / 2) / cam.zoom + cam.y];
function fit() {
  if (!world || !W) return;
  cam.x = 0; cam.y = 0;
  cam.zoom = Math.min(W, H) / (world.radius * 2 * 1.12);
}
function zoomAt(f, sx = W / 2, sy = H / 2) {
  const [wx, wy] = toWorld(sx, sy);
  cam.zoom = Math.max(0.15, Math.min(14, cam.zoom * f));
  const [nx, ny] = toWorld(sx, sy);
  cam.x += wx - nx; cam.y += wy - ny;
}

// Background stars, made once per galaxy.
let stars = [];
function makeStars() {
  const r = mulberry32(world.seed * 3 + 1);
  stars = Array.from({ length: 900 }, () => ({ x: (r() - 0.5) * 2, y: (r() - 0.5) * 2, b: 0.15 + r() * 0.5, s: r() < 0.08 ? 1.6 : 1 }));
}

// ------------------------------------------------------------ drawing
function draw(now) {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#05070c'; g.fillRect(0, 0, W, H);
  if (!world) return;
  const R = world.radius, z = cam.zoom;

  // Stars drift slowly with the camera (parallax), so panning feels like moving.
  for (const s of stars) {
    const sx = W / 2 + (s.x * R * 1.6 - cam.x * 0.3) * Math.min(z, 2) * 0.7, sy = H / 2 + (s.y * R * 1.6 - cam.y * 0.3) * Math.min(z, 2) * 0.7;
    const px = ((sx % W) + W) % W, py = ((sy % H) + H) % H;
    g.fillStyle = `rgba(200,215,255,${s.b})`; g.fillRect(px, py, s.s, s.s);
  }
  // Galactic glow.
  const [cx, cy] = toScreen(0, 0);
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.15 * z);
  glow.addColorStop(0, 'rgba(70,95,170,0.16)'); glow.addColorStop(0.6, 'rgba(50,70,130,0.06)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, H);

  // Territory: a soft disc of each owner's colour round their worlds.
  for (const P of world.planets) {
    if (P.owner === null) continue;
    const [x, y] = toScreen(P.x, P.y), r = 46 * z;
    const t = g.createRadialGradient(x, y, 0, x, y, r);
    t.addColorStop(0, hexA(colorOf(P.owner), 0.16)); t.addColorStop(1, hexA(colorOf(P.owner), 0));
    g.fillStyle = t; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }

  // Hyperlanes.
  g.lineCap = 'round';
  for (const [a, b] of world.lanes) {
    const A = world.planets[a], B = world.planets[b];
    const [x1, y1] = toScreen(A.x, A.y), [x2, y2] = toScreen(B.x, B.y);
    g.strokeStyle = 'rgba(134,232,255,0.10)'; g.lineWidth = 5; line(x1, y1, x2, y2);
    g.strokeStyle = 'rgba(134,232,255,0.42)'; g.lineWidth = 1.3; line(x1, y1, x2, y2);
  }

  // Fleet routes (remaining part), then the move preview.
  for (const f of world.fleets) {
    const pos = fleetPosition(world.planets, f, world.clock);
    const mine = allied(world, f.owner, ui.me), selected = sel?.kind === 'fleet' && sel.id === f.id;
    if (!mine && !selected) continue;
    drawRoute(f.legs, pos, hexA(colorOf(f.owner), selected ? 0.9 : 0.4), selected ? 2 : 1.2);
  }
  if (move && move.to !== null && move.preview?.ok) {
    drawRoute(move.preview.legs, null, 'rgba(230,238,255,0.95)', 2.2);
    const T = world.planets[move.to], [x, y] = toScreen(T.x, T.y);
    g.font = '600 12px "JetBrains Mono", monospace'; g.textAlign = 'center';
    label(`ETA ${fmtHours(move.preview.hours)}`, x, y - planetR(T) * z - 22, '#e6eeff');
  }

  // Planets.
  const showNames = z > 0.75;
  for (const P of world.planets) {
    const [x, y] = toScreen(P.x, P.y);
    const r = Math.max(3.5, planetR(P) * z);
    if (x < -60 || y < -60 || x > W + 60 || y > H + 60) continue;
    const col = colorOf(P.owner);
    // Body.
    const body = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    body.addColorStop(0, P.owner === null ? '#8a96a8' : mix(col, '#ffffff', 0.35)); body.addColorStop(1, P.owner === null ? '#232a36' : mix(col, '#05070c', 0.7));
    g.fillStyle = body; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    // Owner ring.
    g.strokeStyle = P.owner === null ? 'rgba(125,139,161,0.5)' : col; g.lineWidth = P.owner === null ? 1 : 2;
    g.beginPath(); g.arc(x, y, r + 3, 0, Math.PI * 2); g.stroke();
    // Spawn point: an extra dashed ring.
    if (P.home >= 0) {
      g.setLineDash([3, 3]); g.strokeStyle = hexA(colorOf(P.home), 0.8); g.lineWidth = 1;
      g.beginPath(); g.arc(x, y, r + 8, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
    // Selection and hover.
    if ((sel?.kind === 'planet' && sel.id === P.id) || (move && move.from === P.id)) {
      g.strokeStyle = '#e6eeff'; g.lineWidth = 1.5;
      const k = 12 + Math.sin(now / 300) * 1.5;
      bracket(x, y, r + k);
    }
    if (hover?.kind === 'planet' && hover.id === P.id) { g.strokeStyle = 'rgba(230,238,255,0.5)'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, r + 12, 0, Math.PI * 2); g.stroke(); }
    if (move?.picking && hover?.kind === 'planet' && hover.id === P.id && P.id !== move.from) { g.strokeStyle = '#e6eeff'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, r + 14, 0, Math.PI * 2); g.stroke(); }
    // Shipyards: one pip each above the world.
    const ny = P.yards.length;
    if (ny) {
      const shown = Math.min(ny, 8), w = 5, gap = 2, x0 = x - (shown * (w + gap) - gap) / 2, yy = y - r - 12;
      g.fillStyle = '#ffb35c';
      for (let k = 0; k < shown; k++) g.fillRect(x0 + k * (w + gap), yy, w, w);
      if (ny > shown) { g.font = '500 10px "JetBrains Mono", monospace'; g.textAlign = 'left'; g.fillText(`+${ny - shown}`, x0 + shown * (w + gap) + 1, yy + 5); }
    }
    // Ship count.
    const n = shipTotal(P);
    if (n) {
      g.font = '600 11px "JetBrains Mono", monospace'; g.textAlign = 'left';
      label(n >= 10000 ? `${Math.round(n / 1000)}k` : String(n), x + r + 6, y + 4, P.garrison.some((s) => s.owner !== P.owner) && P.owner !== null ? '#ffcf5c' : '#dbe4f2');
    }
    // Name.
    if (showNames || P.owner === ui.me || (sel?.kind === 'planet' && sel.id === P.id)) {
      g.font = `600 ${P.home >= 0 ? 12.5 : 11.5}px "Chakra Petch", sans-serif`; g.textAlign = 'center';
      label(P.name, x, y + r + 17, P.owner === null ? '#7d8ba1' : '#dbe4f2');
    }
  }

  // Fleets in flight: a chevron in the owner's colour.
  for (const f of world.fleets) {
    const pos = fleetPosition(world.planets, f, world.clock);
    const [x, y] = toScreen(pos.x, pos.y);
    const s = 7 + Math.min(5, Math.log10(1 + countShips(f.ships)) * 2);
    g.save(); g.translate(x, y); g.rotate(pos.angle);
    g.fillStyle = colorOf(f.owner); g.strokeStyle = '#05070c'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(s, 0); g.lineTo(-s * 0.7, s * 0.6); g.lineTo(-s * 0.35, 0); g.lineTo(-s * 0.7, -s * 0.6); g.closePath(); g.stroke(); g.fill();
    g.restore();
    if ((sel?.kind === 'fleet' && sel.id === f.id) || (hover?.kind === 'fleet' && hover.id === f.id)) { g.strokeStyle = '#e6eeff'; g.lineWidth = 1.2; bracket(x, y, s + 6); }
  }
}

function line(x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
function bracket(x, y, r) {
  const k = r * 0.45;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    g.beginPath(); g.moveTo(x + sx * r, y + sy * (r - k)); g.lineTo(x + sx * r, y + sy * r); g.lineTo(x + sx * (r - k), y + sy * r); g.stroke();
  }
}
function label(text, x, y, color) {
  g.lineWidth = 3; g.strokeStyle = 'rgba(5,7,12,0.85)'; g.strokeText(text, x, y);
  g.fillStyle = color; g.fillText(text, x, y);
}
/** Route legs: hyperlane legs solid, normal-space legs dashed. `from` (a position) starts mid-leg. */
function drawRoute(legs, pos, color, width) {
  g.strokeStyle = color; g.lineWidth = width;
  const start = pos ? pos.leg : 0;
  for (let k = start; k < legs.length; k++) {
    const L = legs[k], A = world.planets[L.from], B = world.planets[L.to];
    const [x1, y1] = k === start && pos ? toScreen(pos.x, pos.y) : toScreen(A.x, A.y), [x2, y2] = toScreen(B.x, B.y);
    g.setLineDash(L.lane ? [] : [5, 5]);
    line(x1, y1, x2, y2);
  }
  g.setLineDash([]);
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function mix(a, b, t) {
  const p = parseInt(a.slice(1), 16), q = parseInt(b.slice(1), 16);
  const c = (s) => Math.round(((p >> s) & 255) * (1 - t) + ((q >> s) & 255) * t);
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

// ------------------------------------------------------------ picking and input
let hover = null;
function pick(sx, sy) {
  let best = null, bd = Infinity;
  for (const f of world.fleets) {
    const p = fleetPosition(world.planets, f, world.clock), [x, y] = toScreen(p.x, p.y), d = Math.hypot(x - sx, y - sy);
    if (d < 11 && d < bd) { bd = d; best = { kind: 'fleet', id: f.id }; }
  }
  if (best) return best;
  for (const P of world.planets) {
    const [x, y] = toScreen(P.x, P.y), d = Math.hypot(x - sx, y - sy);
    if (d < Math.max(14, planetR(P) * cam.zoom + 6) && d < bd) { bd = d; best = { kind: 'planet', id: P.id }; }
  }
  return best;
}

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, id: e.pointerId };
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (drag && drag.id === e.pointerId) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) { cam.x = drag.cx - dx / cam.zoom; cam.y = drag.cy - dy / cam.zoom; canvas.style.cursor = 'grabbing'; }
  }
  if (!world) return;
  hover = drag?.moved ? null : pick(sx, sy);
  if (move?.picking) {
    const to = hover?.kind === 'planet' && hover.id !== move.from ? hover.id : null;
    if (to !== move.hoverTo) { move.hoverTo = to; if (move.to === null || move.picking) setMoveTarget(to, false); }
  }
  showTip(sx, sy);
  if (!drag?.moved) canvas.style.cursor = hover ? 'pointer' : move?.picking ? 'crosshair' : 'default';
});
canvas.addEventListener('pointerleave', () => { hover = null; $('tip').hidden = true; });
canvas.addEventListener('pointerup', (e) => {
  if (!drag || drag.id !== e.pointerId) return;
  const wasDrag = drag.moved;
  drag = null; canvas.style.cursor = 'default';
  if (wasDrag || !world) return;
  const r = canvas.getBoundingClientRect(), hit = pick(e.clientX - r.left, e.clientY - r.top);
  if (move?.picking) {
    if (hit?.kind === 'planet' && hit.id !== move.from) { setMoveTarget(hit.id, true); return; }
    if (!hit) { move.picking = false; setMoveTarget(null, false); renderPanel(true); return; }
  }
  select(hit);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
// Pinch zoom.
const touches = new Map();
canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') touches.set(e.pointerId, [e.clientX, e.clientY]); });
canvas.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return;
  const before = [...touches.values()];
  touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (touches.size === 2) {
    const after = [...touches.values()];
    const d0 = Math.hypot(before[0][0] - before[1][0], before[0][1] - before[1][1]), d1 = Math.hypot(after[0][0] - after[1][0], after[0][1] - after[1][1]);
    const r = canvas.getBoundingClientRect();
    if (d0 > 0) zoomAt(d1 / d0, (after[0][0] + after[1][0]) / 2 - r.left, (after[0][1] + after[1][1]) / 2 - r.top);
    if (drag) { drag.moved = true; drag.x = e.clientX; drag.y = e.clientY; drag.cx = cam.x; drag.cy = cam.y; }
  }
});
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, (e) => touches.delete(e.pointerId));

// WASD / arrows pan while held, like the designer.
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) { keys.add(k); if (k.startsWith('arrow')) e.preventDefault(); }
  if (k === 'escape' && move) { cancelMove(); }
  else if (k === 'escape' && sel) select(null);
  if (k === '+' || k === '=') zoomAt(1.25);
  if (k === '-') zoomAt(0.8);
  if (k === 'f') fit();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());
let lastKey = 0;
function keyPan(now) {
  const dt = Math.min(0.05, (now - lastKey) / 1000); lastKey = now;
  let dx = 0, dy = 0;
  if (keys.has('a') || keys.has('arrowleft')) dx--;
  if (keys.has('d') || keys.has('arrowright')) dx++;
  if (keys.has('w') || keys.has('arrowup')) dy--;
  if (keys.has('s') || keys.has('arrowdown')) dy++;
  if (!dx && !dy) return;
  const v = (keys.has('shift') ? 1400 : 600) / cam.zoom;
  cam.x += dx * v * dt; cam.y += dy * v * dt;
}
$('zoom-in').addEventListener('click', () => zoomAt(1.4));
$('zoom-out').addEventListener('click', () => zoomAt(1 / 1.4));
$('fit').addEventListener('click', fit);

function showTip(sx, sy) {
  const tip = $('tip');
  if (!hover || drag?.moved) { tip.hidden = true; return; }
  let html = '';
  if (hover.kind === 'planet') {
    const P = world.planets[hover.id];
    html = `<b>${esc(P.name)}</b>${P.home >= 0 ? ' <span class="tag">spawn</span>' : ''}<br>${who(P.owner)}<br><span class="m">${fmt(P.income)} cr/h · ${shipTotal(P)} ships · ${P.yards.length} shipyard${P.yards.length === 1 ? '' : 's'}</span>`;
    if (move?.picking && move.preview?.ok && move.to === P.id) html += `<br><span class="m">Arrives in ${fmtHours(move.preview.hours)}</span>`;
  } else {
    const f = world.fleets.find((x) => x.id === hover.id);
    if (!f) { tip.hidden = true; return; }
    html = `<b>Fleet</b> ${f.retreat ? '<span class="tag">retreating</span>' : ''}<br>${who(f.owner)}<br><span class="m">${countShips(f.ships)} ships → ${esc(world.planets[f.to].name)} in ${inText(f.arrive - world.clock)}</span>`;
  }
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect(), mr = canvas.getBoundingClientRect();
  tip.style.left = `${Math.min(mr.width - r.width - 8, sx + 16)}px`;
  tip.style.top = `${Math.min(mr.height - r.height - 8, sy + 16)}px`;
}

// ------------------------------------------------------------ selection and the side panel
function select(hit) {
  sel = hit;
  if (move && !(hit?.kind === 'planet' && hit.id === move.from)) move = null;
  renderPanel(true);
}

let panelSig = '';
function renderPanel(force = false) {
  if (!world) return;
  const panel = $('panel');
  // Don't rebuild under the player's fingers while they're typing a number.
  if (!force && panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const sig = panelSignature();
  if (!force && sig === panelSig) return updateLive();
  panelSig = sig;
  if (sel?.kind === 'planet') panel.innerHTML = planetPanel(world.planets[sel.id]);
  else if (sel?.kind === 'fleet' && world.fleets.some((f) => f.id === sel.id)) panel.innerHTML = fleetPanel(world.fleets.find((f) => f.id === sel.id));
  else { sel = null; panel.innerHTML = overviewPanel(); }
  updateLive();
}
// What the panel shows, coarsely: rebuild only when it changes (timers update in place).
function panelSignature() {
  const s = [ui.me, sel?.kind, sel?.id, move ? `${move.from}>${move.to}:${move.picking}:${move.lanes}:${JSON.stringify(move.ships)}` : '', busy];
  if (sel?.kind === 'planet') {
    const P = world.planets[sel.id];
    s.push(P.owner, JSON.stringify(P.garrison), P.yards.map((y) => y.id).join(), Math.floor(me().credits / 500));
  } else if (sel?.kind === 'fleet') s.push(world.fleets.length);
  else s.push(world.log.length, world.planets.map((p) => p.owner).join(), world.fleets.length, world.planets.reduce((a, p) => a + shipTotal(p), 0));
  return s.join('|');
}
function updateLive() {
  for (const el of document.querySelectorAll('[data-next]')) el.textContent = inText(Number(el.dataset.next) - world.clock);
  for (const el of document.querySelectorAll('[data-arrive]')) el.textContent = inText(Number(el.dataset.arrive) - world.clock);
}

function garrisonTable(P) {
  const byOwner = new Map();
  for (const s of P.garrison) { if (!byOwner.has(s.owner)) byOwner.set(s.owner, []); byOwner.get(s.owner).push(s); }
  if (!byOwner.size) return '<p class="hint">No ships here.</p>';
  let html = '';
  for (const [owner, list] of byOwner) {
    const total = list.reduce((a, s) => a + s.n, 0), value = list.reduce((a, s) => a + s.n * world.designs[s.design].cost, 0);
    html += `<table><thead><tr><th>${who(owner)}${owner !== P.owner && P.owner !== null ? ' <span class="tag">guest</span>' : ''}</th><th>Ships</th><th>Speed</th></tr></thead><tbody>`;
    html += list.map((s) => { const d = world.designs[s.design]; return `<tr><td title="${esc(d.cls)} · ${fmt(d.cost)} cr each">${esc(d.name)}</td><td>${fmt(s.n)}</td><td>${d.speed < MIN_FLEET_SPEED ? 'fixed' : d.speed.toFixed(1)}</td></tr>`; }).join('');
    html += `</tbody></table><p class="hint" style="margin:2px 0 10px">${fmt(total)} ships · ${fmt(value)} cr of hulls</p>`;
  }
  return html;
}

function planetPanel(P) {
  const mine = P.owner === ui.me, friendly = allied(world, P.owner, ui.me);
  const myShips = shipsAt(P, ui.me), haveShips = Object.keys(myShips).length > 0;
  const lanes = world.lanes.filter(([a, b]) => a === P.id || b === P.id).length;
  let html = `<h1><span class="swatch" style="background:${colorOf(P.owner)}"></span>${esc(P.name)}</h1>
    <div class="sub">${who(P.owner)}${P.home >= 0 ? ` <span class="tag" title="Spawn point">${esc(playerName(world, P.home))}'s home</span>` : ''}${friendly && !mine ? ' <span class="tag">ally</span>' : ''}</div>
    <dl class="kv">
      <dt>Income</dt><dd>${fmt(P.income)} cr/h</dd>
      <dt>Hyperlanes</dt><dd>${lanes}</dd>
      <dt>Shipyards</dt><dd>${P.yards.length}${P.yards.length ? ` (${fmt(yardListValue(P))} cr)` : ''}</dd>
    </dl>`;

  // Shipyards.
  if (mine || P.yards.length) {
    html += `<h2>Shipyards ${mine ? `<button class="small go" data-act="yard" ${busy || me().eliminated ? 'disabled' : ''}>Build</button>` : ''}</h2>`;
    if (!P.yards.length) html += `<p class="hint">None yet. A shipyard builds one ship of its design every ${SHIPYARD_INTERVAL_MIN} min, for free, forever, and the ships guard this world.</p>`;
    for (const y of P.yards) {
      const d = world.designs[y.design];
      html += `<div class="yard"><b>${esc(d.name)}</b>${mine ? `<button class="small danger" data-act="sell" data-yard="${y.id}" ${busy ? 'disabled' : ''} title="Sell for ${Math.round(SHIPYARD_SELL_REFUND * 100)}% of what you paid">Sell +${fmt(sellValue(y))}</button>` : ''}
        <span>${esc(d.cls)} · next in <span data-next="${y.next}"></span> · ${fmt(y.built)} built${mine ? ` · paid ${fmt(y.paid)}` : ''}</span></div>`;
    }
  }

  // Ships, and moving them.
  html += `<h2>Ships here</h2>${garrisonTable(P)}`;
  if (haveShips && !me().eliminated) {
    if (!move || move.from !== P.id) html += `<div class="row"><button class="go" data-act="move" ${busy ? 'disabled' : ''}>Move ships…</button></div>`;
    else html += movePanel(P, myShips);
  }
  if (!friendly && !haveShips) html += `<p class="hint">${P.owner === null ? 'Unclaimed: held by militia.' : 'Enemy world.'} Send a fleet here and win the battle to take it: every shipyard on it is destroyed and its income becomes yours.</p>`;
  return html;
}

function movePanel(P, myShips) {
  let html = `<h2>Move ships</h2><table><thead><tr><th>Design</th><th>Here</th><th>Send</th></tr></thead><tbody>`;
  for (const [d, n] of Object.entries(myShips)) {
    const D = world.designs[d], fixed = D.speed < MIN_FLEET_SPEED;
    html += `<tr><td>${esc(D.name)}</td><td>${fmt(n)}</td><td>${fixed ? '<span title="No engines: a fixed defence">fixed</span>' : `<input type="number" min="0" max="${n}" step="1" value="${move.ships[d] ?? 0}" data-ship="${d}" aria-label="${esc(D.name)} to send">`}</td></tr>`;
  }
  html += `</tbody></table><div class="row"><button class="small" data-act="all">All</button><button class="small" data-act="none">None</button></div>`;
  html += `<label class="check"><input type="checkbox" data-act="lanes" ${move.lanes ? 'checked' : ''}> Use hyperlanes (${HYPERLANE_SPEEDUP}× faster)</label>`;
  if (move.to === null) {
    html += `<div class="route">${move.picking ? '<b>Click a world on the map</b> to send them there. Esc cancels.' : 'Pick where to send them.'}${move.preview && !move.preview.ok ? `<br><span style="color:var(--bad)">${esc(move.preview.error)}</span>` : ''}</div>`;
    html += `<div class="row"><button data-act="cancel-move">Cancel</button><button class="go" data-act="pick" ${move.picking ? 'disabled' : ''}>Choose destination</button></div>`;
  } else {
    const T = world.planets[move.to], pv = move.preview;
    const kind = allied(world, T.owner, ui.me) ? (T.owner === ui.me ? 'Reinforce your world' : 'Help defend an ally') : T.owner === null ? 'Attack militia' : `Attack ${esc(playerName(world, T.owner))}`;
    html += `<div class="route"><b>${kind}: ${esc(T.name)}</b><br>`;
    if (pv?.ok) {
      const laneLegs = pv.legs.filter((l) => l.lane).length, spaceLegs = pv.legs.length - laneLegs;
      html += `<span class="eta">${fmtHours(pv.hours)}</span><br>${laneLegs ? `${laneLegs} hyperlane jump${laneLegs > 1 ? 's' : ''}` : 'No hyperlanes'}${spaceLegs ? `${laneLegs ? ' + ' : ', '}${spaceLegs} leg${spaceLegs > 1 ? 's' : ''} through normal space` : ''} · speed ${pv.speed.toFixed(1)} · arrives ${clockText(world.clock + pv.hours * HOUR_MS)}`;
    } else html += `<span style="color:var(--bad)">${esc(pv?.error || '')}</span>`;
    html += `</div><div class="row"><button data-act="cancel-move">Cancel</button><button data-act="pick">Change</button><button class="go" data-act="launch" ${pv?.ok && !busy ? '' : 'disabled'}>Launch</button></div>`;
  }
  return html;
}

function fleetPanel(f) {
  const T = world.planets[f.to], F = world.planets[f.from];
  const rows = Object.entries(f.ships).map(([d, n]) => `<tr><td>${esc(world.designs[d].name)}</td><td>${fmt(n)}</td></tr>`).join('');
  const lanes = f.legs.filter((l) => l.lane).length;
  return `<h1><span class="swatch" style="background:${colorOf(f.owner)}"></span>Fleet${f.retreat ? ' <span class="tag">retreating</span>' : ''}</h1>
    <div class="sub">${who(f.owner)}</div>
    <dl class="kv">
      <dt>From</dt><dd>${esc(F.name)}</dd>
      <dt>To</dt><dd>${esc(T.name)}</dd>
      <dt>Arrives in</dt><dd data-arrive="${f.arrive}"></dd>
      <dt>Route</dt><dd>${lanes} lane / ${f.legs.length - lanes} space</dd>
      <dt>Speed</dt><dd>${f.speed.toFixed(1)}</dd>
      <dt>Value</dt><dd>${fmt(fleetValue(world, f.ships))} cr</dd>
    </dl>
    <h2>Ships</h2><table><tbody>${rows}</tbody></table>
    <p class="hint">Fleets can't be recalled once launched. They don't stop at the worlds they pass.</p>
    <div class="row"><button data-act="goto" data-planet="${T.id}">Show destination</button></div>`;
}

function overviewPanel() {
  const P = me();
  const mine = world.planets.filter((p) => p.owner === ui.me);
  let html = `<h1><span class="swatch" style="background:${P.color}"></span>${esc(P.name)}</h1>
    <div class="sub">${P.team ? `Team ${esc(P.team)}` : 'No team'}${P.eliminated ? ' · <span style="color:var(--bad)">knocked out</span>' : ''}</div>
    <p class="hint">Click a world to see it. Build shipyards on your worlds; select a world with your ships on it to move them. Hyperlanes (bright lines) are ${HYPERLANE_SPEEDUP}× faster than normal space.</p>
    <h2>Your worlds</h2><div class="list">`;
  html += mine.map((p) => `<button data-act="goto" data-planet="${p.id}"><span class="swatch" style="background:${P.color}"></span><span>${esc(p.name)}</span><em>${fmt(p.income)}/h · ${p.yards.length} yd · ${shipTotal(p)} sh</em></button>`).join('') || '<p class="hint">None.</p>';
  html += '</div>';
  const fleets = world.fleets.filter((f) => f.owner === ui.me);
  if (fleets.length) {
    html += '<h2>Your fleets</h2><div class="list">';
    html += fleets.map((f) => `<button data-act="fleet" data-fleet="${f.id}"><span class="swatch" style="background:${P.color}"></span><span>${countShips(f.ships)} ships → ${esc(world.planets[f.to].name)}</span><em data-arrive="${f.arrive}"></em></button>`).join('');
    html += '</div>';
  }
  html += '<h2>Players</h2><table class="score"><thead><tr><th>Player</th><th>Worlds</th><th>Income</th><th>Ships</th></tr></thead><tbody>';
  for (const pl of world.players) {
    const worlds = world.planets.filter((p) => p.owner === pl.id).length;
    const ships = world.planets.reduce((a, p) => a + p.garrison.filter((s) => s.owner === pl.id).reduce((b, s) => b + s.n, 0), 0) + world.fleets.filter((f) => f.owner === pl.id).reduce((a, f) => a + countShips(f.ships), 0);
    html += `<tr class="${pl.eliminated ? 'out' : ''}"><td class="who">${who(pl.id)}${pl.team ? ` <span class="tag">${esc(pl.team)}</span>` : ''}</td><td>${worlds}</td><td>${fmt(incomeOf(world, pl.id))}</td><td>${fmt(ships)}</td></tr>`;
  }
  return html + '</tbody></table>';
}

$('panel').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT') return;
  const act = b.dataset.act;
  if (act === 'goto') { const P = world.planets[Number(b.dataset.planet)]; cam.x = P.x; cam.y = P.y; cam.zoom = Math.max(cam.zoom, 1.6); select({ kind: 'planet', id: P.id }); }
  else if (act === 'fleet') select({ kind: 'fleet', id: Number(b.dataset.fleet) });
  else if (act === 'yard') openYardDialog(sel.id);
  else if (act === 'sell') sellYard(sel.id, b.dataset.yard);
  else if (act === 'move') startMove(sel.id);
  else if (act === 'all' || act === 'none') {
    const have = shipsAt(world.planets[move.from], ui.me);
    for (const d of Object.keys(have)) if (world.designs[d].speed >= MIN_FLEET_SPEED) move.ships[d] = act === 'all' ? have[d] : 0;
    refreshPreview(); renderPanel(true);
  } else if (act === 'pick') { move.picking = true; move.to = null; refreshPreview(); renderPanel(true); toast('Click a world to send the fleet there.'); }
  else if (act === 'cancel-move') cancelMove();
  else if (act === 'launch') launchMove();
});
$('panel').addEventListener('change', (e) => {
  if (e.target.dataset.act === 'lanes') { move.lanes = e.target.checked; refreshPreview(); renderPanel(true); }
});
$('panel').addEventListener('input', (e) => {
  const d = e.target.dataset.ship;
  if (!d || !move) return;
  const have = shipsAt(world.planets[move.from], ui.me)[d] || 0;
  move.ships[d] = Math.max(0, Math.min(have, Math.floor(Number(e.target.value) || 0)));
  refreshPreview();
  // Update the route box without rebuilding the inputs.
  const route = $('panel').querySelector('.route');
  if (route && move.to !== null) {
    const keep = document.activeElement;
    const html = movePanel(world.planets[move.from], shipsAt(world.planets[move.from], ui.me));
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    route.replaceWith(tmp.querySelector('.route'));
    const launch = $('panel').querySelector('[data-act=launch]'), fresh = tmp.querySelector('[data-act=launch]');
    if (launch && fresh) launch.disabled = fresh.disabled;
    keep?.focus();
  }
});

// ------------------------------------------------------------ moving ships
function startMove(from) {
  const have = shipsAt(world.planets[from], ui.me);
  const ships = {};
  for (const [d, n] of Object.entries(have)) ships[d] = world.designs[d].speed >= MIN_FLEET_SPEED ? n : 0;
  move = { from, ships, to: null, lanes: true, picking: true, preview: null, hoverTo: null };
  renderPanel(true);
  toast('Click a world to send the fleet there.');
}
function cancelMove() { move = null; renderPanel(true); }
function refreshPreview() {
  if (!move) return;
  const to = move.to;
  move.preview = to === null ? (Object.values(move.ships).some((n) => n > 0) ? null : { ok: false, error: 'Pick some ships to send.' }) : previewFleet(world, move.from, to, move.ships, move.lanes);
}
function setMoveTarget(to, commit) {
  if (!move) return;
  move.to = to;
  if (commit) move.picking = false;
  refreshPreview();
  if (commit) renderPanel(true);
}
function launchMove() {
  if (busy || !move) return;
  const r = sendFleet(world, ui.me, move.from, move.to, move.ships, move.lanes);
  if (!r.ok) return toast(r.error, true);
  toast(`Fleet launched: arrives at ${world.planets[move.to].name} in ${fmtHours((r.fleet.arrive - world.clock) / HOUR_MS)}.`);
  move = null;
  select({ kind: 'fleet', id: r.fleet.id });
  save(); renderEvents();
}

// ------------------------------------------------------------ shipyards
function sellYard(planetId, yardId) {
  const P = world.planets[planetId], y = P.yards.find((x) => x.id === yardId);
  if (!y || busy) return;
  if (!confirm(`Sell the ${world.designs[y.design].name} shipyard at ${P.name} for ${fmt(sellValue(y))} credits (${Math.round(SHIPYARD_SELL_REFUND * 100)}% of what you paid)?`)) return;
  const r = sellShipyard(world, ui.me, planetId, yardId);
  if (!r.ok) return toast(r.error, true);
  toast(`Sold for ${fmt(r.refund)} credits.`);
  save(); renderPanel(true); renderEvents(); updateTop();
}

const library = () => store.get(LIB_KEY, []);
let yardPlanet = null;
function openYardDialog(planetId) {
  yardPlanet = planetId;
  const P = world.planets[planetId], existing = yardListValue(P);
  $('yard-title').textContent = `New shipyard at ${P.name}`;
  const mult = 1 + existing / SHIPYARD_CROWDING_CR;
  $('yard-info').innerHTML = P.yards.length
    ? `${P.name} already has <b>${P.yards.length}</b> shipyard${P.yards.length > 1 ? 's' : ''} worth ${fmt(existing)} cr, so a new one here costs <b>${mult.toFixed(2)}×</b> its list price. Building on your other worlds is cheaper. You have <b>${fmt(me().credits)}</b> credits.`
    : `A shipyard costs 10× the ship it builds, and makes one every ${SHIPYARD_INTERVAL_MIN} min for free. Each extra shipyard on the same world costs more. You have <b>${fmt(me().credits)}</b> credits.`;
  // Your designs already in the game, then your designer library.
  const seen = new Set(), items = [];
  for (const d of Object.values(world.designs)) {
    if (d.owner !== ui.me) continue;
    seen.add(`${d.name}|${d.data.cells}`);
    items.push({ design: designOf(world, d.id), src: 'In use' });
  }
  for (const o of library()) {
    try {
      const d = decodeDesign(o);
      if (seen.has(`${d.name}|${o.cells}`) || !analyzeDesign(d).ok) continue;
      items.push({ design: d, src: 'Library' });
    } catch { /* skip broken entries */ }
  }
  const list = $('yard-list');
  list.innerHTML = '';
  if (!items.length) list.innerHTML = '<p class="empty">No designs yet. Design a ship (or save some in the ship designer\'s library) and it will appear here.</p>';
  for (const it of items) {
    const q = quoteShipyard(world, planetId, it.design), afford = me().credits >= q.price;
    const row = document.createElement('div');
    row.className = 'design';
    row.innerHTML = `<canvas width="96" height="48"></canvas><div><b>${esc(it.design.name)}</b><span>${esc(it.design.cls)} · ${fmt(designCost(it.design))} cr a ship · ${it.src}</span><br><span class="price">${fmt(q.price)} cr</span>${q.mult > 1.0005 ? ` <span>(list ${fmt(q.list)})</span>` : ''}</div><button class="go" ${afford ? '' : 'disabled'} title="${afford ? '' : 'Not enough credits'}">Build</button>`;
    thumb(row.querySelector('canvas'), it.design);
    row.querySelector('button').addEventListener('click', () => { if (build(planetId, it.design)) $('yard-dlg').close(); });
    list.append(row);
  }
  $('yard-dlg').showModal();
}
$('yard-cancel').addEventListener('click', () => $('yard-dlg').close());
$('yard-design').addEventListener('click', () => { $('yard-dlg').close(); openDesigner(yardPlanet); });

function build(planetId, design) {
  const r = buildShipyard(world, ui.me, planetId, design);
  if (!r.ok) { toast(r.error, true); return false; }
  toast(`Shipyard built at ${world.planets[planetId].name}: first ${world.designs[r.yard.design].name} in ${SHIPYARD_INTERVAL_MIN} min.`);
  save(); renderPanel(true); renderEvents(); updateTop();
  return true;
}

function thumb(c, d) {
  const x = c.getContext('2d'), s = Math.min(c.width / d.w, c.height / d.h), ox = (c.width - d.w * s) / 2, oy = (c.height - d.h * s) / 2;
  for (let j = 0; j < d.h; j++) for (let i = 0; i < d.w; i++) {
    const t = d.cells[j * d.w + i];
    if (!t) continue;
    x.fillStyle = BLOCK_COLOR[t] || '#888';
    x.fillRect(ox + i * s, oy + j * s, Math.max(1, s), Math.max(1, s));
  }
}

// The ship designer runs in an overlay (tools/build-viewer.mjs builds it into this page). It
// shares this page's storage, so its library is the one listed above.
/* global __DESIGNER_PAGE__, __VIEWER_PAGE__ */
const DESIGNER_PAGE = typeof __DESIGNER_PAGE__ === 'string' ? __DESIGNER_PAGE__ : '';
const VIEWER_PAGE = typeof __VIEWER_PAGE__ === 'string' ? __VIEWER_PAGE__ : '';
const pageDoc = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">${body}</body></html>`;
let designerFor = null, designerTimer = 0;
function designerInfo() {
  const P = world.planets[designerFor];
  return { type: 'lsb-designer-embed', planet: P.name, mult: quoteShipyard(world, P.id, { cells: new Uint8Array(0) }).mult, credits: Math.floor(me().credits), yards: P.yards.length };
}
function openDesigner(planetId) {
  if (!DESIGNER_PAGE) return toast('This build has no ship designer. Run npm run build.', true);
  designerFor = planetId;
  $('designer-overlay').hidden = false;
  $('designer-frame').srcdoc = pageDoc(DESIGNER_PAGE);
  clearInterval(designerTimer);
  designerTimer = setInterval(() => { if (designerFor !== null) $('designer-frame').contentWindow?.postMessage(designerInfo(), '*'); }, 2000);
}
function closeDesigner() {
  designerFor = null; clearInterval(designerTimer);
  $('designer-overlay').hidden = true; $('designer-frame').srcdoc = '';
}
$('designer-close').addEventListener('click', closeDesigner);
addEventListener('message', (e) => {
  const frame = $('designer-frame');
  if (e.source !== frame.contentWindow || designerFor === null) return;
  if (e.data?.type === 'lsb-designer-ready') frame.contentWindow.postMessage(designerInfo(), '*');
  if (e.data?.type === 'lsb-design-chosen') {
    let d;
    try { d = decodeDesign(e.data.design); } catch (err) { return toast(err.message, true); }
    if (build(designerFor, d)) closeDesigner();
  }
});

// ------------------------------------------------------------ replays
function watch(id) {
  const rep = replays.get(id);
  if (!rep) return toast('That replay isn\'t in memory any more (replays are kept until the page is closed).', true);
  if (!VIEWER_PAGE) return toast('This build has no replay viewer. Run npm run build.', true);
  const frame = $('replay-frame');
  const send = (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'lsb-viewer-ready') return;
    removeEventListener('message', send);
    const copy = rep.bytes.slice();
    frame.contentWindow.postMessage({ type: 'lsb-replay', bytes: copy.buffer, computeMs: rep.computeMs, sides: rep.sides, title: rep.title }, '*', [copy.buffer]);
  };
  addEventListener('message', send);
  $('replay-overlay').hidden = false;
  frame.srcdoc = pageDoc(VIEWER_PAGE);
}
$('replay-close').addEventListener('click', () => { $('replay-overlay').hidden = true; $('replay-frame').srcdoc = ''; });

// ------------------------------------------------------------ events list
function renderEvents() {
  const list = $('events');
  const items = world.log.filter((e) => !ui.mine || (e.players || []).some((p) => allied(world, p, ui.me))).slice(-120).reverse();
  list.innerHTML = items.map((e) => {
    const c = colorOf(e.players?.[0]);
    const btn = e.battle && replays.has(e.battle.id) ? `<button class="small" data-watch="${e.battle.id}">Watch</button>` : '';
    return `<li class="${e.kind}" style="${e.kind === 'battle' ? '' : `border-left-color:${hexA(c, 0.6)}`}" ${e.planet !== undefined ? `data-planet="${e.planet}"` : ''}><span>${esc(e.text)}</span>${btn}<time>${clockText(e.t)}</time></li>`;
  }).join('') || '<li><span class="hint">Nothing yet.</span></li>';
}
$('events').addEventListener('click', (e) => {
  const w = e.target.closest('[data-watch]');
  if (w) return watch(w.dataset.watch);
  const li = e.target.closest('[data-planet]');
  if (li) { const P = world.planets[Number(li.dataset.planet)]; cam.x = P.x; cam.y = P.y; select({ kind: 'planet', id: P.id }); }
});
$('ev-mine').addEventListener('click', () => { ui.mine = !ui.mine; $('ev-mine').setAttribute('aria-pressed', String(ui.mine)); renderEvents(); store.set(UI_KEY, ui); });

// ------------------------------------------------------------ top bar
function setupTop() {
  const sel = $('me');
  sel.innerHTML = '';
  world.players.forEach((p) => sel.add(new Option(`${p.name}${p.eliminated ? ' (out)' : ''}`, String(p.id))));
  if (!world.players[ui.me]) ui.me = 0;
  sel.value = String(ui.me);
  const sp = $('speed');
  sp.innerHTML = '';
  for (const [v, l] of SPEEDS) {
    const b = document.createElement('button');
    b.textContent = l; b.dataset.speed = v;
    b.title = v === 0 ? 'Pause the galaxy' : v === 1 ? 'Real time, as on the server' : `${v}× faster, for testing`;
    b.addEventListener('click', () => { ui.speed = v; syncSpeed(); store.set(UI_KEY, ui); });
    sp.append(b);
  }
  syncSpeed();
}
function syncSpeed() { document.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === ui.speed))); }
$('me').addEventListener('change', () => {
  ui.me = Number($('me').value); move = null; sel = null;
  store.set(UI_KEY, ui);
  renderPanel(true); renderEvents(); updateTop();
  const H = world.planets[me().home];
  if (H && H.owner === ui.me) { cam.x = H.x; cam.y = H.y; }
});
function updateTop() {
  const p = me();
  $('me-swatch').style.background = p.color;
  document.documentElement.style.setProperty('--me', p.color);
  $('credits').textContent = fmt(p.credits);
  $('income').textContent = `+${fmt(incomeOf(world, ui.me))}/h`;
  $('clock').textContent = clockText(world.clock);
  const b = $('banner');
  if (world.winner) { b.hidden = false; b.innerHTML = `<span>${world.winner.map((id) => who(id)).join(' &amp; ')} won the galaxy.</span><button class="small" id="banner-new">New game</button>`; }
  else if (p.eliminated) { b.hidden = false; b.innerHTML = `<span>${esc(p.name)} has been knocked out. Pick another player above, or start a new game.</span>`; }
  else b.hidden = true;
}
$('banner').addEventListener('click', (e) => { if (e.target.id === 'banner-new') openNewGame(); });

// ------------------------------------------------------------ new game
const ngPlayers = [];
function openNewGame() {
  const count = $('ng-count');
  if (!count.options.length) for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) count.add(new Option(String(n), String(n)));
  count.value = String(world ? world.players.length : 4);
  $('ng-seed').value = String(1 + Math.floor(Math.random() * 9999));
  if (!ngPlayers.length) for (let k = 0; k < MAX_PLAYERS; k++) ngPlayers.push({ name: world?.players[k]?.name ?? `Player ${k + 1}`, color: world?.players[k]?.color ?? PLAYER_COLORS[k], team: world?.players[k]?.team ?? '' });
  renderNgPlayers();
  $('ng-cancel').hidden = !world;
  $('newgame').showModal();
}
function renderNgPlayers() {
  const n = Number($('ng-count').value), box = $('ng-players');
  box.innerHTML = '<div class="prow"><span></span><label>Name</label><label>Colour</label><label>Team</label></div>';
  for (let k = 0; k < n; k++) {
    const p = ngPlayers[k], row = document.createElement('div');
    row.className = 'prow';
    row.innerHTML = `<span>${k + 1}</span><input type="text" maxlength="24" value="${esc(p.name)}" aria-label="Player ${k + 1} name"><input type="color" value="${p.color}" aria-label="Player ${k + 1} colour"><select aria-label="Player ${k + 1} team"><option value="">None</option>${'ABCDE'.split('').map((t) => `<option ${p.team === t ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    const [name, color, team] = row.querySelectorAll('input, select');
    name.addEventListener('input', () => { p.name = name.value; });
    color.addEventListener('input', () => { p.color = color.value; });
    team.addEventListener('change', () => { p.team = team.value; });
    box.append(row);
  }
}
$('ng-count').addEventListener('change', renderNgPlayers);
$('new-btn').addEventListener('click', openNewGame);
$('ng-cancel').addEventListener('click', () => $('newgame').close());
$('newgame').addEventListener('cancel', (e) => { if (!world) e.preventDefault(); });
$('ng-start').addEventListener('click', () => {
  if (busy) return toast('Wait for the battle to finish.', true);
  const n = Number($('ng-count').value);
  const players = ngPlayers.slice(0, n).map((p, k) => ({ name: p.name.trim() || `Player ${k + 1}`, color: p.color, team: p.team }));
  const teams = new Set(players.map((p, k) => p.team || `solo${k}`));
  if (teams.size < 2) return toast('Everyone is on one team: put at least one player on another side.', true);
  if (world && !confirm('Start a new galaxy? The current game will be lost.')) return;
  const planets = Math.max(3, Math.min(14, Number($('ng-planets').value) || 7));
  world = createWorld({ players, seed: Math.max(1, Number($('ng-seed').value) || 1), planetsPerPlayer: planets });
  gameTarget = world.clock;
  ui.me = 0; sel = null; move = null; replays.clear();
  $('newgame').close();
  start();
  save();
});

// ------------------------------------------------------------ time and battles
let lastReal = performance.now();
async function pump(now) {
  const dt = Math.min(1000, now - lastReal); lastReal = now;
  if (busy || !world) return;
  gameTarget = Math.max(gameTarget, world.clock) + dt * ui.speed;
  // Arrivals in order; non-battle ones resolve on the spot, battles run over several frames.
  for (let guard = 0; guard < 200; guard++) {
    const f = dueFleet(world, gameTarget);
    if (!f) break;
    advanceTo(world, f.arrive);
    const plan = arrivalPlan(world, f);
    if (plan.kind === 'battle') { await fight(f, plan); return; }
    completeArrival(world, f, plan, null);
    afterEvent();
  }
  advanceTo(world, gameTarget);
}

async function fight(fleet, plan) {
  busy = true;
  renderPanel(true);
  const B = plan.battle, P = world.planets[B.planet];
  const sides = [playerName(world, B.attacker), P.owner === null ? `${P.name} militia` : playerName(world, B.defender)];
  $('fight').hidden = false;
  $('fight-title').innerHTML = `Battle at <b>${esc(P.name)}</b>: ${who(B.attacker)} attacks ${who(B.defender)}`;
  const b = new Battle({ designs: B.designs, ships: B.ships, seed: B.seed, maxTime: B.maxTime });
  const t0 = performance.now();
  while (!b.done) {
    const end = performance.now() + 30;
    while (!b.done && performance.now() < end) b.step();
    $('fight-status').textContent = `${(b.tick * DT).toFixed(0)} s simulated · ${b.teamAlive[0]} vs ${b.teamAlive[1]} ships`;
    $('fight-bar').style.width = `${Math.min(100, (b.tick / b.maxTicks) * 100)}%`;
    await new Promise((r) => requestAnimationFrame(r));
  }
  const computeMs = performance.now() - t0;
  const result = readBattle(b, B);
  const rep = b.toReplay();
  const entry = completeArrival(world, fleet, plan, result);
  if (entry?.battle) {
    replays.set(entry.battle.id, { bytes: packReplay(rep.meta, rep.cols), computeMs, sides, title: `Battle of ${P.name}` });
    while (replays.size > 16) replays.delete(replays.keys().next().value);
  }
  $('fight').hidden = true;
  busy = false;
  lastReal = performance.now(); // the clock stood still while the battle ran
  if (entry) toast(entry.text);
  afterEvent();
}

function afterEvent() {
  if (move && !Object.keys(shipsAt(world.planets[move.from], ui.me)).length) move = null;
  if (sel?.kind === 'fleet' && !world.fleets.some((f) => f.id === sel.id)) sel = null;
  setupTopIfNeeded();
  renderEvents(); renderPanel(); updateTop();
  save();
}
let knownOut = '';
function setupTopIfNeeded() {
  const out = world.players.map((p) => p.eliminated).join();
  if (out !== knownOut) { knownOut = out; const keep = ui.me; setupTop(); ui.me = keep; $('me').value = String(keep); }
}

// ------------------------------------------------------------ main loop
let lastSave = 0, lastPanel = 0;
function loop(now) {
  keyPan(now);
  pump(now);
  draw(now);
  if (world && now - lastPanel > 250) { lastPanel = now; updateTop(); renderPanel(); }
  if (world && !busy && now - lastSave > 3000) { lastSave = now; save(); }
  requestAnimationFrame(loop);
}

function start() {
  makeStars(); setupTop(); knownOut = world.players.map((p) => p.eliminated).join();
  resize(); fit();
  const H = world.planets[me().home];
  if (H) { cam.x = H.x * 0.5; cam.y = H.y * 0.5; }
  renderPanel(true); renderEvents(); updateTop();
  $('ev-mine').setAttribute('aria-pressed', String(!!ui.mine));
}

addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
addEventListener('beforeunload', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); else lastReal = performance.now(); });

// Load the saved game; time spent away counts at 1× (as it will on the server).
ui = { ...ui, ...store.get(UI_KEY, {}) };
const saved = store.get(WORLD_KEY, null);
if (saved?.format === 'lsb-world') {
  world = saved;
  const away = Math.max(0, Date.now() - (ui.saved || Date.now()));
  gameTarget = world.clock + away;
  start();
  if (away > 60000) toast(`Welcome back: ${fmtHours(away / HOUR_MS)} passed in the galaxy while you were away.`);
} else {
  resize();
  openNewGame();
}
requestAnimationFrame((now) => { resize(); if (world) fit(); lastReal = now; loop(now); });

// Small hook for debugging and automated checks.
window.galaxy = { get world() { return world; }, get ui() { return ui; }, cam, fit, select, replays };
