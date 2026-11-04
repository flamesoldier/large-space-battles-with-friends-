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
import { makeDesign } from '../shared/designs.js';
import { mulberry32 } from '../shared/rng.js';
import {
  SHIPYARD_INTERVAL_MIN, shipyardPrice, crowdingSurcharge, SHIPYARD_SELL_REFUND,
  STARTING_CREDITS, NEUTRAL_GARRISON_HOURS,
} from '../shared/economy.js';
import { generateGalaxy } from './galaxyGen.js';
import { planRoute, travelSpeed, laneMap } from './routes.js';
import { makeBattleScenario } from './battleSetup.js';
import { HOUR_MS, MIN_FLEET_SPEED, PLAYER_COLORS, MIN_PLAYERS, MAX_PLAYERS, BATTLE_MAX_TIME, BATTLE_HOLD_MIN } from './rules.js';

export const YARD_MS = SHIPYARD_INTERVAL_MIN * 60 * 1000;
export const HOLD_MS = BATTLE_HOLD_MIN * 60 * 1000;
const LOG_KEEP = 400;

// ---------------------------------------------------------------- creation

/**
 * players: [{ name, color?, team? }] (2–10). team: '' for nobody, or any label: players with the
 * same label start the game allied (they can station ships on each other's worlds and defend
 * them together). Alliances can change later through diplomacy.
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
export function registerDesign(world, owner, design) {
  const data = encodeDesign(design);
  for (const [id, e] of Object.entries(world.designs))
    if (e.owner === owner && e.data.cells === data.cells && e.data.w === data.w && e.data.stance === data.stance && e.name === data.name) return id;
  const a = analyzeDesign(design);
  if (!a.ok) throw new Error(`“${design.name}” can't be built: ${a.errors[0]}`);
  const id = `d${newId(world)}`;
  world.designs[id] = { id, owner, name: data.name, cls: a.hullClass?.id ?? design.cls, cost: a.cost, speed: a.maxSpeed, blocks: a.blocks, data };
  return id;
}

// ---------------------------------------------------------------- shipyards

/** List value of every shipyard already on a world (what crowding is measured on). */
export const yardListValue = (planet) => planet.yards.reduce((s, y) => s + y.list, 0);

/** What a shipyard for this design would cost on this world right now: { list, surcharge, mult, price, existing }. */
export function quoteShipyard(world, planetId, design) {
  const p = world.planets[planetId], existing = yardListValue(p);
  const list = shipyardPrice(design), surcharge = crowdingSurcharge(existing), price = list + surcharge;
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

/** Sell a shipyard: it's removed and SHIPYARD_SELL_REFUND of what was paid comes back. */
export function sellShipyard(world, pid, planetId, yardId) {
  const p = world.planets[planetId], pl = world.players[pid];
  if (!p || p.owner !== pid) return { ok: false, error: 'You don\'t hold that world.' };
  const k = p.yards.findIndex((y) => y.id === yardId);
  if (k < 0) return { ok: false, error: 'No such shipyard.' };
  const [y] = p.yards.splice(k, 1);
  const refund = Math.round(y.paid * SHIPYARD_SELL_REFUND);
  pl.credits += refund;
  log(world, 'yard', `${pl.name} sold the ${world.designs[y.design].name} shipyard at ${p.name} for ${refund.toLocaleString()} cr.`, { planet: p.id, players: [pid] });
  return { ok: true, refund };
}

export const sellValue = (yard) => Math.round(yard.paid * SHIPYARD_SELL_REFUND);

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
      if (y.next > t) continue;
      const k = Math.floor((t - y.next) / YARD_MS) + 1;
      addShips(p, p.owner, y.design, k);
      y.next += k * YARD_MS; y.built += k;
    }
  }
  world.clock = t;
}

/**
 * The next thing due at or before t, or null:
 *  { kind: 'fleet', fleet, at }  a fleet reaches the next world on its route
 *  { kind: 'siege', siege, at }  a siege's hold is over: the battle starts
 * At the same moment fleets go first, so a fleet arriving exactly on time still joins the fight.
 */
