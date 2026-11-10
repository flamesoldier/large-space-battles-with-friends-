// The persistent world: galaxy, players, credits, shipyards, garrisons and fleets.
//
// The state is one plain JSON-serialisable object, and every rule is a function of it plus a
// game clock (ms), with no DOM and no wall clock, so the same code can run on the server. For now
// the galaxy page runs it in the browser as a hot-seat game.
//
// Time moves in two ways:
//  - advanceTo(world, t) accrues income and shipyard production up to t. Both are linear in time,
//    so a long gap (the server was idle, the page was closed) costs the same as a short one.
//  - Everything else is a discrete event: a fleet reaching the next world on its route, or a
//    siege's hold running out. runWorld() (or the page's async version) takes them in order with
//    dueEvent(), planEvent() and applyEvent(), then carries on.
//
// Battles are not run in here: planEvent() returns a Battle scenario, the caller runs the sim
// (src/sim/battle.js) however it likes (Node worker, browser with a progress bar) and passes
// readBattle()'s result to applyEvent().

import { analyzeDesign, decodeDesign, encodeDesign, designCost } from '../shared/shipStats.js';
import { BT } from '../shared/blocks.js';
import { makeDesign } from '../shared/designs.js';
import { mulberry32 } from '../shared/rng.js';
import {
  SHIPYARD_INTERVAL_MIN, shipyardPrice, crowdingSurcharge, SHIPYARD_SELL_REFUND,
  defensePrice, MAX_DEFENSE_ORDER, STARTING_CREDITS, NEUTRAL_GARRISON_HOURS, SELL_HOURS, DEFENSE_BUILD_HOURS,
} from '../shared/economy.js';
import { generateGalaxy, linkHomesInward } from './galaxyGen.js';
import { planRoute, travelSpeed, laneMap } from './routes.js';
import { makeBattleScenario } from './battleSetup.js';
import { HOUR_MS, MIN_FLEET_SPEED, NEUTRAL_COLOR, PLAYER_COLORS, CHOOSABLE_COLORS, MIN_PLAYERS, MAX_PLAYERS, BATTLE_MAX_TIME, BATTLE_HOLD_MIN } from './rules.js';

export const YARD_MS = SHIPYARD_INTERVAL_MIN * 60 * 1000;
export const HOLD_MS = BATTLE_HOLD_MIN * 60 * 1000;
const LOG_KEEP = 400;

// ---------------------------------------------------------------- creation

/**
 * players: [{ name, color?, team?, open? }] (2–10). team: '' for nobody, or any label: players with
 * the same label start the game allied (they can station ships on each other's worlds and defend
 * them together). Alliances can change later through diplomacy. open: an empty seat whose player
 * picks their own name and colour when they first log in (claimPlayer).
 */
export function createWorld({ players, seed = 1, planetsPerPlayer, clock = 0 }) {
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) throw new Error(`A game needs ${MIN_PLAYERS}–${MAX_PLAYERS} players.`);
  const g = generateGalaxy({ players: players.length, seed, planetsPerPlayer });
  const world = {
    format: 'lsb-world', version: 3, seed, clock, nextId: 1, winner: null,
    radius: g.radius,
    players: players.map((p, k) => ({
      id: k, name: String(p.name || `Player ${k + 1}`).slice(0, 24), color: p.color || PLAYER_COLORS[k % PLAYER_COLORS.length],
      team: String(p.team || '').slice(0, 12), credits: STARTING_CREDITS, home: g.spawns[k], eliminated: false,
      claimed: !p.open,
    })),
    planets: g.planets.map((p) => ({
      id: p.id, name: p.name, x: p.x, y: p.y, size: p.size, income: p.income,
      home: p.home, owner: p.home >= 0 ? p.home : null, yards: [], garrison: [],
    })),
    lanes: g.lanes,
    designs: {},
    fleets: [],
    sieges: [],
    relations: {},
    proposals: [],
    jobs: [],
    log: [],
  };
  // Starting teams only decide who begins allied; diplomacy can change it later.
  for (const a of world.players) for (const b of world.players) if (a.id < b.id && a.team && a.team === b.team) world.relations[`${a.id}|${b.id}`] = 'ally';
  addMilitia(world);
  log(world, 'start', `A new galaxy: ${world.planets.length} worlds, ${world.lanes.length} hyperlanes, ${players.length} players.`);
  return world;
}

/** Unclaimed worlds get a militia garrison worth NEUTRAL_GARRISON_HOURS of their income. */
function addMilitia(world) {
  if (NEUTRAL_GARRISON_HOURS <= 0) return;
  const r = mulberry32(world.seed * 13 + 5);
  const kinds = ['corvette', 'frigate', 'destroyer'].map((cls, k) => {
    const d = { ...makeDesign(cls, world.seed * 17 + k * 101 + 3), name: `Militia ${cls}` };
    return { id: registerDesign(world, null, d), cost: designCost(d) };
  });
  for (const p of world.planets) {
    if (p.owner !== null) continue;
    const budget = p.income * NEUTRAL_GARRISON_HOURS;
    let spent = 0;
    for (let guard = 0; guard < 200; guard++) {
      const fits = kinds.filter((k) => spent + k.cost <= budget);
      if (!fits.length) break;
      const k = fits[(r() * fits.length) | 0];
      addShips(p, null, k.id, 1); spent += k.cost;
    }
    if (!p.garrison.length) addShips(p, null, kinds[0].id, 1);
  }
}

// ---------------------------------------------------------------- small helpers

const newId = (world) => world.nextId++;

export function log(world, kind, text, extra = {}) {
  world.log.push({ id: newId(world), t: world.clock, kind, text, ...extra });
  if (world.log.length <= LOG_KEEP) return;
  // Trim the oldest routine entries first: battles and captures are the combat log, keep them longest.
  const combat = (e) => e.battle || e.capture;
  let extraN = world.log.length - LOG_KEEP;
  world.log = world.log.filter((e) => (extraN > 0 && !combat(e) ? (extraN--, false) : true));
  if (world.log.length > LOG_KEEP * 2) world.log.splice(0, world.log.length - LOG_KEEP * 2);
}

/** Same player, or allied right now (see diplomacy below). Militia (null) has no allies. */
export function allied(world, a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (a === b) return true;
  return world.relations?.[a < b ? `${a}|${b}` : `${b}|${a}`] === 'ally';
}

export const playerName = (world, id) => (id === null || id === undefined ? 'Militia' : world.players[id]?.name ?? '?');

/** Credits per hour from every world a player holds. */
export const incomeOf = (world, pid) => world.planets.reduce((s, p) => s + (p.owner === pid ? p.income : 0), 0);

export function addShips(planet, owner, design, n) {
  if (n <= 0) return;
  const s = planet.garrison.find((g) => g.owner === owner && g.design === design);
  if (s) s.n += n; else planet.garrison.push({ owner, design, n });
}

function tidyGarrison(planet) { planet.garrison = planet.garrison.filter((s) => s.n > 0); }

/** Ships a player has at a world: { designId: n }. */
export function shipsAt(planet, owner) {
  const out = {};
  for (const s of planet.garrison) if (s.owner === owner && s.n > 0) out[s.design] = (out[s.design] || 0) + s.n;
  return out;
}

