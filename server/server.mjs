// The game's web server: serves the game page, logs players in with their password, and takes
// their actions. Plain Node, no dependencies.
//
//   npm run admin -- new-game --players "Ann,Ben,Cat,Dan"   (prints each player's password once)
//   npm run build && npm start                               (http://localhost:8080)
//
// Settings (environment): PORT (8080), HOST (0.0.0.0), LSB_DATA (./data), LSB_SPEED (1 = real
// time), LSB_TRUST_PROXY=1 when behind a reverse proxy that does HTTPS (Caddy, nginx): then the
// session cookie is marked Secure and the client address comes from X-Forwarded-For.
//
// Security model, for a game among friends: the password is the identity. A session cookie
// (random 256-bit token, HttpOnly, SameSite=Strict) carries it afterwards; the server takes the
// player from the session for every action, never from the request. Logins are rate limited per
// address. Run it behind HTTPS, or passwords cross the network in the clear.

import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Accounts, sha256, writeJsonAtomic } from './accounts.mjs';
import { Game, gameExists } from './game.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const env = process.env;
const DATA = resolve(env.LSB_DATA || join(ROOT, 'data'));
const PORT = Number(env.PORT || 8080), HOST = env.HOST || '0.0.0.0';
const SPEED = Math.max(0, Number(env.LSB_SPEED || 1));
const TRUST_PROXY = env.LSB_TRUST_PROXY === '1';
const PAGE_FILE = join(ROOT, 'dist', 'play.html');

const SESSION_DAYS = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX_FAILS = 8;
const MAX_BODY = 4 * 1024 * 1024; // a giant ship design is under 1 MB of base64
const POLL_MS = 25000;

if (!gameExists(DATA)) {
  console.error(`No game in ${DATA}. Create one first:\n  npm run admin -- new-game --players "Ann,Ben,Cat,Dan"`);
  process.exit(1);
}
if (!existsSync(PAGE_FILE)) {
  console.error(`${PAGE_FILE} is missing. Run: npm run build`);
  process.exit(1);
}

const game = new Game({ dir: DATA, speed: SPEED });
const accounts = new Accounts(join(DATA, 'accounts.json'));
if (!accounts.load().list.length) console.warn('Warning: no player passwords set. Run: npm run admin -- passwords');

// ------------------------------------------------------------------ sessions
// Stored as sha256(token) → { player, gen, expires }, so the file alone can't be used to log in.
const SESS_FILE = join(DATA, 'sessions.json');
let sessions = existsSync(SESS_FILE) ? JSON.parse(readFileSync(SESS_FILE, 'utf8')) : {};
let sessTimer = 0;
const saveSessions = () => { clearTimeout(sessTimer); sessTimer = setTimeout(() => writeJsonAtomic(SESS_FILE, sessions), 200); };

