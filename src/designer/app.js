// Ship designer page: grid editor, live stats and price, validation, save/load and test battles.
// All game numbers come from src/shared (blocks.js, shipStats.js, economy.js), the same code the
// battle sim and server use.

import { BT, BLOCKS, WEAPON, MULTIBLOCK, HULL_CLASSES, COOKOFF } from '../shared/blocks.js';
import { ARC_BINS, binAngle, binOpen } from '../shared/arcs.js';
import { routeLength } from '../shared/bayRoute.js';
import { analyzeDesign, encodeDesign, decodeDesign, designCost, STANCE_INFO, PLACE_INFO } from '../shared/shipStats.js';
import { shipyardPrice, shipyardPriceAt, crowdingSurcharge, SHIPYARD_INTERVAL_MIN, SHIPYARD_PRICE_MULT, defensePrice, DEFENSE_PRICE_SHARE, DEFENSE_BUILD_HOURS } from '../shared/economy.js';
import { makeDesign, CLASSES } from '../shared/designs.js';
import { FORTRESSES, loadFortress } from '../shared/fortresses.js';
import { Battle, DT } from '../sim/battle.js';
import { packReplay } from '../shared/replayFormat.js';
import { ShipEditor } from './editor.js';
import { makeTestScenario, summarise, DEFAULT_COPIES } from './testBattle.js';
import { BATTLE_MAX_TIME } from '../world/rules.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString();

// Same colours as the replay viewer's Azure side, so a design looks like it will in battle.
const COLOR = {
  [BT.HUB]: '#86e8ff', [BT.ARMOR]: '#5c7ea3', [BT.HEAVY]: '#41597a', [BT.FRAME]: '#90a6c0', [BT.THRUSTER]: '#3d434f',
  [BT.LASER]: '#d8f4ff', [BT.CANNON]: '#9aa1ab', [BT.MISSILE]: '#b9b16c', [BT.PD]: '#c2413f', [BT.LANCE]: '#2c3150', [BT.GUIDED]: '#8fb79e', [BT.BAY]: '#c9a23c', [BT.FLAK]: '#5d574b',
};
// Palette order and number keys.
const PALETTE = [
  [BT.FRAME, '1'], [BT.ARMOR, '2'], [BT.HEAVY, '3'], [BT.THRUSTER, '4'], [BT.LASER, '5'],
  [BT.CANNON, '6'], [BT.PD, '7'], [BT.MISSILE, '8'], [BT.GUIDED, 'g'], [BT.BAY, 'c'], [BT.LANCE, '9'], [BT.FLAK, 'k'], [BT.HUB, '0'], [0, 'x'],
];
const WEAPON_ORDER = [BT.LASER, BT.CANNON, BT.PD, BT.MISSILE, BT.GUIDED, BT.BAY, BT.LANCE, BT.FLAK];

const ed = new ShipEditor();
// block: the selected palette block (0 = eraser), or null when nothing is selected (Esc).
// Right-clicking an empty cell picks the Hand tool and drags the view (owner, Nov 2026).
let block = BT.ARMOR, tool = 'pencil', showArcs = false;
let design = null, info = null, seenVersion = -1;
const canvas = $('grid'), g = canvas.getContext('2d');
const cam = { x: ed.w / 2, y: ed.h / 2, zoom: 12 };
let dirty = true, hover = null, touchInspect = false; // touchInspect: a Hand-tool tap is showing a cell's readout (touch screens)

// ------------------------------------------------------------ storage (never fatal)
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const LIB_KEY = 'lsb.designs.v1';
// The design you were last working on. The defence designer keeps its own, so taking the
// thrusters off a defence never changes the ship you come back to in the ship designer.
const SHIP_CUR_KEY = 'lsb.designer.current.v1', DEF_CUR_KEY = 'lsb.designer.defence.current.v1';
let CUR_KEY = SHIP_CUR_KEY;
// What a block is for, in its palette tooltip (owner, Nov 2026: a friend didn't know point defence
// shoots missiles down).
const BLOCK_HINT = {
  [BT.PD]: `SHOOTS DOWN ENEMY MISSILES (normal and guided) within ${WEAPON[BT.PD].range} blocks: a missile has ${WEAPON[BT.MISSILE].hp} hp and each burst does ${WEAPON[BT.PD].missileDamage}, so a few of these protect a ship. Then ENEMY FIGHTERS within ${WEAPON[BT.PD].range} (${WEAPON[BT.PD].damage} a burst). When neither is near, it shoots any enemy ship within ${WEAPON[BT.PD].range}.`,
  // Owner, Nov 2026: players didn't know thrusters also set galaxy map speed.
  [BT.THRUSTER]: 'Moves the ship. More thrust for the ship\'s mass means a higher top speed and faster turning in battle.\n\nIT ALSO SETS SPEED ON THE GALAXY MAP: a fleet crosses the map at the top speed of its SLOWEST ship, so one under-powered ship slows the whole fleet down. Top speed (in the stats panel) is the same number in battle and on the map; a ship with almost no thrust can\'t leave its world.',
  [BT.MISSILE]: 'A huge, slow, unguided missile: flies straight where it was aimed, over your own ships, and its blast wrecks everything within 9 blocks. Point defence can shoot it down.',
  [BT.GUIDED]: 'The same huge missile, but it steers after its target in flight (and finds a new one nearby if its target dies), so it hits ships that dodge. Point defence can still shoot it down.',
  [BT.BAY]: `LAUNCHES FIGHTERS: ${WEAPON[BT.BAY].waves[0]} as the battle opens, then one every minute for as long as it lasts, at any range. Fighters need a way out: put the bay on the hull edge, or leave a tunnel of empty cells from it to space; the tunnel can turn corners (hover the bay to see its way out). A fighter circles the nearest enemy ship shooting it (${WEAPON[BT.BAY].fighter.damage} damage every ${WEAPON[BT.BAY].fighter.cooldown} s, range ${WEAPON[BT.BAY].fighter.range}), dogfights enemy fighters, and flies until it's shot down (${WEAPON[BT.BAY].fighter.hp} hp). Early on they soak up enemy fire; late in a battle they hunt down the long-range ships left at the back. Lasers hit them ${Math.round(WEAPON[BT.LASER].fighterHit * 100)}% of the time; point defence goes for them first. They shine in long, drawn-out fights.`,
};
BLOCK_HINT[BT.FLAK] = `ANTI-SWARM GUN FOR BIG SHIPS: every ${WEAPON[BT.FLAK].cooldown} s it fires a salvo of ${WEAPON[BT.FLAK].salvo} shells up to ${WEAPON[BT.FLAK].range} blocks at one enemy ship. Each shell bursts right beside it and sprays ${WEAPON[BT.FLAK].fragments} pieces of shrapnel, mostly onward into the target; every piece flies on until it hits something (${WEAPON[BT.FLAK].damage} damage to an enemy). Shreds small, lightly armoured ships and fighters; barely scratches thick armour. It picks the most lightly armoured ship in range (lots of guns, little armour or frame) and spreads its fire, so many flak cannons don't all shoot the same ship. Shells fly over your own and allied ships and through wrecks; shrapnel is stopped by wrecks and by allied ships, but never hurts them. Its blocks don't explode.`;
const PLASMA_WARNING = "WARNING: HUGE FRIENDLY FIRE. ITS BOLT CARVES THROUGH YOUR OWN SHIPS AS WELL AS THE ENEMY'S, AND ITS BLOCKS EXPLODE WHEN DESTROYED, WRECKING YOUR SHIP AND ANY ALLY NEARBY.";

