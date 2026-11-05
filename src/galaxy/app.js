// Galaxy map page: the world, economy and fleets, played as a hot-seat game in one browser until
// there is a server. Every rule lives in src/world (world.js, routes.js, galaxyGen.js) and
// src/shared/economy.js; this file only draws the map, takes clicks and runs battles.
//
// Time: the world has its own clock. While the page is open it runs at the chosen speed (60× by
// default, so a 30-minute shipyard cycle takes 30 s); time spent with the page closed counts at
// 1×, as it will on the server. The clock stops while a battle is being resolved.
//
// Online (dist/play.html, built with __ONLINE__): the game server (server/) owns the world and
// its clock. You log in with your password, the page keeps a copy of the world up to date
// (net.js), shows time passing between updates, and sends your actions to the server, which
// applies them as the logged-in player. No speed buttons, no "Playing as", no new game.

import { BT } from '../shared/blocks.js';
import { decodeDesign, encodeDesign, analyzeDesign, designCost } from '../shared/shipStats.js';
import { SHIPYARD_INTERVAL_MIN, SHIPYARD_CROWDING_SHARE, SHIPYARD_SELL_REFUND, crowdingSurcharge } from '../shared/economy.js';
import { Battle, DT } from '../sim/battle.js';
import { packReplay } from '../shared/replayFormat.js';
import { mulberry32 } from '../shared/rng.js';
import {
  createWorld, advanceTo, dueEvent, planEvent, applyEvent, siegeAt, defendersAt, buildShipyard, sellShipyard, quoteShipyard,
  sendFleet, previewFleet, shipsAt, incomeOf, allied, playerName, designOf, fleetValue, countShips, fmtHours,
  sellValue, yardListValue, YARD_MS, HOLD_MS, upgradeWorld,
  proposeAlliance, acceptAlliance, declineAlliance, breakAlliance, proposalsFor, hasProposed,
  isOpenSeat, freeColors,
} from '../world/world.js';
import { readBattle } from '../world/battleSetup.js';
import { fleetPosition } from '../world/routes.js';
import { PlanetSprites, planetLook } from './planetArt.js';
import { ReplayStore } from './replayStore.js';
import { Net } from './net.js';
import { HOUR_MS, PLAYER_COLORS, NEUTRAL_COLOR, MIN_PLAYERS, MAX_PLAYERS, HYPERLANE_SPEEDUP, MIN_FLEET_SPEED } from '../world/rules.js';

/* global __ONLINE__ */
const ONLINE = typeof __ONLINE__ !== 'undefined' && __ONLINE__;
const net = ONLINE ? new Net() : null;
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
let ui = { me: 0, speed: 60, saved: Date.now(), mine: false, evOpen: innerWidth > 640, seen: {} };
let sel = null; // { kind: 'planet' | 'fleet', id }
let move = null; // { from, ships: { designId: n }, to, lanes, picking }
let busy = false; // a battle is being resolved
let gameTarget = 0; // game time we're catching up to
const replays = new ReplayStore(); // battle id → { bytes, sides, title, computeMs }, kept in IndexedDB (hot-seat)
const hasReplay = (id) => (ONLINE ? !!net.state?.replays.includes(id) : replays.has(id));

