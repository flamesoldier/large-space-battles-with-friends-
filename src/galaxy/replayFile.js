// A replay saved as a web page (owner, 22 Nov 2026: "a standalone playable in a browser file"): the
// replay viewer and the replay in one .html file that plays when opened, no server or game needed.
// replayPageParts(viewerDoc, meta) gives the text before and after the replay; put the gzipped packed
// replay, base64, between them. The page reads <script id="lsb-meta"> (title, sides, teams, side
// colours, world, time, log text), <script id="lsb-viewer"> (the viewer page) and
// <script id="lsb-replay"> (the replay), and feeds the viewer the way the game page does.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safe = (o) => JSON.stringify(o).replace(/</g, '\\u003c'); // never closes the script tag

export function replayPageParts(viewerDoc, meta) {
  const title = meta.title || 'Battle replay';
  const head = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>html,body{margin:0;height:100%;background:#05070b;color:#cfd8e3;font:14px system-ui,sans-serif}iframe{border:0;width:100%;height:100%;display:block}#msg{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none}</style>
</head><body><div id="msg">Loading the replay…</div><iframe id="v" title="Battle replay"></iframe>
<script id="lsb-meta" type="application/json">${safe(meta)}</script>
<script id="lsb-viewer" type="application/json">${safe(viewerDoc)}</script>
<script id="lsb-replay" type="text/plain">`;
  const tail = `</script>
<script>
const meta = JSON.parse(document.getElementById('lsb-meta').textContent);
const frame = document.getElementById('v');
addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow || !e.data || e.data.type !== 'lsb-viewer-ready') return;
  try {
    const raw = await (await fetch('data:application/gzip;base64,' + document.getElementById('lsb-replay').textContent.trim())).arrayBuffer();
    const bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    frame.contentWindow.postMessage({ type: 'lsb-replay', bytes: bytes.buffer, computeMs: meta.computeMs, sides: meta.sides, teams: meta.teams, title: meta.title, sideColors: meta.sideColors }, '*', [bytes.buffer]);
    document.getElementById('msg').remove();
  } catch (err) { document.getElementById('msg').textContent = "This replay could not be opened: " + err.message + ". Try a recent Chrome, Edge, Firefox or Safari."; }
});
frame.src = URL.createObjectURL(new Blob([JSON.parse(document.getElementById('lsb-viewer').textContent)], { type: 'text/html' }));
</script></body></html>
`;
  return [head, tail];
}
