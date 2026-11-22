// The defence arranger (owner, 20 Nov 2026: players asked to "build a designable defence/fortress
// by moving all the defences they have on a planet into an arrangement"). A full-screen editor
// over the galaxy page: every defence the player has at one world, drawn from its blocks, which
// they drag into place and turn to any angle (15° snaps on Q/E, the buttons, or Shift while
// turning). What they save becomes P.layout (see src/world/defenceLayout.js), and battles there
// stand each defence exactly as shown. The battle frame is used throughout: x right, y down, the
// world at (0, 0), one attacker coming in from the left (several spread evenly round the world);
// the screen shows it turned half round, so attackers come from the right (see toScreen).
//
// openArrange(opts) with opts = { title, designs: { id: { name, design } } (every defence design of
//   the player's), counts: { id: n } (defences at this world), layout: spots | null,
//   colors: { [blockType]: css }, touch: bool, toast(msg, bad),
//   save: async (spots) => { ok, error },
//   blueprints: () => [{ id, name, spots }], saveBlueprint: async (name, spots), deleteBlueprint: async (id),
//   price: (id) => credits for one defence, credits: () => credits now, buildMissing: async ([{ id, count }]) }

import { shapeOf, piecesOverlap, pieceReach, LAYOUT_RADIUS, MAX_SPOTS } from '../world/defenceLayout.js';
import { layoutDefences } from '../world/battleSetup.js';

const SNAP = Math.PI / 12; // 15°
const CSS = `
#arrange { position: fixed; inset: 0; z-index: 12; background: #04060b; display: flex; flex-direction: column; }
#arrange .ar-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; padding-top: max(8px, env(safe-area-inset-top, 0px)); border-bottom: 1px solid var(--line); background: var(--panel); flex: none; flex-wrap: wrap; }
#arrange .ar-bar b { font-size: 15px; margin-right: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#arrange .ar-bar button { font-size: 13px; padding: 7px 12px; white-space: nowrap; }
#arrange canvas { flex: 1; min-height: 0; width: 100%; display: block; touch-action: none; cursor: grab; }
#arrange .ar-foot { flex: none; padding: 7px 12px; padding-bottom: max(7px, env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--line); background: var(--panel); color: var(--dim); font-size: 12.5px; line-height: 1.45; }
#arrange .ar-foot .bad { color: var(--bad); font-weight: 600; }
#arrange .ar-foot .ok { color: var(--azure); }
#arrange { position: fixed; }
#arrange .ar-bp { position: absolute; right: 12px; top: 64px; z-index: 2; width: min(340px, calc(100% - 24px)); max-height: 60%; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.6); font-size: 13px; }
#arrange .ar-bp h3 { margin: 0 0 6px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dim); }
#arrange .ar-bp .r { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
#arrange .ar-bp .r span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#arrange .ar-bp input { flex: 1; min-width: 0; font: inherit; padding: 6px 8px; background: #0b111c; color: var(--ink); border: 1px solid var(--line); border-radius: 4px; }
#arrange .ar-bp button { font-size: 12px; padding: 5px 9px; }
#arrange .ar-bp p { color: var(--dim); margin: 6px 0 0; line-height: 1.4; }
@media (max-width: 640px), (pointer: coarse) and (max-height: 500px) {
  #arrange .ar-bar { flex-wrap: nowrap; overflow-x: auto; gap: 6px; padding: 6px 8px; }
  #arrange .ar-bar b { display: none; }
  #arrange .ar-bar [data-a=back] { order: -2; }
  #arrange .ar-bar [data-a=save] { order: -1; } /* Save in reach without swiping */
  #arrange .ar-foot { font-size: 12px; }
}`;

let root = null, S = null; // S: the open editor's state

export function openArrange(opts) {
  if (!root) build();
  S = { opts, pieces: [], sel: new Set(), cam: { x: 0, y: 0, z: 1 }, drag: null, pointers: new Map(), bad: new Set(), dirty: false, sprites: new Map() };
  S.pieces = piecesFrom(opts.layout);
  checkAll();
  root.querySelector('.ar-title').textContent = opts.title;
  root.querySelector('.ar-bp').hidden = true;
  root.hidden = false;
  resize();
  fit();
  hint();
  draw();
}

/**
 * Pieces for an arrangement (spots, or null for none): the defences here fill the spots of their
 * design in order; spots left over are empty (ghosts); defences beyond the spots start where
 * one-attacker rows would put them.
 */
