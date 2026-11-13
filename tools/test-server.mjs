// Usage: node tools/test-server.mjs
// Runs the real game server on a throwaway data folder and checks logins, sessions, that nobody
// can act as another player, the login rate limit, and a full battle resolved by the worker with
// its replay served back. Needs dist/play.html (npm run build).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { makeDesign } from '../src/shared/designs.js';
import { encodeDesign } from '../src/shared/shipStats.js';
import { unpackReplay } from '../src/shared/replayFormat.js';

if (!existsSync('dist/play.html')) { console.error('dist/play.html missing: run npm run build'); process.exit(1); }

const DATA = mkdtempSync(join(tmpdir(), 'lsb-test-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, LSB_DATA: DATA, PORT: String(PORT), HOST: '127.0.0.1', LSB_SPEED: '3600', LSB_TRUST_PROXY: '1', LSB_ADMIN_PASSWORD: 'admin-test-password' };
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function admin(...args) { return execFileSync(process.execPath, ['server/admin.mjs', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function passwords(out) {
  const m = {};
  for (const line of out.split('\n')) { const x = line.match(/^\s+(\S+)\s+([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/); if (x) m[x[1]] = x[2]; }
  return m;
}

let server = null;
async function startServer() {
  server = spawn(process.execPath, ['server/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.output = '';
  server.stdout.on('data', (d) => { server.output += d; });
  server.stderr.on('data', (d) => { server.output += d; });
  for (let k = 0; k < 100; k++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`server didn't start:\n${server.output}`);
}
async function stopServer() {
  const s = server;
  const done = new Promise((r) => s.on('exit', r));
  s.kill('SIGTERM');
  await done;
}

let ip = 1;
// The build id stamped into the page the server serves (tools/build-viewer.mjs); the page sends it.
const BUILD = /<meta name="lsb-build" content="([0-9a-f]+)">/.exec(readFileSync('dist/play.html', 'utf8'))?.[1];

/** A client with its own cookie jar and (via X-Forwarded-For) its own address. */
function client() {
  const c = { cookie: '', ip: `10.0.0.${ip++}` };
  c.req = async (method, path, body, headers = {}) => {
    const res = await fetch(BASE + path, {
      method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': c.ip, ...(c.cookie ? { Cookie: c.cookie } : {}), ...headers },
    });
    const set = res.headers.get('set-cookie');
    if (set) c.cookie = set.split(';')[0];
    return res;
  };
  c.json = async (method, path, body, headers) => { const r = await c.req(method, path, body, headers); return { status: r.status, body: await r.json(), res: r }; };
  c.act = (a, build = BUILD) => c.json('POST', '/api/act', a, build ? { 'X-LSB-Build': build } : {});
  c.state = () => c.json('GET', '/api/state');
  return c;
}

try {
  // ---- a fresh install: no game yet, the admin page makes one
  await startServer();
  {
    const anon = client(), boss = client();
    ok((await anon.req('GET', '/')).status === 200 && (await (await anon.req('GET', '/admin')).text()).includes('Game admin'), 'the site and the admin page are up before there is a game');
    ok((await anon.state()).status === 503 && (await anon.json('POST', '/api/login', { password: 'abcd-efgh-jkmn' })).status === 503, 'players are told there is no game yet');
    ok((await boss.json('GET', '/api/admin/state')).status === 401, 'admin needs a login');
    ok((await boss.json('POST', '/api/admin/new-game', { players: ['A', 'B'] })).status === 401, 'no game creation without admin login');
    ok((await boss.json('POST', '/api/admin/login', { password: 'admin-test-passwor' })).status === 401, 'wrong admin password refused');
    const login = await boss.json('POST', '/api/admin/login', { password: 'admin-test-password' });
    ok(login.body.ok && login.body.game === null && /lsb_admin=/.test(boss.cookie), 'admin logs in');
    ok(!(await boss.json('POST', '/api/admin/new-game', { players: ['Solo'] })).body.ok, 'a game needs two players');
    const made = await boss.json('POST', '/api/admin/new-game', { players: ['Cat', 'Dan', 'Eve'], teams: ['A', 'A', ''], worlds: 4 });
    ok(made.body.ok && made.body.passwords.length === 3 && made.body.game.players[0].team === 'A', 'admin makes a game and gets every password');
    ok((await boss.json('POST', '/api/admin/new-game', { players: ['X', 'Y'] })).status === 409, 'replacing a game needs confirming');
    const cat = client();
    ok((await cat.json('POST', '/api/login', { password: made.body.passwords[0].password })).body.name === 'Cat', 'a player logs in with the password from the admin page');
    ok((await cat.state()).body.world.players.length === 3, 'and plays the new game');
    ok((await cat.json('GET', '/api/admin/state')).status === 401, 'a player session is not an admin session');
    const reset = await boss.json('POST', '/api/admin/reset-password', { player: 0 });
    ok(reset.body.passwords[0].name === 'Cat' && reset.body.passwords[0].password !== made.body.passwords[0].password, 'admin resets a password');
    ok((await cat.state()).status === 401, 'which logs that player out');
    // ---- open seats: players pick their own name and colour, once
    const seats = await boss.json('POST', '/api/admin/new-game', { count: 4, players: ['Cat'], replace: true });
    ok(seats.body.ok && seats.body.passwords.length === 4 && seats.body.passwords.filter((p) => p.open).length === 3, 'a game with one named player and three open seats');
    const catNow = seats.body.passwords[0].password, seat2 = seats.body.passwords[1].password, seat3 = seats.body.passwords[2].password;
    const p2 = client(), p3 = client(), cat2 = client();
    await p2.json('POST', '/api/login', { password: seat2 });
    await p3.json('POST', '/api/login', { password: seat3 });
    await cat2.json('POST', '/api/login', { password: catNow });
    let w = (await p2.state()).body.world;
    ok(w.players[1].claimed === false && w.players[0].claimed === true, 'open seats are marked until claimed');
    ok(/already called/.test((await p2.act({ type: 'claim', name: 'cat', color: '#ff4d4d' })).body.error), 'names must be different (any case)');
    ok(/of your own/.test((await p2.act({ type: 'claim', name: 'player 9', color: '#ff4d4d' })).body.error), 'placeholder names are refused');
    ok(/colours shown/.test((await p2.act({ type: 'claim', name: 'Dan', color: w.players[0].color })).body.error), 'someone else\'s colour is refused');
    ok(/colours shown/.test((await p2.act({ type: 'claim', name: 'Dan', color: 'red' })).body.error), 'made-up colours are refused');
    let c = await p2.act({ type: 'claim', name: '  Dan <b>the</b>  Bold ', color: '#FF4D4D' });
    ok(c.body.ok && c.body.state.world.players[1].name === 'Dan bthe/b Bold' && c.body.state.world.players[1].color === '#ff4d4d' && c.body.state.world.players[1].claimed, 'a player claims their seat (name tidied)');
    ok(!(await p2.act({ type: 'claim', name: 'Again', color: '#4dff88' })).body.ok, 'only once');
    ok(!(await cat2.act({ type: 'claim', name: 'Kitty', color: '#4dff88' })).body.ok, 'named players can\'t rename');
    ok(/colours shown/.test((await p3.act({ type: 'claim', name: 'Eve', color: '#ff4d4d' })).body.error), 'a colour just taken is gone');
    ok((await p3.act({ type: 'claim', name: 'Eve', color: '#4dff88' })).body.ok, 'the next player claims theirs');
    // ---- the admin controls the game's speed for everyone
    ok((await p3.json('POST', '/api/admin/speed', { speed: 0 })).status === 401, 'players can\'t change the speed');
    let sp = await boss.json('POST', '/api/admin/speed', { speed: 0 });
    ok(sp.body.ok && sp.body.game.speed === 0, 'admin pauses the game');
    const t0 = (await p2.state()).body;
    await sleep(300);
    const t1 = (await p2.state()).body;
    ok(t0.speed === 0 && t1.gameNow === t0.gameNow, 'paused: the clock stands still');
    const j = await boss.json('POST', '/api/admin/jump', { hours: 2 });
    ok(j.body.ok && Math.abs(j.body.game.clock - t1.gameNow - 2 * 3600e3) < 1000, 'jump ahead moves the clock');
    const yard2 = (await p2.state()).body.world;
    ok(yard2.players[1].credits > t1.world.players[1].credits + 2500, 'and income arrives for the jump');
    ok(!(await boss.json('POST', '/api/admin/jump', { hours: -1 })).body.ok && !(await boss.json('POST', '/api/admin/speed', { speed: 'fast' })).body.ok, 'bad speeds and jumps are refused');
    sp = await boss.json('POST', '/api/admin/speed', { speed: 600 });
    ok(sp.body.game.speed === 600 && (await p2.state()).body.speed === 600, 'players get the new speed');

    const adm = (await boss.json('GET', '/api/admin/state')).body.game.players;
    ok(adm[1].name === 'Dan bthe/b Bold' && adm[1].joined && !adm[3].joined, 'the admin page shows who has joined');

    const dan = client();
    await dan.json('POST', '/api/login', { password: catNow });
    const waiting = dan.json('GET', `/api/state?v=${(await dan.state()).body.v}`);
    const again = await boss.json('POST', '/api/admin/new-game', { players: ['Fay', 'Gus'], replace: true });
    ok(again.body.ok && again.body.game.players.length === 2, 'admin replaces the game');
    ok((await waiting).status === 401 && (await dan.state()).status === 401, 'players of the old game are sent back to the login screen');
    ok((await dan.json('POST', '/api/login', { password: made.body.passwords[1].password })).status === 401, 'old passwords stop working');
  }
  await stopServer();

  // ---- the command-line tool: a new game prints a password per player, unique
  const pw = passwords(admin('new-game', '--players', 'Ann,Ben', '--seed', '7', '--worlds', '4', '--force'));
  ok(pw.Ann && pw.Ben && pw.Ann !== pw.Ben, 'every player gets their own password');
  ok(/already a game/.test((() => { try { admin('new-game', '--players', 'X,Y'); return ''; } catch (e) { return String(e.stderr); } })()), 'new-game refuses to replace a game without --force');

  await startServer();
  const anon = client();
  const page = await anon.req('GET', '/');
  ok(page.status === 200 && (await page.text()).includes('login-form'), 'the page is served with its login form');
  ok((await anon.state()).status === 401, 'no session, no state');
  ok((await anon.act({ type: 'propose', player: 1 })).status === 401, 'no session, no actions');

  // ---- logging in
  const bad = await anon.json('POST', '/api/login', { password: 'wrong-pass-word' });
  ok(bad.status === 401 && !anon.cookie, 'a wrong password is refused');
  const ann = client(), ben = client();
  const la = await ann.json('POST', '/api/login', { password: `  ${pw.Ann.toUpperCase()} ` });
  ok(la.status === 200 && la.body.player === 0 && la.body.name === 'Ann', 'the password picks the player (case and spaces forgiven)');
  ok(/HttpOnly/.test(la.res.headers.get('set-cookie')) && /SameSite=Strict/.test(la.res.headers.get('set-cookie')), 'session cookie is HttpOnly and SameSite=Strict');
  const lb = await ben.json('POST', '/api/login', { password: pw.Ben });
  ok(lb.body.player === 1, 'Ben logs in as Ben');
  let st = (await ann.state()).body;
  ok(st.me === 0 && st.world.players.length === 2 && st.world.format === 'lsb-world', 'state says who you are and has the world');
  ok(!JSON.stringify(st).includes('scrypt'), 'no password hashes in the state');

  // ---- requests that must be refused
  ok((await ann.json('POST', '/api/act', { type: 'propose', player: 1 }, { Origin: 'https://evil.example' })).status === 403, 'cross-site POSTs are refused');
  ok((await ann.json('POST', '/api/act', 'type=propose', { 'Content-Type': 'application/x-www-form-urlencoded' })).status === 415, 'form posts are refused');
  ok((await ann.json('POST', '/api/act', '{not json')).status === 400, 'bad JSON is refused');

  // ---- nobody can act as someone else
  const W = st.world, annHome = W.players[0].home, benHome = W.players[1].home;
  const design = encodeDesign({ ...makeDesign('destroyer', 99), name: 'Test Destroyer', stance: 'line' });
  let r = await ann.act({ type: 'build', planet: benHome, design, player: 1, pid: 1, me: 1 });
  ok(r.status === 400 && /don't hold/.test(r.body.error), 'Ann can\'t build on Ben\'s world, whatever player id she sends');
  r = await ann.act({ type: 'build', planet: annHome, design, player: 1, pid: 1 });
  ok(r.body.ok && r.body.state.world.planets[annHome].yards.length === 1, 'Ann builds on her own world');
  const after = r.body.state.world;
  ok(after.players[0].credits < W.players[0].credits && Math.abs(after.players[1].credits - W.players[1].credits) < 1e4, 'and Ann pays for it, not Ben');
  const yard = after.planets[annHome].yards[0].id;
  r = await ben.act({ type: 'sell', planet: annHome, yard });
  ok(!r.body.ok, 'Ben can\'t sell Ann\'s shipyard');
  r = await ann.act({ type: 'sell', planet: annHome, yard });
  ok(r.body.ok && r.body.state.world.planets[annHome].yards[0].sellAt > 0 && r.body.state.world.jobs.length === 1, 'Ann starts selling her shipyard (it takes hours)');
  r = await ben.act({ type: 'unsell', planet: annHome, yard });
  ok(!r.body.ok, 'Ben can\'t call off Ann\'s sale');
  r = await ann.act({ type: 'unsell', planet: annHome, yard });
  ok(r.body.ok && r.body.state.world.planets[annHome].yards[0].sellAt === undefined && !r.body.state.world.jobs.length, 'Ann calls the sale off');
  const dId = after.planets[annHome].yards[0].design;
  r = await ben.act({ type: 'rename', design: dId, name: 'Ben was here' });
  ok(!r.body.ok, 'Ben can\'t rename Ann\'s design');
  r = await ann.act({ type: 'rename', design: dId, name: 'Ann Destroyer' });
  ok(r.body.ok && r.body.state.world.designs[dId].name === 'Ann Destroyer', 'Ann renames her own design');
  r = await ann.act({ type: 'rename', design: '__proto__', name: 'x' });
  ok(!r.body.ok, 'odd design ids are refused');
  const fortD = makeDesign('corvette', 7);
  const fort = encodeDesign({ ...fortD, cells: fortD.cells.map((t) => (t === 5 ? 2 : t)), name: 'Test Fort', stance: 'line' }); // thrusters → armour
  r = await ben.act({ type: 'defend', planet: annHome, design: fort, count: 2 });
  ok(!r.body.ok, 'Ben can\'t build defences on Ann\'s world');
  r = await ann.act({ type: 'defend', planet: annHome, design, count: 1 });
  ok(!r.body.ok && /thruster/.test(r.body.error), 'a design with thrusters can\'t be a defence');
  r = await ann.act({ type: 'defend', planet: annHome, design: fort, count: 'lots' });
  ok(!r.body.ok, 'defence counts must be whole numbers');
  r = await ann.act({ type: 'defend', planet: annHome, design: fort, count: 2 });
  const fortId = r.body.ok && Object.values(r.body.state.world.designs).find((d) => d.fixed)?.id;
  ok(fortId && r.body.state.world.jobs.some((j) => j.kind === 'defence' && j.design === fortId && j.count === 2 && j.owner === 0 && j.planet === annHome), 'Ann orders 2 defences on her world');
  r = await ann.act({ type: 'fleet', from: annHome, to: benHome, ships: { [fortId]: 1 } });
  ok(!r.body.ok, 'defences can\'t be sent');
  r = await ben.act({ type: 'fleet', from: annHome, to: benHome, ships: { [after.planets[annHome].yards[0].design]: 1 } });
  ok(!r.body.ok, 'Ben can\'t move Ann\'s ships');
  r = await ann.act({ type: 'fleet', from: annHome, to: 'constructor', ships: {} });
  ok(!r.body.ok && r.status === 400, 'bad world ids are refused');
  r = await ann.act({ type: 'fleet', from: annHome, to: benHome, ships: JSON.parse('{"__proto__": 5}') });
  ok(!r.body.ok, 'odd ship keys are refused');
  r = await ann.act({ type: 'build', planet: annHome, design: { w: 5000, h: 5000, cells: '' } });
  ok(!r.body.ok, 'malformed designs are refused');
  r = await ann.act({ type: 'propose', player: 0 });
  ok(!r.body.ok, 'can\'t ally with yourself');
  r = await ann.act({ type: 'propose', player: 1 });
  ok(r.body.ok && r.body.state.world.proposals.some((p) => p.from === 0 && p.to === 1), 'Ann proposes to Ben as Ann');
  r = await ben.act({ type: 'decline', player: 0 });
  ok(r.body.ok, 'Ben declines');

  // ---- long poll: a change wakes a waiting client
  st = (await ben.state()).body;
  const waiting = ben.json('GET', `/api/state?v=${st.v}&wv=${st.wv}`);
  await sleep(200);
  await ann.act({ type: 'propose', player: 1 });
  const woke = await waiting;
  ok(woke.body.v > st.v && woke.body.world.proposals.length === 1, 'a waiting client hears about the change');

  // ---- a real battle, resolved by the worker, with a replay
  // At 3600× a second is an hour: wait for some ships, then attack the nearest militia world.
  await sleep(2500);
  st = (await ann.state()).body;
  const home = st.world.planets[annHome];
  const mine = home.garrison.filter((g) => g.owner === 0 && !st.world.designs[g.design].fixed);
  ok(mine.length && mine[0].n >= 2, `the shipyard has built ships (${mine[0]?.n})`);
  const target = st.world.planets.filter((p) => p.owner === null).sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y))[0];
  r = await ann.act({ type: 'fleet', from: annHome, to: target.id, ships: { [mine[0].design]: mine[0].n } });
  // Out-of-date pages (another build, or one from before build ids) can't send orders.
  ok(!!BUILD, 'the game page carries a build id');
  const stBefore = (await ann.state()).body;
  ok(stBefore.build === BUILD, 'the server tells pages which build it runs');
  for (const [b, what] of [['0123456789ab', 'another build'], ['', 'no build id']]) {
    const o = await ann.act({ type: 'propose', player: 1 }, b);
    ok(o.status === 409 && o.body.outdated && /Refresh/.test(o.body.error) && o.body.build === BUILD, `orders from a page with ${what} are refused with "refresh"`);
  }
  ok((await ann.state()).body.v === stBefore.v, '…and not carried out (nothing changed)');
  ok(r.body.ok && r.body.fleet.owner === 0, 'Ann launches a fleet');
  r = await ben.act({ type: 'stop', fleet: r.body.fleet.id });
  ok(!r.body.ok, 'Ben can\'t call off Ann\'s fleet');
  r = await ann.act({ type: 'stop', fleet: 'x' });
  ok(!r.body.ok, 'stop needs a fleet id');
  ok(!(await ben.act({ type: 'rally', planet: annHome, to: null })).body.ok, 'Ben can\'t change Ann\'s rally points');
  ok(!(await ben.act({ type: 'renamePlanet', planet: annHome, name: 'Bens Now' })).body.ok, 'Ben can\'t rename Ann\'s world');
  ok((await ann.act({ type: 'renamePlanet', planet: annHome, name: 'Annhold' })).body.ok, 'Ann renames her world');
  ok(!(await ann.act({ type: 'renamePlanet', planet: 'x', name: 'Q' })).body.ok, 'world rename needs a real world');
  ok(!(await ann.act({ type: 'rally', planet: annHome, to: benHome })).body.ok, 'no rally point at an enemy world');
  ok(!(await ann.act({ type: 'rally', planet: 'x', to: 1 })).body.ok && !(await ann.act({ type: 'rallyAll', to: -1 })).body.ok, 'rally orders need real worlds');
  let battle = null;
  for (let k = 0; k < 600 && !battle; k++) {
    await sleep(250);
    st = (await ann.state()).body;
    battle = st.world.log.find((e) => e.battle && e.battle.target === target.id);
  }
  ok(battle, `the battle at ${target.name} was fought: ${battle?.text}`);
  ok(st.replays.includes(battle.battle.id), 'its replay is listed');
  const rep = await ann.req('GET', `/api/replay/${battle.battle.id}`);
  const meta = JSON.parse(decodeURIComponent(rep.headers.get('x-replay-meta')));
  const bytes = new Uint8Array(await rep.arrayBuffer());
  const { meta: rmeta, cols } = unpackReplay(bytes);
  ok(rep.status === 200 && meta.title.includes(target.name) && rmeta && Object.keys(cols).length > 5, 'the replay downloads and unpacks');
  ok((await anon.req('GET', `/api/replay/${battle.battle.id}`)).status === 401, 'replays need a login');
  ok((await ann.req('GET', '/api/replay/..%2Fgame')).status === 404, 'replay ids are checked');

  // ---- sessions: logout, password reset
  const ben2 = client();
  await ben2.json('POST', '/api/login', { password: pw.Ben });
  ok((await ben2.state()).status === 200, 'a second device logs in');
  await ben2.json('POST', '/api/logout', {});
  ok((await ben2.state()).status === 401, 'logging out ends that session');
  ok((await ben.state()).status === 200, 'but not Ben\'s other session');
  const newBen = passwords(admin('reset-password', 'Ben')).Ben;
  ok(newBen && newBen !== pw.Ben, 'reset-password gives a new password');
  ok((await ben.state()).status === 401, 'resetting a password logs that player out everywhere');
  ok((await ben.json('POST', '/api/login', { password: pw.Ben })).status === 401, 'the old password stops working');
  ok((await ben.json('POST', '/api/login', { password: newBen })).body.player === 1, 'the new one works');
  ok((await ann.state()).status === 200, 'other players stay logged in');

  // ---- guessing passwords: blocked after a few tries from one address
  const guesser = client();
  let last;
  for (let k = 0; k < 9; k++) last = await guesser.json('POST', '/api/login', { password: `guess-${k}-xxxx` });
  ok(last.status === 429 && last.res.headers.get('retry-after'), 'too many wrong passwords from one address are blocked');
  ok((await guesser.json('POST', '/api/login', { password: newBen })).status === 429, 'even the right password, while blocked');
  ok((await client().json('POST', '/api/login', { password: newBen })).status === 200, 'other addresses are unaffected');

  // ---- restart: the world, sessions and time carry on
  const before = (await ann.state()).body;
  await stopServer();
  await startServer();
  const again = (await ann.state()).body;
  ok(again.me === 0, 'sessions survive a restart');
  ok(again.world.log.some((e) => e.battle?.id === battle.battle.id) && again.gameNow >= before.gameNow, 'the world and its clock survive a restart');
  ok(/running/.test((() => { try { admin('new-game', '--players', 'X,Y', '--force'); return ''; } catch (e) { return String(e.stderr); } })()), 'new-game refuses while the server runs');
} finally {
  if (server && server.exitCode === null) await stopServer();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`server: ${checks} checks passed`);
