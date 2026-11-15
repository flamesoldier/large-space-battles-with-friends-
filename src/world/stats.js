// Game statistics for the end-of-game screens (owner, 16 Nov 2026: "a full-screen victory card
// with final standings").
//
// world.stats = {
//   since,        clock when tracking started (games from before this have their history rebuilt
//                 from the log by backfillStats; `backfilled` says so)
//   p: { [playerId]: { built, defences, lost, lostValue, killedValue, earned, bounty, battles,
//                      wins, taken, peak, biggest: { ships, planet } | null } },
//   battles, destroyed,   galaxy totals: battles fought, ships destroyed (militia included)
//   biggest, longest:     { id, planet, t, ships, value, lost, seconds, players } | null
// }
// world.final = the standings frozen when the galaxy was won (finalize), so the victory card shows
// the moment of victory even though play carries on afterwards.
//
// Nobody tracks who killed whom (owner's bounty rule), so `killedValue` is everything lost in a
// player's battles by the sides at war with them, like the bounty.
//
// No imports from world.js (it imports this file): the few helpers needed are copied.

import { HOUR_MS } from './rules.js';

const ally = (world, a, b) => a !== null && b !== null && a !== undefined && b !== undefined
  && (a === b || world.relations?.[a < b ? `${a}|${b}` : `${b}|${a}`] === 'ally');
const blank = () => ({ built: 0, defences: 0, lost: 0, lostValue: 0, killedValue: 0, earned: 0, bounty: 0, battles: 0, wins: 0, taken: 0, peak: 0, biggest: null });

export function playerStats(world, pid) {
  const S = world.stats;
  if (!S || pid === null || pid === undefined || !world.players[pid]) return null;
  return (S.p[pid] ??= blank());
}

export const worldsOf = (world, pid) => world.planets.reduce((n, p) => n + (p.owner === pid ? 1 : 0), 0);

/** Ships a player has right now (garrisons and fleets), split into ships and defences. */
export function shipsOf(world, pid) {
  let ships = 0, defences = 0, value = 0;
  const add = (design, n) => {
    const d = world.designs[design];
    if (d?.fixed) defences += n; else ships += n;
    value += n * (d?.worth ?? d?.cost ?? 0);
  };
  for (const P of world.planets) for (const s of P.garrison) if (s.owner === pid && s.n > 0) add(s.design, s.n);
  for (const f of world.fleets) if (f.owner === pid) for (const [d, n] of Object.entries(f.ships)) add(d, n);
  return { ships, defences, value };
}

// ---------------------------------------------------------------- live updates (called from world.js)

export function noteIncome(world, pid, credits) { const s = playerStats(world, pid); if (s) s.earned += credits; }
export function noteBuilt(world, pid, n, fixed = false) { const s = playerStats(world, pid); if (s) { if (fixed) s.defences += n; else s.built += n; } }
export function noteCapture(world, pid) {
  const s = playerStats(world, pid);
  if (!s) return;
  s.taken++;
  s.peak = Math.max(s.peak, worldsOf(world, pid));
}

/** A fought battle (the `battle` object siegeEnds puts on its log entry), at world P. */
export function noteBattle(world, B, planetName, t) {
  const S = world.stats;
  if (!S || !B?.players) return;
  const per = B.players;
  const ships = per.reduce((s, q) => s + q.ships, 0), value = per.reduce((s, q) => s + q.value, 0);
  const lost = per.reduce((s, q) => s + q.lost, 0), dead = per.reduce((s, q) => s + (q.ships - q.survived), 0);
  S.battles++; S.destroyed += dead;
  const rec = { id: B.id, planet: planetName, t, ships, value, lost, seconds: B.seconds || 0, players: [...new Set(per.map((q) => q.id).filter((x) => x !== null && x !== undefined))] };
  if (!S.biggest || ships > S.biggest.ships || (ships === S.biggest.ships && value > S.biggest.value)) S.biggest = rec;
  if (!S.longest || rec.seconds > S.longest.seconds) S.longest = rec;
  for (const q of per) {
    const s = playerStats(world, q.id);
    if (!s) continue;
    s.battles++;
    s.lost += q.ships - q.survived; s.lostValue += q.lost;
    for (const o of per) if (o.id !== q.id && !ally(world, o.id, q.id)) s.killedValue += o.lost;
    const won = B.won ? ally(world, q.id, B.winner) : (B.defenders || []).includes(q.id) || (B.defender !== null && ally(world, q.id, B.defender));
    if (won) s.wins++;
    s.bounty += B.bounty?.[q.id] || 0;
    if (!s.biggest || ships > s.biggest.ships) s.biggest = { ships, planet: planetName };
  }
}

// ---------------------------------------------------------------- history (games from before stats)

/**
 * Rebuild what can be rebuilt from the log for a game that started before stats were kept:
 * every battle and capture still in the log, income from who held each world when (captures
 * walked back from today's owners), and ships built from today's ships plus the ones lost.
 */