// ---------------------------------------------------------------- designs

const decoded = new WeakMap(); // world → Map(designId → decoded design)

/** The design behind a world design id, decoded (cached). */
export function designOf(world, id) {
  let m = decoded.get(world);
  if (!m) decoded.set(world, (m = new Map()));
  let d = m.get(id);
  if (!d) { d = decodeDesign(world.designs[id].data); m.set(id, d); }
  return d;
}

/**
 * Store a design for a player (or null for militia) and return its id. The same ship saved
 * twice by the same player gets the same id. Throws if the design isn't valid.
 */
export function registerDesign(world, owner, design, fixed = false) {
  const data = encodeDesign(design);
  for (const [id, e] of Object.entries(world.designs))
    if (e.owner === owner && !!e.fixed === fixed && e.data.cells === data.cells && e.data.w === data.w && e.data.stance === data.stance && (e.data.place || 'auto') === (data.place || 'auto') && e.name === data.name) return id;
  const a = analyzeDesign(design);
  if (!a.ok) throw new Error(`“${design.name}” can't be built: ${a.errors[0]}`);
  const id = `d${newId(world)}`;
  world.designs[id] = fixed
    ? { id, owner, name: data.name, cls: a.hullClass?.id ?? design.cls, cost: defensePrice(design), speed: 0, blocks: a.blocks, data, fixed: true }
    : { id, owner, name: data.name, cls: a.hullClass?.id ?? design.cls, cost: a.cost, speed: a.maxSpeed, blocks: a.blocks, data };
  return id;
}

/** Is this world design a defence (never moves, can't leave its world)? */
export const isDefense = (world, id) => !!world.designs[id]?.fixed;

// ---------------------------------------------------------------- shipyards

/** List value of every shipyard already on a world (what crowding is measured on). */
export const yardListValue = (planet) => planet.yards.reduce((s, y) => s + y.list, 0);

/** What a shipyard for this design would cost on this world right now: { list, surcharge, mult, price, existing }. */
export function quoteShipyard(world, planetId, design) {
  const p = world.planets[planetId], existing = yardListValue(p);
  const list = shipyardPrice(design), surcharge = crowdingSurcharge(list, existing), price = list + surcharge;
  return { list, surcharge, mult: list ? price / list : 1, price, existing };
}

/** Buy a shipyard for `design` (a decoded design) on one of your worlds. Returns { ok, error?, yard? }. */
export function buildShipyard(world, pid, planetId, design) {
  const p = world.planets[planetId], pl = world.players[pid];
  if (!p || !pl) return { ok: false, error: 'No such world or player.' };
  if (pl.eliminated) return { ok: false, error: `${pl.name} is out of the game.` };
  if (p.owner !== pid) return { ok: false, error: `You don't hold ${p.name}.` };
  let id;
  try { id = registerDesign(world, pid, design); } catch (e) { return { ok: false, error: e.message }; }
  const q = quoteShipyard(world, planetId, design);
  if (pl.credits + 1e-6 < q.price) return { ok: false, error: `Needs ${Math.round(q.price).toLocaleString()} credits; you have ${Math.floor(pl.credits).toLocaleString()}.` };
  pl.credits -= q.price;
  const yard = { id: `y${newId(world)}`, design: id, list: q.list, paid: q.price, built: 0, since: world.clock, next: world.clock + YARD_MS };
  p.yards.push(yard);
  log(world, 'yard', `${pl.name} built a shipyard for ${world.designs[id].name} at ${p.name} (${q.price.toLocaleString()} cr).`, { planet: p.id, players: [pid] });
  return { ok: true, yard };
}

// Jobs (owner, Nov 2026): selling a shipyard and building defences take SELL_HOURS /
// DEFENSE_BUILD_HOURS, so they can't be done in reaction to an attack. Each is an entry in
// world.jobs, { id, kind: 'sell' | 'defence', planet, owner, done, ... }, finished by a 'job'
// event (dueEvent) at `done`. If the world changes hands first, capture() cancels them: the
// shipyard is destroyed with the rest and the defences under construction are lost.
const SELL_MS = SELL_HOURS * HOUR_MS, DEFENSE_BUILD_MS = DEFENSE_BUILD_HOURS * HOUR_MS;

/** Jobs under way at a world (all, or one kind). */
export const jobsAt = (world, planetId, kind) => (world.jobs || []).filter((j) => j.planet === planetId && (!kind || j.kind === kind));

/**
 * Start selling a shipyard: it stops building at once and, SELL_HOURS later, is removed and
 * SHIPYARD_SELL_REFUND of what was paid comes back (cancelSale stops it).
 */
export function sellShipyard(world, pid, planetId, yardId) {
  const p = world.planets[planetId], pl = world.players[pid];
  if (!p || p.owner !== pid) return { ok: false, error: 'You don\'t hold that world.' };
  const y = p.yards.find((x) => x.id === yardId);
  if (!y) return { ok: false, error: 'No such shipyard.' };
  if (y.sellAt != null) return { ok: false, error: 'That shipyard is already being sold.' };
  const refund = sellValue(y);
  y.sellAt = world.clock + SELL_MS;
  const job = { id: newId(world), kind: 'sell', planet: p.id, owner: pid, yard: y.id, refund, done: y.sellAt };
  world.jobs.push(job);
  log(world, 'yard', `${pl.name} started selling the ${world.designs[y.design].name} shipyard at ${p.name}: +${refund.toLocaleString()} cr in ${SELL_HOURS} hours.`, { planet: p.id, players: [pid] });
  return { ok: true, refund, done: y.sellAt, job };
}

/** Stop selling a shipyard: it starts building again (its next ship a full interval from now). */
export function cancelSale(world, pid, planetId, yardId) {
  const p = world.planets[planetId], pl = world.players[pid];
  if (!p || p.owner !== pid) return { ok: false, error: 'You don\'t hold that world.' };
  const y = p.yards.find((x) => x.id === yardId);
  if (!y || y.sellAt == null) return { ok: false, error: 'That shipyard isn\'t being sold.' };
  world.jobs = world.jobs.filter((j) => !(j.kind === 'sell' && j.yard === yardId));
  delete y.sellAt;
  y.next = world.clock + YARD_MS;
  log(world, 'yard', `${pl.name} kept the ${world.designs[y.design].name} shipyard at ${p.name} (sale called off).`, { planet: p.id, players: [pid] });
  return { ok: true };
}

/** A job's time is up: pay out the sale, or put the finished defences in the garrison. */
function finishJob(world, job) {
  world.jobs = world.jobs.filter((j) => j !== job);
  const p = world.planets[job.planet], pl = world.players[job.owner];
  if (!p || !pl || p.owner !== job.owner) return null; // the world changed hands: capture() should have removed it
  if (job.kind === 'sell') {
    const k = p.yards.findIndex((y) => y.id === job.yard);
    if (k < 0) return null;
    const [y] = p.yards.splice(k, 1);
    pl.credits += job.refund;
    log(world, 'yard', `${pl.name} sold the ${world.designs[y.design].name} shipyard at ${p.name} for ${job.refund.toLocaleString()} cr.`, { planet: p.id, players: [job.owner] });
  } else {
    addShips(p, job.owner, job.design, job.count);
    const name = world.designs[job.design].name;
    log(world, 'yard', `${job.count === 1 ? `A ${name} defence is` : `${job.count.toLocaleString()} ${name} defences are`} ready at ${p.name} (${pl.name}).`, { planet: p.id, players: [job.owner] });
  }
  return lastLog(world);
}

