// Runs one battle off the main thread, so the server keeps answering players while a big fight
// (seconds to minutes of compute) resolves. Receives the Battle scenario from planEvent(), sends
// back progress, readBattle()'s result and the packed replay.

import { parentPort } from 'node:worker_threads';
import { Battle, DT } from '../src/sim/battle.js';
import { readBattle, shipColors, battleOptions } from '../src/world/battleSetup.js';
import { packReplay } from '../src/shared/replayFormat.js';

// Ships left on each side of the summary (0 attackers, 1 the world's side), for the progress bar.
function sideAlive(b, scen) {
  const out = [0, 0];
  const sideOf = [];
  for (const g of scen.groups) sideOf[g.team ?? g.side] = g.side;
  b.teamAlive.forEach((n, t) => { out[sideOf[t] ?? 0] += n; });
  return out;
}

parentPort.on('message', ({ scenario }) => {
  try {
    const t0 = performance.now();
    const b = new Battle({ designs: scenario.designs, ships: scenario.ships, seed: scenario.seed, maxTime: scenario.maxTime, ...battleOptions(scenario) });
    let lastNote = 0;
    while (!b.done) {
      b.step();
      const now = performance.now();
      if (now - lastNote > 500) {
        lastNote = now;
        parentPort.postMessage({ type: 'progress', seconds: Math.round(b.tick * DT), frac: Math.min(1, b.tick / b.maxTicks), alive: sideAlive(b, scenario) });
      }
    }
    const result = readBattle(b, scenario);
    const rep = b.toReplay();
    rep.meta.colors = shipColors(scenario);
    const bytes = packReplay(rep.meta, rep.cols);
    parentPort.postMessage({ type: 'done', result, bytes, computeMs: Math.round(performance.now() - t0) }, [bytes.buffer]);
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String(err?.stack || err) });
  }
});
