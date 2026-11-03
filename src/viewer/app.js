// Replay viewer app: resolves a battle in the browser (same sim code the server will run),
// packs it into the replay format, loads it back, and plays it.

import { makeScenario } from '../shared/designs.js';
import { Battle, DT } from '../sim/battle.js';
import { packReplay } from '../shared/replayFormat.js';
import { ReplayModel } from './model.js';
import { Renderer, TEAM } from './renderer.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
let renderer;
try { renderer = new Renderer(canvas); } catch (err) { $('progress-title').textContent = err.message; throw err; }

const cam = { x: 0, y: 0, zoom: 1 };
let model = null, t = 0, playing = true, speed = 1, last = performance.now();
let fps = 60, frames = 0, fpsT = performance.now();
const info = { computeMs: 0, raw: 0, gz: 0, blocks: 0 };

// ------------------------------------------------------------ starfield (static, parallax via CSS)
(function stars() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  let s = 12345;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 420; i++) {
    const b = r(), sz = b > 0.97 ? 1.6 : b > 0.85 ? 1.1 : 0.7;
    g.fillStyle = `rgba(${200 + r() * 55 | 0},${210 + r() * 45 | 0},255,${0.25 + b * 0.6})`;
    g.fillRect(r() * 512, r() * 512, sz, sz);
  }
  document.documentElement.style.setProperty('--stars', `url(${c.toDataURL()})`);
})();

// ------------------------------------------------------------ resolve a battle
async function resolve() {
  const perSide = Number($('ships').value), seed = Number($('seed').value) || 1;
  playing = false;
  $('progress').hidden = false;
  $('resolve').disabled = true;
  const scen = makeScenario({ perSide, seed });
  info.blocks = scen.ships.reduce((n, s) => n + scen.designs[s.design].cells.reduce((k, c) => k + (c ? 1 : 0), 0), 0);
  $('progress-title').textContent = `Resolving ${(perSide * 2).toLocaleString()} ships · ${info.blocks.toLocaleString()} blocks`;
  await frame();
  const b = new Battle({ ...scen, seed });
  const t0 = performance.now();
  while (!b.done) {
    const sliceEnd = performance.now() + 30;
    while (!b.done && performance.now() < sliceEnd) b.step();
    $('progress-detail').textContent = `${(b.tick * DT).toFixed(1)} s simulated · ${b.teamAlive[0]} vs ${b.teamAlive[1]} ships left · ${b.P.n} rounds in flight`;
    $('progress-bar').style.width = `${Math.min(100, (b.tick / b.maxTicks) * 100)}%`;
    await frame();
  }
  info.computeMs = performance.now() - t0;
  $('progress-detail').textContent = 'Packing replay';
  await frame();
  const rep = b.toReplay();
  show(packReplay(rep.meta, rep.cols));
  $('resolve').disabled = false;
}

/** Play a packed replay (from the sim above, or handed over by the ship designer). */
function show(bytes) {
  info.raw = bytes.length;
  info.gz = 0;
  gzipSize(bytes).then((n) => { info.gz = n; });
  model = new ReplayModel(bytes); // load from the packed bytes, exactly like a downloaded replay
  $('scrub').max = model.ticks;
  drawStrength();
  // Open close enough to see individual blocks, centred on the line of contact.
  fitView();
  cam.zoom = Math.max(cam.zoom, 2.2);
  t = 0; playing = true; setPlayIcon();
  $('progress').hidden = true;
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

async function gzipSize(bytes) {
  if (typeof CompressionStream === 'undefined') return 0;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

function fitView() {
  const b = model.bounds, w = canvas.clientWidth, h = canvas.clientHeight;
  cam.x = (b.minX + b.maxX) / 2; cam.y = (b.minY + b.maxY) / 2;
  cam.zoom = Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY)) * 0.95;
}

// ------------------------------------------------------------ main loop
function loop(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (model) {
    if (playing) {
      t += (dtReal / DT) * speed;
      if (t >= model.ticks) { t = model.ticks; playing = false; setPlayIcon(); }
    }
    renderer.draw(model, t, cam);
    $('scrub').value = t;
    if (frames % 6 === 0) { updateHud(); drawMinimap(); }
  }
  document.documentElement.style.setProperty('--sx', `${-cam.x * 0.15}px`);
  document.documentElement.style.setProperty('--sy', `${-cam.y * 0.15}px`);
  frames++;
  if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
  requestAnimationFrame(loop);
}

