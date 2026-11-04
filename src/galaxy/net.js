// The galaxy page's link to the game server (online mode, dist/play.html). The server owns the
// world; this keeps a copy up to date with a long poll and sends the player's actions. Which
// player you are comes from your login session on the server, never from the page.

const json = async (res) => { try { return await res.json(); } catch { return { ok: false, error: `Server error (${res.status}).` }; } };

export class Net {
  constructor() {
    this.v = -1; this.wv = -1; // versions of what we have
    this.state = null; // last snapshot (without the world once we have it)
    this.received = 0; // performance.now() when gameNow was measured
    this.online = true;
    this.onState = null; // (snapshot with or without .world) → void
    this.onLoggedOut = null;
    this.polling = false;
  }

  /** Game time now, extrapolated from the last snapshot (capped, so a lost connection doesn't run away). */
  gameNow() {
    if (!this.state) return 0;
    const dt = Math.min(90000, performance.now() - this.received);
    return this.state.gameNow + dt * this.state.speed;
  }

  async login(password) {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), credentials: 'same-origin' });
    return json(res);
  }
  async logout() {
    await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' }).catch(() => {});
    this.polling = false;
  }

  take(s) {
    this.received = performance.now();
    this.v = s.v;
    if (s.world) this.wv = s.wv;
    this.state = { ...s, world: undefined };
    this.online = true;
    this.onState?.(s);
  }

  /** First load: resolves true with the state applied, or false when not logged in. */
  async fetchState() {
    const res = await fetch(`/api/state?wv=${this.wv}`, { credentials: 'same-origin' });
    if (res.status === 401) return false;
    if (!res.ok) throw new Error(`Server error (${res.status})`);
    this.take(await res.json());
    return true;
  }

  /** Keep the copy fresh: the server answers when something changes (or every 25 s). */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    let backoff = 1000;
    while (this.polling) {
      try {
        const res = await fetch(`/api/state?v=${this.v}&wv=${this.wv}`, { credentials: 'same-origin' });
        if (res.status === 401) { this.polling = false; this.onLoggedOut?.(); return; }
        if (!res.ok) throw new Error(String(res.status));
        this.take(await res.json());
        backoff = 1000;
      } catch {
        this.online = false;
        this.onState?.(null);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(15000, backoff * 2);
      }
    }
  }

  /** Send an action. Returns the server's result ({ ok, error?, ... }); the new state is applied first. */
  async act(action) {
    let res;
    try {
      res = await fetch('/api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action), credentials: 'same-origin' });
    } catch { return { ok: false, error: 'Can\'t reach the server. Check your connection and try again.' }; }
    if (res.status === 401) { this.polling = false; this.onLoggedOut?.(); return { ok: false, error: 'Please log in again.' }; }
    const r = await json(res);
    if (r.state) { this.take(r.state); delete r.state; }
    return r;
  }

  async replay(id) {
    const res = await fetch(`/api/replay/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    let meta = {};
    try { meta = JSON.parse(decodeURIComponent(res.headers.get('X-Replay-Meta') || '{}')); } catch { /* no meta */ }
    return { bytes: new Uint8Array(await res.arrayBuffer()), ...meta };
  }
}
