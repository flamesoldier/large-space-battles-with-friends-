// The live game: one world, a real-time clock, every player action and every event, in order.
//
// The world is the same JSON object and the same rules (src/world/) the hot-seat page uses. The
// server only adds what a browser can't: a clock that keeps running when nobody is looking, one
// place where every change happens (so nobody can act for someone else), battles in a worker
// thread, and replays on disk.
//
// Clock: game time = anchor.clock + (now − anchor.wall) × speed. Time the server was down counts
// (at the speed in force). The speed is the admin's to change (admin page: pause … 3600×, and
// "jump ahead"); it is saved with the game, LSB_SPEED only sets it for a game that has none yet.
// too, like a closed page did. Everything that changes the world runs under one lock: the tick
// (events and battles) and player actions. While a battle resolves the world waits at the moment
// the battle started (as the page did), and actions sent meanwhile simply wait their turn.

import { Worker } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  advanceTo, dueEvent, planEvent, applyEvent, upgradeWorld, sendFleet, stopFleet, setRally, rallyAll, buildShipyard, sellShipyard, cancelSale, renameDesign, buildDefense, giveCredits,
  proposeAlliance, acceptAlliance, declineAlliance, breakAlliance, playerName, claimPlayer,
} from '../src/world/world.js';
import { decodeDesign } from '../src/shared/shipStats.js';
import { writeJsonAtomic } from './accounts.mjs';

const WORKER = new URL('./battleWorker.mjs', import.meta.url);

/** Whole number in [0, n), or null. Request bodies are untrusted, so everything is checked. */
const index = (v, n) => (Number.isInteger(v) && v >= 0 && v < n ? v : null);

export class Game {
  /** dir: the data folder (game.json, replays/). speed: game seconds per real second. */
  constructor({ dir, speed = 1, log = console.log }) {
    this.dir = dir; this.log = log;
    this.file = join(dir, 'game.json');
    this.replayDir = join(dir, 'replays');
    mkdirSync(this.replayDir, { recursive: true });
    const saved = JSON.parse(readFileSync(this.file, 'utf8'));
    this.world = upgradeWorld(saved.world);
    this.speed = Number.isFinite(saved.speed) ? saved.speed : speed;
    // Older saves stored only the wall time matching world.clock.
    this.anchor = saved.anchor ?? { wall: saved.wall ?? Date.now(), clock: this.world.clock };
    this.replays = new Set(readdirSync(this.replayDir).filter((f) => f.endsWith('.bin.gz')).map((f) => f.slice(0, -7)));
    this.version = 1; // any change worth telling clients about (world or status)
    this.worldVersion = 1; // the world itself changed
    this.status = null; // { battle: { planet, title, ... progress } } while one resolves
    this.watchers = new Set();
    this.queue = Promise.resolve();
    this.failures = 0;
    this.stopped = false; // shutting down: stop processing events
    this.retired = false; // replaced by a new game: never write to disk again
  }

  /** Change how fast game time runs from now on (0 = paused). Doesn't move the clock. */
  setSpeed(speed) {
    const now = Date.now();
    this.anchor = { wall: now, clock: this.gameNow(now) };
    this.speed = speed;
    this.save(); this.changed(false);
  }

  /** Move game time forward by ms at once (testing): everything due on the way happens, in order. */
  jump(ms) {
    return this.locked(async () => {
      this.anchor = { wall: this.anchor.wall, clock: this.anchor.clock + ms };
      await this.catchUp();
      this.save(); this.changed();
    });
  }

  /** Make a new game file (the admin tool does this). */
  static create(dir, world) {
    mkdirSync(join(dir, 'replays'), { recursive: true });
    writeJsonAtomic(join(dir, 'game.json'), { world, wall: Date.now() });
  }

  gameNow(wall = Date.now()) { return this.anchor.clock + (wall - this.anchor.wall) * this.speed; }

