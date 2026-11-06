// Resolve a generated battle in Node and write it as one self-contained HTML page that plays the
// replay (the viewer page in a frame, fed the gzipped replay). For sending battles to the owner
// after combat changes: the file opens in any browser, no server needed.
//
// Usage: node tools/replay-page.mjs [perSide=600] [seed=1] [out=dist/replay.html] [title]
// Run `npm run build:viewer` first (it embeds dist/viewer.html).
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Battle } from '../src/sim/battle.js';
import { makeScenario } from '../src/shared/designs.js';
import { packReplay } from '../src/shared/replayFormat.js';

const [perSide = 600, seed = 1, out = 'dist/replay.html', title = 'Test battle'] = process.argv.slice(2);
const scen = makeScenario({ perSide: Number(perSide), seed: Number(seed) });
const t0 = performance.now();
const b = new Battle({ ...scen, seed: Number(seed) });
b.run();
const ms = performance.now() - t0;
const rep = b.toReplay();
const bytes = packReplay(rep.meta, rep.cols);
const gz = gzipSync(bytes, { level: 9 });
const viewer = readFileSync('dist/viewer.html', 'utf8');

const page = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#05070b}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><iframe id="v"></iframe>
<script>
const replay = "${gz.toString('base64')}";
const html = new TextDecoder().decode(Uint8Array.from(atob("${Buffer.from(viewer).toString('base64')}"), (c) => c.charCodeAt(0)));
const frame = document.getElementById('v');
addEventListener('message', async (e) => {
  if (!e.data || e.data.type !== 'lsb-viewer-ready') return;
  const raw = Uint8Array.from(atob(replay), (c) => c.charCodeAt(0));
  const bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  frame.contentWindow.postMessage({ type: 'lsb-replay', bytes: bytes.buffer, title: ${JSON.stringify(title)}, computeMs: ${Math.round(ms)} }, '*', [bytes.buffer]);
});
frame.src = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
</script></body></html>`;
writeFileSync(out, page);
console.log(`${out}: ${perSide} vs ${perSide}, ${(b.tick / 10).toFixed(0)} s (${b.endReason}), ${(ms / 1000).toFixed(1)} s compute, page ${(page.length / 1e6).toFixed(1)} MB`);