export const sellValue = (yard) => Math.round(yard.paid * SHIPYARD_SELL_REFUND);

// ---------------------------------------------------------------- defences

/** Why a design can't be a defence, or null if it can (it has to have no thrusters). */
export function defenseProblem(design) {
  const n = design.cells.reduce((s, t) => s + (t === BT.THRUSTER ? 1 : 0), 0);
  return n ? `Defences can't have thrusters: remove its ${n} thruster${n > 1 ? 's' : ''} in the designer.` : null;
}

/**
 * Order `count` defences of `design` (a decoded design, no thrusters) on one of your worlds. They
 * cost defensePrice() each, paid now, and join the garrison DEFENSE_BUILD_HOURS later (lost if
 * the world falls first); they never move, and a defence that's destroyed is gone.
 * Returns { ok, error?, design?, count?, price?, done? }.
 */
export function buildDefense(world, pid, planetId, design, count = 1) {
  const p = world.planets[planetId], pl = world.players[pid];
  if (!p || !pl) return { ok: false, error: 'No such world or player.' };
  if (pl.eliminated) return { ok: false, error: `${pl.name} is out of the game.` };
  if (p.owner !== pid) return { ok: false, error: `You don't hold ${p.name}.` };
  if (!Number.isInteger(count) || count < 1 || count > MAX_DEFENSE_ORDER) return { ok: false, error: `Build between 1 and ${MAX_DEFENSE_ORDER} at a time.` };
  const why = defenseProblem(design);
  if (why) return { ok: false, error: why };
  const each = defensePrice(design), price = each * count;
  if (pl.credits + 1e-6 < price) return { ok: false, error: `Needs ${price.toLocaleString()} credits; you have ${Math.floor(pl.credits).toLocaleString()}.` };
  let id;
  try { id = registerDesign(world, pid, design, true); } catch (e) { return { ok: false, error: e.message }; }
  pl.credits -= price;
  const done = world.clock + DEFENSE_BUILD_MS;
  world.jobs.push({ id: newId(world), kind: 'defence', planet: p.id, owner: pid, design: id, count, price, done });
  log(world, 'yard', `${pl.name} started building ${count === 1 ? 'a' : count.toLocaleString()} ${world.designs[id].name} defence${count > 1 ? 's' : ''} at ${p.name} (${price.toLocaleString()} cr, ready in ${DEFENSE_BUILD_HOURS} hours).`, { planet: p.id, players: [pid] });
  return { ok: true, design: id, count, price, done };
}

/**
 * Rename one of your ship designs (owner, Nov 2026: a friend left a shipyard as "My frigate").
 * The new name shows everywhere the design does: its shipyards, garrisons, fleets and battles.
 */
export function renameDesign(world, pid, designId, name) {
  const d = world.designs[designId];
  if (!d || !Object.hasOwn(world.designs, designId)) return { ok: false, error: 'No such ship design.' };
  if (d.owner !== pid) return { ok: false, error: 'You can only rename your own designs.' };
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  if (!clean) return { ok: false, error: 'Give it a name.' };
  if (clean === d.name) return { ok: true, name: clean };
  const old = d.name;
  d.name = clean;
  if (d.data) d.data.name = clean;
  decoded.get(world)?.delete(designId); // cached decoded copy carries the old name
  log(world, 'yard', `${world.players[pid].name} renamed the ${old} design to ${clean}.`, { players: [pid] });
  return { ok: true, name: clean };
}

// ---------------------------------------------------------------- time and events

/**
 * Accrue income and shipyard production up to game time t (ms). Doesn't process events: the
 * caller makes sure nothing is due before t (runWorld does).
 */
export function advanceTo(world, t) {
  const dt = t - world.clock;
  if (dt <= 0) return;
  for (const p of world.planets) {
    if (p.owner === null) continue;
    world.players[p.owner].credits += (p.income * dt) / HOUR_MS;
    for (const y of p.yards) {
      if (y.next > t || y.sellAt != null) continue; // a shipyard being sold has stopped building
      const k = Math.floor((t - y.next) / YARD_MS) + 1;
      addShips(p, p.owner, y.design, k);
      y.next += k * YARD_MS; y.built += k;
    }
  }
  world.clock = t;
}

/**
 * The next thing due at or before t, or null:
 *  { kind: 'job', job, at }      a shipyard sale or a defence order is finished
 *  { kind: 'fleet', fleet, at }  a fleet reaches the next world on its route
 *  { kind: 'siege', siege, at }  a siege's hold is over: the battle starts
 * At the same moment jobs go first (defences finished on time fight), then fleets, so a fleet
 * arriving exactly on time still joins the fight.
 */
export function dueEvent(world, t) {
  let ev = null;
  for (const j of world.jobs || []) {
    if (j.done > t) continue;
    if (!ev || j.done < ev.at || (j.done === ev.at && j.id < ev.job.id)) ev = { kind: 'job', job: j, at: j.done };
  }
  for (const f of world.fleets) {
    if (f.wait != null || f.next > t) continue;
    if (!ev || f.next < ev.at || (f.next === ev.at && ev.kind === 'fleet' && f.id < ev.fleet.id)) ev = { kind: 'fleet', fleet: f, at: f.next };
  }
  for (const s of world.sieges) {
    if (s.startsAt > t) continue;
    if (!ev || s.startsAt < ev.at || (s.startsAt === ev.at && ev.kind === 'siege' && s.id < ev.siege.id)) ev = { kind: 'siege', siege: s, at: s.startsAt };
  }
  return ev;
}

/** Synchronous driver (server, tests): advance to t, resolving every event on the way. */
export function runWorld(world, t, resolveBattle) {
  for (let guard = 0; guard < 100000; guard++) {
    const ev = dueEvent(world, t);
    if (!ev) break;
    advanceTo(world, ev.at);
    const plan = planEvent(world, ev);
    applyEvent(world, ev, plan, plan.kind === 'battle' ? resolveBattle(plan.battle, plan) : null);
  }
  advanceTo(world, t);
}

// ---------------------------------------------------------------- fleets

const laneCache = new WeakMap();
const lanesOf = (world) => { let m = laneCache.get(world); if (!m) laneCache.set(world, (m = laneMap(world.lanes))); return m; };

/** Slowest ship's battle speed in a { designId: n } set. */
export const fleetSpeed = (world, ships) => Math.min(...Object.keys(ships).filter((d) => ships[d] > 0).map((d) => world.designs[d].speed));

/** Worlds a player's fleet would have to fight its way past: anything not held by them or an ally. */
export function hostileWorlds(world, pid) {
  const out = new Set();
  for (const p of world.planets) if (!allied(world, p.owner, pid)) out.add(p.id);
  return out;
}