// ------------------------------------------------------------ UI setup
function blockTitle(t) {
  if (!t) return 'Erase blocks (right drag also erases)';
  const B = BLOCKS[t], W = WEAPON[t];
  let s = `${B.name}: ${B.cost} cr, ${B.hp} hp, mass ${B.mass}`;
  if (t === BT.LANCE) s = `${B.name}: one 10×10 unit, ${B.cost * 100} cr, ${B.hp} hp per block, keeps firing while half survives. Destroyed blocks explode (${COOKOFF.damage} damage, radius ${COOKOFF.radius}), hurting your own ship and allies`;
  if (t === BT.BAY) { const n = MULTIBLOCK[t].size; s = `${B.name}: one ${n}×${n} unit, ${B.cost * n * n} cr, ${B.hp} hp per block, keeps launching while half its blocks survive`; }
  if (t === BT.FLAK) s = `${B.name}: one 10×10 unit, ${B.cost * 100} cr, ${B.hp} hp per block, keeps firing while half survives`;
  if (t === BT.THRUSTER) s += `, thrust ${B.thrust}`;
  if (W && t === BT.FLAK) s += `. Range ${W.range}, a salvo of ${W.salvo} shells every ${W.cooldown} s, each bursting into ${W.fragments} × ${W.damage} shrapnel`;
  else if (W && t !== BT.BAY) s += `. Range ${W.range}, ${W.damage} damage every ${W.cooldown} s`;
  if (t === BT.HUB) s += '. One per ship; placing it moves it. Lose it and the ship breaks apart.';
  if (BLOCK_HINT[t]) s += `.\n\n${BLOCK_HINT[t]}`;
  if (t === BT.LANCE) s += `.\n\n${PLASMA_WARNING}`;
  return s;
}
for (const [t, key] of PALETTE) {
  const b = document.createElement('button');
  b.className = 'blk'; b.dataset.block = t; b.title = `${blockTitle(t)} (${key.toUpperCase()})`;
  const n = MULTIBLOCK[t] ? MULTIBLOCK[t].size : 1, cost = !t ? '' : `${BLOCKS[t].cost * n * n}`;
  b.innerHTML = `<i style="background:${t ? COLOR[t] : 'transparent'};${t ? '' : 'box-shadow:inset 0 0 0 1px var(--bad)'}"></i><span>${t ? BLOCKS[t].name + (n > 1 ? ` ${n}×${n}` : '') : 'Erase'}</span><em>${cost ? cost + ' cr' : ''}</em>`;
  b.addEventListener('click', () => setBlock(t));
  $('blocks').append(b);
}
function setBlock(t) {
  if (t === BT.THRUSTER && defenseMode()) { toast("Defences can't have thrusters: they never move."); return; }
  block = t;
  if ((MULTIBLOCK[t] || t === BT.HUB || tool === 'pan') && tool !== 'pencil') setTool('pencil'); // picking a block leaves the Hand tool
  document.querySelectorAll('.blk').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.block) === t)));
  dirty = true;
}
function setTool(t) {
  tool = t;
  canvas.style.cursor = t === 'pan' ? 'grab' : '';
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  if (t !== 'pencil' && (MULTIBLOCK[block] || block === BT.HUB)) setBlock(BT.ARMOR);
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

for (const [id, s] of Object.entries(STANCE_INFO)) $('stance').add(new Option(s.label, id));
$('stance').addEventListener('change', () => { ed.stance = $('stance').value; ed.changed(); });
for (const [id, p] of Object.entries(PLACE_INFO)) $('place').add(new Option(p.label, id));
$('place').addEventListener('change', () => { ed.place = $('place').value; ed.changed(); });
$('name').addEventListener('input', () => { ed.name = $('name').value; ed.changed(); });

const tpl = $('template');
tpl.add(new Option('Start from…', ''));
tpl.add(new Option('Blank (hub only)', 'blank'));
for (const cls of Object.keys(CLASSES)) tpl.add(new Option(`Sample ${cls}${['dreadnought', 'leviathan', 'colossus'].includes(cls) ? ' (huge)' : ''}`, cls));
tpl.addEventListener('change', () => {
  const v = tpl.value;
  tpl.value = '';
  if (!v) return;
  if (v.startsWith('f')) { // a ready-made Aegis fortress (defence designer only)
    const f = FORTRESSES[Number(v.slice(1))];
    toast(`Loading ${f.name}…`);
    loadFortress(Number(v.slice(1))).then((d) => { ed.load(d); dropThrusters(); syncFields(); fit(); toast(`Loaded ${f.name}. Undo to go back.`); })
      .catch((err) => toast(`Couldn't load ${f.name}: ${err.message}`));
    return;
  }
  if (v === 'blank') { ed.clear(); ed.name = 'New design'; ed.stance = 'line'; ed.place = 'auto'; toast('Cleared. Undo to get your design back.'); }
  else if (v.startsWith('y')) { // one of your shipyards' designs or defences (opened from the galaxy)
    const o = embed.designs[Number(v.slice(1))], d = decodeDesign(o.data);
    ed.load({ ...d, name: o.name }); toast(`Loaded ${o.name}. Undo to go back.`);
  } else { const d = makeDesign(v, 7 + Math.floor(Math.random() * 1000)); ed.load({ ...d, name: defenseMode() ? `My ${v} defence` : `My ${v}` }); toast(`Loaded a sample ${v}. Undo to go back.`); }
  if (v !== 'blank') dropThrusters();
  syncFields(); fit();
});

// Opened from the galaxy: "Start from" also lists the designs your shipyards build, and in the
// defence designer the defences you've already built come first.
function addYardTemplates(list, defence = false) {
  const group = (label, pick) => {
    const mine = list.map((o, k) => [o, k]).filter(([o]) => pick(o));
    if (!mine.length) return null;
    const grp = document.createElement('optgroup');
    grp.label = label;
    for (const [o, k] of mine) grp.append(new Option(o.name, `y${k}`));
    return grp;
  };
  const blank = [...tpl.options].find((o) => o.value === 'blank');
  const defs = defence && group('Your defences', (o) => o.defence);
  if (defs) tpl.insertBefore(defs, blank);
  const yards = group('Your shipyards', (o) => o.yard);
  if (yards) tpl.insertBefore(yards, blank);
}

// Defence designer: the ready-made Aegis fortresses (owner, 12 Nov 2026), after your own defences.
let fortressesShown = false;
function addFortressTemplates() {
  if (fortressesShown) return;
  fortressesShown = true;
  const grp = document.createElement('optgroup');
  grp.label = 'Aegis fortresses (150,000 cr each)';
  FORTRESSES.forEach((f, k) => { const o = new Option(`${f.name}: ${f.blurb}`, `f${k}`); grp.append(o); });
  const yards = [...tpl.querySelectorAll('optgroup')].find((g) => g.label === 'Your shipyards');
  tpl.insertBefore(grp, yards || [...tpl.options].find((o) => o.value === 'blank'));
}

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

function syncFields() { $('name').value = ed.name; $('stance').value = ed.stance; $('place').value = ed.place; dirty = true; }

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

// ------------------------------------------------------------ analysis -> stats panel
// Analysis of a huge design can take tens of milliseconds, so while painting one it waits for
// the end of the stroke (or a pause) instead of running every frame.
let analysisMs = 0, analysedAt = 0;
function refresh(force = false) {
  if (ed.version === seenVersion) return;
  const now = performance.now();
  if (!force && analysisMs > 20 && (drag || now - analysedAt < Math.min(1500, analysisMs * 8))) return;
  seenVersion = ed.version;
  design = ed.toDesign();
  info = analyzeDesign(design);
  analysisMs = performance.now() - now; analysedAt = performance.now();
  dirty = true;
  const a = info;
  $('cost').textContent = fmt(a.cost);
  $('stats-cost').textContent = `${fmt(a.cost)} cr`; // phone Stats button (hidden on computers)
  $('stats-btn').classList.toggle('bad', !a.ok);
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
    const W = WEAPON[t];
    const shot = t === BT.BAY ? `${W.waves[0]} fighters, then 1 / ${W.cooldown} s` : t === BT.FLAK ? `${W.salvo} × (${W.fragments} × ${W.damage}) / ${W.cooldown} s` : `${fmt(W.damage)} / ${W.cooldown} s`;
    return `<tr title="${SHOT_HINT[t] || ''}"><td>${BLOCKS[t].name}</td><td>${f.count}${f.buried ? ` <small title="${t === BT.BAY ? 'no way out' : 'buried'}">(${f.buried} ${t === BT.BAY ? 'sealed' : 'buried'})</small>` : ''}</td><td>${shot}</td><td>${t === BT.BAY ? 'any' : f.range}</td></tr>`;
  }).join('') || '<tr><td colspan="4" style="color:var(--dim)">No weapons yet</td></tr>';
  $('stance-hint').textContent = STANCE_INFO[ed.stance].hint;
  $('place-hint').textContent = PLACE_INFO[ed.place][defenseMode() ? 'defHint' : 'hint'];
  const errs = [...a.errors], warns = [...a.warnings];
  if (defenseMode()) {
    const n = a.byType[BT.THRUSTER] || 0;
    if (n) errs.unshift(`Defences can't have thrusters: remove ${n === 1 ? 'the' : `all ${n}`} thruster${n > 1 ? 's' : ''}.`);
    for (let k = warns.length - 1; k >= 0; k--) if (warns[k].startsWith('No thrusters')) warns.splice(k, 1);
    warns.push('A defence never moves or turns: its front (the right-hand side here) always faces the enemy. Put the guns where you want them to fire, e.g. all facing front, or armour in front and guns on the sides to hit ships flying past.');
  }
  const items = [...errs.map((s) => `<li class="err">${s}</li>`), ...warns.map((s) => `<li class="warn">${s}</li>`)];
  $('issues').innerHTML = items.join('') || '<li class="ok">Ready for battle.</li>';
  $('test-btn').disabled = !a.ok;
  $('test-btn').title = a.ok ? '' : 'Fix the red issues first';
  syncEmbed();
  saveCurrent();
}

