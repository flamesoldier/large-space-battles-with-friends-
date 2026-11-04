// The game's web server: serves the game page, logs players in with their password, and takes
// their actions. Plain Node, no dependencies.
//
//   npm run build && LSB_ADMIN_PASSWORD="something long" npm start      (http://localhost:8080)
//   then open /admin to make the game and get every player's password,
//   or use the command line: npm run admin -- new-game --players "Ann,Ben,Cat,Dan"
//
// Settings (environment):
//   PORT (8080), HOST (0.0.0.0)
//   LSB_DATA            data folder (default: the Railway volume if there is one, else ./data)
//   LSB_ADMIN_PASSWORD  turns on the /admin page (at least 10 characters)
//   LSB_SPEED           game speed (1 = real time)
//   LSB_TRUST_PROXY=1   behind a proxy that does HTTPS (Caddy, nginx; automatic on Railway): the
//                       session cookie is marked Secure and the client address comes from X-Forwarded-For
//
// Security model, for a game among friends: the password is the identity. A session cookie
// (random 256-bit token, HttpOnly, SameSite=Strict) carries it afterwards; the server takes the
// player from the session for every action, never from the request. Logins are rate limited per
// address. Run it behind HTTPS, or passwords cross the network in the clear.

import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Accounts, sha256, writeJsonAtomic } from './accounts.mjs';
import { Game, gameExists } from './game.mjs';
import { makeNewGame } from './setup.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const env = process.env;
const ON_RAILWAY = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID);
const DATA = resolve(env.LSB_DATA || env.RAILWAY_VOLUME_MOUNT_PATH || join(ROOT, 'data'));
const PORT = Number(env.PORT || 8080), HOST = env.HOST || '0.0.0.0';
const SPEED = Math.max(0, Number(env.LSB_SPEED || 1));
const TRUST_PROXY = env.LSB_TRUST_PROXY === '1' || (ON_RAILWAY && env.LSB_TRUST_PROXY !== '0');
const ADMIN_PW = String(env.LSB_ADMIN_PASSWORD || '').trim();
const ADMIN_ON = ADMIN_PW.length >= 10;
const PAGE_FILE = join(ROOT, 'dist', 'play.html');
const ADMIN_FILE = join(ROOT, 'server', 'admin.html');

const SESSION_DAYS = 30, ADMIN_SESSION_HOURS = 12;
const LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX_FAILS = 8;
const MAX_BODY = 4 * 1024 * 1024; // a giant ship design is under 1 MB of base64
const POLL_MS = 25000;

if (!existsSync(PAGE_FILE)) {
  console.error(`${PAGE_FILE} is missing. Run: npm run build`);
  process.exit(1);
}
mkdirSync(DATA, { recursive: true });
if (ADMIN_PW && !ADMIN_ON) console.warn('LSB_ADMIN_PASSWORD is too short (10 characters or more), so the admin page is off.');

// The game can be missing (a fresh install): the site still runs, and /admin makes one.
let game = gameExists(DATA) ? new Game({ dir: DATA, speed: SPEED }) : null;
const accounts = new Accounts(join(DATA, 'accounts.json'));
if (!game) console.warn(`No game yet in ${DATA}. ${ADMIN_ON ? 'Open /admin to make one.' : 'Set LSB_ADMIN_PASSWORD and open /admin, or run: npm run admin -- new-game --players "Ann,Ben"'}`);

// ------------------------------------------------------------------ sessions
// Stored as sha256(token) → { player, gen, expires } (players) or { admin, key, expires }, so the
// file alone can't be used to log in.
const SESS_FILE = join(DATA, 'sessions.json');
let sessions = existsSync(SESS_FILE) ? JSON.parse(readFileSync(SESS_FILE, 'utf8')) : {};
let sessTimer = 0;
const saveSessions = () => { clearTimeout(sessTimer); sessTimer = setTimeout(() => writeJsonAtomic(SESS_FILE, sessions), 200); };
const adminKey = () => sha256(`admin:${ADMIN_PW}`).slice(0, 16); // changing the admin password ends admin sessions

