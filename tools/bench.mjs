// Usage: node tools/bench.mjs [shipsPerSide=500] [seed=1] [--out file.replay.gz]
// Runs a full battle headless and reports compute time and replay size.
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeScenario } from '../src/shared/designs.js';
import { Battle, DT } from '../src/sim/battle.js';
import { packReplay, unpackReplay } from '../src/shared/replayFormat.js';

const args = process.argv.slice(2);
const perSide = Number(args[0] ?? 500);
const seed = Number(args[1] ?? 1);
const outIdx = args.indexOf('--out');

const scen = makeScenario({ perSide, seed });
let blocks = 0;
for (const s of scen.ships) { const d = scen.designs[s.design]; blocks += d.cells.reduce((n, c) => n + (c ? 1 : 0), 0); }
const byCls = {};
for (const s of scen.ships) { const c = scen.designs[s.design].cls; byCls[c] = (byCls[c] || 0) + 1; }
console.log(`ships: ${scen.ships.length} (${JSON.stringify(byCls)}), blocks: ${blocks.toLocaleString()}`);

const t0 = performance.now();
const b = new Battle({ ...scen, seed });
b.run((bb) => {
  if (bb.tick % 200 === 0)
    process.stdout.write(`  t=${(bb.tick * DT).toFixed(0)}s alive ${bb.teamAlive.join(' vs ')}  ents ${bb.ents.length}  projectiles ${bb.P.n}\n`);
});
const simMs = performance.now() - t0;
const rep = b.toReplay();
const packed = packReplay(rep.meta, rep.cols);
const gz = gzipSync(packed, { level: 6 });
unpackReplay(packed); // sanity

const p = b.perf;
console.log(`\nbattle length: ${(b.tick * DT).toFixed(1)}s simulated, survivors ${b.teamAlive.join(' vs ')}`);
console.log(`compute: ${(simMs / 1000).toFixed(2)}s total, ${(p.ms / p.ticks).toFixed(2)} ms/tick avg (${((b.tick * DT) / (simMs / 1000)).toFixed(1)}x realtime)`);
console.log(`peak entities ${p.peakEntities}, peak projectiles ${p.peakProjectiles}, raycasts ${p.raycasts.toLocaleString()}`);
console.log(`events: ${rep.cols.shotT0.length.toLocaleString()} kinetic, ${rep.cols.lasT.length.toLocaleString()} laser, ${rep.cols.misT0.length.toLocaleString()} missiles, ${rep.cols.bdT.length.toLocaleString()} block deaths, ${rep.meta.chunkCount.toLocaleString()} debris chunks`);
console.log(`replay: ${(packed.length / 1e6).toFixed(2)} MB raw, ${(gz.length / 1e6).toFixed(2)} MB gzip`);
const groups = { tracks: /^(ship|track)/, debris: /^ch/, blockDeaths: /^bd/, kinetic: /^shot/, lasers: /^las/, missiles: /^mis/, explosions: /^exp/ };
const parts = Object.entries(groups).map(([g, re]) => {
  const cols = Object.entries(rep.cols).filter(([k]) => re.test(k));
  const z = cols.reduce((n, [, v]) => n + gzipSync(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).length, 0);
  return `${g} ${(z / 1e6).toFixed(2)}MB`;
});
console.log('gzip by stream:', parts.join(', '));

if (outIdx >= 0) {
  const f = args[outIdx + 1];
  mkdirSync(f.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  writeFileSync(f, gz);
  console.log('wrote', f);
}