let saveTimer = 0;
function saveCurrent() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(CUR_KEY, encodeDesign(design)), 1000);
}

// What each weapon does, shown when hovering its row in the weapon table.
const SHOT_HINT = {
  [BT.LASER]: 'Always hits. The beam burns through blocks until its damage is spent, often into a second ship.',
  [BT.CANNON]: 'A slow shell aimed ahead of the target; damage splashes onto the blocks around the hit.',
  [BT.MISSILE]: 'Huge slow missile, flies over your own ships. Blast 9 blocks wide, strongest in the middle. Point defence can shoot it down.',
  [BT.GUIDED]: 'Like the missile launcher, but the missile steers after its target in flight. Point defence can shoot it down.',
  [BT.PD]: `Anti-missile: shoots down enemy missiles within ${WEAPON[BT.PD].range} blocks first (${WEAPON[BT.PD].missileDamage} a burst, a missile has ${WEAPON[BT.MISSILE].hp} hp), then enemy fighters (the best answer to carriers), then enemy hulls, ${WEAPON[BT.PD].damage} a burst, all within ${WEAPON[BT.PD].range}.`,
  [BT.LANCE]: `A blue plasma bolt that carves through ship after ship until its damage is spent.\n\n${PLASMA_WARNING}`,
  [BT.FLAK]: `A salvo of ${WEAPON[BT.FLAK].salvo} shells that burst beside the most lightly armoured enemy ship in range, each spraying ${WEAPON[BT.FLAK].fragments} pieces of shrapnel (${WEAPON[BT.FLAK].damage} each). Deadly to small ships and fighters, weak against heavy armour. Flak cannons spread their fire over many targets.`,
  [BT.BAY]: `${WEAPON[BT.BAY].waves[0]} fighters as the battle opens, then one every minute. Fighters circle enemy ships shooting them (${WEAPON[BT.BAY].fighter.damage} damage every ${WEAPON[BT.BAY].fighter.cooldown} s, range ${WEAPON[BT.BAY].fighter.range}), dogfight enemy fighters, and fly until shot down (${WEAPON[BT.BAY].fighter.hp} hp). Point defence shoots them first.`,
};

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

// Whole-grid bitmap, one pixel per cell: used when zoomed far out and for the minimap.
const bmp = document.createElement('canvas');
bmp.width = ed.w; bmp.height = ed.h;
const bg = bmp.getContext('2d');
const bimg = bg.createImageData(ed.w, ed.h), bpx = new Uint32Array(bimg.data.buffer);
const RGBA = new Uint32Array(16);
for (const [t, hex] of Object.entries(COLOR)) {
  const v = parseInt(hex.slice(1), 16);
  RGBA[t] = (255 << 24) | ((v & 255) << 16) | (((v >> 8) & 255) << 8) | (v >> 16); // little-endian ABGR
}
let bmpVersion = -1;
function updateBitmap() {
  if (bmpVersion === ed.version) return;
  bmpVersion = ed.version;
  const cells = ed.cells;
  for (let i = 0; i < cells.length; i++) bpx[i] = cells[i] ? RGBA[cells[i]] : 0;
  bg.putImageData(bimg, 0, 0);
}

const paths = {};
function draw() {
  const W = canvas.width, H = canvas.height, z = cam.zoom * dpr();
  g.clearRect(0, 0, W, H);
  // Visible cell range: only what's on screen is drawn, however big the grid is.
  const vx0 = Math.max(0, Math.floor(cam.x - W / 2 / z)), vx1 = Math.min(ed.w - 1, Math.ceil(cam.x + W / 2 / z));
  const vy0 = Math.max(0, Math.floor(cam.y - H / 2 / z)), vy1 = Math.min(ed.h - 1, Math.ceil(cam.y + H / 2 / z));
  // Build area and grid lines.
  g.fillStyle = 'rgba(134,170,220,0.035)';
  g.fillRect(sx(0), sy(0), ed.w * z, ed.h * z);
  if (z >= 6 && vx1 >= vx0 && vy1 >= vy0) {
    g.beginPath();
    for (let x = vx0; x <= vx1 + 1; x++) { g.moveTo(sx(x) + 0.5, sy(vy0)); g.lineTo(sx(x) + 0.5, sy(vy1 + 1)); }
    for (let y = vy0; y <= vy1 + 1; y++) { g.moveTo(sx(vx0), sy(y) + 0.5); g.lineTo(sx(vx1 + 1), sy(y) + 0.5); }
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

  // Blocks: far out, the whole grid is one scaled bitmap; closer in, one path per block type.
  const cells = ed.cells;
  if (z < 5) {
    updateBitmap();
    g.imageSmoothingEnabled = false;
    if (vx1 >= vx0 && vy1 >= vy0) g.drawImage(bmp, vx0, vy0, vx1 - vx0 + 1, vy1 - vy0 + 1, sx(vx0), sy(vy0), (vx1 - vx0 + 1) * z, (vy1 - vy0 + 1) * z);
  } else {
    const gap = z >= 8 ? Math.max(1, z * 0.06) : 0;
    for (const t in COLOR) paths[t] = new Path2D();
    for (let y = vy0; y <= vy1; y++)
      for (let x = vx0, i = y * ed.w + vx0; x <= vx1; x++, i++) {
        const t = cells[i];
        if (!t) continue;
        if (MULTIBLOCK[t]) paths[t].rect(sx(x) - 0.5, sy(y) - 0.5, z + 1, z + 1);
        else paths[t].rect(sx(x) + gap, sy(y) + gap, z - gap * 2, z - gap * 2);
      }
    for (const t in COLOR) { g.fillStyle = COLOR[t]; g.fill(paths[t]); }
    if (z >= 7)
      for (let y = vy0; y <= vy1; y++)
        for (let x = vx0, i = y * ed.w + vx0; x <= vx1; x++, i++) if (cells[i] && !MULTIBLOCK[cells[i]]) glyph(cells[i], sx(x), sy(y), z);
  }
  // Plasma cannons and fighter bays: one machine per unit (from the last analysis).
  if (info) {
    const ox = design.x0, oy = design.y0;
    const visible = (x0, y0, x1, y1) => x1 + ox >= vx0 && x0 + ox <= vx1 && y1 + oy >= vy0 && y0 + oy <= vy1;
    for (const w of info.weapons) {
      if (!w.group) continue;
      const gr = w.group;
      if (!visible(gr.x0, gr.y0, gr.x1, gr.y1)) continue;
      const x = sx(gr.x0 + ox), y = sy(gr.y0 + oy), ww = (gr.x1 - gr.x0 + 1) * z, hh = (gr.y1 - gr.y0 + 1) * z;
      if (gr.ok && ww > 12) (gr.type === BT.BAY ? bayUnit : gr.type === BT.FLAK ? flakUnit : plasmaUnit)(x, y, ww, hh, z);
      g.strokeStyle = gr.ok ? 'rgba(200,205,255,0.4)' : '#ff6b6b'; g.lineWidth = Math.max(1, dpr());
      g.strokeRect(x + 0.5, y + 0.5, ww - 1, hh - 1);
    }
    // Problems: loose blocks and buried weapons.
    g.fillStyle = 'rgba(255,80,80,0.45)';
    for (const c of info.loose) g.fillRect(sx((c % design.w) + ox), sy(((c / design.w) | 0) + oy), Math.max(z, 1), Math.max(z, 1));
    g.strokeStyle = '#ff6b6b'; g.lineWidth = Math.max(1.5, z * 0.12);
    for (const w of info.weapons) {
      if (!w.buried) continue;
      const x = sx(w.x - 0.5 + ox), y = sy(w.y - 0.5 + oy), m = z * 0.22, zz = Math.max(z, 6);
      g.beginPath(); g.moveTo(x + m, y + m); g.lineTo(x + zz - m, y + zz - m); g.moveTo(x + zz - m, y + m); g.lineTo(x + m, y + zz - m); g.stroke();
    }
    // Firing arcs: all of them, or just the weapon under the cursor.
    const hoverCell = hover ? ed.idx(hover[0], hover[1]) : -1;
    for (const w of info.weapons) {
      const at = ((w.y - 0.5 + oy) | 0) * ed.w + ((w.x - 0.5 + ox) | 0);
      const mine = w.group ? hover && hover[0] >= w.group.x0 + ox && hover[0] <= w.group.x1 + ox && hover[1] >= w.group.y0 + oy && hover[1] <= w.group.y1 + oy : at === hoverCell;
      if (!showArcs && !mine) continue;
      const wx = w.x + ox, wy = w.y + oy;
      if (!mine && (wx < vx0 - 20 || wx > vx1 + 20 || wy < vy0 - 20 || wy > vy1 + 20)) continue;
      if (w.route && !w.m0 && !w.m1) drawRoute(w.route, ox, oy, z, mine);
      else drawArc(w, sx(wx), sy(wy), z, mine);
    }
  }

  // Cursor preview (none when no block is selected, unless erasing a rectangle with a right drag).
  if (hover && !panning && !touchInspect && (block !== null || drag)) {
    const [hx, hy] = hover;
    if (drag && tool === 'rect') {
      const x0 = Math.min(drag.x, hx), y0 = Math.min(drag.y, hy), x1 = Math.max(drag.x, hx), y1 = Math.max(drag.y, hy);
      previewRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1, drag.type);
      if (ed.mirror) { const my0 = ed.mirrorY(y1), my1 = ed.mirrorY(y0); previewRect(x0, my0, x1 - x0 + 1, my1 - my0 + 1, drag.type, true); }
    } else if (block === null) {
      // right drag with nothing selected: nothing to preview until the rectangle starts
    } else if (MULTIBLOCK[block]) {
      const n = MULTIBLOCK[block].size, [x0, y0] = ShipEditor.stampOrigin(hx, hy, block);
      previewRect(x0, y0, n, n, block);
      if (ed.mirror) { const my0 = ed.mirrorY(y0 + n - 1); if (my0 >= y0 + n || my0 + n <= y0) previewRect(x0, my0, n, n, block, true); }
    } else {
      previewRect(hx, hy, 1, 1, block);
      if (ed.mirror && block !== BT.HUB && ed.mirrorY(hy) !== hy) previewRect(hx, ed.mirrorY(hy), 1, 1, block, true);
    }
  }
}