function piecesFrom(spots) {
  const { designs, counts } = S.opts, pieces = [];
  const ids = [...new Set([...Object.keys(counts).filter((id) => counts[id] > 0), ...(spots || []).map((s) => s.d)])].filter((id) => designs[id]);
  const byDesign = new Map(ids.map((id) => [id, []]));
  for (const sp of spots || []) if (byDesign.has(sp.d)) byDesign.get(sp.d).push(sp);
  for (const id of ids) {
    const shape = shapeOf(designs[id].design), n = counts[id] || 0, sps = byDesign.get(id);
    sps.forEach((sp, k) => pieces.push({ id, shape, x: sp.x, y: sp.y, a: sp.a, ghost: k >= n, auto: false }));
    for (let k = sps.length; k < n; k++) pieces.push({ id, shape, x: 0, y: 0, a: Math.PI, ghost: false, auto: true });
  }
  autoPlace(pieces.filter((p) => p.auto), pieces.filter((p) => !p.auto));
  return pieces;
}

/** Empty spots per design: [{ id, count }] and what building them would cost. */
function missing() {
  const m = new Map();
  for (const p of S.pieces) if (p.ghost) m.set(p.id, (m.get(p.id) || 0) + 1);
  const list = [...m].map(([id, count]) => ({ id, count }));
  return { list, n: list.reduce((t, x) => t + x.count, 0), cost: list.reduce((t, x) => t + x.count * S.opts.price(x.id), 0) };
}

export const arrangeOpen = () => !!root && !root.hidden;

function close() { root.hidden = true; S = null; }

// ------------------------------------------------------------------ layout helpers
/** Lay out pieces the way a battle with one attacker would (rows facing left, beyond `around`). */
function autoPlace(list, around) {
  if (!list.length) return;
  const designs = [], idx = new Map();
  const di = (p) => { if (!idx.has(p.id)) { idx.set(p.id, designs.length); designs.push(S.opts.designs[p.id].design); } return idx.get(p.id); };
  const fixed = list.map((p) => ({ design: di(p), p }));
  const near = around.map((p) => ({ design: di(p), x: p.x, y: p.y, a: p.a }));
  layoutDefences(fixed, designs, [Math.PI], 2, near);
  for (const f of fixed) { f.p.x = f.x; f.p.y = f.y; f.p.a = f.a; }
}

