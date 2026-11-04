// The persistent world: galaxy, players, credits, shipyards, garrisons and fleets.
//
// The state is one plain JSON-serialisable object, and every rule is a function of it plus a
// game clock (ms), with no DOM and no wall clock, so the same code can run on the server. For now
// the galaxy page runs it in the browser as a hot-seat game.
//
// Time moves in two ways:
//  - advanceTo(world, t) accrues income and shipyard production up to t. Both are linear in time,
//    so a long gap (the server was idle, the page was closed) costs the same as a short one.
//  - Fleet arrivals are discrete events. runWorld() (or the page's async version) advances to each
//    arrival in order, resolves it (joining a garrison, capturing an empty world, or a battle),
//    then carries on.
//
// Battles are not run in here: arrivalPlan() returns a Battle scenario, the caller runs the sim
// (src/sim/battle.js) however it likes (Node worker, browser with a progress bar) and passes
// readBattle()'s result to completeArrival().

import { analyzeDesign, decodeDesign, encodeDesign, designCost } from '../shared/shipStats.js';
import { makeDesign } from '../shared/designs.js';
import { mulberry32 } from '../shared/rng.js';
import {
  SHIPYARD_INTERVAL_MIN, shipyardPrice, crowdingMult, SHIPYARD_SELL_REFUND,
  STARTING_CREDITS, NEUTRAL_GARRISON_HOURS,
} from '../shared/economy.js';
import { generateGalaxy } from './galaxyGen.js';
import { planRoute, travelSpeed, laneMap } from './routes.js';
import { makeBattleScenario } from './battleSetup.js';
import { HOUR_MS, MIN_FLEET_SPEED, PLAYER_COLORS, MIN_PLAYERS, MAX_PLAYERS, BATTLE_MAX_TIME } from './rules.js';

export const YARD_MS = SHIPYARD_INTERVAL_MIN * 60 * 1000;
const LOG_KEEP = 400;

// ---------------------------------------------------------------- creation

/**
 * players: [{ name, color?, team? }] (2–10). team: '' for nobody, or any label: players with the
 * same label are allies (they can station ships on each other's worlds and defend them together).
 */
export function createWorld({ players, seed = 1, planetsPerPlayer, clock = 0 }) {
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) throw new Error(`A game needs ${MIN_PLAYERS}–${MAX_PLAYERS} players.`);
  const g = generateGalaxy({ players: players.length, seed, planetsPerPlayer });
  const world = {
    format: 'lsb-world', version: 1, seed, clock, nextId: 1, winner: null,
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
    log: [],
  };
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
  if (world.log.length > LOG_KEEP) world.log.splice(0, world.log.length - LOG_KEEP);
}