// Minimap: the whole build area with the visible part outlined. Click or drag to jump.
const mm = $('minimap'), mg = mm.getContext('2d');
function mmLayout() {
  const W = mm.width, H = mm.height, s = Math.min(W / ed.w, H / ed.h);
  return { s, ox: (W - ed.w * s) / 2, oy: (H - ed.h * s) / 2 };
}
function drawMinimap() {
  const d = Math.min(2, devicePixelRatio || 1);
  if (mm.width !== Math.round(mm.clientWidth * d)) { mm.width = Math.round(mm.clientWidth * d); mm.height = Math.round(mm.clientHeight * d); }
  updateBitmap();
  const { s, ox, oy } = mmLayout();
  mg.clearRect(0, 0, mm.width, mm.height);
  mg.fillStyle = 'rgba(134,170,220,0.06)'; mg.fillRect(ox, oy, ed.w * s, ed.h * s);
  mg.imageSmoothingEnabled = true; // averaging keeps thin hulls visible when shrunk
  mg.drawImage(bmp, ox, oy, ed.w * s, ed.h * s);
  const r = canvas.getBoundingClientRect(), vw = r.width / cam.zoom, vh = r.height / cam.zoom;
  mg.strokeStyle = 'rgba(230,238,255,0.9)'; mg.lineWidth = d;
  mg.strokeRect(ox + (cam.x - vw / 2) * s, oy + (cam.y - vh / 2) * s, vw * s, vh * s);
}
function minimapJump(e) {
  const r = mm.getBoundingClientRect(), d = mm.width / r.width, { s, ox, oy } = mmLayout();
  cam.x = ((e.clientX - r.left) * d - ox) / s; cam.y = ((e.clientY - r.top) * d - oy) / s;
  clampCam(); dirty = true;
}
mm.addEventListener('pointerdown', (e) => { mm.setPointerCapture(e.pointerId); minimapJump(e); });
mm.addEventListener('pointermove', (e) => { if (e.buttons) minimapJump(e); });

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

// Block details, drawn to match the replay viewer's look (fixed gun mounts, see renderer.js).
function glyph(t, x, y, z) {
  const c = z / 2, cx = x + c, cy = y + c;
  const circle = (r, fill) => { g.fillStyle = fill; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); };
  const ring = (r, w, stroke) => { g.strokeStyle = stroke; g.lineWidth = w; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); };
  if (t === BT.HUB) { circle(z * 0.34, 'rgba(255,255,255,0.35)'); circle(z * 0.18, '#ffffff'); }
  else if (t === BT.ARMOR) { // rivets in the corners
    g.fillStyle = 'rgba(255,255,255,0.22)';
    for (const [dx, dy] of [[0.17, 0.17], [0.83, 0.17], [0.17, 0.83], [0.83, 0.83]]) { g.beginPath(); g.arc(x + z * dx, y + z * dy, z * 0.055, 0, Math.PI * 2); g.fill(); }
  } else if (t === BT.HEAVY) { // raised inner plate in a groove
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x + z * 0.18, y + z * 0.18, z * 0.64, z * 0.64);
    g.fillStyle = 'rgba(255,255,255,0.09)'; g.fillRect(x + z * 0.24, y + z * 0.24, z * 0.52, z * 0.52);
  } else if (t === BT.FRAME) { // open truss
    g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = Math.max(1, z * 0.08);
    g.beginPath(); g.moveTo(x + z * 0.1, y + z * 0.1); g.lineTo(x + z * 0.9, y + z * 0.9); g.moveTo(x + z * 0.9, y + z * 0.1); g.lineTo(x + z * 0.1, y + z * 0.9); g.stroke();
  } else if (t === BT.THRUSTER) { ring(z * 0.3, Math.max(1, z * 0.1), 'rgba(200,210,225,0.55)'); circle(z * 0.2, '#ff8c3a'); circle(z * 0.09, '#ffe2b0'); }
  else if (t === BT.LASER) { // faceted crystal in a dark mount
    g.fillStyle = 'rgba(5,7,12,0.55)'; g.fillRect(x + z * 0.1, y + z * 0.1, z * 0.8, z * 0.8);
    g.fillStyle = '#e6f7ff'; g.beginPath(); g.moveTo(cx, y + z * 0.16); g.lineTo(x + z * 0.84, cy); g.lineTo(cx, y + z * 0.84); g.lineTo(x + z * 0.16, cy); g.fill();
    g.fillStyle = 'rgba(120,200,255,0.55)'; g.beginPath(); g.moveTo(cx, cy); g.lineTo(x + z * 0.84, cy); g.lineTo(cx, y + z * 0.84); g.fill();
  } else if (t === BT.CANNON) { ring(z * 0.36, Math.max(1, z * 0.12), 'rgba(235,240,248,0.75)'); circle(z * 0.3, '#07090d'); circle(z * 0.1, 'rgba(255,120,40,0.45)'); }
  else if (t === BT.PD) { // sensor dish: rings, crosshair, red eye
    ring(z * 0.31, Math.max(1, z * 0.06), 'rgba(255,220,220,0.6)'); ring(z * 0.19, Math.max(1, z * 0.06), 'rgba(255,220,220,0.6)');
    g.strokeStyle = 'rgba(255,220,220,0.45)'; g.beginPath(); g.moveTo(cx - z * 0.31, cy); g.lineTo(cx + z * 0.31, cy); g.moveTo(cx, cy - z * 0.31); g.lineTo(cx, cy + z * 0.31); g.stroke();
    circle(z * 0.08, '#ff3b30');
  } else if (t === BT.MISSILE || t === BT.GUIDED) { // four tubes inside hazard stripes (guided: a green seeker eye in the middle)
    g.save(); g.beginPath(); g.rect(x, y, z, z); g.rect(x + z * 0.16, y + z * 0.16, z * 0.68, z * 0.68); g.clip('evenodd');
    g.strokeStyle = 'rgba(10,10,10,0.6)'; g.lineWidth = Math.max(1, z * 0.1);
    for (let k = -1; k <= 3; k++) { g.beginPath(); g.moveTo(x + k * z * 0.3, y + z); g.lineTo(x + k * z * 0.3 + z, y); g.stroke(); }
    g.restore();
    g.fillStyle = 'rgba(5,7,12,0.75)';
    for (const [dx, dy] of [[0.33, 0.33], [0.67, 0.33], [0.33, 0.67], [0.67, 0.67]]) { g.beginPath(); g.arc(x + z * dx, y + z * dy, z * 0.12, 0, Math.PI * 2); g.fill(); }
    if (t === BT.GUIDED) { circle(z * 0.11, 'rgba(5,7,12,0.85)'); circle(z * 0.07, '#5dff9a'); }
  }
}

