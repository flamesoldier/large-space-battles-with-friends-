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

/**
 * The page a share link opens (owner, 26 Nov 2026: "my friends… send each other replays… it doesn't open
 * on my phone"): a downloaded .html file won't run in Facebook Messenger or a phone's file viewer, so
 * the game's Share button gives a link instead, /watch/<battle>/<key>, that opens in any browser with
 * no login. This page holds the viewer; it fetches the replay from /api/watch/<battle>/<key> (the
 * server checks the key) and feeds the viewer like the game page does. `<!--LSB-OG-->` is where the
 * server puts the battle's title and story for link previews.
 */
export function watchPage(viewerDoc) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!--LSB-OG-->
<style>html,body{margin:0;height:100%;background:#05070b;color:#cfd8e3;font:15px system-ui,sans-serif}iframe{border:0;width:100%;height:100%;display:block}#msg{position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;line-height:1.5}</style>
</head><body><div id="msg">Loading the replay…</div><iframe id="v" title="Battle replay"></iframe>
<script id="lsb-viewer" type="application/json">${safe(viewerDoc)}</script>
<script>
const msg = document.getElementById('msg'), frame = document.getElementById('v');
const say = (t) => { msg.textContent = t; msg.style.pointerEvents = 'auto'; frame.hidden = true; };
const m = location.pathname.match(/^\\/watch\\/(b\\d+)\\/([A-Za-z0-9_-]+)\\/?$/);
const got = !m ? Promise.reject(new Error('link')) : fetch('/api/watch/' + m[1] + '/' + m[2]).then(async (res) => {
  if (res.status === 404) throw new Error('gone');
  if (!res.ok) throw new Error('bad');
  let meta = {};
  try { meta = JSON.parse(decodeURIComponent(res.headers.get('X-Replay-Meta') || '{}')); } catch (e) { /* no meta */ }
  return { meta, bytes: await res.arrayBuffer() };
});
got.catch((e) => say(e.message === 'gone'
  ? 'This replay isn\\'t available. The link may not have been copied in full, the game keeps only its newest battles, or a new game has started.'
  : e.message === 'link' ? 'This link isn\\'t a replay link. Check it was copied in full.' : 'Couldn\\'t load the replay. Check your connection and try again.'));
addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow || !e.data || e.data.type !== 'lsb-viewer-ready') return;
  let r; try { r = await got; } catch (err) { return; }
  if (r.meta.title) document.title = r.meta.title;
  frame.contentWindow.postMessage({ type: 'lsb-replay', bytes: r.bytes, computeMs: r.meta.computeMs, sides: r.meta.sides, teams: r.meta.teams, title: r.meta.title, sideColors: r.meta.sideColors }, '*', [r.bytes]);
  msg.remove();
});
if (!window.WebGL2RenderingContext) say('This browser can\\'t play replays (it needs WebGL 2). Open the link in Chrome, Safari, Firefox or Edge.');
else frame.src = URL.createObjectURL(new Blob([JSON.parse(document.getElementById('lsb-viewer').textContent)], { type: 'text/html' }));
</script></body></html>
`;
}
