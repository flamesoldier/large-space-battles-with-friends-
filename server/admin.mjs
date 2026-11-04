// Game admin, run on the server machine:
//
//   npm run admin -- new-game --players "Ann,Ben,Cat,Dan" [--count 6] [--teams "A,A,B,B"] [--seed 42] [--worlds 7] [--force]
//       Make a new galaxy and a password for every player. The passwords are printed once:
//       send each friend theirs privately. --count makes more seats than names (or use --count
//       alone): players in unnamed seats pick their name and colour when they first log in.
//       (Stop the server first; --force replaces a game.)
//   npm run admin -- players
//       List the players.
//   npm run admin -- reset-password <player name or number> [--password "..."]
//       New password for one player (logs them out everywhere). Fine while the server runs.
//   npm run admin -- passwords
//       New passwords for everyone (logs everyone out).
//
// LSB_DATA picks the data folder (default ./data, or the Railway volume when there is one).
// The admin web page (/admin, with LSB_ADMIN_PASSWORD set) does the same things in a browser.

import { join, resolve } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Accounts } from './accounts.mjs';
import { gameExists } from './game.mjs';
import { makeNewGame } from './setup.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DATA = resolve(process.env.LSB_DATA || process.env.RAILWAY_VOLUME_MOUNT_PATH || join(ROOT, 'data'));
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
    const names = String(flags.players === true ? '' : flags.players || '').split(',');
    const teams = flags.teams ? String(flags.teams).split(',') : [];
    let made;
    try { made = makeNewGame(DATA, { count: flags.count, names, teams, seed: flags.seed, worlds: flags.worlds }); } catch (e) { die(`${e.message} Example: --players "Ann,Ben,Cat,Dan"`); }
    rmSync(join(DATA, 'sessions.json'), { force: true });
    const { world } = made;
    console.log(`New galaxy in ${DATA}: ${world.planets.length} worlds, seed ${world.seed}, ${world.players.length} players.`);
    printPasswords(world, made.passwords);
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