/** A fighter bay: a dark hangar deck in a hazard-striped frame, a small fighter on its pad, landing lights. */
function bayUnit(x, y, ww, hh, z) {
  const cx = x + ww / 2, cy = y + hh / 2, R = Math.min(ww, hh), f = R * 0.12;
  g.fillStyle = '#d2a93a'; g.fillRect(x, y, ww, hh);
  g.save(); g.beginPath(); g.rect(x, y, ww, hh); g.clip();
  g.strokeStyle = '#1d2026'; g.lineWidth = R * 0.07;
  for (let k = -3; k <= 3; k++) { g.beginPath(); g.moveTo(x + ww * (k / 3), y + hh); g.lineTo(x + ww * (k / 3 + 1), y); g.stroke(); }
  g.restore();
  g.fillStyle = '#23272e'; g.fillRect(x + f, y + f, ww - 2 * f, hh - 2 * f);
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
  for (let k = 1; k < 3; k++) { g.beginPath(); g.moveTo(x + f, y + (hh * k) / 3); g.lineTo(x + ww - f, y + (hh * k) / 3); g.stroke(); }
  // the fighter on its pad, nose forward (+x)
  g.fillStyle = '#c9d2de';
  g.beginPath(); g.moveTo(cx + R * 0.2, cy); g.lineTo(cx - R * 0.14, cy - R * 0.15); g.lineTo(cx - R * 0.07, cy); g.lineTo(cx - R * 0.14, cy + R * 0.15); g.closePath(); g.fill();
  g.fillStyle = '#ffb347';
  for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) { g.beginPath(); g.arc(x + ww * dx, y + hh * dy, R * 0.035, 0, Math.PI * 2); g.fill(); }
}