function newSession(record) {
  const token = randomBytes(32).toString('base64url');
  sessions[sha256(token)] = record;
  saveSessions();
  return token;
}
/** The player id for this request's session, or null. */
function sessionPlayer(req) {
  const token = cookies(req).lsb_session;
  if (!token || !game) return null;
  const key = sha256(token), s = sessions[key];
  if (!s || s.admin) return null;
  const acc = accounts.get(s.player);
  // Expired, or the password was reset since this session was made.
  if (s.expires < Date.now() || !acc || acc.gen !== s.gen || !game.world.players[s.player]) { delete sessions[key]; saveSessions(); return null; }
  return s.player;
}
function isAdmin(req) {
  const token = cookies(req).lsb_admin;
  if (!token || !ADMIN_ON) return false;
  const key = sha256(token), s = sessions[key];
  if (!s || !s.admin) return false;
  if (s.expires < Date.now() || s.key !== adminKey()) { delete sessions[key]; saveSessions(); return false; }
  return true;
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const k = part.indexOf('=');
    if (k > 0) { try { out[part.slice(0, k).trim()] = decodeURIComponent(part.slice(k + 1).trim()); } catch { /* ignore bad cookies */ } }
  }
  return out;
}
const isHttps = (req) => TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const cookie = (req, name, token, maxAge) => `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

// ------------------------------------------------------------------ login rate limit
// Shared by player and admin logins. Behind a proxy the client is the first X-Forwarded-For
// entry: Caddy and Railway's edge both replace whatever the client sent there.
const fails = new Map(); // address → [times]
const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';
function recentFails(ip) {
  const now = Date.now(), list = (fails.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) fails.set(ip, list); else fails.delete(ip);
  return list;
}
setInterval(() => { for (const ip of fails.keys()) recentFails(ip); }, 60000).unref();
const stamp = () => `[${new Date().toISOString()}]`;

/** Runs a password check with the rate limit. check() returns a truthy match or null. Returns { hit } or { blocked: response sent }. */
function limited(req, res, label, check) {
  const ip = clientIp(req), recent = recentFails(ip);
  if (recent.length >= LOGIN_MAX_FAILS) {
    const wait = Math.ceil((recent[0] + LOGIN_WINDOW_MS - Date.now()) / 1000);
    fail(req, res, 429, `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.`, { 'Retry-After': String(wait) });
    return null;
  }
  const hit = check();
  if (!hit) {
    recent.push(Date.now()); fails.set(ip, recent);
    console.log(`${stamp()} Failed ${label} login from ${ip} (${recent.length}/${LOGIN_MAX_FAILS})`);
    return { hit: null };
  }
  fails.delete(ip);
  return { hit, ip };
}

// ------------------------------------------------------------------ responses
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'self'",
};
function send(req, res, status, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers };
  h['Content-Type'] ??= 'application/json; charset=utf-8';
  if (buf.length > 1024 && !h['Content-Encoding'] && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { buf = gzipSync(buf, { level: 5 }); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(buf);
}
const fail = (req, res, status, error, headers) => send(req, res, status, { ok: false, error }, headers);

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('Expected JSON.'), { status: 415 }));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Bad JSON.'), { status: 400 })); } });
    req.on('error', reject);
  });
}

/** POSTs must come from our own page: JSON (no plain cross-site form can send it) and, if the browser says where from, from this host. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// Pages are re-read after `npm run build` without restarting.
const pages = new Map();
function pageFile(file) {
  let m = 0;
  try { m = statSync(file).mtimeMs; } catch { /* missing */ }
  const c = pages.get(file);
  if (c && c.m === m) return c.gz;
  const gz = gzipSync(readFileSync(file), { level: 9 });
  pages.set(file, { m, gz });
  return gz;
}
const html = (req, res, file) => send(req, res, 200, pageFile(file), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' });

// ------------------------------------------------------------------ admin
function adminState() {
  if (!game) return { ok: true, game: null };
  const W = game.world;
  return {
    ok: true,
    game: {
      seed: W.seed, worlds: W.planets.length, day: Math.floor(game.gameNow() / 864e5) + 1, speed: game.speed, clock: game.gameNow(),
      winner: W.winner, replays: game.replays.size,
      players: W.players.map((p) => ({ id: p.id, name: p.name, color: p.color, team: p.team, eliminated: p.eliminated, joined: p.claimed !== false, password: !!accounts.get(p.id), worlds: W.planets.filter((x) => x.owner === p.id).length })),
    },
  };
}

/** Swap in a brand-new game while the server runs: wait for anything in progress, then replace it. */
async function replaceGame(opts) {
  let old = game;
  if (old) {
    old.stopped = true;
    await old.locked(() => {}); // let a battle or action in progress finish
    old.retired = true;
  }
  let made;
  try { made = makeNewGame(DATA, opts); } catch (e) { if (old) { old.retired = false; old.stopped = false; } throw e; }
  game = new Game({ dir: DATA, speed: SPEED });
  // Everyone's player sessions belonged to the old game; admin sessions stay.
  for (const [k, s] of Object.entries(sessions)) if (!s.admin) delete sessions[k];
  saveSessions();
  if (old) for (const w of [...old.watchers]) w(); // answer waiting clients (they'll be told to log in again)
  console.log(`${stamp()} New game: ${made.world.players.length} players, ${made.world.planets.length} worlds, seed ${made.world.seed}`);
  return made;
}

async function handleAdmin(req, res, path, body) {
  if (!ADMIN_ON) return fail(req, res, 403, 'The admin page is off. Set LSB_ADMIN_PASSWORD (10+ characters) on the server and restart it.');
  if (path === '/api/admin/login') {
    const pw = typeof body.password === 'string' ? body.password.trim() : '';
    const r = limited(req, res, 'admin', () => timingSafeEqual(Buffer.from(sha256(pw), 'hex'), Buffer.from(sha256(ADMIN_PW), 'hex')));
    if (!r) return;
    if (!r.hit) return fail(req, res, 401, 'Wrong admin password.');
    console.log(`${stamp()} Admin logged in from ${r.ip}`);
    const token = newSession({ admin: true, key: adminKey(), expires: Date.now() + ADMIN_SESSION_HOURS * 3600e3 });
    return send(req, res, 200, adminState(), { 'Set-Cookie': cookie(req, 'lsb_admin', token, ADMIN_SESSION_HOURS * 3600) });
  }
  if (path === '/api/admin/logout') {
    const token = cookies(req).lsb_admin;
    if (token) { delete sessions[sha256(token)]; saveSessions(); }
    return send(req, res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'lsb_admin', '', 0) });
  }
  if (!isAdmin(req)) return fail(req, res, 401, 'Please log in as admin.');
  if (path === '/api/admin/state') return send(req, res, 200, adminState());
  if (path === '/api/admin/new-game') {
    if (game && body.replace !== true) return fail(req, res, 409, 'There is already a game. Tick the box to replace it.');
    let made;
    if (body.players !== undefined && !Array.isArray(body.players)) return fail(req, res, 400, 'Bad player list.');
    try { made = await replaceGame({ count: body.count, names: body.players, teams: Array.isArray(body.teams) ? body.teams : [], seed: body.seed, worlds: body.worlds }); } catch (e) { return fail(req, res, 400, e.message); }
    return send(req, res, 200, { ...adminState(), passwords: made.passwords.map(([id, pw]) => ({ id, name: made.world.players[id].name, open: made.world.players[id].claimed === false, password: pw })) });
  }
  if (path === '/api/admin/speed') {
    if (!game) return fail(req, res, 400, 'There is no game yet.');
    const s = body.speed;
    if (!Number.isFinite(s) || s < 0 || s > 100000) return fail(req, res, 400, 'Bad speed.');
    game.setSpeed(s);
    console.log(`${stamp()} Admin set the game speed to ${s}×`);
    return send(req, res, 200, adminState());
  }
  if (path === '/api/admin/jump') {
    if (!game) return fail(req, res, 400, 'There is no game yet.');
    const h = body.hours;
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 14) return fail(req, res, 400, 'Jump between a minute and 14 days.');
    await game.jump(h * 3600e3);
    console.log(`${stamp()} Admin jumped the game ${h} h ahead`);
    return send(req, res, 200, adminState());
  }
  if (path === '/api/admin/reset-password') {
    if (!game) return fail(req, res, 400, 'There is no game yet.');
    const p = game.world.players[body.player];
    if (!Number.isInteger(body.player) || !p) return fail(req, res, 400, 'No such player.');
    const pw = accounts.setPassword(p.id);
    console.log(`${stamp()} Admin reset ${p.name}'s password`);
    return send(req, res, 200, { ...adminState(), passwords: [{ id: p.id, name: p.name, open: p.claimed === false, password: pw }] });
  }
  return fail(req, res, 404, 'Not found.');
}

