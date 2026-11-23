// Disk-full handling (15 Nov 2026: the Railway volume filled with replays and every save failed).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Game } from '../server/game.mjs';
import { createWorld } from '../src/world/world.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const dir = mkdtempSync(join(tmpdir(), 'lsb-storage-'));
Game.create(dir, createWorld({ players: [{ name: 'A' }, { name: 'B' }], seed: 1 }));
for (let i = 1; i <= 30; i++) { writeFileSync(join(dir, 'replays', `b${i}.bin.gz`), Buffer.alloc(1000)); writeFileSync(join(dir, 'replays', `b${i}.json`), '{}'); }
writeFileSync(join(dir, 'game.json.tmp'), 'half a save');
const logs = [];
const g = new Game({ dir, log: (m) => logs.push(m) });
ok(!existsSync(join(dir, 'game.json.tmp')), 'a half-written save is cleared at start');
ok(g.replays.size === 30 && g.replayBytes.get('b1') === 1002, 'replays and their sizes are known');

// pretend the disk is nearly full: 20,000 bytes short
let free = 1e9;
g.disk = () => ({ total: 10e9, free });
ok(g.pruneReplays() === 0, 'nothing is deleted while there is room');
free = 300e6 - 20000;
const v0 = g.replayVer;
const n = g.pruneReplays();
ok(n === 20 && !g.replays.has('b1') && !g.replays.has('b20') && g.replays.has('b21') && !existsSync(join(dir, 'replays', 'b1.bin.gz')), `the oldest replays go first (${n})`);
ok(g.replayVer > v0, 'and clients are told the list changed');
free = 0;
g.pruneReplays();
ok(g.replays.size === 10 && g.replays.has('b30'), 'the newest 10 are always kept');

// replays are kept to 2 GB in all (owner, 23 Nov 2026), whatever room the disk has
ok(g.replayCap === 2e9, 'the replay limit is 2 GB');
for (let i = 31; i <= 50; i++) { writeFileSync(join(dir, 'replays', `b${i}.bin.gz`), Buffer.alloc(1000)); writeFileSync(join(dir, 'replays', `b${i}.json`), '{}'); g.replays.add(`b${i}`); g.replayBytes.set(`b${i}`, 1002); }
free = 1e9;
g.replayCap = 15000; // 30 replays of 1,002 bytes are kept now, so 16 must go (14 fit)
const m = g.pruneReplays();
const kept = [...g.replayBytes.values()].reduce((a, b) => a + b, 0);
ok(m === 16 && kept <= 15000 && g.replays.has('b50') && !g.replays.has('b36') && g.replays.has('b37'), `oldest go once replays pass the limit (${m} deleted, ${kept} bytes kept)`);
ok(logs.some((l) => /Replays over/.test(l)), 'and the log says why');
ok(g.pruneReplays(2000) === 2 && g.replays.has('b50'), 'room is made for the next replay too');
g.replayCap = 2e9;

// a save that fails never throws (the order still happened) and is shown to the admin
g.file = join(dir, 'no-such-folder', 'game.json');
g.save();
ok(g.saveError && /ENOENT/.test(g.saveError.message) && logs.some((l) => /SAVE FAILED/.test(l)), 'a failed save is recorded, not thrown');
mkdirSync(join(dir, 'no-such-folder'));
g.save();
ok(g.saveError === null && existsSync(g.file), 'and clears once saving works again');
rmSync(dir, { recursive: true, force: true });
console.log(`storage: ${checks} checks passed`);