/** A flak cannon unit: gunmetal deck in an armoured rim, a turret ring with four big barrels, ammunition feeds, amber lights. */
function flakUnit(x, y, ww, hh, z) {
  const cx = x + ww / 2, cy = y + hh / 2, R = Math.min(ww, hh);
  g.fillStyle = '#4a463d'; g.fillRect(x, y, ww, hh);
  g.fillStyle = '#5d584c'; g.fillRect(x + R * 0.06, y + R * 0.06, ww - R * 0.12, hh - R * 0.12);
  g.strokeStyle = '#3a372f'; g.lineWidth = R * 0.05; g.lineCap = 'round';
  for (const [ex, ey] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) { g.beginPath(); g.moveTo(x + ww * ex, y + hh * ey); g.lineTo(cx, cy); g.stroke(); }
  g.lineCap = 'butt';
  g.fillStyle = '#7a7466'; g.beginPath(); g.arc(cx, cy, R * 0.32, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#b8b09c'; g.lineWidth = R * 0.025; g.beginPath(); g.arc(cx, cy, R * 0.32, 0, Math.PI * 2); g.stroke();
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const bx = cx + dx * R * 0.12, by = cy + dy * R * 0.12;
    g.fillStyle = '#c9c1ab'; g.beginPath(); g.arc(bx, by, R * 0.085, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#17181b'; g.beginPath(); g.arc(bx, by, R * 0.06, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#ffa646';
  for (const [dx, dy] of [[0.11, 0.11], [0.89, 0.11], [0.11, 0.89], [0.89, 0.89]]) { g.beginPath(); g.arc(x + ww * dx, y + hh * dy, R * 0.025, 0, Math.PI * 2); g.fill(); }
}

/** A plasma cannon unit, drawn as one machine: housing, corner machinery, pipes into a blue orb. */
function plasmaUnit(x, y, ww, hh, z) {
  const cx = x + ww / 2, cy = y + hh / 2, R = Math.min(ww, hh);
  g.fillStyle = '#23283f'; g.fillRect(x, y, ww, hh);
  g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
  for (let k = 1; k < 5; k++) { g.beginPath(); g.moveTo(x + (ww * k) / 5, y); g.lineTo(x + (ww * k) / 5, y + hh); g.moveTo(x, y + (hh * k) / 5); g.lineTo(x + ww, y + (hh * k) / 5); g.stroke(); }
  g.fillStyle = '#3a4160';
  for (const [dx, dy] of [[0.04, 0.04], [0.8, 0.04], [0.04, 0.8], [0.8, 0.8]]) g.fillRect(x + ww * dx, y + hh * dy, ww * 0.16, hh * 0.16);
  g.lineCap = 'round';
  for (const [ex, ey] of [[0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) {
    g.strokeStyle = '#8f98b8'; g.lineWidth = R * 0.05;
    g.beginPath(); g.moveTo(x + ww * ex, y + hh * ey); g.lineTo(cx, cy); g.stroke();
    g.strokeStyle = '#4f9dff'; g.lineWidth = R * 0.018;
    g.beginPath(); g.moveTo(x + ww * ex, y + hh * ey); g.lineTo(cx, cy); g.stroke();
  }
  g.lineCap = 'butt';
  g.strokeStyle = '#a9b2d0'; g.lineWidth = R * 0.03; g.beginPath(); g.arc(cx, cy, R * 0.215, 0, Math.PI * 2); g.stroke();
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.17);
  grad.addColorStop(0, '#f4fbff'); grad.addColorStop(0.45, '#7fc8ff'); grad.addColorStop(1, '#2a5fd8');
  g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, R * 0.17, 0, Math.PI * 2); g.fill();
}

// A fighter bay's way out along a tunnel with corners: a dashed line with an arrow at the exit.
function drawRoute(pts, ox, oy, z, strong) {
  g.lineWidth = Math.max(2, z * 0.25);
  g.strokeStyle = strong ? 'rgba(255,179,92,0.95)' : 'rgba(255,179,92,0.45)';
  g.setLineDash([Math.max(4, z * 0.6), Math.max(3, z * 0.4)]);
  g.beginPath();
  for (let k = 0; k < pts.length; k += 2) { const x = sx(pts[k] + ox), y = sy(pts[k + 1] + oy); if (k) g.lineTo(x, y); else g.moveTo(x, y); }
  g.stroke();
  g.setLineDash([]);
  const n = pts.length, x1 = sx(pts[n - 2] + ox), y1 = sy(pts[n - 1] + oy), a = Math.atan2(pts[n - 1] - pts[n - 3], pts[n - 2] - pts[n - 4]), L = Math.max(8, z * 1.2);
  g.fillStyle = g.strokeStyle;
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - Math.cos(a - 0.45) * L, y1 - Math.sin(a - 0.45) * L); g.lineTo(x1 - Math.cos(a + 0.45) * L, y1 - Math.sin(a + 0.45) * L); g.closePath(); g.fill();
}

function drawArc(w, x, y, z, strong) {
  // Direction only: real ranges (30 to 700 blocks) dwarf the ship, so arcs are drawn short.
  // A heavy laser's arc starts at the edge of its 10x10 unit, so draw it well past that.
  const R = w.group ? (w.group.x1 - w.group.x0 + 1) * z * (strong ? 1.6 : 1.2)
    : Math.min(110 * dpr(), Math.max(28 * dpr(), (strong ? 4 : 2.5) * z));
  g.lineWidth = Math.max(1, dpr());
  if (w.buried) return;
  if (w.omni) {
    g.setLineDash([4 * dpr(), 4 * dpr()]);
    g.strokeStyle = strong ? 'rgba(255,179,92,0.9)' : 'rgba(255,179,92,0.35)';
    g.beginPath(); g.arc(x, y, R * (w.group ? 1.6 : 0.8), 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    return;
  }
  // Draw each run of open directions as one wedge.
  const half = Math.PI / ARC_BINS;
  g.fillStyle = strong ? 'rgba(134,232,255,0.16)' : 'rgba(134,232,255,0.06)';
  g.strokeStyle = strong ? 'rgba(134,232,255,0.8)' : 'rgba(134,232,255,0.22)';
  for (const [k0, k1] of openRuns(w)) {
    g.beginPath(); g.moveTo(x, y); g.arc(x, y, R, binAngle(k0) - half, binAngle(k1) + half); g.closePath();
    g.fill(); g.stroke();
  }
}

/** Runs of consecutive open slices [first, last] (last may exceed ARC_BINS when a run wraps). */
function openRuns(w) {
  const open = (k) => binOpen(w.m0, w.m1, ((k % ARC_BINS) + ARC_BINS) % ARC_BINS);
  let start = 0;
  while (start < ARC_BINS && open(start)) start++; // begin just after a closed slice
  const runs = [];
  for (let i = 1; i <= ARC_BINS; i++) {
    const k = start + i;
    if (!open(k)) continue;
    let e = k;
    while (e + 1 <= start + ARC_BINS && open(e + 1)) e++;
    runs.push([k, e]); i = e - start;
  }
  return runs;
}

/** Middle direction of the widest open run, as a compass word. */
function mainSide(w) {
  let best = null;
  for (const r of openRuns(w)) if (!best || r[1] - r[0] > best[1] - best[0]) best = r;
  if (!best) return '';
  const a = (binAngle(best[0]) + binAngle(best[1])) / 2;
  return SIDES[(Math.round(Math.atan2(Math.sin(a), Math.cos(a)) / (Math.PI / 4)) + 8) % 8];
}

// ------------------------------------------------------------ hover readout
const SIDES = ['forward', 'forward-starboard', 'starboard', 'aft-starboard', 'aft', 'aft-port', 'port', 'forward-port'];
function describe(x, y) {
  const i = ed.idx(x, y), t = i < 0 ? 0 : ed.cells[i];
  if (!t) return `${x}, ${y}`;
  let s = `${BLOCKS[t].name} · ${BLOCKS[t].hp} hp · ${MULTIBLOCK[t] ? BLOCKS[t].cost * MULTIBLOCK[t].size ** 2 + ' cr (unit)' : BLOCKS[t].cost + ' cr'}`;
  if (info && design) {
    const ox = design.x0, oy = design.y0;
    const w = info.weapons.find((v) => v.group ? v.group.cells.some((c) => (c % design.w) + ox === x && ((c / design.w) | 0) + oy === y) : (v.x - 0.5 + ox) === x && (v.y - 0.5 + oy) === y);
    if (w) {
      if (w.buried) s += w.type === BT.BAY ? ' · sealed in: no way out for its fighters' : ' · buried: every shot would hit your own hull';
      else if (w.omni) s += ' · fires in any direction';
      else if (w.route && !w.m0 && !w.m1) s += ` · fighters taxi out along a ${Math.round(routeLength(w.route))}-block tunnel`;
      else s += w.type === BT.BAY ? ` · fighters launch through ${Math.round(w.arcDeg)}°, mainly ${mainSide(w)}` : ` · ${Math.round(w.arcDeg)}° arc, mainly ${mainSide(w)}`;
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
  cam.zoom = Math.max(MIN_ZOOM, Math.min(48, cam.zoom * k));
  cam.x = wx - px / cam.zoom; cam.y = wy - py / cam.zoom;
  clampCam(); dirty = true;
}
const MIN_ZOOM = 0.15;
/** Keep the view over the build area: its centre never leaves the grid, so you can't get lost. */
function clampCam() {
  cam.x = Math.min(ed.w, Math.max(0, cam.x));
  cam.y = Math.min(ed.h, Math.max(0, cam.y));
}
function panBy(dxPx, dyPx) { cam.x += dxPx / cam.zoom; cam.y += dyPx / cam.zoom; clampCam(); dirty = true; }

function fit() {
  refresh(true);
  const r = canvas.getBoundingClientRect();
  const has = info && info.blocks > 1;
  const w = has ? design.w : 24, h = has ? design.h : 16;
  cam.x = (has ? design.x0 : ed.w / 2 - 12) + w / 2;
  cam.y = (has ? design.y0 : ed.h / 2 - 8) + h / 2;
  cam.zoom = Math.max(MIN_ZOOM, Math.min(40, Math.min((r.width - 90) / w, (r.height - 60) / h) * 0.9));
  clampCam(); dirty = true;
}

// Paint along a line between two cells so fast strokes don't leave gaps.
function strokeTo(x, y, type) {
  if (!last) { ed.paint(x, y, type); last = [x, y]; return; }
  let [x0, y0] = last;
  const dx = Math.abs(x - x0), dy = -Math.abs(y - y0), stx = x0 < x ? 1 : -1, sty = y0 < y ? 1 : -1;
  let err = dx + dy;
  for (let n = 0; n < 8192; n++) {
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
    if (drag && drag.started) ed.cancelStep();
    drag = null; panning = true;
    return;
  }
  if (e.button === 1 || spaceDown || (tool === 'pan' && e.button === 0)) { panning = true; canvas.style.cursor = 'grabbing'; return; }
  const [x, y] = toCell(e.clientX, e.clientY);
  if (e.button === 2 && tool === 'pan' && ed.get(x, y)) {
    // With the Hand tool, right-clicking the ship goes back to building (it doesn't erase).
    setTool('pencil'); if (block === null) setBlock(BT.ARMOR);
    toast('Back to building.');
    return;
  }
  if (e.button === 2 && !ed.get(x, y)) {
    // Right-click on an empty cell picks the Hand tool, and dragging moves the view. Picking a
    // block from the palette (or B / R / F) goes back to building.
    if (tool !== 'pan') { setTool('pan'); toast('Hand tool: drag to move around. Pick a block (or press B) to build again.'); }
    panning = true; canvas.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 2 && block === null) { toast('No block selected: pick one from the palette (or press 1–0).'); return; }
  const type = e.button === 2 ? 0 : block;
  drag = { x, y, type, started: false };
  last = null;
  if (tool === 'pencil' || MULTIBLOCK[type] || type === BT.HUB) {
    ed.checkpoint(); drag.started = true;
    if (MULTIBLOCK[type]) { if (!ed.stamp(x, y, type)) toast(type === BT.BAY ? `A fighter bay needs a clear ${MULTIBLOCK[type].size}×${MULTIBLOCK[type].size} space inside the grid, away from the hub.` : `A ${type === BT.FLAK ? 'flak' : 'plasma'} cannon needs a clear 10×10 space inside the grid, away from the hub.`); drag.once = true; }
    else if (type === BT.HUB) { ed.setCell(x, y, BT.HUB); drag.once = true; }
    else strokeTo(x, y, type);
  } else if (tool === 'fill') {
    ed.checkpoint();
    if (!ed.fill(x, y, type)) { ed.cancelStep(); toast(ed.get(x, y) ? 'Nothing to fill there.' : 'Fill only works inside a closed outline.'); }
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
      panBy(-(m1x - m0x), -(m1y - m0y));
      if (d0 > 0) zoomAt(m1x, m1y, d1 / d0);
    } else {
      panBy(-(e.clientX - p.x), -(e.clientY - p.y));
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
  if (panning) { if (!pointers.size) { panning = false; canvas.style.cursor = tool === 'pan' || spaceDown ? 'grab' : ''; } return; }
  if (drag && tool === 'rect' && !drag.started && hover) {
    ed.checkpoint();
    ed.rect(drag.x, drag.y, hover[0], hover[1], drag.type);
  }
  drag = null; last = null; dirty = true;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { if (!drag && !touchInspect) { hover = null; $('hover').hidden = true; dirty = true; } });

// Touch screens have no hover, so with the Hand tool a tap on a cell shows what the mouse
// would show there (the readout and, for a gun, its firing arc) until the next touch.
let tapStart = null;
canvas.addEventListener('pointerdown', (e) => {
  touchInspect = false;
  tapStart = e.pointerType === 'touch' && tool === 'pan' && pointers.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
});
canvas.addEventListener('pointerup', (e) => {
  if (!tapStart || tapStart.id !== e.pointerId) return;
  const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 8;
  tapStart = null;
  if (moved) return;
  const [x, y] = toCell(e.clientX, e.clientY), el = $('hover');
  if (x < 0 || y < 0 || x >= ed.w || y >= ed.h) return;
  hover = [x, y]; touchInspect = true; dirty = true;
  el.textContent = describe(x, y); el.hidden = false;
});

// Phones: the stats sit behind the Stats button and open over the grid.
$('stats-btn').addEventListener('click', () => {
  const on = $('app').classList.toggle('show-stats');
  $('stats-btn').setAttribute('aria-pressed', String(on));
});
if (matchMedia('(pointer: coarse)').matches && !store.get('lsb.designer.touchhint.v1', false)) {
  store.set('lsb.designer.touchhint.v1', true);
  setTimeout(() => toast('One finger draws. Two fingers move and zoom. Pick Erase to remove blocks, and the Hand tool to tap a block and see what it does.', 9000), 600);
}
// The mouse wheel (and a trackpad pinch) zooms towards the cursor. Moving around is WASD /
// arrow keys, the Hand tool, Space + drag, middle drag or the minimap.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
  const pinch = e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50; // trackpad pinch: small, precise steps
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * (pinch ? 0.01 : 0.0015)));
}, { passive: false });

// WASD and the arrow keys move the view smoothly while held (Shift for faster).
const held = new Set();
const PAN_KEYS = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0], arrowup: [0, -1], arrowleft: [-1, 0], arrowdown: [0, 1], arrowright: [1, 0] };
let panT = 0, fast = false;
function keyPan(now) {
  const dt = panT ? Math.min(0.05, (now - panT) / 1000) : 0;
  panT = held.size ? now : 0;
  if (!held.size || !dt) return;
  let vx = 0, vy = 0;
  for (const k of held) { vx += PAN_KEYS[k][0]; vy += PAN_KEYS[k][1]; }
  const speed = (fast ? 2400 : 900) * dt; // screen pixels per second
  if (vx || vy) panBy(vx * speed, vy * speed);
}
addEventListener('blur', () => held.clear());
const zoomCentre = (k) => { const r = canvas.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, k); };
$('zoom-in').addEventListener('click', () => zoomCentre(1.5));
$('zoom-out').addEventListener('click', () => zoomCentre(1 / 1.5));
$('zoom-fit').addEventListener('click', fit);

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); (e.shiftKey ? ed.redo() : ed.undo()) && syncFields(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); ed.redo() && syncFields(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveToLibrary(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault(); return; }
  if (PAN_KEYS[k]) { e.preventDefault(); held.add(k); fast = e.shiftKey; return; }
  if (e.key === '+' || e.key === '=') return zoomCentre(1.4);
  if (e.key === '-' || e.key === '_') return zoomCentre(1 / 1.4);
  if (k === 'h') return setTool('pan');
  const p = PALETTE.find(([, key]) => key === k);
  if (p) return setBlock(p[0]);
  if (k === 'b') setTool('pencil');
  if (k === 'r') setTool('rect');
  if (k === 'f') setTool('fill');
  if (k === 'm') { ed.mirror = !ed.mirror; syncMirror(); dirty = true; }
  if (k === 'q') { showArcs = !showArcs; syncArcs(); dirty = true; }
  if (e.key === 'Escape' && block !== null) setBlock(null);
});
addEventListener('keyup', (e) => {
  held.delete(e.key.toLowerCase()); fast = e.shiftKey;
  if (e.code === 'Space') { spaceDown = false; canvas.style.cursor = tool === 'pan' ? 'grab' : ''; }
});

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
    item.querySelector('[data-act=load]').addEventListener('click', () => { ed.load(d); syncFields(); fit(); $('library').close(); toast(`Loaded “${d.name}”.`); dropThrusters(); });
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
  try { const d = decodeDesign(JSON.parse(await f.text())); ed.load(d); syncFields(); fit(); toast(`Imported “${d.name}”.`); dropThrusters(); }
  catch (err) { toast(`Couldn't import: ${err.message}`); }
});

