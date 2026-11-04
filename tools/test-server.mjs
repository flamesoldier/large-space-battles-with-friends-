// Usage: node tools/test-server.mjs
// Runs the real game server on a throwaway data folder and checks logins, sessions, that nobody
// can act as another player, the login rate limit, and a full battle resolved by the worker with
// its replay served back. Needs dist/play.html (npm run build).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
const env = { ...process.env, LSB_DATA: DATA, PORT: String(PORT), HOST: '127.0.0.1', LSB_SPEED: '3600', LSB_TRUST_PROXY: '1' };
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
  c.act = (a) => c.json('POST', '/api/act', a);
  c.state = () => c.json('GET', '/api/state');
  return c;
}

try {
  // ---- a new game prints a password per player, unique
  const pw = passwords(admin('new-game', '--players', 'Ann,Ben', '--seed', '7', '--worlds', '4'));
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
  const mine = home.garrison.filter((g) => g.owner === 0);
  ok(mine.length && mine[0].n >= 2, `the shipyard has built ships (${mine[0]?.n})`);
  const target = st.world.planets.filter((p) => p.owner === null).sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y))[0];
  r = await ann.act({ type: 'fleet', from: annHome, to: target.id, ships: { [mine[0].design]: mine[0].n } });
  ok(r.body.ok && r.body.fleet.owner === 0, 'Ann launches a fleet');
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
