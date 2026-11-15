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

// a save that fails never throws (the order still happened) and is shown to the admin
g.file = join(dir, 'no-such-folder', 'game.json');
g.save();
ok(g.saveError && /ENOENT/.test(g.saveError.message) && logs.some((l) => /SAVE FAILED/.test(l)), 'a failed save is recorded, not thrown');
mkdirSync(join(dir, 'no-such-folder'));
g.save();
ok(g.saveError === null && existsSync(g.file), 'and clears once saving works again');
rmSync(dir, { recursive: true, force: true });
console.log(`storage: ${checks} checks passed`);