function save() {
  if (!world) return;
  if (ONLINE) { store.set(UI_KEY, ui); return; } // the server keeps the world
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
/** Screen radius just outside a world's atmosphere (owner ring), from its body radius in pixels. */
const outerR = (r) => r * 1.22 + 3;

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

// Background: a fixed starfield and faint nebulae, painted once per screen size. It stays put
// while you pan and zoom (only the galaxy moves), like a distant sky.
let sky = null, skyKey = '';
function paintSky() {
  const key = `${world.seed}:${Math.round(W)}x${Math.round(H)}@${dpr}`;
  if (key === skyKey && sky) return;
  skyKey = key;
  sky = document.createElement('canvas');
  sky.width = Math.max(1, Math.round(W * dpr)); sky.height = Math.max(1, Math.round(H * dpr));
  const x = sky.getContext('2d'), r = mulberry32(world.seed * 3 + 1);
  x.fillStyle = '#04060b'; x.fillRect(0, 0, sky.width, sky.height);
  for (const [hue, a] of [[220, 0.07], [265, 0.05], [195, 0.045]]) {
    const cx = r() * sky.width, cy = r() * sky.height, rad = (0.35 + r() * 0.4) * Math.max(sky.width, sky.height);
    const gr = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
    gr.addColorStop(0, `hsla(${hue},60%,45%,${a})`); gr.addColorStop(1, `hsla(${hue},60%,45%,0)`);
    x.fillStyle = gr; x.fillRect(0, 0, sky.width, sky.height);
  }
  const n = Math.round((W * H) / 900);
  for (let k = 0; k < n; k++) {
    const b = r(), sz = (b > 0.985 ? 1.8 : b > 0.9 ? 1.2 : 0.8) * dpr;
    const tint = r() < 0.15 ? '255,225,190' : r() < 0.2 ? '190,210,255' : '225,232,255';
    x.fillStyle = `rgba(${tint},${0.18 + b * b * 0.7})`;
    x.fillRect(r() * sky.width, r() * sky.height, sz, sz);
  }
}

// Planet art (cosmetic): a type and texture per world, rendered once and cached.
const sprites = new PlanetSprites();
const looks = new Map();
function lookOf(P) {
  let l = looks.get(P.id);
  if (!l) looks.set(P.id, (l = planetLook(world.seed, P)));
  return l;
}
function makeStars() { sprites.reset(); looks.clear(); skyKey = ''; }

// Where to draw a fleet: on its route, or (waiting in a siege) in a ring round the world.
function fleetWorldPos(f) {
  const pos = fleetPosition(world.planets, f, world.clock);
  if (f.wait == null) return pos;
  const P = world.planets[f.legs[f.leg].to];
  const s = world.sieges.find((x) => x.id === f.wait), k = s ? s.fleets.indexOf(f.id) : 0;
  const a = Math.PI + 0.5 * (k - ((s?.fleets.length ?? 1) - 1) / 2); // a fan on the world's left, clear of its name and counts
  const r = (outerR(Math.max(3.5, planetR(P) * cam.zoom)) + 16) / cam.zoom;
  return { x: P.x + Math.cos(a) * r, y: P.y + Math.sin(a) * r, angle: a + Math.PI, leg: f.leg, holding: true };
}

// ------------------------------------------------------------ drawing
function draw(now) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#04060b'; g.fillRect(0, 0, canvas.width, canvas.height);
  if (!world) return;
  paintSky();
  g.drawImage(sky, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const R = world.radius, z = cam.zoom;
  sprites.budget(12);
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
    let [x1, y1] = toScreen(A.x, A.y), [x2, y2] = toScreen(B.x, B.y);
    // Stop each lane at the worlds' owner rings instead of running into their atmospheres.
    const len = Math.hypot(x2 - x1, y2 - y1), ra = outerR(Math.max(3.5, planetR(A) * z)), rb = outerR(Math.max(3.5, planetR(B) * z));
    if (len <= ra + rb + 2) continue;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    x1 += ux * ra; y1 += uy * ra; x2 -= ux * rb; y2 -= uy * rb;
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
    for (const id of move.preview.stops) {
      const S = world.planets[id], [sx, sy] = toScreen(S.x, S.y), rr = outerR(Math.max(3.5, planetR(S) * z)) + 7;
      g.strokeStyle = '#ffcf5c'; g.lineWidth = 2; g.setLineDash([4, 3]);
      g.beginPath(); g.arc(sx, sy, rr, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
    const T = world.planets[move.to], [x, y] = toScreen(T.x, T.y);
    g.font = '600 12px "JetBrains Mono", monospace'; g.textAlign = 'center';
    label(`ETA ${fmtHours(move.preview.hours)}`, x, y - outerR(planetR(T) * z) - 22, '#e6eeff');
  }

  // Planets.
  const showNames = z > 0.75;
  for (const P of world.planets) {
    const [x, y] = toScreen(P.x, P.y);
    const r = Math.max(3.5, planetR(P) * z);
    if (x < -60 || y < -60 || x > W + 60 || y > H + 60) continue;
    const col = colorOf(P.owner), ro = outerR(r); // ro: just outside the atmosphere, where the owner ring sits
    // Body: the world's own procedural sprite (with its halo and rings).
    const sp = sprites.get(P.id, lookOf(P), r * 2 * dpr, now);
    if (sp) {
      const k = r / (sp.bodyPx / 2), C = sp.canvas.width * k;
      g.drawImage(sp.canvas, x - C / 2, y - C / 2, C, C);
    }
    // Owner: a thin ring in their colour, clear of the atmosphere.
    if (P.owner !== null) {
      g.strokeStyle = col; g.lineWidth = 1.6;
      g.beginPath(); g.arc(x, y, ro, 0, Math.PI * 2); g.stroke();
    }
    // Spawn point: an extra dashed ring.
    if (P.home >= 0) {
      g.setLineDash([3, 3]); g.strokeStyle = hexA(colorOf(P.home), 0.8); g.lineWidth = 1;
      g.beginPath(); g.arc(x, y, ro + 5, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
    // Selection and hover.
    if ((sel?.kind === 'planet' && sel.id === P.id) || (move && move.from === P.id)) {
      g.strokeStyle = '#e6eeff'; g.lineWidth = 1.5;
      const k = 12 + Math.sin(now / 300) * 1.5;
      bracket(x, y, ro + k - 3);
    }
    if (hover?.kind === 'planet' && hover.id === P.id) { g.strokeStyle = 'rgba(230,238,255,0.5)'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, ro + 9, 0, Math.PI * 2); g.stroke(); }
    if (move?.picking && hover?.kind === 'planet' && hover.id === P.id && P.id !== move.from) { g.strokeStyle = '#e6eeff'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, ro + 11, 0, Math.PI * 2); g.stroke(); }
    // Shipyards: one pip each above the world.
    const ny = P.yards.length;
    if (ny) {
      const shown = Math.min(ny, 8), w = 5, gap = 2, x0 = x - (shown * (w + gap) - gap) / 2, yy = y - ro - 10;
      g.fillStyle = '#ffb35c';
      for (let k = 0; k < shown; k++) g.fillRect(x0 + k * (w + gap), yy, w, w);
      if (ny > shown) { g.font = '500 10px "JetBrains Mono", monospace'; g.textAlign = 'left'; g.fillText(`+${ny - shown}`, x0 + shown * (w + gap) + 1, yy + 5); }
    }
    // Ship count.
    const n = shipTotal(P);
    if (n) {
      g.font = '600 11px "JetBrains Mono", monospace'; g.textAlign = 'left';
      label(n >= 10000 ? `${Math.round(n / 1000)}k` : String(n), x + ro + 5, y + 4, P.garrison.some((s) => s.owner !== P.owner) && P.owner !== null ? '#ffcf5c' : '#dbe4f2');
    }
    // Name.
    if (showNames || P.owner === ui.me || (sel?.kind === 'planet' && sel.id === P.id)) {
      g.font = `600 ${P.home >= 0 ? 12.5 : 11.5}px "Chakra Petch", sans-serif`; g.textAlign = 'center';
      label(P.name, x, y + ro + (P.home >= 0 ? 20 : 14), P.owner === null ? '#7d8ba1' : '#dbe4f2');
    }
  }

  // Sieges: a pulsing dashed ring and a countdown to the battle.
  for (const sg of world.sieges) {
    const P = world.planets[sg.planet], [x, y] = toScreen(P.x, P.y), ro = outerR(Math.max(3.5, planetR(P) * z));
    const pulse = 0.55 + 0.45 * Math.sin(now / 260);
    g.strokeStyle = hexA('#ffb35c', 0.5 + 0.4 * pulse); g.lineWidth = 2; g.setLineDash([6, 4]);
    g.lineDashOffset = -now / 60;
    g.beginPath(); g.arc(x, y, ro + 22, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.lineDashOffset = 0;
    g.font = '600 11.5px "JetBrains Mono", monospace'; g.textAlign = 'center';
    label(`Battle in ${inText(sg.startsAt - world.clock)}`, x, y - ro - 30, '#ffb35c');
  }

  // Fleets: a chevron in the owner's colour (in flight, or holding round a world).
  for (const f of world.fleets) {
    const pos = fleetWorldPos(f);
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

// ------------------------------------------------------------ picking and input
let hover = null;
function pick(sx, sy) {
  let best = null, bd = Infinity;
  for (const f of world.fleets) {
    const p = fleetWorldPos(f), [x, y] = toScreen(p.x, p.y), d = Math.hypot(x - sx, y - sy);
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
    for (const sg of siegeAt(world, P.id)) html += `<br><span class="m" style="color:var(--ember)">Under attack by ${esc(playerName(world, sg.leader))}: battle in ${inText(sg.startsAt - world.clock)}</span>`;
    if (move?.picking && move.preview?.ok && move.to === P.id) html += `<br><span class="m">Arrives in ${fmtHours(move.preview.hours)}</span>`;
  } else {
    const f = world.fleets.find((x) => x.id === hover.id);
    if (!f) { tip.hidden = true; return; }
    const holdAt = f.wait != null ? world.planets[f.legs[f.leg].to] : null, sg = holdAt && world.sieges.find((x) => x.id === f.wait);
    html = `<b>Fleet</b> ${f.retreat ? '<span class="tag">retreating</span>' : ''}${holdAt ? '<span class="tag">in a siege</span>' : ''}<br>${who(f.owner)}<br><span class="m">${countShips(f.ships)} ships${holdAt ? ` at ${esc(holdAt.name)}, battle in ${inText(sg.startsAt - world.clock)}` : ` → ${esc(world.planets[f.to].name)} in ${inText(f.arrive - world.clock)}`}</span>`;
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
  const s = [ui.me, sel?.kind, sel?.id, move ? `${move.from}>${move.to}:${move.picking}:${move.lanes}:${move.avoid}:${JSON.stringify(move.ships)}` : '', busy];
  if (sel?.kind === 'planet') {
    const P = world.planets[sel.id];
    s.push(P.owner, JSON.stringify(P.garrison), P.yards.map((y) => y.id).join(), Math.floor(me().credits / 500), JSON.stringify(siegeAt(world, P.id).map((x) => x.fleets)));
  } else if (sel?.kind === 'fleet') s.push(world.fleets.length, world.fleets.find((f) => f.id === sel.id)?.wait, world.fleets.find((f) => f.id === sel.id)?.leg);
  else s.push(world.log.length, Object.keys(world.relations).join(), world.planets.map((p) => p.owner).join(), world.fleets.length, world.planets.reduce((a, p) => a + shipTotal(p), 0));
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

  // Sieges: who is attacking, and when the battle starts.
  for (const sg of siegeAt(world, P.id)) {
    const fl = sg.fleets.map((id) => world.fleets.find((f) => f.id === id)).filter(Boolean);
    const byOwner = new Map();
    for (const f of fl) byOwner.set(f.owner, (byOwner.get(f.owner) || 0) + countShips(f.ships));
    const defs = defendersAt(world, P, [...byOwner.keys()].filter((o) => !allied(world, o, P.owner))).reduce((a, d) => a + d.n, 0);
    const idle = P.garrison.filter((x) => x.n > 0 && x.owner !== P.owner && !defendersAt(world, P, [...byOwner.keys()]).includes(x)).reduce((a, d) => a + d.n, 0);
    const meAtt = allied(world, sg.leader, ui.me), meDef = allied(world, P.owner, ui.me);
    html += `<div class="route siege"><b>Battle in <span data-arrive="${sg.startsAt}"></span></b><br>
      Attacking: ${[...byOwner].map(([o, n]) => `${who(o)} ${fmt(n)} ships`).join(', ')}<br>
      Defending: ${fmt(defs)} ships${P.owner === null ? ' (militia)' : ''}${idle ? ` · ${fmt(idle)} sitting out (allied with both sides)` : ''}<br>
      <span class="hint">${meAtt ? 'Send more ships here before then and they join the attack.' : meDef ? 'Send ships here before then and they join the defence. Shipyards here keep building too.' : 'Both sides can still send reinforcements.'}</span></div>`;
  }

  // Ships, and moving them.
  html += `<h2>Ships here</h2>${garrisonTable(P)}`;
  if (haveShips && !me().eliminated) {
    if (!move || move.from !== P.id) html += `<div class="row"><button class="go" data-act="move" ${busy ? 'disabled' : ''}>Move ships…</button></div>`;
    else html += movePanel(P, myShips);
  }
  if (!friendly && !haveShips) html += `<p class="hint">${P.owner === null ? 'Unclaimed: held by militia.' : 'Enemy world.'} Send a fleet here and win the battle to take it: every shipyard on it is destroyed and its income becomes yours.</p>`;
  // Shipyards: below the ships so they don't push the move controls down; collapsible (the
  // choice is remembered in ui.yardsOpen). The Build button stays in the header either way.
  if (mine || P.yards.length) {
    const open = ui.yardsOpen !== false;
    html += `<h2><button class="fold" data-act="fold-yards" aria-expanded="${open}">${open ? '▾' : '▸'} Shipyards (${P.yards.length})</button>${mine ? `<button class="small go" data-act="yard" ${busy || me().eliminated ? 'disabled' : ''}>Build</button>` : ''}</h2>`;
    if (open) {
      if (!P.yards.length) html += `<p class="hint">None yet. A shipyard builds one ship of its design every ${SHIPYARD_INTERVAL_MIN} min, for free, forever, and the ships guard this world.</p>`;
      for (const y of P.yards) {
        const d = world.designs[y.design];
        html += `<div class="yard"><b>${esc(d.name)}</b>${mine ? `<button class="small danger" data-act="sell" data-yard="${y.id}" ${busy ? 'disabled' : ''} title="Sell for ${Math.round(SHIPYARD_SELL_REFUND * 100)}% of what you paid">Sell +${fmt(sellValue(y))}</button>` : ''}
        <span>${esc(d.cls)} · next in <span data-next="${y.next}"></span> · ${fmt(y.built)} built${mine ? ` · paid ${fmt(y.paid)}` : ''}</span></div>`;
      }
    }
  }
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
  html += `<label class="check" title="Fleets stop at every world on their route, and defenders at worlds you don't hold will fight them"><input type="checkbox" data-act="avoid" ${move.avoid ? 'checked' : ''}> Avoid worlds you don't hold</label>`;
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
      const via = pv.legs.slice(0, -1).map((l) => l.to);
      if (via.length) html += `<br>Stops at ${via.map((id) => esc(world.planets[id].name)).join(', ')} on the way.`;
      html += `<br><span class="hint">Battles start ${fmtHours(HOLD_MS / HOUR_MS)} after the fleet arrives, so reinforcements can join.</span>`;
      if (pv.stops.length) {
        const list = pv.stops.map((id) => { const S = world.planets[id], n = shipTotal(S); return `${esc(S.name)} (${esc(playerName(world, S.owner))}${n ? `, ${n} ships` : ''})`; }).join(', ');
        html += `<br><span style="color:var(--warn)">Passes worlds you don't hold: ${list}. Defenders there will fight this fleet: if it wins it takes that world and flies on, if it loses the survivors turn back.</span>`;
      }
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
      ${f.wait != null
        ? `<dt>Holding at</dt><dd>${esc(world.planets[f.legs[f.leg].to].name)}</dd><dt>Battle in</dt><dd data-arrive="${world.sieges.find((x) => x.id === f.wait)?.startsAt ?? world.clock}"></dd>`
        : `<dt>Next stop</dt><dd>${esc(world.planets[f.legs[f.leg].to].name)}, <span data-arrive="${f.next}"></span></dd>`}
      <dt>Arrives in</dt><dd data-arrive="${f.arrive}"></dd>
      <dt>Route</dt><dd>${lanes} lane / ${f.legs.length - lanes} space</dd>
      <dt>Speed</dt><dd>${f.speed.toFixed(1)}</dd>
      <dt>Value</dt><dd>${fmt(fleetValue(world, f.ships))} cr</dd>
    </dl>
    <h2>Ships</h2><table><tbody>${rows}</tbody></table>
    ${f.legs.length > 1 ? `<p class="hint">Route: ${[f.from, ...f.legs.map((l) => l.to)].map((id, k) => { const N = esc(world.planets[id].name); return k === f.leg + 1 ? `<b>${N}</b>` : N; }).join(' → ')}</p>` : ''}
    <p class="hint">Fleets stop at every world on their route. At a world they mean to attack, or where defenders bar the way, the battle starts ${fmtHours(HOLD_MS / HOUR_MS)} after they arrive, so both sides can bring reinforcements. Winning takes the world. Fleets can't be recalled once launched.</p>
    <div class="row"><button data-act="goto" data-planet="${T.id}">Show destination</button></div>`;
}

function alliesText(pid) {
  const al = world.players.filter((p) => p.id !== pid && allied(world, p.id, pid));
  return al.length ? `Allied with ${al.map((p) => esc(p.name)).join(', ')}` : 'No allies';
}

function overviewPanel() {
  const P = me();
  const mine = world.planets.filter((p) => p.owner === ui.me);
  let html = `<h1><span class="swatch" style="background:${P.color}"></span>${esc(P.name)}</h1>
    <div class="sub">${alliesText(ui.me)}${P.eliminated ? ' · <span style="color:var(--bad)">knocked out</span>' : ''}</div>
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
    html += `<tr class="${pl.eliminated ? 'out' : ''}"><td class="who">${who(pl.id)}${pl.id !== ui.me && allied(world, pl.id, ui.me) ? ' <span class="tag">ally</span>' : ''}</td><td>${worlds}</td><td>${fmt(incomeOf(world, pl.id))}</td><td>${fmt(ships)}</td></tr>`;
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
  else if (act === 'fold-yards') { ui.yardsOpen = ui.yardsOpen === false; store.set(UI_KEY, ui); renderPanel(true); }
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
  if (e.target.dataset.act === 'avoid') { move.avoid = e.target.checked; refreshPreview(); renderPanel(true); }
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
  move = { from, ships, to: null, lanes: true, avoid: true, picking: true, preview: null, hoverTo: null };
  renderPanel(true);
  toast('Click a world to send the fleet there.');
}
function cancelMove() { move = null; renderPanel(true); }
function refreshPreview() {
  if (!move) return;
  const to = move.to;
  move.preview = to === null ? (Object.values(move.ships).some((n) => n > 0) ? null : { ok: false, error: 'Pick some ships to send.' }) : previewFleet(world, move.from, to, move.ships, { owner: ui.me, lanes: move.lanes, avoid: move.avoid });
}
function setMoveTarget(to, commit) {
  if (!move) return;
  move.to = to;
  if (commit) move.picking = false;
  refreshPreview();
  if (commit) renderPanel(true);
}
/**
 * Do an action: hot-seat runs the world function here; online sends it to the server, which runs
 * the same function as the logged-in player and sends back the new world.
 */
let acting = false;
async function perform(action, local) {
  if (!ONLINE) return local();
  if (acting) return { ok: false, error: 'Still sending your last order…' };
  acting = true;
  try { return await net.act(action); } finally { acting = false; }
}

async function launchMove() {
  if (busy || !move) return;
  const { from, to, ships, lanes, avoid } = move;
  const r = await perform({ type: 'fleet', from, to, ships, lanes, avoid }, () => sendFleet(world, ui.me, from, to, ships, { lanes, avoid }));
  if (!r.ok) return toast(r.error, true);
  toast(`Fleet launched: arrives at ${world.planets[to].name} in ${fmtHours((r.fleet.arrive - world.clock) / HOUR_MS)}.`);
  move = null;
  select({ kind: 'fleet', id: r.fleet.id });
  save(); renderEvents();
}

// ------------------------------------------------------------ shipyards
let armedSell = null;
async function sellYard(planetId, yardId) {
  const P = world.planets[planetId], y = P.yards.find((x) => x.id === yardId);
  if (!y || busy) return;
  // Two clicks to sell (no confirm(): hosts like the artifact viewer block it).
  if (armedSell !== yardId) {
    armedSell = yardId;
    const b = $('panel').querySelector(`[data-act=sell][data-yard="${yardId}"]`);
    if (b) b.textContent = 'Click again to sell';
    setTimeout(() => { if (armedSell === yardId) { armedSell = null; renderPanel(true); } }, 3000);
    return;
  }
  armedSell = null;
  const r = await perform({ type: 'sell', planet: planetId, yard: yardId }, () => sellShipyard(world, ui.me, planetId, yardId));
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
  const extra = crowdingSurcharge(existing);
  $('yard-info').innerHTML = P.yards.length
    ? `${P.name} already has <b>${P.yards.length}</b> shipyard${P.yards.length > 1 ? 's' : ''} worth ${fmt(existing)} cr, so a new one here costs <b>${fmt(extra)} cr</b> more than its list price (${Math.round(SHIPYARD_CROWDING_SHARE * 100)}% of the shipyards already here). Building on your other worlds avoids that. You have <b>${fmt(me().credits)}</b> credits.`
    : `A shipyard costs 10× the ship it builds, and makes one every ${SHIPYARD_INTERVAL_MIN} min for free. Each shipyard already on a world adds ${Math.round(SHIPYARD_CROWDING_SHARE * 100)}% of its price to the next one there. You have <b>${fmt(me().credits)}</b> credits.`;
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
    row.innerHTML = `<canvas width="96" height="48"></canvas><div><b>${esc(it.design.name)}</b><span>${esc(it.design.cls)} · ${fmt(designCost(it.design))} cr a ship · ${it.src}</span><br><span class="price">${fmt(q.price)} cr</span>${q.surcharge ? ` <span>(list ${fmt(q.list)} + ${fmt(q.surcharge)})</span>` : ''}</div><button class="go" ${afford ? '' : 'disabled'} title="${afford ? '' : 'Not enough credits'}">Build</button>`;
    thumb(row.querySelector('canvas'), it.design);
    row.querySelector('button').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      if (await build(planetId, it.design)) $('yard-dlg').close(); else e.currentTarget.disabled = false;
    });
    list.append(row);
  }
  $('yard-dlg').showModal();
}
$('yard-cancel').addEventListener('click', () => $('yard-dlg').close());
$('yard-design').addEventListener('click', () => { $('yard-dlg').close(); openDesigner(yardPlanet); });

async function build(planetId, design) {
  const r = await perform({ type: 'build', planet: planetId, design: encodeDesign(design) }, () => buildShipyard(world, ui.me, planetId, design));
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
  return { type: 'lsb-designer-embed', planet: P.name, existing: yardListValue(P), credits: Math.floor(me().credits), yards: P.yards.length };
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
    build(designerFor, d).then((ok) => { if (ok) closeDesigner(); });
  }
});

// ------------------------------------------------------------ replays
async function watch(id) {
  if (ONLINE) toast('Loading the replay…');
  const rep = ONLINE ? await net.replay(id) : await replays.get(id);
  if (!rep) return toast(ONLINE ? 'Couldn\'t load that replay from the server.' : 'That replay isn\'t saved any more: this browser keeps the last 80 battles.', true);
  if (!VIEWER_PAGE) return toast('This build has no replay viewer. Run npm run build.', true);
  const frame = $('replay-frame');
  const send = (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'lsb-viewer-ready') return;
    removeEventListener('message', send);
    const copy = rep.bytes.slice();
    frame.contentWindow.postMessage({ type: 'lsb-replay', bytes: copy.buffer, computeMs: rep.computeMs, sides: rep.sides, title: rep.title }, '*', [copy.buffer]);
  };
  addEventListener('message', send);
  // Dialogs sit above everything, so step out of the combat log while the replay plays.
  backToCombat = $('combat').open;
  if (backToCombat) $('combat').close();
  $('replay-overlay').hidden = false;
  frame.srcdoc = pageDoc(VIEWER_PAGE);
}
let backToCombat = false;
$('replay-close').addEventListener('click', () => {
  $('replay-overlay').hidden = true; $('replay-frame').srcdoc = '';
  if (backToCombat) { backToCombat = false; renderCombat(); $('combat').showModal(); }
});