export function dueEvent(world, t) {
  let ev = null;
  for (const f of world.fleets) {
    if (f.wait != null || f.next > t) continue;
    if (!ev || f.next < ev.at || (f.next === ev.at && f.id < ev.fleet.id)) ev = { kind: 'fleet', fleet: f, at: f.next };
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
  world.proposals ??= [];
  if (!world.relations) {
    world.relations = {};
    for (const a of world.players) for (const b of world.players) if (a.id < b.id && a.team && a.team === b.team) world.relations[`${a.id}|${b.id}`] = 'ally';
  }
  world.version = 3;
  return world;
}

export const countShips = (ships) => Object.values(ships).reduce((s, n) => s + n, 0);
export const fleetValue = (world, ships) => Object.entries(ships).reduce((s, [d, n]) => s + world.designs[d].cost * n, 0);

export function fmtHours(h) {
  if (h < 1 / 60) return 'under a minute';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min`;
  return `${(h / 24).toFixed(1)} days`;
}

// ---------------------------------------------------------------- arrivals and sieges
//
// A fleet stops at every world on its route. At its own or an ally's world it joins the garrison
// (its destination) or flies on. At any other world:
//  - if a siege is already under way there, led by an ally, it joins that siege;
//  - if this is its destination, or there are defenders, it starts a siege;
//  - otherwise (passing a world nobody defends) it flies on.
// A siege holds for BATTLE_HOLD_MIN, so both sides can bring reinforcements: allied fleets that
// arrive join the attack, and the defenders' own and allied fleets join the garrison (as does
// anything their shipyards build). Then everyone there fights one battle. If the attackers win
// they take the world (even a world they were only passing: owner's rule), every shipyard on it is
// destroyed, and each fleet carries on as if it had just arrived (garrisoning it, or flying on).
// If they lose, the survivors fall back.
//
// Fleets that leave a siege are "released": they arrive again at that world, and whatever is true
// now (who owns it, who is allied with whom) decides what they do. That one rule covers winning,
// alliances changing during a hold, and a siege with nobody left to fight.

/** Ships at P that would fight an attack by `attacker`: the owner's side, minus anyone allied with the attacker. */
export function defendersAt(world, P, attacker) {
  return P.garrison.filter((s) => s.n > 0 && !allied(world, s.owner, attacker)
    && (P.owner === null ? s.owner === null : s.owner === P.owner || allied(world, s.owner, P.owner)));
}

export const siegeAt = (world, planetId) => world.sieges.filter((s) => s.planet === planetId);
const siegeFleets = (world, s) => s.fleets.map((id) => world.fleets.find((f) => f.id === id)).filter(Boolean);

/**
 * What an event will do (doesn't change the world):
 *  fleet:  { kind: 'join' | 'pass' | 'hold' | 'siege' }   join a garrison / fly on / join a siege / start one
 *  siege:  { kind: 'release' }   nothing to fight any more (owner now allied): everyone re-arrives
 *          { kind: 'capture' }   nobody left defending: the attackers take it
 *          { kind: 'battle', battle }  a Battle scenario (attackers team 0, defenders team 1)
 */
export function planEvent(world, ev) {
  if (ev.kind === 'fleet') {
    const f = ev.fleet, L = f.legs[f.leg], final = f.leg >= f.legs.length - 1, P = world.planets[L.to];
    if (allied(world, f.owner, P.owner)) return { kind: final ? 'join' : 'pass' };
    const s = siegeAt(world, P.id).find((x) => allied(world, x.leader, f.owner));
    if (s) return { kind: 'hold', siege: s.id };
    if (final || defendersAt(world, P, f.owner).length) return { kind: 'siege' };
    return { kind: 'pass' };
  }
  const s = ev.siege, P = world.planets[s.planet];
  if (allied(world, s.leader, P.owner)) return { kind: 'release' };
  const fleets = siegeFleets(world, s);
  const defenders = defendersAt(world, P, s.leader);
  if (!fleets.length) return { kind: 'release' };
  if (!defenders.length) return { kind: 'capture' };
  const groups = [
    ...fleets.flatMap((f) => Object.entries(f.ships).map(([design, n]) => ({ side: 0, owner: f.owner, design, n, fleet: f.id }))),
    ...defenders.map((d) => ({ side: 1, owner: d.owner, design: d.design, n: d.n })),
  ];
  const battle = makeBattleScenario(groups, (id) => designOf(world, id), (world.seed * 1000003 + s.id * 131) >>> 0);
  Object.assign(battle, {
    maxTime: BATTLE_MAX_TIME, planet: P.id, attacker: s.leader, defender: P.owner,
    attackers: [...new Set(fleets.map((f) => f.owner))], passing: fleets.every((f) => f.leg < f.legs.length - 1),
  });
  return { kind: 'battle', battle };
}

/** Apply an event. `result` is readBattle()'s output for a battle, else null. Returns the log entry written, if any. */
export function applyEvent(world, ev, plan, result) {
  let entry = null;
  if (ev.kind === 'fleet') entry = fleetArrives(world, ev.fleet, plan);
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
    log(world, 'siege', `${countShips(f.ships)} of ${me}'s ships joined the attack on ${P.name}${owner}. The battle starts ${clockIn(world, s.startsAt)}.`,
      { planet: P.id, players: [f.owner, P.owner].filter((x) => x !== null), siege: { by: s.leader, against: P.owner, startsAt: s.startsAt, join: true } });
    return lastLog(world);
  }
  // A new siege.
  const s = { id: newId(world), planet: P.id, leader: f.owner, fleets: [f.id], startsAt: world.clock + HOLD_MS, against: P.owner };
  world.sieges.push(s);
  f.wait = s.id; f.next = Infinity;
  const why = f.leg < f.legs.length - 1 ? ` on its way to ${world.planets[f.to].name}` : '';
  log(world, 'siege', `${me}'s fleet (${countShips(f.ships)} ships) reached the ${held}world ${P.name}${owner}${why}. The battle starts in ${startsIn}: both sides can still send reinforcements.`,
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

function siegeEnds(world, s, plan, result) {
  world.sieges.splice(world.sieges.indexOf(s), 1);
  const P = world.planets[s.planet], fleets = siegeFleets(world, s);
  if (plan.kind === 'release') { for (const f of fleets) release(world, f); return null; }
  if (plan.kind === 'capture') {
    const entry = capture(world, P, s.leader, {}, null);
    for (const f of fleets) release(world, f);
    return entry;
  }
  // A battle. Apply the defenders' losses, then each attacking fleet's.
  const lost = [0, 0], value = [0, 0], ships = [0, 0], survived = [0, 0];
  const defenderIds = new Set();
  const byFleet = new Map(fleets.map((f) => [f.id, {}]));
  for (const g of result.groups) {
    const cost = world.designs[g.design].cost;
    value[g.side] += g.n * cost; lost[g.side] += (g.n - g.survived) * cost; ships[g.side] += g.n; survived[g.side] += g.survived;
    if (g.side === 0) { const m = byFleet.get(g.fleet); if (m && g.survived) m[g.design] = (m[g.design] || 0) + g.survived; continue; }
    if (g.owner !== null) defenderIds.add(g.owner);
    const st = P.garrison.find((x) => x.owner === g.owner && x.design === g.design);
    if (st) st.n = Math.max(0, st.n - (g.n - g.survived));
  }
  tidyGarrison(P);
  for (const f of fleets) f.ships = byFleet.get(f.id);
  const attackers = [...new Set(fleets.map((f) => f.owner))];
  const passing = fleets.every((f) => f.leg < f.legs.length - 1);
  const battle = {
    id: `b${newId(world)}`, attacker: s.leader, attackers, defender: P.owner, defenders: [...defenderIds], won: result.attackerWon,
    passing, captured: result.attackerWon, seconds: result.seconds, ships, survived, value, lost, target: P.id,
  };
  const who = [...attackers, ...defenderIds];
  const allies = attackers.length > 1 ? ` and ${attackers.filter((a) => a !== s.leader).map((a) => playerName(world, a)).join(', ')}` : '';
  const defAllies = [...defenderIds].filter((d) => d !== P.owner);
  const helped = defAllies.length ? `, helped by ${defAllies.map((d) => playerName(world, d)).join(', ')}` : '';
  const owner = P.owner === null ? ' (militia)' : ` (${playerName(world, P.owner)}${helped})`;
  let entry;
  if (result.attackerWon) {
    // The side that still has the most ships there takes it: the leader unless all its ships died.
    const alive = fleets.filter((f) => countShips(f.ships));
    const captor = alive.some((f) => f.owner === s.leader) ? s.leader
      : alive.map((f) => [f.owner, fleetValue(world, f.ships)]).sort((a, b) => b[1] - a[1])[0][0];
    entry = capture(world, P, captor, {}, { battle });
    entry.text = `${playerName(world, s.leader)}${allies} won the battle for ${P.name}${owner}. ${entry.text.split('. ').slice(1).join('. ')}`.replace(/\s+$/, '');
    for (const f of fleets) { if (countShips(f.ships)) release(world, f); else dropFleet(world, f); }
  } else {
    const tails = [];
    for (const f of fleets) {
      dropFleet(world, f);
      const n = countShips(f.ships);
      if (!n) continue;
      const back = retreatTarget(world, f, P);
      const pv = back === null ? null : previewFleet(world, P.id, back, f.ships, { owner: f.owner, lanes: true, avoid: true });
      const ships = `${n} of ${playerName(world, f.owner)}'s ships`, one = n === 1;
      if (pv?.ok) { launch(world, f.owner, P.id, back, f.ships, pv, true); tails.push(`${ships} ${one ? 'falls' : 'fall'} back to ${world.planets[back].name}`); }
      else tails.push(`${ships} ${one ? 'has' : 'have'} nowhere to go and ${one ? 'is' : 'are'} lost`);
    }
    const tail = tails.length ? ` ${tails.join('; ')}.` : ' None of the attackers survived.';
    log(world, 'battle', `${playerName(world, s.leader)}${allies} attacked ${P.name}${owner} and ${attackers.length > 1 ? 'were' : 'was'} beaten off.${tail}`, { planet: P.id, players: who, battle });
    entry = lastLog(world);
  }
  return entry;
}

/** Take a world: every shipyard on it is destroyed, the income moves, the ships garrison it. */
function capture(world, P, owner, ships, battleInfo) {
  const old = P.owner, yards = P.yards.length;
  P.yards = [];
  P.owner = owner;
  // Anyone left who isn't on the new owner's side (only disarmed hulks can be) is gone.
  P.garrison = P.garrison.filter((s) => s.n > 0 && allied(world, s.owner, owner));
  for (const [d, n] of Object.entries(ships)) addShips(P, owner, d, n);
  const me = playerName(world, owner);
  const from = old === null ? '' : ` from ${playerName(world, old)}`;
  const how = battleInfo ? 'won the battle for' : 'took';
  const ruin = yards ? ` ${yards} shipyard${yards > 1 ? 's' : ''} destroyed.` : '';
  log(world, battleInfo ? 'battle' : 'capture', `${me} ${how} ${P.name}${from}.${ruin} +${P.income.toLocaleString()} cr/h.`, { planet: P.id, players: old === null ? [owner] : [owner, old], capture: { by: owner, from: old, yards }, ...(battleInfo || {}) });
  return world.log[world.log.length - 1];
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
// worlds are sent home, and fleets waiting in a siege next to their new enemy are released to
// arrive again under the new terms.

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

/** End an alliance: the two players are enemies from now on. */
export function breakAlliance(world, pid, other) {
  if (!allied(world, pid, other) || pid === other) return { ok: false, error: 'You aren\'t allied with them.' };
  setAllied(world, pid, other, false);
  const sentHome = [];
  // Guests on the other side's worlds go home (to the nearest world still friendly to them).
  for (const P of world.planets) {
    for (const [guest, host] of [[pid, other], [other, pid]]) {
      if (P.owner !== host || allied(world, P.owner, guest)) continue;
      const ships = shipsAt(P, guest);
      if (!countShips(ships)) continue;
      P.garrison = P.garrison.filter((s) => s.owner !== guest);
      const fake = { from: -1, owner: guest };
      const back = retreatTarget(world, fake, P);
      const mobile = Object.fromEntries(Object.entries(ships).filter(([d]) => world.designs[d].speed >= MIN_FLEET_SPEED));
      const pv = back === null || !countShips(mobile) ? null : previewFleet(world, P.id, back, mobile, { owner: guest, lanes: true, avoid: true });
      if (pv?.ok) launch(world, guest, P.id, back, mobile, pv, true);
      sentHome.push(`${countShips(ships)} of ${world.players[guest].name}'s ships ${pv?.ok ? 'leave' : 'are stranded and lost at'} ${P.name}`);
    }
  }
  // Fleets waiting in a siege whose leader is now an enemy arrive again under the new terms.
  for (const s of world.sieges) {
    for (const f of siegeFleets(world, s)) {
      if (allied(world, f.owner, s.leader)) continue;
      s.fleets = s.fleets.filter((id) => id !== f.id);
      release(world, f);
    }
  }
  const tail = sentHome.length ? ` ${sentHome.join('; ')}.` : '';
  log(world, 'diplomacy', `${world.players[pid].name} broke the alliance with ${world.players[other].name}. They are enemies now.${tail}`, { players: [pid, other], diplomacy: { kind: 'break', a: pid, b: other } });
  checkPlayers(world);
  return { ok: true };
}
