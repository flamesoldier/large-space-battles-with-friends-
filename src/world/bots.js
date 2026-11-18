// Bot players (owner, 18 Nov 2026: "they don't have to be good, just basic bots").
//
// A bot is a normal player with `bot: true`. In 2.0 fleets fly by themselves, so all a bot decides
// is what to spend its credits on, every BOT_EVERY_MIN of game time (the server calls runBots):
//   - an enemy fleet is heading for one of its worlds (or besieging it) → defences there (5-minute
//     jobs), up to half its credits, at most once per world every 3 hours;
//   - otherwise a shipyard for one of its own generated designs (frigate to battleship), on the world
//     where that's cheapest, keeping a reserve of 2 hours' income for defences;
//   - alliance proposals to it are turned down. It never proposes one.
// Randomness comes from the world's seed, the player and the clock, so a run is repeatable.

import { makeDesign } from '../shared/designs.js';
import { BT } from '../shared/blocks.js';
import { mulberry32 } from '../shared/rng.js';
import { defensePrice } from '../shared/economy.js';
import { HOUR_MS } from './rules.js';
import {
  quoteShipyard, buildShipyard, buildDefense, defenseProblem, declineAlliance, proposalsFor,
  pinned, jobsAt, incomeOf,
} from './world.js';

export const BOT_EVERY_MIN = 10;
const BOT_EVERY_MS = BOT_EVERY_MIN * 60000;
const SHIP_CLASSES = ['frigate', 'destroyer', 'destroyer', 'cruiser', 'cruiser', 'battleship'];
const DEFENCE_GAP_MS = 3 * HOUR_MS;

const cache = new Map(); // `${seed}:${pid}` → { ships, defence }
function botDesigns(world, pid) {
  const key = `${world.seed}:${pid}`;
  if (cache.has(key)) return cache.get(key);
  const name = world.players[pid].name;
  const base = (world.seed * 7919 + pid * 101) >>> 0;
  const ships = ['frigate', 'destroyer', 'cruiser', 'battleship'].map((cls, k) => ({ ...makeDesign(cls, base + k), name: `${name} ${cls}` }));
  let defence = null;
  for (let k = 0; k < 20 && !defence; k++) {
    const d = makeDesign('cruiser', base + 50 + k);
    const fort = { ...d, cells: d.cells.map((t) => (t === BT.THRUSTER ? BT.ARMOR : t)), name: `${name} fort` };
    if (!defenseProblem(fort)) defence = fort;
  }
  const v = { ships, defence };
  cache.set(key, v);
  return v;
}

export const isBot = (p) => !!p?.bot;
export const hasBots = (world) => world.players.some((p) => p.bot && !p.eliminated);

/** When the bots next act (game time). */
export const botsDue = (world) => (hasBots(world) ? world.botNext ?? world.clock : Infinity);

/** Let every bot take its turn now and set the next turn. Returns the number of things bought. */
export function runBots(world) {
  let n = 0;
  for (const p of world.players) if (p.bot && !p.eliminated) n += botTurn(world, p.id);
  world.botNext = world.clock + BOT_EVERY_MS;
  return n;
}

export function botTurn(world, pid) {
  const pl = world.players[pid];
  const r = mulberry32((world.seed * 31 + pid * 977 + Math.floor(world.clock / 60000)) >>> 0);
  for (const pr of proposalsFor(world, pid)) declineAlliance(world, pid, pr.from);
  const { ships, defence } = botDesigns(world, pid);
  const mine = world.planets.filter((P) => P.owner === pid);
  if (!mine.length) return 0;
  let n = 0;
  pl.botDef ??= {};

  // 1. Defend worlds an enemy is coming for.
  if (defence) {
    for (const P of mine) {
      if (!pinned(world, P, pid)) continue;
      if ((pl.botDef[P.id] ?? -Infinity) > world.clock - DEFENCE_GAP_MS || jobsAt(world, P.id, 'defence').length) continue;
      const each = defensePrice(defence);
      const count = Math.min(200, Math.floor((pl.credits * 0.5) / each));
      if (count < 1) continue;
      if (buildDefense(world, pid, P.id, defence, count).ok) { pl.botDef[P.id] = world.clock; n++; }
    }
  }

  // 2. Shipyards, keeping 2 hours' income back for defences.
  const reserve = 2 * incomeOf(world, pid);
  for (let guard = 0; guard < 20; guard++) {
    const cls = SHIP_CLASSES[Math.floor(r() * SHIP_CLASSES.length)];
    const d = ships.find((s) => s.cls === cls) || ships[0];
    let best = null;
    for (const P of mine) {
      const q = quoteShipyard(world, P.id, d);
      if (q.price != null && (!best || q.price < best.q.price)) best = { P, q };
    }
    if (!best || best.q.price > pl.credits - reserve) break;
    if (!buildShipyard(world, pid, best.P.id, d).ok) break;
    n++;
  }
  return n;
}

