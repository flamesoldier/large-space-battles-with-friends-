// Game admin, run on the server machine:
//
//   npm run admin -- new-game --players "Ann,Ben,Cat,Dan" [--teams "A,A,B,B"] [--seed 42] [--worlds 7] [--force]
//       Make a new galaxy and a password for every player. The passwords are printed once:
//       send each friend theirs privately. (Stop the server first; --force replaces a game.)
//   npm run admin -- players
//       List the players.
//   npm run admin -- reset-password <player name or number> [--password "..."]
//       New password for one player (logs them out everywhere). Fine while the server runs.
//   npm run admin -- passwords
//       New passwords for everyone (logs everyone out).
//
// LSB_DATA picks the data folder (default ./data).

import { join, resolve } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createWorld } from '../src/world/world.js';
import { MIN_PLAYERS, MAX_PLAYERS, DEFAULT_PLANETS_PER_PLAYER } from '../src/world/rules.js';
import { Accounts } from './accounts.mjs';
import { Game, gameExists } from './game.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DATA = resolve(process.env.LSB_DATA || join(ROOT, 'data'));
const accounts = new Accounts(join(DATA, 'accounts.json'));

const [cmd, ...rest] = process.argv.slice(2);
const flags = {}, args = [];
for (let k = 0; k < rest.length; k++) {
  if (rest[k].startsWith('--')) { const name = rest[k].slice(2); flags[name] = rest[k + 1] && !rest[k + 1].startsWith('--') ? rest[++k] : true; }
  else args.push(rest[k]);
}
const die = (msg) => { console.error(msg); process.exit(1); };
const loadWorld = () => (gameExists(DATA) ? JSON.parse(readFileSync(join(DATA, 'game.json'), 'utf8')).world : die(`No game in ${DATA}. Run: npm run admin -- new-game --players "Ann,Ben"`));

function serverRunning() {
  const f = join(DATA, 'server.pid');
  if (!existsSync(f)) return false;
  try { process.kill(Number(readFileSync(f, 'utf8')), 0); return true; } catch { return false; }
}

function printPasswords(world, list) {
  console.log('\nPasswords (shown once: send each player theirs privately):\n');
  const w = Math.max(...world.players.map((p) => p.name.length));
  for (const [id, pw] of list) console.log(`  ${world.players[id].name.padEnd(w)}  ${pw}`);
  console.log('');
}

switch (cmd) {
  case 'new-game': {
    if (serverRunning()) die('The server is running. Stop it first, then make the new game.');
    if (gameExists(DATA) && !flags.force) die(`There is already a game in ${DATA}. Add --force to replace it (its replays are deleted too).`);
    const names = String(flags.players || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) die(`Give ${MIN_PLAYERS}–${MAX_PLAYERS} player names: --players "Ann,Ben,Cat,Dan"`);
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) die('Player names must be different.');
    const teams = flags.teams ? String(flags.teams).split(',').map((s) => s.trim()) : [];
    const seed = Number(flags.seed) || 1 + Math.floor(Math.random() * 99999);
    const planetsPerPlayer = Math.max(3, Math.min(14, Number(flags.worlds) || DEFAULT_PLANETS_PER_PLAYER));
    const world = createWorld({ players: names.map((name, k) => ({ name, team: teams[k] || '' })), seed, planetsPerPlayer });
    rmSync(join(DATA, 'replays'), { recursive: true, force: true });
    rmSync(join(DATA, 'sessions.json'), { force: true });
    rmSync(join(DATA, 'accounts.json'), { force: true });
    Game.create(DATA, world);
    const pws = world.players.map((p) => [p.id, accounts.setPassword(p.id)]);
    console.log(`New galaxy in ${DATA}: ${world.planets.length} worlds, seed ${seed}, ${names.length} players.`);
    printPasswords(world, pws);
    console.log('Start the server with: npm start');
    break;
  }
  case 'players': {
    const world = loadWorld();
    for (const p of world.players) console.log(`  ${p.id + 1}. ${p.name}${p.team ? ` (team ${p.team})` : ''}${p.eliminated ? ' (out)' : ''}${accounts.get(p.id) ? '' : '  [no password]'}`);
    break;
  }
  case 'reset-password': {
    const world = loadWorld(), q = String(args[0] ?? '');
    const p = world.players.find((x) => x.name.toLowerCase() === q.toLowerCase()) ?? world.players[Number(q) - 1];
    if (!p) die(`No player "${q}". Players: ${world.players.map((x) => x.name).join(', ')}`);
    let pw;
    try { pw = accounts.setPassword(p.id, typeof flags.password === 'string' ? flags.password : undefined); } catch (e) { die(e.message); }
    printPasswords(world, [[p.id, pw]]);
    break;
  }
  case 'passwords': {
    const world = loadWorld();
    printPasswords(world, world.players.map((p) => [p.id, accounts.setPassword(p.id)]));
    break;
  }
  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    if (cmd) process.exit(1);
}