const fmtT = (ticks) => {
  const s = ticks * DT, m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const mb = (n) => (n ? `${(n / 1e6).toFixed(2)} MB` : '…');

function updateHud() {
  const sec = Math.min(model.strength[0].length - 1, Math.floor(t * DT));
  for (const team of [0, 1]) {
    const alive = model.strength[team][sec], start = model.startCount[team];
    $(`alive${team}`).textContent = `${alive.toLocaleString()}`;
    $(`meter${team}`).style.width = `${(alive / start) * 100}%`;
  }
  $('time').textContent = `${fmtT(t)} / ${fmtT(model.ticks)}`;
  const s = renderer.stats;
  $('st-compute').textContent = `${(info.computeMs / 1000).toFixed(1)} s for ${(model.ticks * DT).toFixed(0)} s of battle`;
  $('st-size').textContent = `${mb(info.gz)} gzip (${mb(info.raw)} raw)`;
  $('st-draw').textContent = `${s.blocks.toLocaleString()} blocks · ${s.effects.toLocaleString()} fx`;
  $('st-fps').textContent = `${fps.toFixed(0)} fps · ${s.ships.toLocaleString()} ships on screen`;
  $('st-zoom').textContent = cam.zoom < 0.9 ? 'Fleet view (zoom in for blocks)' : `${cam.zoom.toFixed(1)} px per block`;
}

// ------------------------------------------------------------ timeline + strength graph
function drawStrength() {
  const c = $('strength'), dpr = Math.min(2, devicePixelRatio || 1);
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const max = Math.max(model.startCount[0], model.startCount[1]);
  const n = model.strength[0].length;
  [0, 1].forEach((team) => {
    const col = TEAM[team].accent;
    g.beginPath();
    for (let k = 0; k < n; k++) {
      const x = (k / (n - 1)) * W, y = H - (model.strength[team][k] / max) * (H - 4 * dpr) - 2 * dpr;
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = col; g.globalAlpha = 0.9; g.lineWidth = 1.5 * dpr; g.stroke();
    g.lineTo(W, H); g.lineTo(0, H); g.closePath();
    g.globalAlpha = 0.12; g.fillStyle = col; g.fill();
  });
  g.globalAlpha = 1;
}

$('scrub').addEventListener('input', (e) => { t = Number(e.target.value); });
const setPlayIcon = () => { $('play').textContent = playing ? 'Pause' : 'Play'; $('play').setAttribute('aria-pressed', String(playing)); };
$('play').addEventListener('click', () => {
  if (!model) return;
  if (!playing && t >= model.ticks) t = 0;
  playing = !playing; setPlayIcon();
});
document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
  speed = Number(b.dataset.speed);
  document.querySelectorAll('[data-speed]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
}));
$('resolve').addEventListener('click', resolve);
$('fit').addEventListener('click', () => model && fitView());
addEventListener('resize', () => model && drawStrength());
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  if (e.code === 'ArrowRight') t = Math.min(model.ticks, t + 50);
  if (e.code === 'ArrowLeft') t = Math.max(0, t - 50);
});

// ------------------------------------------------------------ camera: drag, wheel, pinch
const pointers = new Map();
let pinch0 = null;
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
canvas.addEventListener('pointerup', (e) => { pointers.delete(e.pointerId); pinch0 = null; });
canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch0 = null; });
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) { cam.x -= (e.clientX - p.x) / cam.zoom; cam.y -= (e.clientY - p.y) / cam.zoom; }
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch0);
    pinch0 = d;
  }
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
function zoomAt(sx, sy, k) {
  const r = canvas.getBoundingClientRect();
  const wx = cam.x + (sx - r.left - r.width / 2) / cam.zoom, wy = cam.y + (sy - r.top - r.height / 2) / cam.zoom;
  cam.zoom = Math.max(0.05, Math.min(40, cam.zoom * k));
  cam.x = wx - (sx - r.left - r.width / 2) / cam.zoom; cam.y = wy - (sy - r.top - r.height / 2) / cam.zoom;
}

// ------------------------------------------------------------ minimap
const mm = $('minimap'), mg = mm.getContext('2d');
const tr = { x: 0, y: 0, a: 0 };
function mmScale() {
  const b = model.bounds, pad = 1.6;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const s = Math.min(mm.width / ((b.maxX - b.minX) * pad), mm.height / ((b.maxY - b.minY) * pad));
  return { cx, cy, s };
}
function drawMinimap() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (mm.width !== mm.clientWidth * dpr) { mm.width = mm.clientWidth * dpr; mm.height = mm.clientHeight * dpr; }
  const { cx, cy, s } = mmScale(), W = mm.width, H = mm.height;
  mg.clearRect(0, 0, W, H);
  const cols = TEAM.map((T) => T.accent);
  for (const e of model.ents) {
    if (e.kind !== 0 || t >= e.t1) continue;
    model.transform(e, t, tr);
    mg.fillStyle = cols[e.team];
    const sz = Math.max(1.2 * dpr, e.radius * s * 0.8);
    mg.fillRect(W / 2 + (tr.x - cx) * s - sz / 2, H / 2 + (tr.y - cy) * s - sz / 2, sz, sz);
  }
  const vw = canvas.clientWidth / cam.zoom, vh = canvas.clientHeight / cam.zoom;
  mg.strokeStyle = 'rgba(230,238,255,0.8)'; mg.lineWidth = dpr;
  mg.strokeRect(W / 2 + (cam.x - vw / 2 - cx) * s, H / 2 + (cam.y - vh / 2 - cy) * s, vw * s, vh * s);
}
function minimapJump(e) {
  if (!model) return;
  const r = mm.getBoundingClientRect(), dpr = mm.width / r.width, { cx, cy, s } = mmScale();
  cam.x = cx + ((e.clientX - r.left) * dpr - mm.width / 2) / s;
  cam.y = cy + ((e.clientY - r.top) * dpr - mm.height / 2) / s;
}
mm.addEventListener('pointerdown', (e) => { mm.setPointerCapture(e.pointerId); minimapJump(e); });
mm.addEventListener('pointermove', (e) => { if (e.buttons) minimapJump(e); });

requestAnimationFrame(loop);
// Opened by the ship designer's test battle (viewer.html#replay): it posts the packed replay.
if (location.hash === '#replay' && window.opener) {
  $('progress').hidden = false;
  $('progress-title').textContent = 'Waiting for the test battle';
  addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'lsb-replay') return;
    document.querySelectorAll('.side small').forEach((el, k) => { if (e.data.sides?.[k]) el.textContent = e.data.sides[k]; });
    info.computeMs = e.data.computeMs || 0;
    show(new Uint8Array(e.data.bytes));
  });
  window.opener.postMessage({ type: 'lsb-viewer-ready' }, '*');
} else resolve();

// Small hook for debugging and automated screenshots.
window.battleViewer = { get model() { return model; }, cam, seek: (v) => { t = v; playing = false; setPlayIcon(); } };