const routeOpts = (o) => (typeof o === 'boolean' ? { lanes: o, avoid: true, owner: undefined } : { lanes: o?.lanes ?? true, avoid: o?.avoid ?? true, owner: o?.owner });

/**
 * Route for a set of ships without sending them: { ok, error?, hours, legs, speed, stops }.
 * opts: { owner, lanes = true, avoid = true } — avoid: plan round worlds the owner's side doesn't hold (the fleet
 * stops at every world on its route, and has to fight any defenders it finds there).
 * stops: the worlds on the way (not the destination) that aren't yours or an ally's.
 */
export function previewFleet(world, from, to, ships, opts = {}) {
  const { lanes, avoid } = routeOpts(opts);
  let { owner } = routeOpts(opts);
  const ids = Object.keys(ships).filter((d) => ships[d] > 0);
  if (!ids.length) return { ok: false, error: 'Pick some ships to send.' };
  if (from === to) return { ok: false, error: 'They\'re already there.' };
  const fixed = ids.find((d) => world.designs[d].fixed);
  if (fixed !== undefined) return { ok: false, error: `${world.designs[fixed].name} is a defence: defences never leave their world.` };
  const slow = ids.filter((d) => world.designs[d].speed < MIN_FLEET_SPEED);
  if (slow.length) return { ok: false, error: `${world.designs[slow[0]].name} has no engines to speak of and can't leave its world.` };
  const speed = travelSpeed(fleetSpeed(world, ships));
  if (owner === undefined) owner = world.designs[ids[0]].owner;
  const hostile = hostileWorlds(world, owner);
  const r = planRoute(world.planets, lanesOf(world), from, to, speed, lanes, avoid ? hostile : null);
  const stops = r.legs.slice(0, -1).map((l) => l.to).filter((id) => hostile.has(id));
  return { ok: true, speed, ...r, stops };
}

/**
 * Send ships from a world's garrison. ships: { designId: n }; opts as previewFleet (a boolean is
 * read as `lanes`). Returns { ok, error?, fleet? }.
 */
export function sendFleet(world, pid, from, to, ships, opts = {}) {
  const pl = world.players[pid], P = world.planets[from];
  if (!pl || !P || !world.planets[to]) return { ok: false, error: 'No such world or player.' };
  if (pl.eliminated) return { ok: false, error: `${pl.name} is out of the game.` };
  const have = shipsAt(P, pid);
  for (const [d, n] of Object.entries(ships)) {
    if (n < 0 || !Number.isInteger(n)) return { ok: false, error: 'Ship counts must be whole numbers.' };
    if (n > (have[d] || 0)) return { ok: false, error: `Only ${have[d] || 0} ${world.designs[d]?.name ?? 'ships'} at ${P.name}.` };
  }
  const clean = Object.fromEntries(Object.entries(ships).filter(([, n]) => n > 0));
  const plan = previewFleet(world, from, to, clean, { ...routeOpts(opts), owner: pid });
  if (!plan.ok) return plan;
  for (const [d, n] of Object.entries(clean)) P.garrison.find((s) => s.owner === pid && s.design === d).n -= n;
  tidyGarrison(P);
  const fleet = launch(world, pid, from, to, clean, plan, false);
  const T = world.planets[to];
  const via = plan.legs.length > 1 ? ` via ${plan.legs.length - 1} world${plan.legs.length > 2 ? 's' : ''}` : '';
  log(world, 'fleet', `${pl.name} sent ${countShips(clean)} ships from ${P.name} to ${T.name}${via}, arriving in ${fmtHours(plan.hours)}.`, { planet: to, players: [pid] });
  return { ok: true, fleet };
}

/**
 * Fleets move leg by leg: `leg` is the leg in flight and `next` the game time it ends. Each leg
 * records `at`, the time it ends, so the schedule never drifts.
 */
function launch(world, owner, from, to, ships, plan, retreat) {
  let h = 0;
  const legs = plan.legs.map((l, k) => { h += l.hours; return { ...l, at: world.clock + Math.round((k === plan.legs.length - 1 ? plan.hours : h) * HOUR_MS) }; });
  const fleet = { id: newId(world), owner, ships, from, to, legs, leg: 0, next: legs[0].at, wait: null, speed: plan.speed, retreat, depart: world.clock, arrive: legs[legs.length - 1].at };
  world.fleets.push(fleet);
  return fleet;
}

/** Bring a saved world up to date with the current rules (older saves had no per-leg stops). */
export function upgradeWorld(world) {
  for (const f of world.fleets) {
    if (f.leg !== undefined) continue;
    let h = 0;
    f.legs = f.legs.map((l) => { h += l.hours; return { ...l, at: f.depart + Math.round(h * HOUR_MS) }; });
    f.legs[f.legs.length - 1].at = f.arrive;
    f.leg = f.legs.length - 1; // already under way: let it fly straight on as planned
    f.next = f.arrive;
  }
  for (const f of world.fleets) if (f.wait === undefined) f.wait = null;
  world.sieges ??= [];
  // One siege per world (Nov 2026, free-for-all battles): merge any extra sieges at a world into
  // the one that started first.
  world.sieges.sort((a, b) => a.startsAt - b.startsAt || a.id - b.id);
  for (const sg of [...world.sieges]) {
    const first = world.sieges.find((x) => x.planet === sg.planet);
    if (first === sg) continue;
    for (const id of sg.fleets) { const f = world.fleets.find((x) => x.id === id); if (f) f.wait = first.id; if (!first.fleets.includes(id)) first.fleets.push(id); }
    world.sieges.splice(world.sieges.indexOf(sg), 1);
  }
  world.proposals ??= [];
  world.jobs ??= []; // Nov 2026: selling shipyards and building defences take time
  // Nov 2026: every home world gets a hyperlane inward (some only had lanes along the rim).
  const newLanes = linkHomesInward(world.planets, world.lanes);
  if (newLanes.length) {
    world.lanes.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    for (const [h, b] of newLanes) log(world, 'lane', `New hyperlane: ${world.planets[h].name} ↔ ${world.planets[b].name}.`, { planet: h });
  }
  if (!world.relations) {
    world.relations = {};
    for (const a of world.players) for (const b of world.players) if (a.id < b.id && a.team && a.team === b.team) world.relations[`${a.id}|${b.id}`] = 'ally';
  }
  // Block prices change in balance passes: keep each stored design's price in step with
  // blocks.js, so ship values in the panels and combat log match what a new shipyard for it
  // costs. Shipyards already bought keep what was paid for them.
  for (const d of Object.values(world.designs || {})) {
    try { const dd = decodeDesign(d.data); d.cost = d.fixed ? defensePrice(dd) : designCost(dd); } catch { /* keep the stored price */ }
  }
  world.version = 3;
  return world;
}

export const countShips = (ships) => Object.values(ships).reduce((s, n) => s + n, 0);
export const fleetValue = (world, ships) => Object.entries(ships).reduce((s, [d, n]) => s + world.designs[d].cost * n, 0);

export function fmtHours(h) {
  if (h < 1 / 60) return 'under a minute';
  if (h < 59.5 / 60) return `${Math.round(h * 60)} min`;
  if (h < 48) { const m = Math.round(h * 60); return `${Math.floor(m / 60)} h ${m % 60} min`; } // (was "4 h 60 min" just under a whole hour)
  return `${(h / 24).toFixed(1)} days`;
}