// ------------------------------------------------------------------ routes
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) return html(req, res, PAGE_FILE);
  if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) return html(req, res, ADMIN_FILE);
  if (req.method === 'GET' && path === '/healthz') return send(req, res, 200, { ok: true });
  if (!path.startsWith('/api/')) return fail(req, res, 404, 'Not found.');

  if (req.method === 'POST' || (req.method === 'GET' && path === '/api/admin/state')) {
    if (req.method === 'POST' && !sameOrigin(req)) return fail(req, res, 403, 'Wrong origin.');
    let body = {};
    if (req.method === 'POST') { try { body = await readJson(req); } catch (e) { return fail(req, res, e.status || 400, e.message); } }
    if (path.startsWith('/api/admin/')) return handleAdmin(req, res, path, body);

    if (path === '/api/login') {
      if (!game) return fail(req, res, 503, 'The game hasn\'t been set up yet. Ask the organiser.');
      const g = game;
      const r = limited(req, res, 'player', () => {
        const acc = typeof body.password === 'string' && body.password.length <= 200 ? accounts.find(body.password) : null;
        return acc && g.world.players[acc.id] ? acc : null;
      });
      if (!r) return;
      if (!r.hit) return fail(req, res, 401, 'That password doesn\'t match any player.');
      const acc = r.hit, name = g.world.players[acc.id].name;
      const token = newSession({ player: acc.id, gen: acc.gen, expires: Date.now() + SESSION_DAYS * 864e5 });
      console.log(`${stamp()} ${name} logged in from ${r.ip}`);
      return send(req, res, 200, { ok: true, player: acc.id, name }, { 'Set-Cookie': cookie(req, 'lsb_session', token, SESSION_DAYS * 86400) });
    }
    if (path === '/api/logout') {
      const token = cookies(req).lsb_session;
      if (token) { delete sessions[sha256(token)]; saveSessions(); }
      return send(req, res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'lsb_session', '', 0) });
    }
    if (path === '/api/act') {
      const pid = sessionPlayer(req);
      if (pid === null) return fail(req, res, 401, 'Please log in again.');
      const g = game, r = await g.act(pid, body);
      if (g !== game) return fail(req, res, 401, 'A new game has started. Please log in again.');
      return send(req, res, r.ok ? 200 : 400, { ...r, state: g.snapshot(pid, -1) });
    }
    return fail(req, res, 404, 'Not found.');
  }

  if (req.method !== 'GET') return fail(req, res, 405, 'Method not allowed.');
  if (!game) return send(req, res, 503, { ok: false, noGame: true, error: 'The game hasn\'t been set up yet.' });
  const pid = sessionPlayer(req);
  if (pid === null) return fail(req, res, 401, 'Not logged in.');
  const g = game;

  if (path === '/api/state') {
    // Long poll: answer as soon as something changed since the client's version `v`, or after POLL_MS.
    const v = Number(url.searchParams.get('v')), wv = Number(url.searchParams.get('wv'));
    if (!Number.isFinite(v) || v !== g.version) return send(req, res, 200, g.snapshot(pid, wv));
    let done = false;
    const finish = () => {
      if (done) return;
      done = true; g.watchers.delete(finish); clearTimeout(timer);
      if (res.writableEnded || res.destroyed) return;
      if (g !== game) fail(req, res, 401, 'A new game has started. Please log in again.');
      else send(req, res, 200, g.snapshot(pid, wv));
    };
    const timer = setTimeout(finish, POLL_MS);
    g.watchers.add(finish);
    req.on('close', () => { done = true; g.watchers.delete(finish); clearTimeout(timer); });
    return;
  }
  const m = path.match(/^\/api\/replay\/([a-z0-9]+)$/);
  if (m) {
    const r = g.replay(m[1]);
    if (!r) return fail(req, res, 404, 'No such replay.');
    // The replay is stored gzipped; browsers unzip it for us.
    return send(req, res, 200, r.gz, {
      'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip',
      'X-Replay-Meta': encodeURIComponent(JSON.stringify(r.meta)), 'Cache-Control': 'private, max-age=31536000, immutable',
    });
  }
  return fail(req, res, 404, 'Not found.');
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) fail(req, res, 500, 'Server error.');
  });
});
server.requestTimeout = 0; // actions can wait behind a long battle
server.headersTimeout = 30000;

const PID_FILE = join(DATA, 'server.pid');
server.listen(PORT, HOST, () => {
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`Large Space Battles server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (game) console.log(`  ${game.world.players.length} players, ${game.world.planets.length} worlds, speed ${game.speed}×`);
  console.log(`  data in ${DATA}${TRUST_PROXY ? ', behind a proxy' : ''}, admin page ${ADMIN_ON ? 'on (/admin)' : 'off'}`);
});

// The clock: once a second, process everything that's due.
const ticker = setInterval(() => game?.tick(), 1000);
game?.tick();

function shutdown() {
  clearInterval(ticker);
  server.close();
  const g = game;
  const finish = () => {
    try { writeJsonAtomic(SESS_FILE, sessions); } catch { /* best effort */ }
    try { unlinkSync(PID_FILE); } catch { /* already gone */ }
    process.exit(0);
  };
  if (!g) return finish();
  g.stopped = true;
  g.locked(() => g.save()).finally(finish);
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