// ------------------------------------------------------------ events list
function renderEvents() {
  const list = $('events');
  const items = world.log.filter((e) => !ui.mine || (e.players || []).some((p) => allied(world, p, ui.me))).slice(-120).reverse();
  list.innerHTML = items.map((e) => {
    const c = colorOf(e.players?.[0]);
    const btn = e.battle && hasReplay(e.battle.id) ? `<button class="small" data-watch="${e.battle.id}">Watch</button>` : '';
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
function syncEventsWin() {
  $('events-win').classList.toggle('closed', !ui.evOpen);
  $('ev-toggle').textContent = ui.evOpen ? 'Hide' : 'Show';
  $('ev-toggle').setAttribute('aria-expanded', String(!!ui.evOpen));
}
$('ev-toggle').addEventListener('click', () => { ui.evOpen = !ui.evOpen; syncEventsWin(); store.set(UI_KEY, ui); });

// ------------------------------------------------------------ diplomacy
// Allies station ships on each other's worlds, defend them together and join each other's
// attacks. Anyone else is an enemy. An alliance needs both players to agree; either can end it.
let armedBreak = null;
function renderDiplomacy() {
  const meP = me(), others = world.players.filter((p) => p.id !== ui.me);
  $('dip-who').innerHTML = `${who(ui.me)} · ${alliesText(ui.me)}`;
  $('dip-list').innerHTML = others.map((p) => {
    const al = allied(world, ui.me, p.id), theyAsked = hasProposed(world, p.id, ui.me), iAsked = hasProposed(world, ui.me, p.id);
    const out = p.eliminated || meP.eliminated;
    const worlds = world.planets.filter((x) => x.owner === p.id).length;
    let status = al ? '<span class="res good">Allied</span>' : '<span class="res bad">Enemy</span>';
    if (theyAsked) status += ' <span class="tag">wants an alliance</span>';
    if (iAsked) status += ' <span class="tag">you proposed</span>';
    let acts = '';
    if (out) acts = '<span class="hint">Out of the game</span>';
    else if (al) acts = `<button class="small danger" data-dip="break" data-p="${p.id}">${armedBreak === p.id ? 'Click again: declare war' : 'Break alliance'}</button>`;
    else if (theyAsked) acts = `<button class="small go" data-dip="accept" data-p="${p.id}">Accept</button><button class="small" data-dip="decline" data-p="${p.id}">Decline</button>`;
    else if (iAsked) acts = `<button class="small" data-dip="decline" data-p="${p.id}">Withdraw</button>`;
    else acts = `<button class="small go" data-dip="propose" data-p="${p.id}">Propose alliance</button>`;
    return `<div class="dip ${p.eliminated ? 'out' : ''}"><div class="who-col">${who(p.id)}<span class="hint">${worlds} world${worlds === 1 ? '' : 's'} · ${fmt(incomeOf(world, p.id))} cr/h</span></div><div>${status}</div><div class="acts">${acts}</div></div>`;
  }).join('');
  // Everyone's relations at a glance.
  const ps = world.players;
  $('dip-grid').innerHTML = `<table class="grid"><thead><tr><th></th>${ps.map((p) => `<th title="${esc(p.name)}"><span class="swatch" style="background:${p.color}"></span></th>`).join('')}</tr></thead><tbody>${ps.map((a) => `<tr><td class="who">${who(a.id)}</td>${ps.map((b) => `<td>${a.id === b.id ? '·' : allied(world, a.id, b.id) ? '<span class="ally-dot" title="Allied">●</span>' : '<span class="enemy-dot" title="Enemies">×</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function syncDipBadge() {
  const n = proposalsFor(world, ui.me).length, b = $('dip-badge');
  b.hidden = !n; b.textContent = String(n);
}
$('dip-btn').addEventListener('click', () => { armedBreak = null; renderDiplomacy(); $('diplomacy').showModal(); });
$('dip-close').addEventListener('click', () => $('diplomacy').close());
$('dip-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-dip]');
  if (!b || busy) return;
  const other = Number(b.dataset.p), act = b.dataset.dip;
  if (act === 'break' && armedBreak !== other) { armedBreak = other; renderDiplomacy(); setTimeout(() => { if (armedBreak === other) { armedBreak = null; if ($('diplomacy').open) renderDiplomacy(); } }, 3000); return; }
  armedBreak = null;
  const fn = { propose: proposeAlliance, accept: acceptAlliance, decline: declineAlliance, break: breakAlliance }[act];
  if (!fn) return;
  const r = await perform({ type: act, player: other }, () => fn(world, ui.me, other));
  if (!r.ok) return toast(r.error, true);
  const name = world.players[other].name;
  toast(act === 'propose' ? (r.allied ? `You and ${name} are now allies.` : `Alliance proposed. ${name} has to accept it.`)
    : act === 'accept' ? `You and ${name} are now allies.` : act === 'break' ? `You and ${name} are enemies now.` : 'Done.');
  renderDiplomacy(); afterEvent();
});

// ------------------------------------------------------------ combat log
// Every battle and every world that changed hands, from the chosen player's point of view, with
// the replay where this browser still has it.
const isCombat = (e) => !!(e.battle || e.capture || e.siege);
function involves(e, pid) {
  if (e.battle) return [e.battle.attacker, ...(e.battle.attackers || []), e.battle.defender, ...(e.battle.defenders || [])].some((x) => allied(world, x, pid));
  if (e.siege) return allied(world, e.siege.by, pid) || allied(world, e.siege.against, pid);
  if (e.capture) return allied(world, e.capture.by, pid) || allied(world, e.capture.from, pid);
  return false;
}
/** [tone, label] for a combat entry, seen by player pid. tone: 'good' | 'bad' | ''. */
function verdict(e, pid) {
  if (e.battle) {
    const B = e.battle, captured = B.captured ?? (B.won && !B.passing);
    const att = [B.attacker, ...(B.attackers || [])].some((x) => allied(world, x, pid)), def = allied(world, B.defender, pid) || (B.defenders || []).some((d) => allied(world, d, pid));
    if (att) return B.won ? ['good', captured ? 'World taken' : 'Broke through'] : ['bad', B.passing ? 'Ambushed' : 'Repelled'];
    if (def) return B.won ? ['bad', captured ? (B.defender === pid ? 'World lost' : 'Ally lost a world') : 'Fleet got past'] : ['good', B.passing ? 'Blocked a fleet' : 'Defended'];
    return ['', captured ? 'World taken' : B.passing ? 'Ambush' : 'Battle'];
  }
  if (e.siege) {
    if (allied(world, e.siege.by, pid)) return ['', e.siege.join ? 'Joined attack' : 'Attack begins'];
    if (allied(world, e.siege.against, pid)) return ['bad', 'Under attack'];
    return ['', 'Siege'];
  }
  if (allied(world, e.capture.by, pid)) return ['good', 'World taken'];
  if (allied(world, e.capture.from, pid)) return ['bad', e.capture.from === pid ? 'World lost' : 'Ally lost a world'];
  return ['', 'World taken'];
}
let combatFilter = 'mine';
function unreadCombat() {
  const seen = ui.seen?.[ui.me] ?? 0;
  // New things done *to* you (or your allies): battles, attacks starting on you, worlds lost.
  const mineToo = (e) => (e.capture && !e.battle && allied(world, e.capture.by, ui.me)) || (e.siege && allied(world, e.siege.by, ui.me));
  return world.log.filter((e) => e.id > seen && isCombat(e) && involves(e, ui.me) && !mineToo(e)).length;
}
function syncCombatBadge() {
  const n = unreadCombat(), b = $('combat-badge');
  b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n);
  $('combat-btn').title = n ? `${n} new since you last looked` : 'Every battle and captured world, with replays';
}
function renderCombat() {
  const seen = ui.seen?.[ui.me] ?? 0;
  const items = world.log.filter((e) => isCombat(e) && (combatFilter === 'all' || involves(e, ui.me))).reverse();
  document.querySelectorAll('[data-cfilter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cfilter === combatFilter)));
  $('combat-list').innerHTML = items.map((e) => {
    const [tone, label] = verdict(e, ui.me), P = world.planets[e.planet];
    let nums = '';
    if (e.battle) {
      const B = e.battle, side = (k) => `${fmt(B.ships[k])} ships, ${fmt(B.ships[k] - B.survived[k])} lost (${fmt(B.lost[k])} cr)`;
      const att = (B.attackers || [B.attacker]).map((a) => esc(playerName(world, a))).join(' + ');
      nums = `${att}: ${side(0)} · ${B.defender === null ? 'Militia' : esc(playerName(world, B.defender))}${(B.defenders || []).length > 1 ? ' and allies' : ''}: ${side(1)} · ${B.seconds} s`;
    } else if (e.capture?.yards) nums = `${e.capture.yards} shipyard${e.capture.yards > 1 ? 's' : ''} destroyed`;
    const can = e.battle && hasReplay(e.battle.id);
    return `<div class="fight ${tone}${e.id > seen && involves(e, ui.me) ? ' new' : ''}">
      <div class="fhead"><span class="res">${label}</span><span class="where">${esc(P?.name ?? '')}</span><time>${clockText(e.t)}</time></div>
      <p>${esc(e.text)}</p>${nums ? `<div class="nums">${nums}</div>` : ''}
      <div class="acts">${e.battle ? `<button class="small ${can ? 'go' : ''}" data-watch="${e.battle.id}" ${can ? '' : `disabled title="${ONLINE ? 'No replay for this battle' : 'This replay is no longer saved in this browser'}"`}>Watch</button>` : ''}<button class="small" data-planet="${e.planet}">Map</button></div>
    </div>`;
  }).join('') || `<p class="empty">${combatFilter === 'mine' ? 'No battles involving you yet. Battles, and worlds you take or lose, show up here.' : 'No battles yet.'}</p>`;
}
function openCombat() {
  renderCombat();
  ui.seen = { ...(ui.seen || {}), [ui.me]: world.log.length ? world.log[world.log.length - 1].id : 0 };
  store.set(UI_KEY, ui);
  syncCombatBadge();
  if (!$('combat').open) $('combat').showModal();
}
$('combat-btn').addEventListener('click', openCombat);
$('combat-close').addEventListener('click', () => $('combat').close());
document.querySelectorAll('[data-cfilter]').forEach((b) => b.addEventListener('click', () => { combatFilter = b.dataset.cfilter; renderCombat(); }));
$('combat-list').addEventListener('click', (e) => {
  const w = e.target.closest('[data-watch]');
  if (w && !w.disabled) return watch(w.dataset.watch);
  const m = e.target.closest('[data-planet]');
  if (m) { $('combat').close(); const P = world.planets[Number(m.dataset.planet)]; cam.x = P.x; cam.y = P.y; cam.zoom = Math.max(cam.zoom, 1.6); select({ kind: 'planet', id: P.id }); }
});

// ------------------------------------------------------------ top bar
function setupTop() {
  if (ONLINE) {
    // You are who you logged in as: no picking players, no time controls, no new game.
    $('me').hidden = true; $('me-name').hidden = false; $('me-name').textContent = me().name;
    $('me-pick').title = 'You, as logged in';
    $('speed').hidden = true; $('new-btn').hidden = true; $('logout-btn').hidden = false;
    return;
  }
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
  renderPanel(true); renderEvents(); updateTop(); syncCombatBadge(); syncDipBadge();
  if ($('diplomacy').open) renderDiplomacy();
  const H = world.planets[me().home];
  if (H && H.owner === ui.me) { cam.x = H.x; cam.y = H.y; }
});
function updateTop() {
  const p = me();
  if (ONLINE) $('me-name').textContent = p.name;
  $('me-swatch').style.background = p.color;
  document.documentElement.style.setProperty('--me', p.color);
  $('credits').textContent = fmt(p.credits);
  $('income').textContent = `+${fmt(incomeOf(world, ui.me))}/h`;
  const sp = ONLINE ? net.state?.speed ?? 1 : 1;
  $('clock').textContent = clockText(world.clock) + (sp === 1 ? '' : sp === 0 ? ' · paused' : ` · ${sp}×`);
  const b = $('banner');
  if (world.winner) { b.hidden = false; b.innerHTML = `<span>${world.winner.map((id) => who(id)).join(' &amp; ')} won the galaxy.</span>${ONLINE ? '' : '<button class="small" id="banner-new">New game</button>'}`; }
  else if (p.eliminated) { b.hidden = false; b.innerHTML = `<span>${esc(p.name)} has been knocked out.${ONLINE ? ' You can still watch the galaxy and its battles.' : ' Pick another player above, or start a new game.'}</span>`; }
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
  $('ng-warn').hidden = !world;
  $('newgame').showModal();
}
function renderNgPlayers() {
  const n = Number($('ng-count').value), box = $('ng-players');
  box.innerHTML = '<div class="prow"><span></span><label>Name</label><label>Colour</label><label title="Players with the same letter start as allies">Start team</label></div>';
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
  const planets = Math.max(3, Math.min(14, Number($('ng-planets').value) || 7));
  world = createWorld({ players, seed: Math.max(1, Number($('ng-seed').value) || 1), planetsPerPlayer: planets });
  gameTarget = world.clock;
  ui.me = 0; ui.seen = {}; sel = null; move = null; replays.clear();
  $('newgame').close();
  start();
  save();
});

// ------------------------------------------------------------ time and battles
let lastReal = performance.now();
async function pump(now) {
  const dt = Math.min(1000, now - lastReal); lastReal = now;
  if (ONLINE) {
    // The server runs events and battles; between its updates, income and shipyards tick on here
    // (pure functions of time), so the numbers move smoothly.
    if (world && net.state) advanceTo(world, Math.max(world.clock, net.gameNow()));
    return;
  }
  if (busy || !world) return;
  gameTarget = Math.max(gameTarget, world.clock) + dt * ui.speed;
  // Events in order; most resolve on the spot, battles run over several frames.
  for (let guard = 0; guard < 400; guard++) {
    const ev = dueEvent(world, gameTarget);
    if (!ev) break;
    advanceTo(world, ev.at);
    const plan = planEvent(world, ev);
    if (plan.kind === 'battle') { await fight(ev, plan); return; }
    const entry = applyEvent(world, ev, plan, null);
    if (entry) {
      if (entry.siege && allied(world, entry.siege.against, ui.me)) toast(entry.text, true);
      afterEvent();
    }
  }
  advanceTo(world, gameTarget);
}

async function fight(ev, plan) {
  busy = true;
  renderPanel(true);
  const B = plan.battle, P = world.planets[B.planet];
  const attackers = B.attackers || [B.attacker];
  const sides = [attackers.map((a) => playerName(world, a)).join(' + '), P.owner === null ? `${P.name} militia` : playerName(world, B.defender)];
  $('fight').hidden = false;
  const attHtml = attackers.map((a) => who(a)).join(' + ');
  $('fight-title').innerHTML = B.passing
    ? `Ambush at <b>${esc(P.name)}</b>: ${who(B.defender)} blocks ${attHtml}`
    : `Battle at <b>${esc(P.name)}</b>: ${attHtml} ${attackers.length > 1 ? 'attack' : 'attacks'} ${who(B.defender)}`;
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
  const entry = applyEvent(world, ev, plan, result);
  if (entry?.battle) await replays.put({ id: entry.battle.id, t: entry.t, bytes: packReplay(rep.meta, rep.cols), computeMs, sides, title: `${B.passing ? 'Ambush' : 'Battle'} of ${P.name}` });
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
  renderEvents(); renderPanel(); updateTop(); syncCombatBadge(); syncDipBadge();
  if ($('combat').open) renderCombat();
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
  renderPanel(true); renderEvents(); updateTop(); syncCombatBadge(); syncDipBadge(); syncEventsWin();
  $('ev-mine').setAttribute('aria-pressed', String(!!ui.mine));
}

addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
addEventListener('beforeunload', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); else lastReal = performance.now(); });

// ------------------------------------------------------------ online: login and server updates
// A new copy of the world from the server. Keep what the player is doing (selection, a fleet
// being planned) as long as it still makes sense, and tell them about things that happened to them.
function applyServerState(s) {
  $('net').hidden = !!s; // no snapshot = the connection dropped (net.js keeps retrying)
  if (!s) return;
  if (s.world) {
    const first = !world, lastSeen = world?.log.length ? world.log[world.log.length - 1].id : Infinity;
    world = s.world;
    ui.me = s.me;
    if (first) start();
    else for (const e of world.log) {
      if (e.id <= lastSeen) continue;
      if ((e.battle || e.capture) && involves(e, ui.me)) toast(e.text, verdict(e, ui.me)[0] === 'bad');
      else if (e.siege && allied(world, e.siege.against, ui.me)) toast(e.text, true);
    }
    if (!first) { if (move) refreshPreview(); afterEvent(); }
  }
  showServerBattle(s.status?.battle);
  if (world && isOpenSeat(world, ui.me)) openClaim(); else if ($('claim').open) $('claim').close();
}

// An open seat: the player picks their name and colour the first time they log in.
let claimColor = null;
function openClaim() {
  const colors = freeColors(world, ui.me);
  if (!colors.includes(claimColor)) claimColor = colors.includes(me().color) ? me().color : colors[0];
  $('claim-colors').innerHTML = colors.map((c) => `<button type="button" role="radio" aria-checked="${c === claimColor}" aria-label="Colour ${c}" data-color="${c}" style="background:${c}"></button>`).join('');
  if (!$('claim').open) { $('claim').showModal(); $('claim-name').focus(); }
}
if (ONLINE) {
  $('claim').addEventListener('cancel', (e) => e.preventDefault()); // has to be done before playing
  $('claim-colors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    claimColor = b.dataset.color;
    for (const x of $('claim-colors').children) x.setAttribute('aria-checked', String(x === b));
  });
  $('claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('claim-go').disabled = true; $('claim-err').textContent = '';
    const r = await perform({ type: 'claim', name: $('claim-name').value, color: claimColor }, () => ({ ok: false }));
    $('claim-go').disabled = false;
    if (!r.ok) { $('claim-err').textContent = r.error; if (world) openClaim(); return; }
    $('claim').close();
    toast(`Welcome, ${me().name}. Your home world is ${world.planets[me().home].name}.`);
    const H = world.planets[me().home]; cam.x = H.x; cam.y = H.y; cam.zoom = Math.max(cam.zoom, 1.4);
    select({ kind: 'planet', id: H.id });
  });
}
/** The server's battle progress card: everyone sees when a battle is being fought out. */
function showServerBattle(B) {
  $('fight').hidden = !B || !world;
  if (!B || !world) return;
  const P = world.planets[B.planet], att = B.attackers.map((a) => who(a)).join(' + ');
  $('fight-title').innerHTML = B.passing ? `Ambush at <b>${esc(P.name)}</b>: ${who(B.defender)} blocks ${att}` : `Battle at <b>${esc(P.name)}</b>: ${att} ${B.attackers.length > 1 ? 'attack' : 'attacks'} ${who(B.defender)}`;
  $('fight-status').textContent = `Being fought out on the server · ${B.seconds} s simulated · ${B.alive[0]} vs ${B.alive[1]} ships`;
  $('fight-bar').style.width = `${Math.round(B.frac * 100)}%`;
}

function showLogin(msg = '') {
  $('login').hidden = false;
  $('login-err').textContent = msg;
  $('login-go').disabled = false;
  setTimeout(() => $('login-pw').focus(), 0);
}
async function onlineStart() {
  net.onState = applyServerState;
  net.onLoggedOut = () => { location.reload(); };
  try {
    if (await net.fetchState()) { $('login').hidden = true; net.poll(); return; }
  } catch { return showLogin('Can\'t reach the game server. Try again in a moment.'); }
  showLogin(net.noGame ? 'The game hasn\'t been set up yet. Ask the organiser.' : '');
}
if (ONLINE) {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('login-pw').value;
    if (!pw.trim()) return;
    $('login-go').disabled = true; $('login-err').textContent = '';
    let r;
    try { r = await net.login(pw); } catch { r = { ok: false, error: 'Can\'t reach the game server.' }; }
    if (!r.ok) return showLogin(r.error || 'That didn\'t work.');
    $('login-pw').value = '';
    try { await net.fetchState(); } catch { return showLogin('Logged in, but couldn\'t load the game. Reload the page.'); }
    $('login').hidden = true;
    net.poll();
  });
  $('logout-btn').addEventListener('click', async () => { await net.logout(); location.reload(); });
}

// Load the saved game; time spent away counts at 1× (as it will on the server).
ui = { ...ui, ...store.get(UI_KEY, {}) };
const saved = ONLINE ? null : store.get(WORLD_KEY, null);
if (ONLINE) {
  resize();
  onlineStart();
} else if (saved?.format === 'lsb-world') {
  world = upgradeWorld(saved);
  const away = Math.max(0, Date.now() - (ui.saved || Date.now()));
  gameTarget = world.clock + away;
  start();
  if (away > 60000) toast(`Welcome back: ${fmtHours(away / HOUR_MS)} passed in the galaxy while you were away.`);
} else {
  resize();
  openNewGame();
}
requestAnimationFrame((now) => { resize(); if (world) fit(); lastReal = now; loop(now); });
// Which replays this browser still has (for the Watch buttons).
if (!ONLINE) replays.init().then(() => { if (world) { renderEvents(); if ($('combat').open) renderCombat(); } });

// Small hook for debugging and automated checks.
window.galaxy = { get world() { return world; }, get ui() { return ui; }, cam, fit, select, replays, preview: (from, to, ships, o = {}) => previewFleet(world, from, to, ships, { owner: ui.me, avoid: false, ...o }) };