// ---------------------------------------------------------------- arrivals and sieges
//
// A fleet stops at every world on its route. At its own or an ally's world it joins the garrison
// (its destination) or flies on. At any other world:
//  - if a siege is under way there, it joins it (its destination), or stops for it if anyone there
//    is its enemy (a world it is passing);
//  - else if this is its destination, or there are defenders, it starts a siege;
//  - otherwise (passing a world nobody defends) it flies on.
// There is at most one siege per world. It holds for BATTLE_HOLD_MIN, so everyone can bring
// reinforcements (the owner's and allies' fleets join the garrison, and shipyards keep building).
//
// When the hold ends, everyone at the world fights ONE free-for-all battle (owner's rule, Nov
// 2026): each player is their own side and shoots only the players they are at war with, so any
// mixture of alliances works. Players with no enemy there sit it out, untouched. Who gets the
// world (owner's rule):
//  - the owner keeps it if the owner or an ally that fought still has armed ships (not routed);
//  - otherwise the player who started the siege takes it, if they still have armed ships there;
//  - otherwise the surviving attacker with the most ships left.
// The winner's allies stay on as guests; everyone else who fought against the winner falls back.
// Taking a world destroys its shipyards, even a world the fleet was only passing.
//
// Fleets that leave a siege are "released": they arrive again at that world, and whatever is true
// now (who owns it, who is allied with whom) decides what they do (garrison it, fly on, ...).

/**
 * Ships at P that would fight an attack by `attackers` (a player id or a list): the owner's own
 * and allied ships, minus any player allied with one of the attackers (they would sit it out).
 */
export function defendersAt(world, P, attackers) {
  const att = Array.isArray(attackers) ? attackers : [attackers];
  return P.garrison.filter((s) => s.n > 0 && !att.some((a) => allied(world, s.owner, a))
    && (P.owner === null ? s.owner === null : s.owner === P.owner || allied(world, s.owner, P.owner)));
}

/** Are two parties (player ids, null = militia) at war? */
export const hostile = (world, a, b) => a !== b && !allied(world, a, b);

export const siegeAt = (world, planetId) => world.sieges.filter((s) => s.planet === planetId);
const siegeFleets = (world, s) => s.fleets.map((id) => world.fleets.find((f) => f.id === id)).filter(Boolean);

/** Is anyone at P (garrison or siege fleets) at war with `who`? */
function enemyHere(world, P, who) {
  if (P.garrison.some((g) => g.n > 0 && hostile(world, g.owner, who))) return true;
  return siegeAt(world, P.id).some((s) => siegeFleets(world, s).some((f) => hostile(world, f.owner, who)));
}

/**
 * Everyone at a siege's world, by player (null = militia): { owner, fleets, stacks, ships, enemy }.
 * `enemy` is whether anyone else there is at war with them. Those with no enemy sit the battle out.
 * Order: the world's garrison first (owner, then guests), then siege fleets in arrival order.
 */
export function siegeParties(world, s) {
  const P = world.planets[s.planet], by = new Map();
  const party = (o) => { if (!by.has(o)) by.set(o, { owner: o, fleets: [], stacks: [], ships: 0, enemy: false }); return by.get(o); };
  for (const g of P.garrison) if (g.n > 0) { const q = party(g.owner); q.stacks.push(g); q.ships += g.n; }
  for (const f of siegeFleets(world, s)) { const n = countShips(f.ships); if (!n) continue; const q = party(f.owner); q.fleets.push(f); q.ships += n; }
  const list = [...by.values()];
  for (const a of list) a.enemy = list.some((b) => hostile(world, a.owner, b.owner));
  return list;
}

/** Who takes a world: the siege's leader if among `cands` (player ids), else the one with most ships (`ships(id)`). */
function pickWinner(world, s, cands, ships) {
  if (!cands.length) return null;
  if (cands.includes(s.leader)) return s.leader;
  return [...cands].sort((a, b) => ships(b) - ships(a) || a - b)[0];
}

/**
 * What an event will do (doesn't change the world):
 *  fleet:  { kind: 'join' | 'pass' | 'hold' | 'siege' }   join a garrison / fly on / join a siege / start one
 *  siege:  { kind: 'release' }   nobody there is at war with anyone: everyone re-arrives
 *          { kind: 'capture', winner }   nobody defending, and the attackers are all allies: the winner takes it
 *          { kind: 'battle', battle }  a Battle scenario: one side per player who has an enemy there
 */
export function planEvent(world, ev) {
  if (ev.kind === 'job') return { kind: 'job' };
  if (ev.kind === 'fleet') {
    const f = ev.fleet, L = f.legs[f.leg], final = f.leg >= f.legs.length - 1, P = world.planets[L.to];
    if (allied(world, f.owner, P.owner)) return { kind: final ? 'join' : 'pass' };
    const s = siegeAt(world, P.id)[0];
    if (s) return final || enemyHere(world, P, f.owner) ? { kind: 'hold', siege: s.id } : { kind: 'pass' };
    if (final || defendersAt(world, P, f.owner).length) return { kind: 'siege' };
    return { kind: 'pass' };
  }
  const s = ev.siege, P = world.planets[s.planet];
  const parties = siegeParties(world, s), fighters = parties.filter((q) => q.enemy);
  if (!fighters.length) {
    // Nobody to fight. Fleets at war with the owner (who has no ships here) take the world.
    const cands = parties.filter((q) => q.fleets.length && !allied(world, q.owner, P.owner)).map((q) => q.owner);
    const winner = pickWinner(world, s, cands, (o) => parties.find((q) => q.owner === o).ships);
    return winner === null ? { kind: 'release' } : { kind: 'capture', winner };
  }
  // One battle side (team) per fighting player. Side 0/1 is only for the log's summary: the
  // owner's side (owner, its allies, militia) is 1, everyone else 0.
  const defends = (o) => (P.owner === null ? o === null : o === P.owner || allied(world, o, P.owner));
  const groups = [];
  fighters.forEach((q, team) => {
    const side = defends(q.owner) ? 1 : 0;
    const color = q.owner === null ? NEUTRAL_COLOR : world.players[q.owner]?.color || null;
    for (const g of q.stacks) groups.push({ team, side, owner: q.owner, design: g.design, n: g.n, garrison: true, color, ...(world.designs[g.design]?.fixed ? { fixed: true } : {}) });
    for (const f of q.fleets) for (const [design, n] of Object.entries(f.ships)) if (n > 0) groups.push({ team, side, owner: q.owner, design, n, fleet: f.id, color });
  });
  // Starting positions: the owner's side holds the world; attackers come in from around it, each
  // group of mutual allies together (see makeBattleScenario).
  const owners = fighters.map((q) => q.owner);
  const camps = [], campOf = new Array(fighters.length);
  const defCamp = [];
  fighters.forEach((q, t) => { if (defends(q.owner)) { defCamp.push(t); campOf[t] = 0; } });
  camps.push(defCamp);
  fighters.forEach((q, t) => {
    if (defends(q.owner)) return;
    let c = camps.findIndex((m, k) => k > 0 && m.every((u) => allied(world, owners[u], q.owner)));
    if (c < 0) { c = camps.length; camps.push([]); }
    camps[c].push(t); campOf[t] = c;
  });
  const battle = makeBattleScenario(groups, (id) => designOf(world, id), (world.seed * 1000003 + s.id * 131) >>> 0,
    { teams: fighters.length, campOf, camps: camps.length });
  const attackers = owners.filter((o) => !defends(o));
  Object.assign(battle, {
    maxTime: BATTLE_MAX_TIME, planet: P.id, attacker: s.leader, defender: P.owner, attackers, owners, camps: camps.length,
    // hostile pairs as a list of [a, b] team indexes (plain data, so it can go to a worker)
    hostile: owners.flatMap((a, i) => owners.map((b, j) => (i < j && hostile(world, a, b) ? [i, j] : null)).filter(Boolean)),
    passing: fighters.filter((q) => !defends(q.owner)).every((q) => q.fleets.every((f) => f.leg < f.legs.length - 1)),
  });
  return { kind: 'battle', battle };
}