export function backfillStats(world) {
  world.stats = { since: world.clock, backfilled: true, p: {}, battles: 0, destroyed: 0, biggest: null, longest: null };
  for (const pl of world.players) world.stats.p[pl.id] = blank();
  const log = world.log || [];
  const seen = new Set();
  for (const e of log) {
    if (e.battle && !seen.has(e.battle.id)) { seen.add(e.battle.id); noteBattle(world, e.battle, world.planets[e.planet]?.name ?? '?', e.t); }
    if (e.capture) { const s = playerStats(world, e.capture.by); if (s) s.taken++; }
  }
  // Income: walk captures back from today's owners to find who held each world when.
  const start = log.find((e) => e.kind === 'start')?.t ?? 0;
  const owner = world.planets.map((p) => p.owner), until = world.planets.map(() => world.clock);
  const changes = log.filter((e) => e.capture && world.planets[e.planet]).sort((a, b) => a.t - b.t || a.id - b.id);
  for (let k = changes.length - 1; k >= 0; k--) {
    const e = changes[k], P = world.planets[e.planet];
    noteIncome(world, owner[P.id], (P.income * Math.max(0, until[P.id] - e.t)) / HOUR_MS);
    owner[P.id] = e.capture.from ?? null; until[P.id] = e.t;
  }
  for (const P of world.planets) noteIncome(world, owner[P.id], (P.income * Math.max(0, until[P.id] - start)) / HOUR_MS);
  // Most worlds ever held: replay the captures forward from the owners at the start.
  const count = new Map();
  for (const o of owner) if (o !== null) count.set(o, (count.get(o) || 0) + 1);
  const peak = (o) => { const s = playerStats(world, o); if (s) s.peak = Math.max(s.peak, count.get(o) || 0); };
  for (const o of count.keys()) peak(o);
  for (const e of changes) {
    const from = e.capture.from ?? null, by = e.capture.by;
    if (from !== null) count.set(from, (count.get(from) || 1) - 1);
    if (by !== null && by !== undefined) { count.set(by, (count.get(by) || 0) + 1); peak(by); }
  }
  for (const pl of world.players) {
    const s = world.stats.p[pl.id], now = shipsOf(world, pl.id);
    s.peak = Math.max(s.peak, worldsOf(world, pl.id));
    const yards = world.planets.reduce((n, P) => n + (P.owner === pl.id ? P.yards.reduce((m, y) => m + (y.built || 0), 0) : 0), 0);
    s.built = Math.max(yards, now.ships + s.lost);
    s.defences = now.defences;
  }
  return world.stats;
}

// ---------------------------------------------------------------- standings

/** Every player's line for the end screen, best first (winners, then most worlds, then richest). */
export function standings(world) {
  const winners = world.winner || [];
  const rows = world.players.filter((pl) => pl.claimed !== false || worldsOf(world, pl.id) > 0).map((pl) => {
    const s = playerStats(world, pl.id) || blank(), now = shipsOf(world, pl.id);
    const worlds = worldsOf(world, pl.id);
    return {
      id: pl.id, name: pl.name, color: pl.color, winner: winners.includes(pl.id), eliminated: !!pl.eliminated,
      worlds, peak: Math.max(s.peak, worlds), income: world.planets.reduce((n, p) => n + (p.owner === pl.id ? p.income : 0), 0),
      ships: now.ships, defences: now.defences, fleetValue: Math.round(now.value),
      built: s.built, builtDefences: s.defences, lost: s.lost, lostValue: Math.round(s.lostValue), killedValue: Math.round(s.killedValue),
      earned: Math.round(s.earned + s.bounty), income_earned: Math.round(s.earned), bounty: Math.round(s.bounty),
      battles: s.battles, wins: s.wins, taken: s.taken, biggest: s.biggest, credits: Math.floor(pl.credits),
    };
  });
  rows.sort((a, b) => b.winner - a.winner || b.worlds - a.worlds || b.earned - a.earned || b.killedValue - a.killedValue);
  rows.forEach((r, k) => { r.rank = k + 1; });
  return rows;
}

/** The player on the throne: the winner holding the most worlds (ties: income, then credits earned). */
export function throneOf(rows) {
  const w = rows.filter((r) => r.winner);
  const pool = w.length ? w : rows;
  return [...pool].sort((a, b) => b.worlds - a.worlds || b.income - a.income || b.earned - a.earned)[0]?.id ?? null;
}

/** Freeze the standings at the moment of victory (world.final). */
export function finalize(world) {
  if (!world.winner) return null;
  const rows = standings(world);
  const S = world.stats || {};
  const start = (world.log || []).find((e) => e.kind === 'start')?.t ?? 0;
  world.final = {
    t: world.clock, start, winners: [...world.winner], throne: throneOf(rows), standings: rows,
    battles: S.battles || 0, destroyed: S.destroyed || 0, biggest: S.biggest || null, longest: S.longest || null,
    backfilled: !!S.backfilled, since: S.since ?? 0,
  };
  return world.final;
}

/** What the end screen shows: the frozen standings if the galaxy has been won, else live ones. */
export function endReport(world) {
  if (world.winner && world.final) return world.final;
  const rows = standings(world), S = world.stats || {};
  return {
    t: world.clock, start: (world.log || []).find((e) => e.kind === 'start')?.t ?? 0, winners: [...(world.winner || [])], throne: throneOf(rows), standings: rows,
    battles: S.battles || 0, destroyed: S.destroyed || 0, biggest: S.biggest || null, longest: S.longest || null, backfilled: !!S.backfilled, since: S.since ?? 0, live: true,
  };
}