/** Same player, or two players on the same (non-empty) team. Militia (null) has no allies. */
export function allied(world, a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (a === b) return true;
  const ta = world.players[a]?.team, tb = world.players[b]?.team;
  return !!ta && ta === tb;
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

/** What a shipyard for this design would cost on this world right now: { list, mult, price }. */
export function quoteShipyard(world, planetId, design) {
  const p = world.planets[planetId], existing = yardListValue(p);
  const list = shipyardPrice(design), mult = crowdingMult(existing);
  return { list, mult, price: Math.round(list * mult), existing };
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

// ---------------------------------------------------------------- time

/**
 * Accrue income and shipyard production up to game time t (ms). Doesn't process arrivals: the
 * caller makes sure no fleet arrives before t (runWorld does).
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

/** The first fleet due to arrive at or before t, or null. */
export function dueFleet(world, t) {
  let f = null;
  for (const x of world.fleets) if (x.arrive <= t && (!f || x.arrive < f.arrive || (x.arrive === f.arrive && x.id < f.id))) f = x;
  return f;
}

/** Synchronous driver (server, tests): advance to t, resolving every arrival on the way. */
export function runWorld(world, t, resolveBattle) {
  for (;;) {
    const f = dueFleet(world, t);
    if (!f) break;
    advanceTo(world, f.arrive);
    const plan = arrivalPlan(world, f);
    completeArrival(world, f, plan, plan.kind === 'battle' ? resolveBattle(plan.battle, plan) : null);
  }
  advanceTo(world, t);
}

// ---------------------------------------------------------------- fleets

const laneCache = new WeakMap();
const lanesOf = (world) => { let m = laneCache.get(world); if (!m) laneCache.set(world, (m = laneMap(world.lanes))); return m; };

/** Slowest ship's battle speed in a { designId: n } set. */
export const fleetSpeed = (world, ships) => Math.min(...Object.keys(ships).filter((d) => ships[d] > 0).map((d) => world.designs[d].speed));

/** Route for a set of ships without sending them: { ok, error?, hours, legs, speed }. */
export function previewFleet(world, from, to, ships, useLanes = true) {
  const ids = Object.keys(ships).filter((d) => ships[d] > 0);
  if (!ids.length) return { ok: false, error: 'Pick some ships to send.' };
  if (from === to) return { ok: false, error: 'They\'re already there.' };
  const slow = ids.filter((d) => world.designs[d].speed < MIN_FLEET_SPEED);
  if (slow.length) return { ok: false, error: `${world.designs[slow[0]].name} has no engines to speak of and can't leave its world.` };
  const speed = travelSpeed(fleetSpeed(world, ships));
  const r = planRoute(world.planets, lanesOf(world), from, to, speed, useLanes);
  return { ok: true, speed, ...r };
}

/** Send ships from a world's garrison. ships: { designId: n }. Returns { ok, error?, fleet? }. */
export function sendFleet(world, pid, from, to, ships, useLanes = true) {
  const pl = world.players[pid], P = world.planets[from];
  if (!pl || !P || !world.planets[to]) return { ok: false, error: 'No such world or player.' };
  if (pl.eliminated) return { ok: false, error: `${pl.name} is out of the game.` };
  const have = shipsAt(P, pid);
  for (const [d, n] of Object.entries(ships)) {
    if (n < 0 || !Number.isInteger(n)) return { ok: false, error: 'Ship counts must be whole numbers.' };
    if (n > (have[d] || 0)) return { ok: false, error: `Only ${have[d] || 0} ${world.designs[d]?.name ?? 'ships'} at ${P.name}.` };
  }
  const clean = Object.fromEntries(Object.entries(ships).filter(([, n]) => n > 0));
  const plan = previewFleet(world, from, to, clean, useLanes);
  if (!plan.ok) return plan;
  for (const [d, n] of Object.entries(clean)) P.garrison.find((s) => s.owner === pid && s.design === d).n -= n;
  tidyGarrison(P);
  const fleet = launch(world, pid, from, to, clean, plan, useLanes, false);
  const T = world.planets[to];
  log(world, 'fleet', `${pl.name} sent ${countShips(clean)} ships from ${P.name} to ${T.name}, arriving in ${fmtHours(plan.hours)}.`, { planet: to, players: [pid] });
  return { ok: true, fleet };
}

function launch(world, owner, from, to, ships, plan, useLanes, retreat) {
  const fleet = { id: newId(world), owner, ships, from, to, legs: plan.legs, speed: plan.speed, useLanes, retreat, depart: world.clock, arrive: world.clock + Math.round(plan.hours * HOUR_MS) };
  world.fleets.push(fleet);
  return fleet;
}

export const countShips = (ships) => Object.values(ships).reduce((s, n) => s + n, 0);
export const fleetValue = (world, ships) => Object.entries(ships).reduce((s, [d, n]) => s + world.designs[d].cost * n, 0);

export function fmtHours(h) {
  if (h < 1 / 60) return 'under a minute';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min`;
  return `${(h / 24).toFixed(1)} days`;
}

// ---------------------------------------------------------------- arrivals

/**
 * What happens when this fleet arrives (doesn't change the world):
 *  { kind: 'join' }      its own or an ally's world: the ships join the garrison
 *  { kind: 'capture' }   an enemy or unclaimed world with nobody armed defending it
 *  { kind: 'battle', battle }   a Battle scenario: { designs, ships, groups, seed, maxTime }
 */
export function arrivalPlan(world, fleet) {
  const P = world.planets[fleet.to];
  if (allied(world, fleet.owner, P.owner)) return { kind: 'join' };
  const defenders = P.garrison.filter((s) => s.n > 0 && !allied(world, s.owner, fleet.owner));
  if (!defenders.length) return { kind: 'capture' };
  const groups = [
    ...Object.entries(fleet.ships).map(([design, n]) => ({ side: 0, owner: fleet.owner, design, n })),
    ...defenders.map((s) => ({ side: 1, owner: s.owner, design: s.design, n: s.n })),
  ];
  const battle = makeBattleScenario(groups, (id) => designOf(world, id), (world.seed * 1000003 + fleet.id) >>> 0);
  battle.maxTime = BATTLE_MAX_TIME;
  battle.planet = P.id;
  battle.attacker = fleet.owner;
  battle.defender = P.owner;
  return { kind: 'battle', battle };
}

/**
 * Apply an arrival. `result` is readBattle()'s output for a battle, else null.
 * Returns the log entry written.
 */
export function completeArrival(world, fleet, plan, result) {
  const k = world.fleets.indexOf(fleet);
  if (k >= 0) world.fleets.splice(k, 1);
  const P = world.planets[fleet.to], me = playerName(world, fleet.owner);
  let entry;
  if (plan.kind === 'join') {
    for (const [d, n] of Object.entries(fleet.ships)) addShips(P, fleet.owner, d, n);
    log(world, 'arrive', `${countShips(fleet.ships)} of ${me}'s ships ${fleet.retreat ? 'fell back to' : 'arrived at'} ${P.name}.`, { planet: P.id, players: [fleet.owner] });
  } else if (plan.kind === 'capture') {
    capture(world, P, fleet.owner, fleet.ships, null);
  } else {
    const before = { att: fleetValue(world, fleet.ships), def: 0 }, lost = { att: 0, def: 0 };
    const survivors = {};
    const defenderIds = new Set();
    for (const g of result.groups) {
      const cost = world.designs[g.design].cost;
      if (g.side === 0) { survivors[g.design] = (survivors[g.design] || 0) + g.survived; lost.att += (g.n - g.survived) * cost; continue; }
      before.def += g.n * cost; lost.def += (g.n - g.survived) * cost;
      if (g.owner !== null) defenderIds.add(g.owner);
      const s = P.garrison.find((x) => x.owner === g.owner && x.design === g.design);
      if (s) s.n = Math.max(0, s.n - (g.n - g.survived));
    }
    tidyGarrison(P);
    const att = Object.fromEntries(Object.entries(survivors).filter(([, n]) => n > 0));
    const battleInfo = {
      battle: {
        id: `b${fleet.id}`, attacker: fleet.owner, defender: P.owner, defenders: [...defenderIds], won: result.attackerWon, seconds: result.seconds,
        ships: [countShips(fleet.ships), result.groups.filter((g) => g.side === 1).reduce((s, g) => s + g.n, 0)],
        survived: [result.groups.filter((g) => g.side === 0).reduce((s, g) => s + g.survived, 0), result.groups.filter((g) => g.side === 1).reduce((s, g) => s + g.survived, 0)],
        value: [before.att, before.def], lost: [lost.att, lost.def],
      },
    };
    const who = [fleet.owner, ...defenderIds];
    if (result.attackerWon) {
      entry = capture(world, P, fleet.owner, att, battleInfo);
    } else {
      const backTo = retreatTarget(world, fleet);
      const n = countShips(att);
      let tail;
      if (n && backTo !== null) {
        const plan2 = previewFleet(world, P.id, backTo, att, true);
        if (plan2.ok) { launch(world, fleet.owner, P.id, backTo, att, plan2, true, true); tail = ` ${n} surviving ships fall back to ${world.planets[backTo].name}.`; }
        else tail = ` ${n} surviving ships can't get away and are lost.`;
      } else if (n) tail = ` ${n} surviving ships have nowhere to go and are lost.`;
      else tail = ' None of the attackers survived.';
      log(world, 'battle', `${me} attacked ${P.name}${P.owner === null ? '' : ` (${playerName(world, P.owner)})`} and was beaten off.${tail}`, { planet: P.id, players: who, ...battleInfo });
      entry = world.log[world.log.length - 1];
    }
  }
  checkPlayers(world);
  return entry ?? world.log[world.log.length - 1];
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
  log(world, battleInfo ? 'battle' : 'capture', `${me} ${how} ${P.name}${from}.${ruin} +${P.income.toLocaleString()} cr/h.`, { planet: P.id, players: old === null ? [owner] : [owner, old], ...(battleInfo || {}) });
  return world.log[world.log.length - 1];
}

/** Where beaten attackers go: where they came from if it's still friendly, else the nearest friendly world. */
function retreatTarget(world, fleet) {
  const from = world.planets[fleet.from];
  if (from && allied(world, from.owner, fleet.owner)) return from.id;
  const here = world.planets[fleet.to];
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
  if (left.length && left.every((p) => allied(world, p.id, left[0].id)) && world.players.length > left.length) {
    world.winner = left.map((p) => p.id);
    log(world, 'win', `${left.map((p) => p.name).join(' and ')} ${left.length > 1 ? 'have' : 'has'} won the galaxy.`, { players: world.winner });
  }
}
