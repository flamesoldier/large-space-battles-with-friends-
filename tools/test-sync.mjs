// Checks that the page rebuilds exactly the server's world from the pieces it is sent
// (server/worldSync.mjs + src/galaxy/worldDelta.js), and how much less is sent.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { WorldSync, encodeRuns, decodeRuns } from '../server/worldSync.mjs';
import { WorldCopy } from '../src/galaxy/worldDelta.js';
import { createWorld, registerDesign, buildShipyard, advanceTo } from '../src/world/world.js';
import { makeDesign } from '../src/shared/designs.js';
import { mulberry32 } from '../src/shared/rng.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

// runs
{
  const a = ['a', 'b', 'c', 'd', 'e'], b = ['c', 'd', 'e', 'x', 'a', 'b', 'y'];
  ok(JSON.stringify(decodeRuns(a, encodeRuns(a, b))) === JSON.stringify(b), 'array layouts survive runs encoding');
  ok(JSON.stringify(decodeRuns(null, encodeRuns(null, b))) === JSON.stringify(b), 'and with nothing before');
}

// random changes to a real world, two pages: one keeps up, one is several versions behind
{
  const r = mulberry32(7);
  const world = createWorld({ players: [{ name: 'Ann' }, { name: 'Ben' }, { name: 'Cy' }, { name: 'Di' }], seed: 3 });
  for (let k = 0; k < 6; k++) registerDesign(world, k % 4, { ...makeDesign(['cruiser', 'battleship', 'titan', 'dreadnought'][k % 4], k + 1), name: `D${k}` });
  const sync = new WorldSync();
  const fast = new WorldCopy(), slow = new WorldCopy();
  let wv = 1, fullBytes = 0, deltaBytes = 0;
  const last = new Map();
  const pull = (copy) => {
    const d = sync.delta(world, wv, copy.wv);
    // the same layout id again means nothing changed (the server wouldn't even send it)
    const w = d.sid === copy.wv ? last.get(copy) : copy.apply(JSON.parse(JSON.stringify(d)), d.sid);
    last.set(copy, w);
    return { d, w };
  };
  for (let step = 0; step < 300; step++) {
    // change something, like the game does
    const roll = r();
    if (roll < 0.3) world.log.push({ id: world.nextId++, t: world.clock, kind: 'test', text: `event ${step}` });
    else if (roll < 0.4) world.log.splice(0, 3);
    else if (roll < 0.6) world.players[(r() * 4) | 0].credits += 100;
    else if (roll < 0.7) world.fleets.push({ id: world.nextId++, owner: 0, ships: [{ design: Object.keys(world.designs)[0], n: 2 }], from: 0, to: 1 });
    else if (roll < 0.75 && world.fleets.length) world.fleets.splice((r() * world.fleets.length) | 0, 1);
    else if (roll < 0.8) registerDesign(world, 1, { ...makeDesign('destroyer', 100 + step), name: `New ${step}` });
    else if (roll < 0.85) world.relations[`x${step}`] = { allied: r() < 0.5 };
    else if (roll < 0.9) world.extra = step; // a new top-level key
    else if (roll < 0.93) delete world.extra;
    else world.clock += 60000;
    wv++;
    const f = pull(fast);
    ok(JSON.stringify(f.w) === JSON.stringify(world), `step ${step}: the page's world matches the server's`);
    deltaBytes += JSON.stringify(f.d).length;
    fullBytes += JSON.stringify(world).length;
    if (step % 7 === 6) { const s = pull(slow); ok(JSON.stringify(s.w) === JSON.stringify(world), `step ${step}: a page 7 versions behind catches up`); }
  }
  // an answer that arrives after a newer one changes nothing
  const old = sync.delta(world, wv, -1);
  world.log.push({ id: world.nextId++, kind: 'test', text: 'late' }); wv++;
  const now = pull(fast);
  ok(fast.apply(old, old.sid) === null && JSON.stringify(now.w) === JSON.stringify(world), 'a late answer is ignored');
  console.log(`  sync: 300 random changes, sent ${(deltaBytes / 1e3).toFixed(0)} KB instead of ${(fullBytes / 1e6).toFixed(1)} MB (${(100 * deltaBytes / fullBytes).toFixed(1)}%)`);
}

// a game running for a day with shipyards: what each update costs, gzipped as sent
{
  const world = createWorld({ players: [{ name: 'Ann' }, { name: 'Ben' }, { name: 'Cy' }, { name: 'Di' }], seed: 5 });
  for (let p = 0; p < 4; p++) {
    world.players[p].credits = 1e7;
    const id = registerDesign(world, p, { ...makeDesign('titan', p + 1), name: `Titan ${p}` });
    for (let k = 0; k < 5; k++) buildShipyard(world, p, world.players[p].home, id);
  }
  const sync = new WorldSync(), copy = new WorldCopy();
  let wv = 1, d = sync.delta(world, wv, -1);
  copy.apply(d, d.sid);
  let full = 0, part = 0, n = 0;
  for (let h = 1; h <= 24; h++) {
    advanceTo(world, world.clock + 3600000);
    wv++;
    d = sync.delta(world, wv, copy.wv);
    const w = copy.apply(JSON.parse(JSON.stringify(d)), d.sid);
    ok(JSON.stringify(w) === JSON.stringify(world), `hour ${h}: matches`);
    full += gzipSync(JSON.stringify(world), { level: 5 }).length;
    part += gzipSync(JSON.stringify(d), { level: 5 }).length;
    n++;
  }
  console.log(`  sync: a day of shipyards, each update ${(part / n / 1e3).toFixed(1)} KB instead of ${(full / n / 1e3).toFixed(1)} KB gzipped`);
}
console.log(`sync: ${checks} checks passed`);