/** Snap a piece so its blocks sit on whole-block lines when it's turned a multiple of 90°. */
function snapPos(p) {
  const q = ((p.a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  if (Math.min(q, Math.PI / 2 - q) > 0.002) return;
  const side = Math.round(p.a / (Math.PI / 2)) % 2 !== 0; // turned sideways: width runs along y
  const wx = side ? p.shape.h : p.shape.w, wy = side ? p.shape.w : p.shape.h;
  const off = (n) => (n % 2) / 2;
  p.x = Math.round(p.x - off(wx)) + off(wx);
  p.y = Math.round(p.y - off(wy)) + off(wy);
}

function checkAll() {
  const { pieces } = S, bad = new Set();
  for (let i = 0; i < pieces.length; i++) {
    if (pieceReach(pieces[i]) > LAYOUT_RADIUS) bad.add(i);
    for (let j = i + 1; j < pieces.length; j++) if (piecesOverlap(pieces[i], pieces[j])) { bad.add(i); bad.add(j); }
  }
  S.bad = bad;
}
/** Quicker re-check after moving some pieces: only pairs involving them. */
function checkMoved(moved) {
  const { pieces } = S;
  const bad = new Set([...S.bad].filter((i) => !moved.has(i)));
  for (const i of moved) {
    if (pieceReach(pieces[i]) > LAYOUT_RADIUS) bad.add(i);
    for (let j = 0; j < pieces.length; j++) if (j !== i && piecesOverlap(pieces[i], pieces[j])) { bad.add(i); bad.add(j); }
  }
  // a piece that only overlapped a moved one may be fine now
  for (const j of [...bad]) {
    if (moved.has(j)) continue;
    let still = pieceReach(pieces[j]) > LAYOUT_RADIUS;
    for (let k = 0; k < pieces.length && !still; k++) if (k !== j && piecesOverlap(pieces[j], pieces[k])) still = true;
    if (!still) bad.delete(j);
  }
  S.bad = bad;
}

function spotsOut() {
  // Per design: pieces holding a defence first, then empty spots (so new defences refill them).
  const out = [];
  for (const ghost of [false, true]) for (const p of S.pieces) if (p.ghost === ghost) out.push({ d: p.id, x: p.x, y: p.y, a: p.a });
  return out;
}

// ------------------------------------------------------------------ DOM
function build() {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  root = document.createElement('div');
  root.id = 'arrange'; root.hidden = true;
  root.innerHTML = `<div class="ar-bar">
      <button data-a="back">← Back</button>
      <b class="ar-title"></b>
      <button data-a="ccw" title="Turn 15° anticlockwise (Q)">⟲ 15°</button>
      <button data-a="cw" title="Turn 15° clockwise (E)">⟳ 15°</button>
      <button data-a="all" title="Select every defence (A)">Select all</button>
      <button data-a="remove" title="Remove the selected empty spots (Delete)">Remove empty spots</button>
      <button data-a="auto" title="Put every defence back in automatic rows (nothing is saved until you press Save)">Re-lay automatically</button>
      <button data-a="fit" title="See everything (F)">Fit</button>
      <button data-a="bp" title="Save this arrangement to reuse at your other worlds, or load one you saved">Blueprints…</button>
      <button data-a="missing" class="go" hidden title="Order defences for every empty spot (they take the usual build time, then fill their spots)"></button>
      <button data-a="save" class="go">Save</button>
    </div>
    <div class="ar-bp" hidden></div>
    <canvas></canvas>
    <div class="ar-foot"></div>`;
  document.body.appendChild(root);
  const cv = root.querySelector('canvas');
  root.querySelector('.ar-bar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (b && S) command(b.dataset.a);
  });
  root.querySelector('.ar-bp').addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]');
    if (b && S) blueprintCmd(b.dataset.b, b.dataset.id);
  });
  root.querySelector('.ar-bp').addEventListener('keydown', (e) => { if (e.key === 'Enter' && S) blueprintCmd('save'); e.stopPropagation(); });
  cv.addEventListener('pointerdown', down);
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  addEventListener('resize', () => { if (S) { resize(); draw(); } });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (S) draw(); }).observe(cv);
  // Captured before the galaxy page's own keys, so Esc etc. act here while the editor is open.
  addEventListener('keydown', (e) => {
    if (!S || root.hidden || e.target.closest?.('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    const map = { q: 'ccw', e: 'cw', a: 'all', f: 'fit', delete: 'remove', backspace: 'remove', escape: S.sel.size ? 'deselect' : 'back' };
    if (map[k]) { command(map[k]); e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

function command(a) {
  if (a === 'back') {
    if (S.dirty && !confirm('Leave without saving your arrangement?')) return;
    return close();
  }
  if (a === 'deselect') { S.sel.clear(); }
  else if (a === 'all') { S.sel = new Set(S.pieces.map((_, i) => i)); }
  else if (a === 'cw' || a === 'ccw') rotateSel(a === 'cw' ? SNAP : -SNAP, true);
  else if (a === 'fit') fit();
  else if (a === 'remove') {
    const gone = [...S.sel].filter((i) => S.pieces[i].ghost);
    if (!gone.length) { S.opts.toast('Select an empty spot (faint outline) to remove it. Defences you have can only be moved.'); return; }
    S.pieces = S.pieces.filter((_, i) => !gone.includes(i));
    S.sel.clear(); S.dirty = true; checkAll();
  } else if (a === 'auto') {
    S.pieces = S.pieces.filter((p) => !p.ghost);
    S.pieces.forEach((p) => { p.auto = true; });
    autoPlace(S.pieces, []);
    S.sel.clear(); S.dirty = true; checkAll(); fit();
  } else if (a === 'save') return save();
  else if (a === 'bp') { const el = root.querySelector('.ar-bp'); el.hidden = !el.hidden; if (!el.hidden) renderBlueprints(); return; }
  else if (a === 'missing') return buildMissing();
  hint(); draw();
}

// ------------------------------------------------------------------ blueprints
function renderBlueprints() {
  const el = root.querySelector('.ar-bp'), list = S.opts.blueprints();
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  el.innerHTML = `<h3>Blueprints</h3>
    <div class="r"><input data-k="name" maxlength="40" placeholder="Name for this arrangement"><button data-b="save" class="go">Save as blueprint</button></div>
    ${list.length ? list.map((b) => `<div class="r"><span title="${esc(b.name)}">${esc(b.name)} <em style="color:var(--dim)">· ${b.spots.length}</em></span><button data-b="load" data-id="${b.id}">Load</button><button data-b="del" data-id="${b.id}" class="danger">Delete</button></div>`).join('') : ''}
    <p>${list.length ? 'Loading one lays it out here: your defences fill its spots, and any it has that aren\'t here yet show as empty spots, ready for <b>Build missing</b>. Saving under an existing name replaces it.' : 'Save this arrangement to reuse it at your other worlds. Blueprints are kept with your account.'}</p>`;
}

async function blueprintCmd(b, idStr) {
  const id = Number(idStr), list = S.opts.blueprints();
  if (b === 'save') {
    const name = root.querySelector('.ar-bp [data-k=name]').value.trim();
    if (!name) { S.opts.toast('Give the blueprint a name.', true); return; }
    if (S.bad.size) { S.opts.toast('Fix the overlapping (red) defences first.', true); return; }
    const r = await S.opts.saveBlueprint(name, spotsOut());
    if (!r?.ok) { S.opts.toast(r?.error || 'Could not save the blueprint.', true); return; }
    S.opts.toast(r.replaced ? `Blueprint "${name}" updated.` : `Saved as blueprint "${name}".`);
    renderBlueprints();
  } else if (b === 'load') {
    const bp = list.find((x) => x.id === id);
    if (!bp) return;
    if (S.dirty && !confirm(`Replace what you've arranged here with "${bp.name}"?`)) return;
    S.pieces = piecesFrom(bp.spots);
    S.sel.clear(); S.dirty = true; checkAll(); fit(); hint(); draw();
    root.querySelector('.ar-bp').hidden = true;
    const m = missing();
    S.opts.toast(m.n ? `Loaded "${bp.name}": ${m.n} empty spot${m.n === 1 ? '' : 's'} to fill. Use Build missing, then Save.` : `Loaded "${bp.name}". Save to use it here.`);
  } else if (b === 'del') {
    const bp = list.find((x) => x.id === id);
    if (!bp || !confirm(`Delete the blueprint "${bp.name}"?`)) return;
    const r = await S.opts.deleteBlueprint(id);
    if (!r?.ok) S.opts.toast(r?.error || 'Could not delete it.', true);
    renderBlueprints();
  }
}

async function buildMissing() {
  const m = missing();
  if (!m.n) return;
  if (S.bad.size) { S.opts.toast('Fix the overlapping (red) defences first.', true); return; }
  if (m.cost > S.opts.credits() + 1e-6) { S.opts.toast(`Building the ${m.n} missing defences costs ${Math.round(m.cost).toLocaleString()} cr; you have ${Math.floor(S.opts.credits()).toLocaleString()}.`, true); return; }
  if (!confirm(`Save this arrangement and order ${m.n} defence${m.n === 1 ? '' : 's'} for its empty spots, for ${Math.round(m.cost).toLocaleString()} cr? They fill their spots when they're built.`)) return;
  const r = await S.opts.save(spotsOut());
  if (!r?.ok) { S.opts.toast(r?.error || 'Could not save.', true); return; }
  const b = await S.opts.buildMissing(m.list);
  if (!b?.ok) { S.opts.toast(b?.error || 'Could not order them.', true); return; }
  S.opts.toast(`Arrangement saved; ${m.n} defence${m.n === 1 ? '' : 's'} ordered for the empty spots.`);
  close();
}

async function save() {
  if (S.bad.size) { S.opts.toast(`${S.bad.size} defence${S.bad.size === 1 ? '' : 's'} overlap or stand too far out (shown in red). Move them first.`, true); return; }
  const spots = spotsOut();
  if (spots.length > MAX_SPOTS) { S.opts.toast(`At most ${MAX_SPOTS} spots.`, true); return; }
  const btn = root.querySelector('[data-a=save]');
  btn.disabled = true;
  try {
    const r = await S.opts.save(spots);
    if (!r?.ok) { S.opts.toast(r?.error || 'Could not save.', true); return; }
    S.opts.toast('Defences arranged: battles here will use this layout.');
    close();
  } finally { btn.disabled = false; }
}

function rotateSel(da, snap) {
  if (!S.sel.size) { S.opts.toast('Select a defence first (or Select all).'); return; }
  const list = [...S.sel].map((i) => S.pieces[i]);
  let cx = 0, cy = 0;
  for (const p of list) { cx += p.x; cy += p.y; }
  cx /= list.length; cy /= list.length;
  const c = Math.cos(da), s = Math.sin(da);
  for (const p of list) {
    if (list.length > 1) { const dx = p.x - cx, dy = p.y - cy; p.x = cx + dx * c - dy * s; p.y = cy + dx * s + dy * c; }
    p.a += da;
    if (snap) p.a = Math.round(p.a / SNAP) * SNAP;
    p.a = ((p.a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    p.auto = false;
    snapPos(p);
  }
  S.dirty = true;
  checkMoved(new Set(S.sel));
}

function hint() {
  const mb = root.querySelector('[data-a=missing]'), m = missing();
  mb.hidden = !m.n;
  if (m.n) mb.textContent = `Build missing (${m.n} · ${Math.round(m.cost).toLocaleString()} cr)`;
  const { pieces, sel, bad } = S, n = pieces.filter((p) => !p.ghost).length, ghosts = pieces.length - n, auto = pieces.filter((p) => p.auto).length;
  const t = S.opts.touch;
  let h = `<b>${n}</b> defence${n === 1 ? '' : 's'} here${ghosts ? `, <b>${ghosts}</b> empty spot${ghosts === 1 ? '' : 's'} (faint) waiting for new ones of that design` : ''}. `;
  h += bad.size ? `<span class="bad">${bad.size} overlap or stand too far out (red): move them before saving.</span> ` : '<span class="ok">No overlaps.</span> ';
  if (auto) h += `${auto} not placed by you yet (amber outline): they'll be saved where they are. `;
  h += `<br>${t ? 'Drag' : 'Drag'} a defence to move it${t ? '' : ' (Shift+click to pick several, Shift+drag empty space to box-select)'}; drag its round handle to turn it (${t ? 'snaps to 15° near each step' : 'hold Shift to snap to 15°'}), or use ⟲ ⟳. ${t ? 'Drag empty space to look around, pinch to zoom.' : 'Drag empty space to look around, wheel to zoom.'} The arrow shows where one attacker comes from; two come from the dashed arrows, more spread evenly round the world. The nose (the chevron) is the front you designed. Defences may touch but not overlap. New defences fill empty spots of their design first.`;
  root.querySelector('.ar-foot').innerHTML = h;
}

// ------------------------------------------------------------------ view
let W = 0, H = 0, dpr = 1;
function resize() {
  const cv = root.querySelector('canvas');
  dpr = Math.min(2, devicePixelRatio || 1);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
}
// The canvas changes size after opening (the hint line below it wraps, bar buttons appear):
// every draw and every pointer event uses its real size, or clicks miss what is drawn.
function syncSize() {
  const cv = root.querySelector('canvas');
  if (cv.clientWidth !== W || cv.clientHeight !== H || Math.min(2, devicePixelRatio || 1) !== dpr) resize();
}
// The view is the battle frame turned half round (owner, 21 Nov 2026), so attackers come from the
// right as in the Defence Designer, where a defence's nose (+x) faces right. S.cam is in view
// coordinates (view = -battle); everything stored stays in the battle frame.
const toScreen = (x, y) => [(-x - S.cam.x) * S.cam.z + W / 2, (-y - S.cam.y) * S.cam.z + H / 2];
const toWorld = (sx, sy) => [-((sx - W / 2) / S.cam.z + S.cam.x), -((sy - H / 2) / S.cam.z + S.cam.y)];
function fit() {
  syncSize();
  let r = 120;
  for (const p of S.pieces) r = Math.max(r, Math.hypot(p.x, p.y) + p.shape.r + 20);
  S.cam = { x: 0, y: 0, z: Math.min(W, H) / (2 * r) };
}
function zoomAt(sx, sy, k) {
  syncSize();
  const [wx, wy] = toWorld(sx, sy);
  S.cam.z = Math.max(0.05, Math.min(40, S.cam.z * k));
  S.cam.x = -wx - (sx - W / 2) / S.cam.z; S.cam.y = -wy - (sy - H / 2) / S.cam.z;
  draw();
}

function sprite(id) {
  let c = S.sprites.get(id);
  if (c) return c;
  const d = S.opts.designs[id].design;
  c = document.createElement('canvas'); c.width = d.w; c.height = d.h;
  const g = c.getContext('2d'), img = g.createImageData(d.w, d.h);
  const rgb = {};
  for (const [t, css] of Object.entries(S.opts.colors)) { const n = parseInt(css.slice(1), 16); rgb[t] = [n >> 16, (n >> 8) & 255, n & 255]; }
  for (let i = 0; i < d.cells.length; i++) {
    const t = d.cells[i];
    if (!t) continue;
    const [r, gg, b] = rgb[t] || [150, 160, 180];
    img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  S.sprites.set(id, c);
  return c;
}

const handleOf = (p) => [p.x + Math.cos(p.a) * (p.shape.w / 2 + Math.max(4, 14 / S.cam.z)), p.y + Math.sin(p.a) * (p.shape.w / 2 + Math.max(4, 14 / S.cam.z))];

function draw() {
  if (!S) return;
  syncSize();
  const g = root.querySelector('canvas').getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#04060b'; g.fillRect(0, 0, W, H);
  const z = S.cam.z;
  // grid every 10 blocks (every 50 when zoomed out)
  const step = z * 10 < 8 ? 50 : 10;
  const [ax0, ay0] = toWorld(0, 0), [ax1, ay1] = toWorld(W, H);
  const x0 = Math.min(ax0, ax1), x1 = Math.max(ax0, ax1), y0 = Math.min(ay0, ay1), y1 = Math.max(ay0, ay1);
  g.strokeStyle = 'rgba(140,170,210,0.07)'; g.lineWidth = 1; g.beginPath();
  for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { const [sx] = toScreen(x, 0); g.moveTo(sx, 0); g.lineTo(sx, H); }
  for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { const [, sy] = toScreen(0, y); g.moveTo(0, sy); g.lineTo(W, sy); }
  g.stroke();
  // the area defences must stay inside, and the world itself
  const [cx, cy] = toScreen(0, 0);
  g.setLineDash([6, 6]); g.strokeStyle = 'rgba(255,207,92,0.35)';
  g.beginPath(); g.arc(cx, cy, LAYOUT_RADIUS * z, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  const pr = Math.max(6, 22 * z), grd = g.createRadialGradient(cx - pr * 0.3, cy - pr * 0.3, pr * 0.1, cx, cy, pr);
  grd.addColorStop(0, '#9fd3ff'); grd.addColorStop(1, '#1b3d66');
  g.fillStyle = grd; g.beginPath(); g.arc(cx, cy, pr, 0, Math.PI * 2); g.fill();
  // where attackers come from (drawn on screen, so turned with the view): one from the right; two from ±60°
  const arrow = (ang, main) => {
    const R = Math.min(W, H) * 0.45, ux = Math.cos(ang), uy = Math.sin(ang);
    const ax = cx + ux * R, ay = cy + uy * R, bx = cx + ux * (R - (main ? 70 : 45)), by = cy + uy * (R - (main ? 70 : 45));
    g.strokeStyle = main ? 'rgba(255,107,107,0.9)' : 'rgba(255,107,107,0.5)'; g.fillStyle = g.strokeStyle; g.lineWidth = main ? 4 : 2;
    if (!main) g.setLineDash([6, 5]);
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); g.setLineDash([]);
    const px = -uy, py = ux, hs = main ? 12 : 8;
    g.beginPath(); g.moveTo(bx - ux * hs, by - uy * hs); g.lineTo(bx + px * hs * 0.7, by + py * hs * 0.7); g.lineTo(bx - px * hs * 0.7, by - py * hs * 0.7); g.fill();
    if (main) { g.font = '600 13px var(--display, sans-serif)'; g.textAlign = 'center'; g.fillText('ATTACKERS', ax + ux * -10, ay - 14); }
  };
  arrow(0, true); arrow(-Math.PI / 3, false); arrow(Math.PI / 3, false);
  // the defences
  S.pieces.forEach((p, i) => {
    const [sx, sy] = toScreen(p.x, p.y), r = p.shape.r * z;
    if (sx < -r || sy < -r || sx > W + r || sy > H + r) return;
    g.save(); g.translate(sx, sy); g.rotate(p.a + Math.PI);
    const w = p.shape.w * z, h = p.shape.h * z;
    g.globalAlpha = p.ghost ? 0.22 : 1;
    g.imageSmoothingEnabled = false;
    g.drawImage(sprite(p.id), -w / 2, -h / 2, w, h);
    g.globalAlpha = 1;
    const bad = S.bad.has(i), sel = S.sel.has(i);
    if (bad || sel || p.auto || p.ghost) {
      g.lineWidth = sel ? 2.5 : 1.5;
      g.strokeStyle = bad ? '#ff6b6b' : sel ? '#86e8ff' : p.ghost ? 'rgba(200,210,230,0.6)' : '#ffb35c';
      if ((p.ghost || p.auto) && !sel && !bad) g.setLineDash([5, 4]);
      g.strokeRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4); g.setLineDash([]);
      if (bad) { g.fillStyle = 'rgba(255,60,60,0.25)'; g.fillRect(-w / 2, -h / 2, w, h); }
    }
    // the nose: a chevron just past the front edge
    if (w > 6) {
      const s = Math.max(3, Math.min(10, h * 0.25));
      g.strokeStyle = sel ? '#86e8ff' : 'rgba(255,255,255,0.75)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(w / 2 + 3, -s); g.lineTo(w / 2 + 3 + s, 0); g.lineTo(w / 2 + 3, s); g.stroke();
    }
    g.restore();
  });
  // turning handle for a single selected piece
  if (S.sel.size === 1) {
    const p = S.pieces[[...S.sel][0]], [hx, hy] = toScreen(...handleOf(p)), [px, py] = toScreen(p.x, p.y);
    g.strokeStyle = '#86e8ff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, py); g.lineTo(hx, hy); g.stroke();
    g.fillStyle = '#86e8ff'; g.beginPath(); g.arc(hx, hy, S.opts.touch ? 11 : 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#04060b'; g.font = '600 11px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('↻', hx, hy + 0.5); g.textBaseline = 'alphabetic';
  }
  // box select
  if (S.drag?.kind === 'box') {
    const { sx0, sy0, sx1, sy1 } = S.drag;
    g.strokeStyle = '#86e8ff'; g.setLineDash([4, 4]); g.strokeRect(Math.min(sx0, sx1), Math.min(sy0, sy1), Math.abs(sx1 - sx0), Math.abs(sy1 - sy0)); g.setLineDash([]);
  }
}

// ------------------------------------------------------------------ pointer
function pieceAt(wx, wy) {
  for (let i = S.pieces.length - 1; i >= 0; i--) {
    const p = S.pieces[i], dx = wx - p.x, dy = wy - p.y, c = Math.cos(p.a), s = Math.sin(p.a);
    const lx = dx * c + dy * s, ly = -dx * s + dy * c, pad = Math.max(0.5, (S.opts.touch ? 12 : 6) / S.cam.z);
    if (Math.abs(lx) <= p.shape.w / 2 + pad && Math.abs(ly) <= p.shape.h / 2 + pad && nearBlock(p.shape, lx, ly, pad)) return i;
  }
  return -1;
}

// Owner, 23 Nov 2026: clicking in the gaps of an Aegis fortress selected the fortress. A click only
// picks a piece if one of its real blocks is within `pad` blocks of the pointer, not anywhere in its box.
function nearBlock(sh, lx, ly, pad) {
  const gx = lx + sh.w / 2, gy = ly + sh.h / 2, r = Math.min(pad, 40);
  const i0 = Math.max(0, Math.floor(gx - r)), i1 = Math.min(sh.w - 1, Math.floor(gx + r));
  const j0 = Math.max(0, Math.floor(gy - r)), j1 = Math.min(sh.h - 1, Math.floor(gy + r));
  for (let j = j0; j <= j1; j++) {
    const dy = Math.max(j - gy, 0, gy - (j + 1));
    if (dy > r) continue;
    for (let i = i0; i <= i1; i++) {
      if (!sh.occ[j * sh.w + i]) continue;
      const dx = Math.max(i - gx, 0, gx - (i + 1));
      if (dx * dx + dy * dy <= r * r) return true;
    }
  }
  return false;
}

function down(e) {
  const cv = e.currentTarget;
  syncSize();
  cv.setPointerCapture(e.pointerId);
  S.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (S.pointers.size === 2) { // pinch: zoom + pan with two fingers
    const [a, b] = [...S.pointers.values()];
    S.drag = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    return;
  }
  const [wx, wy] = toWorld(e.offsetX, e.offsetY);
  // the turning handle first
  if (S.sel.size === 1) {
    const p = S.pieces[[...S.sel][0]], [hx, hy] = toScreen(...handleOf(p));
    if (Math.hypot(e.offsetX - hx, e.offsetY - hy) <= (S.opts.touch ? 20 : 11)) { S.drag = { kind: 'turn', i: [...S.sel][0] }; return; }
  }
  const i = pieceAt(wx, wy);
  if (i >= 0) {
    if (e.shiftKey) { if (S.sel.has(i)) S.sel.delete(i); else S.sel.add(i); draw(); hint(); S.drag = null; return; }
    if (!S.sel.has(i)) { S.sel.clear(); S.sel.add(i); }
    const start = [...S.sel].map((k) => [k, S.pieces[k].x, S.pieces[k].y]);
    S.drag = { kind: 'move', wx, wy, start, moved: false };
  } else if (e.shiftKey) {
    S.drag = { kind: 'box', sx0: e.offsetX, sy0: e.offsetY, sx1: e.offsetX, sy1: e.offsetY };
  } else {
    S.drag = { kind: 'pan', sx: e.offsetX, sy: e.offsetY, cx: S.cam.x, cy: S.cam.y, moved: false };
  }
  root.querySelector('canvas').style.cursor = S.drag.kind === 'pan' ? 'grabbing' : 'move';
  draw();
}

function move(e) {
  if (!S || !S.pointers.has(e.pointerId)) return;
  S.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  const d = S.drag;
  if (!d) return;
  if (d.kind === 'pinch' && S.pointers.size >= 2) {
    const [a, b] = [...S.pointers.values()];
    const nd = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.cam.x -= (mx - d.mx) / S.cam.z; S.cam.y -= (my - d.my) / S.cam.z;
    zoomAt(mx, my, nd / Math.max(1, d.d));
    d.d = nd; d.mx = mx; d.my = my;
    return;
  }
  if (d.kind === 'pan') {
    if (Math.hypot(e.offsetX - d.sx, e.offsetY - d.sy) > 4) d.moved = true;
    S.cam.x = d.cx - (e.offsetX - d.sx) / S.cam.z; S.cam.y = d.cy - (e.offsetY - d.sy) / S.cam.z;
  } else if (d.kind === 'move') {
    const [wx, wy] = toWorld(e.offsetX, e.offsetY);
    if (!d.moved && Math.hypot(wx - d.wx, wy - d.wy) * S.cam.z < 3) return;
    d.moved = true;
    for (const [k, x, y] of d.start) { const p = S.pieces[k]; p.x = x + wx - d.wx; p.y = y + wy - d.wy; p.auto = false; snapPos(p); }
    S.dirty = true;
    checkMoved(new Set(d.start.map(([k]) => k)));
    hint();
  } else if (d.kind === 'turn') {
    const p = S.pieces[d.i], [wx, wy] = toWorld(e.offsetX, e.offsetY);
    let a = Math.atan2(wy - p.y, wx - p.x);
    const near = Math.round(a / SNAP) * SNAP;
    if (e.shiftKey || (S.opts.touch && Math.abs(a - near) < 0.06)) a = near;
    p.a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); p.auto = false; snapPos(p);
    S.dirty = true;
    checkMoved(new Set([d.i]));
    hint();
  } else if (d.kind === 'box') { d.sx1 = e.offsetX; d.sy1 = e.offsetY; }
  draw();
}

function up(e) {
  if (!S) return;
  S.pointers.delete(e.pointerId);
  const d = S.drag;
  if (d?.kind === 'pinch') { if (!S.pointers.size) S.drag = null; return; }
  if (d?.kind === 'pan' && !d.moved) { S.sel.clear(); hint(); }
  if (d?.kind === 'box') {
    const [px, py] = toWorld(d.sx0, d.sy0), [qx, qy] = toWorld(d.sx1, d.sy1);
    const ax = Math.min(px, qx), bx = Math.max(px, qx), ay = Math.min(py, qy), by = Math.max(py, qy);
    S.pieces.forEach((p, i) => { if (p.x >= ax && p.x <= bx && p.y >= ay && p.y <= by) S.sel.add(i); });
    hint();
  }
  S.drag = null;
  root.querySelector('canvas').style.cursor = 'grab';
  draw();
}