// ------------------------------------------------------------ test battle
let lastReplay = null;
// Designs you can add to your own side (owner, Nov 2026): yours in this game, your saved library,
// and the samples. Each is { label, get() -> design, fixed }. Built when the dialog opens.
let sideChoices = [];
function buildSideChoices() {
  sideChoices = [];
  (embed?.designs || []).forEach((o) => {
    if (!o.mine) return;
    try { const d = { ...decodeDesign(o.data), name: o.name }; if (analyzeDesign(d).ok) sideChoices.push({ label: `${o.defence ? 'Your defence' : 'Your ship'}: ${o.name} (${fmt(designCost(d))} cr)`, get: () => d, fixed: !!o.defence }); } catch { /* skip */ }
  });
  library().forEach((o) => { try { const d = decodeDesign(o); if (analyzeDesign(d).ok) sideChoices.push({ label: `Saved: ${d.name} (${fmt(designCost(d))} cr)`, get: () => d, fixed: false }); } catch { /* skip */ } });
  for (const cls of Object.keys(CLASSES)) { let d = null; sideChoices.push({ label: `Sample ${cls}`, get: () => (d ||= { ...makeDesign(cls, 7), name: `Sample ${cls}` }), fixed: false }); }
}
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const classOf = (d) => analyzeDesign(d).hullClass?.id || d.cls;
function addSideRow(pick = 0) {
  const row = document.createElement('div');
  row.className = 't-extra';
  const sel = document.createElement('select');
  sideChoices.forEach((c, k) => sel.add(new Option(c.label, String(k))));
  sel.value = String(pick);
  const n = document.createElement('input');
  n.type = 'number'; n.min = '0'; n.max = '400'; n.title = 'How many';
  const setDefault = () => { n.value = DEFAULT_COPIES[classOf(sideChoices[Number(sel.value)].get())] ?? 10; };
  setDefault();
  sel.addEventListener('change', setDefault);
  const del = document.createElement('button');
  del.type = 'button'; del.textContent = '✕'; del.title = 'Remove';
  del.addEventListener('click', () => row.remove());
  row.append(sel, n, del);
  $('t-extras').append(row);
}
$('t-add').addEventListener('click', () => addSideRow());
function sideExtras() {
  return [...$('t-extras').children].map((row) => {
    const c = sideChoices[Number(row.querySelector('select').value)];
    const count = Math.max(0, Math.min(400, Math.floor(Number(row.querySelector('input').value) || 0)));
    return c && count ? { design: { ...c.get() }, count, fixed: c.fixed } : null;
  }).filter(Boolean);
}
function openTest() {
  refresh();
  if (!info.ok) return;
  $('t-copies').value = DEFAULT_COPIES[design.cls] ?? 10;
  const opp = $('t-opp');
  opp.innerHTML = '';
  opp.add(new Option('Mixed fleet (generated sample ships)', ''));
  opp.add(new Option('A copy of this design', 'self'));
  // Opened from the galaxy: the ships really in play there, yours and everyone else's.
  (embed?.designs || []).forEach((o, k) => {
    try { const d = decodeDesign(o.data); if (analyzeDesign(d).ok) opp.add(new Option(`In this game: ${o.name} (${o.mine ? 'yours' : o.owner}, ${fmt(designCost(d))} cr)`, `g${k}`)); } catch { /* skip */ }
  });
  library().forEach((o, k) => { try { const d = decodeDesign(o); if (analyzeDesign(d).ok) opp.add(new Option(`Saved: ${d.name} (${fmt(designCost(d))} cr)`, String(k))); } catch { /* skip */ } });
  // Keep the rows you added last time (same choices list), but refresh it in case designs changed.
  const keep = [...$('t-extras').children].map((row) => [sideChoices[Number(row.querySelector('select').value)]?.label, row.querySelector('input').value]);
  buildSideChoices();
  $('t-extras').innerHTML = '';
  for (const [label, count] of keep) { const k = sideChoices.findIndex((c) => c.label === label); if (k >= 0) { addSideRow(k); $('t-extras').lastChild.querySelector('input').value = count; } }
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
  const opponent = v === 'self' ? { ...mine } : v.startsWith('g') ? { ...decodeDesign(embed.designs[Number(v.slice(1))].data), name: embed.designs[Number(v.slice(1))].name } : v ? decodeDesign(library()[Number(v)]) : null;
  const extras = sideExtras();
  const scen = makeTestScenario(mine, copies, opponent, seed, defenseMode(), extras); // defences stand in rows and hold still, front to the enemy
  const b = new Battle({ designs: scen.designs, ships: scen.ships, seed, maxTime: BATTLE_MAX_TIME }); // same limit as real battles
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
  lastReplay = { bytes: packReplay(rep.meta, rep.cols), computeMs, sides: [extras.length ? 'Your fleet' : mine.name, opponent ? opponent.name : 'Mixed fleet'] };
  // With extras on your side, a line per design: how many started, survived and were lost.
  let perDesign = '';
  if (extras.length) {
    const rows = Array.from({ length: scen.mineDesigns }, () => ({ n: 0, alive: 0, value: 0, lost: 0 }));
    scen.ships.forEach((sh, k) => {
      if (sh.team !== 0) return;
      const e = b.byId[k], c = designCost(scen.designs[sh.design]), out = e.dead || e.hubDead || !e.weapons.length, r = rows[sh.design];
      r.n++; r.value += c; if (out) r.lost += c; else r.alive++;
    });
    perDesign = rows.map((r, k) => r.n ? `<tr><td class="sub">${escapeHtml(scen.designs[k].name || 'Your design')}</td><td>${r.n}</td><td>${r.alive}</td><td>${fmt(r.value)}</td><td>${fmt(r.lost)} (${Math.round((r.lost / r.value) * 100)}%)</td></tr>` : '').join('');
  }
  const verdict = s.winner === 0 ? ['win', 'Victory'] : s.winner === 1 ? ['loss', 'Defeat'] : ['', 'Draw'];
  const pct = (k) => `${Math.round((s.lost[k] / s.start[k]) * 100)}%`;
  $('test-result').innerHTML = `
    <div class="verdict ${verdict[0]}">${verdict[1]}</div>
    <table>
      <thead><tr><th></th><th>Ships</th><th>Survived</th><th>Fleet value</th><th>Lost</th></tr></thead>
      <tbody>
        <tr><td>You</td><td>${s.startCount[0]}</td><td>${s.alive[0]}</td><td>${fmt(s.start[0])}</td><td>${fmt(s.lost[0])} (${pct(0)})</td></tr>${perDesign}
        <tr><td>Enemy</td><td>${s.startCount[1]}</td><td>${s.alive[1]}</td><td>${fmt(s.start[1])}</td><td>${fmt(s.lost[1])} (${pct(1)})</td></tr>
      </tbody>
    </table>
    <p class="hint">Battle lasted ${s.seconds.toFixed(0)} s. Ships that lost every weapon count as lost. Try a few seeds: one battle can be luck.</p>`;
  $('test-result').hidden = false; $('test-progress').hidden = true; $('t-watch').hidden = false;
});