  /** Runs fn with the world to itself. Everything that changes the world goes through here. */
  locked(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  save() {
    if (this.retired) return;
    // The anchor is what the clock is measured from; saving it with the world keeps time running across restarts.
    writeJsonAtomic(this.file, { world: this.world, anchor: this.anchor, speed: this.speed });
  }

  changed(world = true) {
    this.version++;
    if (world) this.worldVersion++;
    for (const w of this.watchers) w();
  }

  /** Bring the world up to now: income, shipyards, fleet arrivals, sieges and battles, in order. Call under the lock. */
  async catchUp() {
    const target = this.gameNow();
    let n = 0;
    for (let guard = 0; guard < 2000 && !this.stopped; guard++) {
      const ev = dueEvent(this.world, target);
      if (!ev) break;
      advanceTo(this.world, ev.at);
      const plan = planEvent(this.world, ev);
      let result = null, replay = null;
      if (plan.kind === 'battle') {
        replay = await this.fight(plan.battle);
        if (!replay) { this.save(); return n; } // the worker failed: try again on the next tick
        result = replay.result;
      }
      const entry = applyEvent(this.world, ev, plan, result);
      if (entry?.battle && replay) this.storeReplay(entry, plan.battle, replay);
      if (entry) this.log(`[${new Date().toISOString()}] ${entry.text}`);
      n++;
      // Tell everyone after each event, so a long string of battles shows up as it happens.
      this.save(); this.changed();
    }
    // New ships leaving for a rally point change the world: tell everyone.
    if (advanceTo(this.world, Math.max(this.world.clock, target))) { this.save(); this.changed(); }
    return n;
  }

  /** Resolve a battle in a worker thread. Returns { result, bytes, computeMs } or null if it failed. */
  fight(B) {
    const P = this.world.planets[B.planet];
    const attackers = B.attackers || [B.attacker];
    this.status = { battle: {
      planet: B.planet, passing: !!B.passing, attackers, defender: B.defender, ships: B.ships.length,
      seconds: 0, frac: 0, alive: [B.ships.filter((s) => s.team === 0).length, B.ships.filter((s) => s.team === 1).length],
    } };
    this.changed(false);
    this.log(`[${new Date().toISOString()}] Resolving a battle at ${P.name}: ${B.ships.length} ships`);
    return new Promise((resolve) => {
      const w = new Worker(WORKER);
      let settled = false;
      const end = (v) => {
        if (settled) return;
        settled = true; this.status = null; this.changed(false);
        w.terminate().catch(() => {});
        resolve(v);
      };
      w.on('message', (m) => {
        if (m.type === 'progress' && this.status) { Object.assign(this.status.battle, { seconds: m.seconds, frac: m.frac, alive: m.alive }); this.changed(false); }
        else if (m.type === 'done') { this.failures = 0; end({ result: m.result, bytes: m.bytes, computeMs: m.computeMs }); }
        else if (m.type === 'error') { this.failures++; this.log(`Battle at ${P.name} failed: ${m.error}`); end(null); }
      });
      w.on('error', (err) => { this.failures++; this.log(`Battle worker crashed at ${P.name}: ${err?.stack || err}`); end(null); });
      w.on('exit', (code) => { if (!settled) { this.failures++; this.log(`Battle worker exited (${code}) at ${P.name}`); end(null); } });
      w.postMessage({ scenario: B });
    });
  }

  storeReplay(entry, B, rep) {
    const P = this.world.planets[B.planet];
    const attackers = B.attackers || [B.attacker];
    const meta = {
      sides: [attackers.map((a) => playerName(this.world, a)).join(' + '), B.defender === null ? `${P.name} militia` : playerName(this.world, B.defender)],
      title: `${B.passing ? 'Ambush' : 'Battle'} of ${P.name}`,
      // one name per battle side (a free-for-all has a side per player)
      teams: B.owners ? B.owners.map((o) => (o === null ? 'Militia' : playerName(this.world, o))) : null,
      computeMs: rep.computeMs,
    };
    const id = entry.battle.id;
    writeFileSync(join(this.replayDir, `${id}.bin.gz`), gzipSync(Buffer.from(rep.bytes.buffer, rep.bytes.byteOffset, rep.bytes.byteLength), { level: 6 }));
    writeFileSync(join(this.replayDir, `${id}.json`), JSON.stringify(meta));
    this.replays.add(id);
  }

  /** Replay file and its meta, or null. id comes from a URL, so it must look like a battle id. */
  replay(id) {
    if (!/^b\d{1,12}$/.test(id) || !this.replays.has(id)) return null;
    const meta = JSON.parse(readFileSync(join(this.replayDir, `${id}.json`), 'utf8'));
    return { gz: readFileSync(join(this.replayDir, `${id}.bin.gz`)), meta };
  }

  /** The 1-second heartbeat: process anything due. */
  tick() {
    if (this.ticking) return;
    this.ticking = true;
    this.locked(() => this.catchUp()).catch((e) => this.log(`Tick failed: ${e?.stack || e}`)).finally(() => { this.ticking = false; });
  }

  /**
   * A player's action. `pid` comes from the session, never from the request: that is what stops
   * anyone acting as someone else. Returns the world function's result ({ ok, error?, ... }).
   */
  act(pid, a) {
    return this.locked(async () => {
      if (this.retired) return { ok: false, error: 'A new game has started. Please log in again.' };
      await this.catchUp();
      const r = this.apply(pid, a ?? {});
      if (r.ok) { this.save(); this.changed(); }
      return r;
    });
  }

  apply(pid, a) {
    const W = this.world, nP = W.planets.length, nPl = W.players.length;
    switch (a.type) {
      case 'fleet': {
        const from = index(a.from, nP), to = index(a.to, nP);
        if (from === null || to === null) return { ok: false, error: 'No such world.' };
        if (!a.ships || typeof a.ships !== 'object' || Array.isArray(a.ships)) return { ok: false, error: 'Pick some ships to send.' };
        const ships = {};
        for (const [d, n] of Object.entries(a.ships)) {
          if (!Object.hasOwn(W.designs, d)) return { ok: false, error: 'Unknown ship design.' };
          if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'Ship counts must be whole numbers.' };
          if (n > 0) ships[d] = n;
        }
        return sendFleet(W, pid, from, to, ships, { lanes: a.lanes !== false, avoid: a.avoid !== false });
      }
      case 'rally': { // one world's rally point; to = null clears it
        const okId = (x) => Number.isInteger(x) && x >= 0 && x < W.planets.length;
        if (!okId(a.planet) || !(a.to === null || okId(a.to))) return { ok: false, error: 'No such world.' };
        return setRally(W, pid, a.planet, a.to);
      }
      case 'rallyAll': { // every world of yours with a shipyard → here (on), or stop rallying here
        if (!Number.isInteger(a.to) || a.to < 0 || a.to >= W.planets.length) return { ok: false, error: 'No such world.' };
        return rallyAll(W, pid, a.to, a.on !== false);
      }
      case 'stop': {
        if (!Number.isInteger(a.fleet)) return { ok: false, error: 'No such fleet.' };
        return stopFleet(W, pid, a.fleet);
      }
      case 'build': {
        const planet = index(a.planet, nP);
        if (planet === null) return { ok: false, error: 'No such world.' };
        let design;
        try { design = decodeDesign(a.design); } catch (e) { return { ok: false, error: e.message }; }
        return buildShipyard(W, pid, planet, design);
      }
      case 'defend': {
        const planet = index(a.planet, nP);
        if (planet === null) return { ok: false, error: 'No such world.' };
        let design;
        try { design = decodeDesign(a.design); } catch (e) { return { ok: false, error: e.message }; }
        return buildDefense(W, pid, planet, design, a.count);
      }
      case 'sell': {
        const planet = index(a.planet, nP);
        if (planet === null || typeof a.yard !== 'string') return { ok: false, error: 'No such shipyard.' };
        return sellShipyard(W, pid, planet, a.yard);
      }
      case 'unsell': {
        const planet = index(a.planet, nP);
        if (planet === null || typeof a.yard !== 'string') return { ok: false, error: 'No such shipyard.' };
        return cancelSale(W, pid, planet, a.yard);
      }
      case 'rename': {
        if (typeof a.design !== 'string' || !Object.hasOwn(W.designs, a.design)) return { ok: false, error: 'No such ship design.' };
        return renameDesign(W, pid, a.design, typeof a.name === 'string' ? a.name.slice(0, 100) : '');
      }
      case 'propose': case 'accept': case 'decline': case 'break': {
        const other = index(a.player, nPl);
        if (other === null || other === pid) return { ok: false, error: 'No such player.' };
        const fn = { propose: proposeAlliance, accept: acceptAlliance, decline: declineAlliance, break: breakAlliance }[a.type];
        return fn(W, pid, other);
      }
      case 'gift': {
        const other = index(a.player, nPl);
        if (other === null || other === pid) return { ok: false, error: 'No such player.' };
        return giveCredits(W, pid, other, a.amount);
      }
      case 'claim': return claimPlayer(W, pid, typeof a.name === 'string' ? a.name.slice(0, 100) : '', typeof a.color === 'string' ? a.color : '');
      default: return { ok: false, error: 'Unknown action.' };
    }
  }

  /** What a client needs. The world is only included when it changed since the client's copy. */
  snapshot(pid, haveWorld) {
    const now = Date.now();
    return {
      v: this.version, wv: this.worldVersion, me: pid,
      gameNow: this.gameNow(now), speed: this.speed,
      status: this.status, replays: [...this.replays],
      world: haveWorld === this.worldVersion ? undefined : this.world,
    };
  }
}

export const gameExists = (dir) => existsSync(join(dir, 'game.json'));