/** Apply an event. `result` is readBattle()'s output for a battle, else null. Returns the log entry written, if any. */
export function applyEvent(world, ev, plan, result) {
  let entry = null;
  if (ev.kind === 'job') entry = finishJob(world, ev.job);
  else if (ev.kind === 'fleet') entry = fleetArrives(world, ev.fleet, plan);
  else entry = siegeEnds(world, ev.siege, plan, result);
  checkPlayers(world);
  return entry;
}

function lastLog(world) { return world.log[world.log.length - 1]; }

function fleetArrives(world, f, plan) {
  const L = f.legs[f.leg], P = world.planets[L.to], me = playerName(world, f.owner);
  if (plan.kind === 'pass') { f.leg++; f.next = f.legs[f.leg].at; return null; }
  if (plan.kind === 'join') {
    dropFleet(world, f);
    for (const [d, n] of Object.entries(f.ships)) addShips(P, f.owner, d, n);
    log(world, 'arrive', `${countShips(f.ships)} of ${me}'s ships ${f.retreat ? 'fell back to' : 'arrived at'} ${P.name}.`, { planet: P.id, players: [f.owner] });
    return lastLog(world);
  }
  const held = P.owner === null ? 'militia-held ' : '';
  const owner = P.owner === null ? '' : ` (${playerName(world, P.owner)})`;
  const startsIn = fmtHours(BATTLE_HOLD_MIN / 60);
  if (plan.kind === 'hold') {
    const s = world.sieges.find((x) => x.id === plan.siege);
    s.fleets.push(f.id);
    f.wait = s.id; f.next = Infinity;
    const how = allied(world, f.owner, s.leader) ? 'joined the attack on' : 'arrived at';
    log(world, 'siege', `${countShips(f.ships)} of ${me}'s ships ${how} ${P.name}${owner}, where a battle starts ${clockIn(world, s.startsAt)}.`,
      { planet: P.id, players: [f.owner, s.leader, P.owner].filter((x) => x !== null), siege: { by: s.leader, against: P.owner, startsAt: s.startsAt, join: true } });
    return lastLog(world);
  }
  // A new siege.
  const s = { id: newId(world), planet: P.id, leader: f.owner, fleets: [f.id], startsAt: world.clock + HOLD_MS, against: P.owner };
  world.sieges.push(s);
  f.wait = s.id; f.next = Infinity;
  const why = f.leg < f.legs.length - 1 ? ` on its way to ${world.planets[f.to].name}` : '';
  log(world, 'siege', `${me}'s fleet (${countShips(f.ships)} ships) reached the ${held}world ${P.name}${owner}${why}. The battle starts in ${startsIn}: everyone can still send ships.`,
    { planet: P.id, players: [f.owner, P.owner].filter((x) => x !== null), siege: { by: f.owner, against: P.owner, startsAt: s.startsAt } });
  return lastLog(world);
}

const clockIn = (world, t) => (t <= world.clock ? 'now' : `in ${fmtHours((t - world.clock) / HOUR_MS)}`);

/** Let a waiting fleet go: it arrives at this world again right now, and its later legs shift by however long it waited. */
function release(world, f) {
  const L = f.legs[f.leg], delay = Math.max(0, world.clock - L.at);
  for (let k = f.leg + 1; k < f.legs.length; k++) f.legs[k].at += delay;
  f.arrive = f.legs[f.legs.length - 1].at;
  L.at = world.clock;
  f.wait = null; f.next = world.clock;
}

function dropFleet(world, f) { const k = world.fleets.indexOf(f); if (k >= 0) world.fleets.splice(k, 1); }

/** Send a beaten fleet back where it came from (or the nearest friendly world). Returns a phrase for the log. */
function fallBack(world, f, P) {
  dropFleet(world, f);
  const n = countShips(f.ships);
  if (!n) return null;
  const back = retreatTarget(world, f, P);
  const pv = back === null ? null : previewFleet(world, P.id, back, f.ships, { owner: f.owner, lanes: true, avoid: true });
  const ships = `${n} of ${playerName(world, f.owner)}'s ships`, one = n === 1;
  if (pv?.ok) { launch(world, f.owner, P.id, back, f.ships, pv, true); return `${ships} ${one ? 'falls' : 'fall'} back to ${world.planets[back].name}`; }
  return `${ships} ${one ? 'has' : 'have'} nowhere to go and ${one ? 'is' : 'are'} lost`;
}

const listNames = (world, ids) => {
  const n = ids.map((id) => playerName(world, id));
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};

