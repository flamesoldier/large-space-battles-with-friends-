// Making a new game, shared by the command-line admin tool and the admin web page.

import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createWorld } from '../src/world/world.js';
import { MIN_PLAYERS, MAX_PLAYERS, DEFAULT_PLANETS_PER_PLAYER } from '../src/world/rules.js';
import { Accounts } from './accounts.mjs';
import { Game } from './game.mjs';

/**
 * Replace whatever game is in `dir` with a new one and give every player a new password.
 * names: player names; teams: optional start-team labels; seed, worlds: optional.
 * Returns { world, passwords: [[playerId, password]] }. Throws with a readable message.
 */
export function makeNewGame(dir, { names, teams = [], seed, worlds } = {}) {
  names = (names || []).map((s) => String(s).trim()).filter(Boolean);
  if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) throw new Error(`A game needs ${MIN_PLAYERS}–${MAX_PLAYERS} players.`);
  if (names.some((n) => n.length > 24)) throw new Error('Player names can be at most 24 characters.');
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new Error('Player names must all be different.');
  const team = (k) => String(teams[k] ?? '').trim().slice(0, 12);
  seed = Number.isInteger(Number(seed)) && Number(seed) > 0 ? Number(seed) : 1 + Math.floor(Math.random() * 99999);
  const planetsPerPlayer = Math.max(3, Math.min(14, Number(worlds) || DEFAULT_PLANETS_PER_PLAYER));
  const world = createWorld({ players: names.map((name, k) => ({ name, team: team(k) })), seed, planetsPerPlayer });
  rmSync(join(dir, 'replays'), { recursive: true, force: true });
  rmSync(join(dir, 'accounts.json'), { force: true });
  Game.create(dir, world);
  const accounts = new Accounts(join(dir, 'accounts.json'));
  const passwords = world.players.map((p) => [p.id, accounts.setPassword(p.id)]);
  return { world, passwords };
}