// The replay viewer page is built into this page (tools/build-viewer.mjs injects it), so the
// test battle plays in an overlay: no second file, no pop-up window.
/* global __VIEWER_PAGE__ */
const VIEWER_PAGE = typeof __VIEWER_PAGE__ === 'string' ? __VIEWER_PAGE__ : '';
$('t-watch').addEventListener('click', () => {
  if (!lastReplay) return;
  if (!VIEWER_PAGE) return toast('This build has no replay viewer. Run npm run build.');
  const frame = $('replay-frame');
  const send = (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'lsb-viewer-ready') return;
    removeEventListener('message', send);
    const copy = lastReplay.bytes.slice();
    frame.contentWindow.postMessage({ type: 'lsb-replay', bytes: copy.buffer, computeMs: lastReplay.computeMs, sides: lastReplay.sides }, '*', [copy.buffer]);
  };
  addEventListener('message', send);
  $('test').close();
  $('replay').hidden = false;
  frame.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">${VIEWER_PAGE}</body></html>`;
});
$('replay-close').addEventListener('click', () => {
  $('replay').hidden = true;
  $('replay-frame').srcdoc = ''; // stop rendering and free the replay
  $('test').showModal();
});

// ------------------------------------------------------------ shipyard mode
// The galaxy map opens this page in an overlay to design the ship a new shipyard will build.
// It sends { type: 'lsb-designer-embed', planet, existing, credits, yards } (existing is the list
// value of the shipyards already on that world, which sets the crowding surcharge); "Build shipyard" posts the design back as { type: 'lsb-design-chosen' }.
let embed = null;
/** Opened from the galaxy to design a defence (no thrusters, never moves) rather than a shipyard's ship. */
const defenseMode = () => embed?.mode === 'defense';
let defenseShown = false;
/** In the defence designer, take every thruster off the design (after loading or importing one). */
function dropThrusters() {
  if (!defenseMode()) return 0;
  const n = ed.removeType(BT.THRUSTER);
  if (n) toast(`Removed ${n} thruster${n === 1 ? '' : 's'}: defences never move. Undo puts them back.`);
  return n;
}
/** Opened from the galaxy as the defence designer: rename the page, grey out thrusters, own memory. */
function enterDefenseMode() {
  document.title = 'Defence Designer';
  $('brand-name').textContent = 'Defence Designer';
  $('brand-sub').textContent = 'Build it block by block. Defences never move, so no thrusters.';
  $('cost-label').textContent = 'Block price';
  $('t-copies-label').textContent = 'Your defences';
  $('t-hint').textContent = 'Your defences stand in staggered rows, fronts toward the enemy, exactly as at a real world, against an enemy fleet worth the same number of credits (at full block price). Real battle sim.';
  const tb = document.querySelector(`.blk[data-block="${BT.THRUSTER}"]`);
  if (tb) { tb.disabled = true; tb.title = "Thrusters: not allowed on defences. A defence never moves."; }
  if (block === BT.THRUSTER) setBlock(BT.ARMOR);
  // Your last defence if you have one, otherwise the design on screen with its thrusters taken off.
  clearTimeout(saveTimer);
  CUR_KEY = DEF_CUR_KEY;
  const saved = store.get(DEF_CUR_KEY, null);
  let loaded = false;
  if (saved) { try { const d = decodeDesign(saved); if (d.cells.some((c) => c && c !== BT.HUB)) { ed.load(d); ed.resetHistory(); loaded = true; } } catch { /* use the one on screen */ } }
  if (loaded) { syncFields(); fit(); dropThrusters(); } else { ed.removeType(BT.THRUSTER); ed.resetHistory(); }
}
const simMode = () => embed?.mode === 'sim';
let simShown = false;
/** Opened from the galaxy's Battle simulator button: no shipyard to build, straight into a test battle. */
function enterSimMode() {
  refresh(true);
  // A blank design can't fight: start the simulator from a sample destroyer instead.
  if (!design || !info.ok || !info.weapons.length) { ed.load({ ...makeDesign('destroyer', 7), name: 'Sample destroyer' }); ed.resetHistory(); syncFields(); fit(); refresh(true); }
  document.querySelector('#test h3').textContent = 'Battle simulator';
  $('t-hint').textContent = 'Battle simulator: your side is the design on screen (pick another from Start from, or build one) plus anything you add below; the enemy is worth the same number of credits. Real battle sim, nothing is spent.';
  openTest();
}
function syncEmbed() {
  if (!embed || !design) return;
  if (simMode()) { $('use-design').hidden = true; return; }
  if (defenseMode()) {
    const price = defensePrice(design), thr = info.byType[BT.THRUSTER] || 0;
    const b = $('use-design');
    b.hidden = false;
    b.textContent = `Build defence · ${fmt(price)} cr`;
    b.disabled = !info.ok || thr > 0 || price > embed.credits;
    b.title = !info.ok || thr ? 'Fix the red issues first' : price > embed.credits ? `You have ${fmt(embed.credits)} credits` : `Build one of these defences at ${embed.planet} (build more from the Build defences list)`;
    $('yard-label').textContent = 'Defence';
    $('yard').textContent = fmt(price);
    $('yard-hint').textContent = `At ${embed.planet}: takes ${DEFENSE_BUILD_HOURS} hours to build and costs ${Math.round(DEFENSE_PRICE_SHARE * 100)}% of the blocks' price. It never moves, and when it's destroyed it's gone.`;
    $('stance-row').hidden = true; $('stance-hint').hidden = true; $('stance-head').hidden = true;
    return;
  }
  const price = shipyardPriceAt(design, embed.existing || 0), extra = crowdingSurcharge(shipyardPrice(design), embed.existing || 0);
  const b = $('use-design');
  b.hidden = false;
  b.textContent = `Build shipyard · ${fmt(price)} cr`;
  b.disabled = !info.ok || price > embed.credits;
  b.title = !info.ok ? 'Fix the red issues first' : price > embed.credits ? `You have ${fmt(embed.credits)} credits` : `Build a shipyard for this design at ${embed.planet}`;
  $('yard').textContent = fmt(price);
  $('yard-hint').textContent = extra
    ? `At ${embed.planet}: list price ${fmt(shipyardPrice(design))} cr + ${fmt(extra)} cr (+${Math.round((extra / shipyardPrice(design)) * 100)}%) for the ${fmt(embed.existing)} cr of shipyards already there. Builds one ship free every ${SHIPYARD_INTERVAL_MIN} min.`
    : `At ${embed.planet}: builds one ship free every ${SHIPYARD_INTERVAL_MIN} min until the world falls. Each shipyard on a world makes the next one there a little dearer.`;
}
if (window.parent !== window) {
  addEventListener('message', (e) => {
    if (e.source !== window.parent || e.data?.type !== 'lsb-designer-embed') return;
    if (e.data.designs && !embed?.designs?.length) addYardTemplates(e.data.designs, e.data.mode === 'defense');
    embed = { ...e.data, designs: e.data.designs || embed?.designs || [] }; // designs come with the first message only
    $('test-btn').classList.remove('go');
    if (defenseMode()) addFortressTemplates();
    if (defenseMode() && !defenseShown) { defenseShown = true; enterDefenseMode(); seenVersion = -1; refresh(true); } // re-check the issues list for defences
    syncEmbed();
    if (simMode() && !simShown) { simShown = true; enterSimMode(); }
  });
  $('use-design').addEventListener('click', () => {
    refresh(true);
    if (!info.ok) return;
    window.parent.postMessage({ type: 'lsb-design-chosen', design: encodeDesign({ ...design, name: design.name || 'Unnamed' }) }, '*');
  });
}

// ------------------------------------------------------------ start
function loop(now) {
  keyPan(now);
  refresh();
  if (dirty) { dirty = false; draw(); drawMinimap(); }
  requestAnimationFrame(loop);
}
addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
resize();
const saved = store.get(CUR_KEY, null);
let restored = false;
if (saved) { try { const d = decodeDesign(saved); if (d.cells.some((c) => c && c !== BT.HUB)) { ed.load(d); ed.resetHistory(); restored = true; } } catch { /* start fresh */ } }
if (!restored) { ed.load({ ...makeDesign('destroyer', 21), name: 'My destroyer' }); ed.resetHistory(); }
setBlock(BT.ARMOR); setTool('pencil'); syncFields();
requestAnimationFrame((now) => { resize(); fit(); loop(now); });

// Small hook for debugging and automated checks.
if (window.parent !== window) window.parent.postMessage({ type: 'lsb-designer-ready' }, '*');
window.shipDesigner = { editor: ed, get design() { return design; }, get info() { return info; }, cam, fit };