function siegeEnds(world, s, plan, result) {
  const P = world.planets[s.planet];
  const parties = siegeParties(world, s), all = siegeFleets(world, s);
  world.sieges.splice(world.sieges.indexOf(s), 1);
  if (plan.kind === 'release') { for (const f of all) release(world, f); return null; }
  if (plan.kind === 'capture') {
    const entry = capture(world, P, plan.winner, {}, null);
    for (const f of all) release(world, f); // the winner and its allies garrison it or fly on
    return entry;
  }
  // A battle. Apply everyone's losses.
  const B = plan.battle, owners = B.owners;
  const lost = [0, 0], value = [0, 0], ships = [0, 0], survived = [0, 0];
  const per = owners.map((o, t) => ({ id: o, side: 0, ships: 0, survived: 0, lost: 0, value: 0, routed: !!result.routed?.[t] }));
  const byFleet = new Map();
  const fought = new Set();
  for (const g of result.groups) {
    const cost = world.designs[g.design].cost, q = per[g.team];
    q.side = g.side; q.ships += g.n; q.survived += g.survived; q.value += g.n * cost; q.lost += (g.n - g.survived) * cost;
    value[g.side] += g.n * cost; lost[g.side] += (g.n - g.survived) * cost; ships[g.side] += g.n; survived[g.side] += g.survived;
    if (g.fleet !== undefined) {
      fought.add(g.fleet);
      if (!byFleet.has(g.fleet)) byFleet.set(g.fleet, {});
      if (g.survived) { const m = byFleet.get(g.fleet); m[g.design] = (m[g.design] || 0) + g.survived; }
    } else {
      const st = P.garrison.find((x) => x.owner === g.owner && x.design === g.design);
      if (st) st.n = Math.max(0, st.n - (g.n - g.survived));
    }
  }
  tidyGarrison(P);
  for (const f of all) if (byFleet.has(f.id)) f.ships = byFleet.get(f.id);
  // Who holds the field: armed survivors of a side that didn't rout.
  const holds = (q) => q.survived > 0 && !q.routed;
  const defends = (o) => (P.owner === null ? o === null : o === P.owner || allied(world, o, P.owner));
  const kept = per.some((q) => holds(q) && defends(q.id));
  const cands = kept ? [] : per.filter((q) => holds(q) && !defends(q.id)).map((q) => q.id);
  const winner = pickWinner(world, s, cands, (o) => per.find((q) => q.id === o).survived);
  const won = winner !== null;
  const attackers = per.filter((q) => !defends(q.id)).map((q) => q.id);
  const defenders = per.filter((q) => defends(q.id) && q.id !== null).map((q) => q.id);
  const passing = B.passing;
  const battle = {
    id: `b${newId(world)}`, attacker: won ? winner : s.leader, leader: s.leader, attackers, defender: P.owner, defenders, won,
    winner, passing, captured: won, seconds: result.seconds, ships, survived, value, lost, target: P.id, players: per,
    camps: B.camps || 2,
  };
  const who = [...new Set(per.map((q) => q.id).filter((x) => x !== null))];
  const ownerTxt = P.owner === null ? ' (militia)' : ` (${playerName(world, P.owner)})`;
  // "N-way" counts groups of allies that fought each other, not players.
  const way = (B.camps || 2) > 2 ? ` in a ${B.camps}-way battle` : '';
  const sitOut = parties.filter((q) => !q.enemy && q.owner !== null).map((q) => q.owner);
  const sat = sitOut.length ? ` ${listNames(world, sitOut)} sat it out.` : '';
  const tails = [];
  let entry;
  if (won) {
    entry = capture(world, P, winner, {}, { battle });
    const foes = per.map((q) => q.id).filter((o) => o !== B.defender && hostile(world, o, winner));
    const vs = foes.length && per.length > 2 ? `, also fighting ${listNames(world, foes)}` : '';
    entry.text = `${playerName(world, winner)} won the battle for ${P.name}${ownerTxt}${way}${vs}. ${entry.text.split('. ').slice(1).join('. ')}`.replace(/\s+$/, '');
  }
  // Fleets: the winner's side (or, if the owner held, the owner's side) garrisons or flies on;
  // everyone who fought against them falls back. Fleets that sat it out arrive again.
  for (const f of all) {
    if (!fought.has(f.id)) { release(world, f); continue; }
    const friend = won ? allied(world, f.owner, winner) : defends(f.owner);
    if (friend && countShips(f.ships)) release(world, f);
    else if (friend) dropFleet(world, f);
    else { const t = fallBack(world, f, P); if (t) tails.push(t); }
  }
  if (won) {
    if (tails.length) entry.text += ` ${tails.join('; ')}.`;
    entry.text += sat;
  } else {
    const tail = tails.length ? ` ${tails.join('; ')}.` : ' None of the attackers survived.';
    const by = listNames(world, attackers);
    log(world, 'battle', `${by} attacked ${P.name}${ownerTxt}${way} and ${attackers.length > 1 ? 'were' : 'was'} beaten off.${tail}${sat}`, { planet: P.id, players: who, battle });
    entry = lastLog(world);
  }
  return entry;
}

/** Take a world: every shipyard on it is destroyed, the income moves, the ships garrison it. */
function capture(world, P, owner, ships, battleInfo) {
  const old = P.owner, yards = P.yards.length;
  P.yards = [];
  // Unfinished jobs here are lost with the world: shipyards being sold (destroyed above, no
  // payout) and defences still being built (already paid for).
  const lostJobs = (world.jobs || []).filter((j) => j.planet === P.id);
  const unbuilt = lostJobs.reduce((s, j) => s + (j.kind === 'defence' ? j.count : 0), 0);
  if (lostJobs.length) world.jobs = world.jobs.filter((j) => j.planet !== P.id);
  P.owner = owner;
  // Defences can't leave: any not on the new owner's side are destroyed with the world.
  let razed = 0;
  P.garrison = P.garrison.filter((s) => {
    if (s.n <= 0 || !world.designs[s.design]?.fixed || allied(world, s.owner, owner)) return true;
    razed += s.n; return false;
  });
  // Anyone still here who isn't on the new owner's side leaves for home: defenders that were routed
  // (a few ships still armed when their side broke) flee, and players who sat the battle out
  // (allied with both sides) go unharmed. Militia that survive a rout scatter and are gone.
  const others = [...new Set(P.garrison.filter((s) => s.n > 0 && !allied(world, s.owner, owner) && s.owner !== null).map((s) => s.owner))];
  P.garrison = P.garrison.filter((s) => s.n > 0 && (allied(world, s.owner, owner) || others.includes(s.owner)));
  const fled = others.map((o) => sendHome(world, P, o)).filter(Boolean);
  for (const [d, n] of Object.entries(ships)) addShips(P, owner, d, n);
  const me = playerName(world, owner);
  const from = old === null ? '' : ` from ${playerName(world, old)}`;
  const how = battleInfo ? 'won the battle for' : 'took';
  const ruin = (yards ? ` ${yards} shipyard${yards > 1 ? 's' : ''} destroyed.` : '') + (razed ? ` ${razed} defence${razed > 1 ? 's' : ''} destroyed.` : '') + (unbuilt ? ` ${unbuilt} unfinished defence${unbuilt > 1 ? 's' : ''} lost.` : '');
  const tail = fled.length ? ` ${fled.join('; ')}.` : '';
  log(world, battleInfo ? 'battle' : 'capture', `${me} ${how} ${P.name}${from}.${ruin} +${P.income.toLocaleString()} cr/h.${tail}`, { planet: P.id, players: old === null ? [owner] : [owner, old], capture: { by: owner, from: old, yards }, ...(battleInfo || {}) });
  return world.log[world.log.length - 1];
}

/**
 * Send all of a player's ships at a world home (to the nearest world still friendly to them).
 * Ships that can't fly, or with nowhere to go, are lost. Returns a sentence for the log, or ''.
 */
function sendHome(world, P, guest) {
  const ships = shipsAt(P, guest);
  if (!countShips(ships)) return '';
  P.garrison = P.garrison.filter((s) => s.owner !== guest);
  const back = retreatTarget(world, { from: -1, owner: guest }, P);
  const mobile = Object.fromEntries(Object.entries(ships).filter(([d]) => world.designs[d].speed >= MIN_FLEET_SPEED));
  const pv = back === null || !countShips(mobile) ? null : previewFleet(world, P.id, back, mobile, { owner: guest, lanes: true, avoid: true });
  if (pv?.ok) launch(world, guest, P.id, back, mobile, pv, true);
  const n = countShips(ships), one = n === 1;
  return `${n} of ${world.players[guest].name}'s ships ${pv?.ok ? (one ? 'leaves' : 'leave') : one ? 'is stranded and lost at' : 'are stranded and lost at'} ${P.name}`;
}