function newSession(acc) {
  const token = randomBytes(32).toString('base64url');
  sessions[sha256(token)] = { player: acc.id, gen: acc.gen, expires: Date.now() + SESSION_DAYS * 864e5 };
  saveSessions();
  return token;
}
/** The player id for this request's session, or null. */
function sessionPlayer(req) {
  const token = cookies(req).lsb_session;
  if (!token) return null;
  const key = sha256(token), s = sessions[key];
  if (!s) return null;
  const acc = accounts.get(s.player);
  // Expired, or the password was reset since this session was made.
  if (s.expires < Date.now() || !acc || acc.gen !== s.gen || !game.world.players[s.player]) { delete sessions[key]; saveSessions(); return null; }
  return s.player;
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const k = part.indexOf('=');
    if (k > 0) out[part.slice(0, k).trim()] = decodeURIComponent(part.slice(k + 1).trim());
  }
  return out;
}
const isHttps = (req) => TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const sessionCookie = (req, token, maxAge) => `lsb_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

// ------------------------------------------------------------------ login rate limit
const fails = new Map(); // address → [times]
const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';
function recentFails(ip) {
  const now = Date.now(), list = (fails.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) fails.set(ip, list); else fails.delete(ip);
  return list;
}
setInterval(() => { for (const ip of fails.keys()) recentFails(ip); }, 60000).unref();

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

let page = null, pageMtime = 0;
function playPage() {
  // Re-read after `npm run build` without restarting.
  const m = statMtime(PAGE_FILE);
  if (!page || m !== pageMtime) { page = gzipSync(readFileSync(PAGE_FILE), { level: 9 }); pageMtime = m; }
  return page;
}
const statMtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

// ------------------------------------------------------------------ routes
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    return send(req, res, 200, playPage(), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' });
  }
  if (req.method === 'GET' && path === '/healthz') return send(req, res, 200, { ok: true });
  if (!path.startsWith('/api/')) return fail(req, res, 404, 'Not found.');

  if (req.method === 'POST') {
    if (!sameOrigin(req)) return fail(req, res, 403, 'Wrong origin.');
    let body;
    try { body = await readJson(req); } catch (e) { return fail(req, res, e.status || 400, e.message); }

    if (path === '/api/login') {
      const ip = clientIp(req);
      const recent = recentFails(ip);
      if (recent.length >= LOGIN_MAX_FAILS) {
        const wait = Math.ceil((recent[0] + LOGIN_WINDOW_MS - Date.now()) / 1000);
        return fail(req, res, 429, `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.`, { 'Retry-After': String(wait) });
      }
      const acc = typeof body.password === 'string' && body.password.length <= 200 ? accounts.find(body.password) : null;
      if (!acc || !game.world.players[acc.id]) {
        recent.push(Date.now()); fails.set(ip, recent);
        console.log(`[${new Date().toISOString()}] Failed login from ${ip} (${recent.length}/${LOGIN_MAX_FAILS})`);
        return fail(req, res, 401, 'That password doesn\'t match any player.');
      }
      fails.delete(ip);
      const token = newSession(acc);
      console.log(`[${new Date().toISOString()}] ${game.world.players[acc.id].name} logged in from ${ip}`);
      return send(req, res, 200, { ok: true, player: acc.id, name: game.world.players[acc.id].name }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
    }
    if (path === '/api/logout') {
      const token = cookies(req).lsb_session;
      if (token) { delete sessions[sha256(token)]; saveSessions(); }
      return send(req, res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (path === '/api/act') {
      const pid = sessionPlayer(req);
      if (pid === null) return fail(req, res, 401, 'Please log in again.');
      const r = await game.act(pid, body);
      return send(req, res, r.ok ? 200 : 400, { ...r, state: game.snapshot(pid, -1) });
    }
    return fail(req, res, 404, 'Not found.');
  }

  if (req.method !== 'GET') return fail(req, res, 405, 'Method not allowed.');
  const pid = sessionPlayer(req);
  if (pid === null) return fail(req, res, 401, 'Not logged in.');

  if (path === '/api/state') {
    // Long poll: answer as soon as something changed since the client's version `v`, or after POLL_MS.
    const v = Number(url.searchParams.get('v')), wv = Number(url.searchParams.get('wv'));
    if (!Number.isFinite(v) || v !== game.version) return send(req, res, 200, game.snapshot(pid, wv));
    let done = false;
    const finish = () => {
      if (done) return;
      done = true; game.watchers.delete(finish); clearTimeout(timer);
      if (!res.writableEnded && !res.destroyed) send(req, res, 200, game.snapshot(pid, wv));
    };
    const timer = setTimeout(finish, POLL_MS);
    game.watchers.add(finish);
    req.on('close', () => { done = true; game.watchers.delete(finish); clearTimeout(timer); });
    return;
  }
  const m = path.match(/^\/api\/replay\/([a-z0-9]+)$/);
  if (m) {
    const r = game.replay(m[1]);
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
  const W = game.world;
  console.log(`Large Space Battles server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  ${W.players.length} players, ${W.planets.length} worlds, speed ${SPEED}×, data in ${DATA}${TRUST_PROXY ? ', behind a proxy' : ''}`);
});

// The clock: once a second, process everything that's due.
const ticker = setInterval(() => game.tick(), 1000);
game.tick();

function shutdown() {
  clearInterval(ticker);
  game.stopped = true;
  server.close();
  game.locked(() => { game.save(); writeJsonAtomic(SESS_FILE, sessions); }).finally(() => {
    try { unlinkSync(PID_FILE); } catch { /* already gone */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