/** Where beaten attackers go: where they came from if it's still friendly, else the nearest friendly world. */
function retreatTarget(world, fleet, here) {
  const from = world.planets[fleet.from];
  if (from && from.id !== here.id && allied(world, from.owner, fleet.owner)) return from.id;
  let best = null, bd = Infinity;
  for (const p of world.planets) {
    if (p.id === here.id || !allied(world, p.owner, fleet.owner)) continue;
    const d = Math.hypot(p.x - here.x, p.y - here.y);
    if (d < bd) { bd = d; best = p.id; }
  }
  return best;
}

/** Knock out players with no worlds, ships or fleets left, and see if one side has won. */
function checkPlayers(world) {
  for (const pl of world.players) {
    if (pl.eliminated) continue;
    const alive = world.planets.some((p) => p.owner === pl.id || p.garrison.some((s) => s.owner === pl.id && s.n > 0)) || world.fleets.some((f) => f.owner === pl.id);
    if (!alive) { pl.eliminated = true; log(world, 'out', `${pl.name} has been knocked out of the game.`, { players: [pl.id] }); }
  }
  if (world.winner !== null) return;
  const left = world.players.filter((p) => !p.eliminated);
  const allFriends = left.every((a) => left.every((b) => allied(world, a.id, b.id)));
  if (left.length && allFriends && world.players.length > left.length) {
    world.winner = left.map((p) => p.id);
    log(world, 'win', `${left.map((p) => p.name).join(' and ')} ${left.length > 1 ? 'have' : 'has'} won the galaxy.`, { players: world.winner });
  }
}

// ---------------------------------------------------------------- diplomacy
//
// Every pair of players is either allied or enemies, and it can change at any time. Starting
// teams only set who begins allied. An alliance needs both sides: one proposes, the other accepts.
// Either side can end it alone. When an alliance ends, each side's ships stationed on the other's
// worlds are sent home. Fleets waiting in a siege stay: sides are decided when the battle starts.

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function setAllied(world, a, b, on) {
  const k = pairKey(a, b);
  if (on) world.relations[k] = 'ally'; else delete world.relations[k];
  world.proposals = world.proposals.filter((p) => !((p.from === a && p.to === b) || (p.from === b && p.to === a)));
}

/** Alliance proposals waiting for player pid to answer. */
export const proposalsFor = (world, pid) => world.proposals.filter((p) => p.to === pid);
export const hasProposed = (world, from, to) => world.proposals.some((p) => p.from === from && p.to === to);

/** Propose an alliance (or accept one, if they already proposed). Returns { ok, error?, allied? }. */
export function proposeAlliance(world, from, to) {
  const A = world.players[from], B = world.players[to];
  if (!A || !B || from === to) return { ok: false, error: 'No such player.' };
  if (A.eliminated || B.eliminated) return { ok: false, error: 'That player is out of the game.' };
  if (allied(world, from, to)) return { ok: false, error: `You're already allied with ${B.name}.` };
  if (hasProposed(world, to, from)) return acceptAlliance(world, from, to);
  if (hasProposed(world, from, to)) return { ok: false, error: `You've already proposed an alliance to ${B.name}.` };
  world.proposals.push({ from, to, t: world.clock });
  log(world, 'diplomacy', `${A.name} proposed an alliance to ${B.name}.`, { players: [from, to], diplomacy: { kind: 'propose', from, to } });
  return { ok: true, allied: false };
}

/** Player `pid` accepts `from`'s proposal. */
export function acceptAlliance(world, pid, from) {
  if (!hasProposed(world, from, pid)) return { ok: false, error: 'There is no proposal to accept.' };
  setAllied(world, pid, from, true);
  log(world, 'diplomacy', `${world.players[pid].name} and ${world.players[from].name} are now allies.`, { players: [pid, from], diplomacy: { kind: 'ally', a: pid, b: from } });
  checkPlayers(world);
  return { ok: true, allied: true };
}

/** Turn down (or withdraw) a proposal between two players. */
export function declineAlliance(world, pid, other) {
  const had = world.proposals.length;
  world.proposals = world.proposals.filter((p) => !((p.from === other && p.to === pid) || (p.from === pid && p.to === other)));
  if (world.proposals.length === had) return { ok: false, error: 'There is no proposal.' };
  log(world, 'diplomacy', `${world.players[pid].name} and ${world.players[other].name} won't be allies for now.`, { players: [pid, other], diplomacy: { kind: 'decline', a: pid, b: other } });
  return { ok: true };
}

// ---------------------------------------------------------------- choosing a name (online)

/** Has this seat's player chosen their name yet? (Older saves have no flag: they have.) */
export const isOpenSeat = (world, pid) => world.players[pid]?.claimed === false;

/** Colours a player could pick now: the choosable ones nobody else is using. */
export const freeColors = (world, pid) => CHOOSABLE_COLORS.filter((c) => !world.players.some((p) => p.id !== pid && p.color.toLowerCase() === c));

/**
 * A player taking an open seat picks their name and colour, once. Names: 1–24 characters,
 * different from everyone else's. Returns { ok, error? }.
 */
export function claimPlayer(world, pid, name, color) {
  const pl = world.players[pid];
  if (!pl) return { ok: false, error: 'No such player.' };
  if (pl.claimed !== false) return { ok: false, error: 'You already have a name.' };
  name = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Pick a name.' };
  if (name.length > 24) return { ok: false, error: 'Names can be at most 24 characters.' };
  if (world.players.some((p) => p.id !== pid && p.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `Someone is already called ${name}.` };
  if (/^(militia|player \d+)$/i.test(name)) return { ok: false, error: 'Pick a name of your own.' };
  color = String(color ?? '').toLowerCase();
  if (!freeColors(world, pid).includes(color)) return { ok: false, error: 'Pick one of the colours shown.' };
  const old = pl.name;
  pl.name = name; pl.color = color; pl.claimed = true;
  log(world, 'join', `${old} is now ${name}.`, { players: [pid] });
  return { ok: true };
}

/** End an alliance: the two players are enemies from now on. */
export function breakAlliance(world, pid, other) {
  if (!allied(world, pid, other) || pid === other) return { ok: false, error: 'You aren\'t allied with them.' };
  setAllied(world, pid, other, false);
  const sentHome = [];
  // Guests on the other side's worlds go home (to the nearest world still friendly to them).
  for (const P of world.planets) {
    for (const [guest, host] of [[pid, other], [other, pid]]) {
      if (P.owner !== host || allied(world, P.owner, guest)) continue;
      const msg = sendHome(world, P, guest);
      if (msg) sentHome.push(msg);
    }
  }
  // Fleets waiting in a siege stay: who fights whom is worked out when the battle starts.
  const tail = sentHome.length ? ` ${sentHome.join('; ')}.` : '';
  log(world, 'diplomacy', `${world.players[pid].name} broke the alliance with ${world.players[other].name}. They are enemies now.${tail}`, { players: [pid, other], diplomacy: { kind: 'break', a: pid, b: other } });
  checkPlayers(world);
  return { ok: true };
}
