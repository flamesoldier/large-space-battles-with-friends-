// End-of-game screens (owner, 16 Nov 2026): a full-screen Victory or Defeat card with the throne
// picture, the final standings and the war's records. Pure HTML from an endReport() (stats.js),
// so the galaxy page and the preview page build exactly the same card.

import { throneSVG } from './throneArt.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
/** 1,234,567 → "1.23M", for the tiles. */
function short(n) {
  n = Math.round(n || 0);
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return fmt(n);
}
function span(ms) {
  const h = Math.max(0, ms) / 3.6e6, d = Math.floor(h / 24), r = Math.round(h - d * 24);
  return d ? `${d} day${d === 1 ? '' : 's'}${r ? ` ${r} h` : ''}` : `${Math.round(h)} hours`;
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const sw = (c) => `<span class="ec-sw" style="background:${esc(c)}"></span>`;
const nameOf = (r) => `<span class="ec-who">${sw(r.color)}${esc(r.name)}</span>`;
const list = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The picture for a report: the throne holder, their fellow winners kneeling, the fallen's banners. */
export function reportArt(R, seed = 1) {
  const rows = R.standings, top = rows.find((r) => r.id === R.throne);
  if (!top) return '';
  const allies = rows.filter((r) => r.winner && r.id !== top.id);
  const fallen = rows.filter((r) => !r.winner);
  const caption = `${top.worlds} world${top.worlds === 1 ? '' : 's'} · Sovereign of the galaxy`;
  return throneSVG({ sovereign: top, allies, fallen, caption, seed });
}

/** Honours: one record per category, to whoever holds it (nothing if nobody scored). */
function honours(rows) {
  const best = (key) => { const r = [...rows].sort((a, b) => (b[key] || 0) - (a[key] || 0))[0]; return r && r[key] > 0 ? r : null; };
  const out = [];
  const add = (key, title, what, val) => { const r = best(key); if (r) out.push({ r, title, what, val: val(r) }); };
  add('killedValue', 'Warlord', 'most enemy hulls destroyed in their battles', (r) => `${short(r.killedValue)} cr`);
  add('earned', 'Tycoon', 'most credits earned', (r) => `${short(r.earned)} cr`);
  add('built', 'Shipwright', 'most ships built', (r) => fmt(r.built));
  add('taken', 'Conqueror', 'most worlds taken', (r) => fmt(r.taken));
  add('battles', 'Veteran', 'most battles fought', (r) => fmt(r.battles));
  add('lost', 'Martyr', 'most ships lost', (r) => fmt(r.lost));
  return out;
}

/**
 * The card's HTML. R: endReport(world). me: the viewing player's id (or null for a spectator).
 * mode: 'victory' | 'defeat' | 'out' (knocked out before the galaxy was won).
 */
export function endCardHTML(R, me, { seed = 1, online = true } = {}) {
  const rows = R.standings, mine = rows.find((r) => r.id === me) || null;
  const won = R.winners.length > 0;
  const mode = !won ? 'out' : mine?.winner ? 'victory' : mine ? 'defeat' : 'victory';
  const winners = rows.filter((r) => r.winner);
  const winNames = list(winners.map((r) => `<b style="color:${esc(r.color)}">${esc(r.name)}</b>`));
  const head = mode === 'victory'
    ? { k: 'Victory', line: mine ? (winners.length > 1 ? `You and your allies hold the galaxy. ${winNames} have won.` : `The galaxy is yours. ${winNames} has won.`) : `${winNames} ${winners.length > 1 ? 'have' : 'has'} won the galaxy.` }
    : mode === 'defeat'
      ? { k: 'Defeat', line: `The galaxy has fallen to ${winNames}.` }
      : { k: 'Knocked out', line: `${esc(mine?.name ?? 'You')} ${mine ? 'has' : 'have'} no worlds, ships or fleets left. You can still watch the galaxy and every battle.` };
  const length = span(R.t - (R.start || 0));
  const sub = won ? `The war for the galaxy is over · ${length}` : `The war goes on · ${length} so far`;

  const art = won ? `<figure class="ec-art">${reportArt(R, seed)}</figure>` : '';

  const tile = (v, k, s = '') => `<div class="ec-tile"><b>${v}</b><small>${k}</small>${s ? `<i>${s}</i>` : ''}</div>`;
  const you = mine ? `<section class="ec-sec"><h3>Your war</h3><div class="ec-tiles four">
      ${tile(`#${mine.rank}`, won ? 'Final place' : 'Place', `of ${rows.length}`)}
      ${tile(fmt(mine.worlds), 'Worlds held', mine.peak > mine.worlds ? `most at once: ${fmt(mine.peak)}` : '')}
      ${tile(short(mine.earned), 'Credits earned', mine.bounty ? `${short(mine.bounty)} of it bounty` : '')}
      ${tile(fmt(mine.built), 'Ships built', mine.builtDefences ? `+ ${fmt(mine.builtDefences)} defences` : '')}
      ${tile(fmt(mine.lost), 'Ships lost', `${short(mine.lostValue)} cr of hulls`)}
      ${tile(short(mine.killedValue), 'Enemy losses', 'cr of enemy hulls destroyed in your battles')}
      ${tile(`${fmt(mine.wins)}<em>/${fmt(mine.battles)}</em>`, 'Battles won', `${fmt(mine.taken)} world${mine.taken === 1 ? '' : 's'} taken`)}
      ${tile(mine.biggest ? fmt(mine.biggest.ships) : '–', 'Your biggest battle', mine.biggest ? `ships at ${esc(mine.biggest.planet)}` : 'no battles fought')}
    </div></section>` : '';

  const B = R.biggest, L = R.longest;
  const records = `<section class="ec-sec"><h3>The war in numbers</h3><div class="ec-tiles">
      ${tile(length, won ? 'Length of the war' : 'So far')}
      ${tile(fmt(R.battles), 'Battles fought')}
      ${tile(fmt(R.destroyed), 'Ships destroyed', 'militia included')}
      ${B ? tile(fmt(B.ships), 'Biggest battle', `ships at ${esc(B.planet)} · ${short(B.value)} cr of hulls · ${short(B.lost)} cr lost`) : ''}
      ${L && L.seconds ? tile(mmss(L.seconds), 'Longest battle', `at ${esc(L.planet)}`) : ''}
    </div></section>`;

  const th = (t, tip = '') => `<th${tip ? ` title="${esc(tip)}"` : ''}>${t}</th>`;
  const table = `<section class="ec-sec"><h3>${won ? 'Final standings' : 'Standings so far'}</h3><div class="ec-scroll"><table class="ec-table">
      <thead><tr>${th('#')}${th('Player')}${th('Worlds', 'Worlds held at the end (most held at once)')}${th('Income', 'Credits per hour at the end')}${th('Credits earned', 'Income plus bounties, the whole game')}${th('Ships built')}${th('Ships lost')}${th('Enemy losses', 'Credits of enemy hulls destroyed in battles they fought')}${th('Battles', 'Won / fought')}${th('Worlds taken')}${th('Biggest battle')}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.id === me ? 'me' : ''}${r.winner ? ' win' : ''}">
        <td>${r.rank}</td>
        <td>${nameOf(r)}${r.id === R.throne && won ? ' <span class="ec-tag gold">Throne</span>' : r.winner ? ' <span class="ec-tag">Victor</span>' : r.eliminated ? ' <span class="ec-tag dim">Out</span>' : ''}</td>
        <td>${fmt(r.worlds)}${r.peak > r.worlds ? ` <em>(${fmt(r.peak)})</em>` : ''}</td>
        <td>${fmt(r.income)}</td>
        <td>${fmt(r.earned)}</td>
        <td>${fmt(r.built)}</td>
        <td>${fmt(r.lost)}</td>
        <td>${fmt(r.killedValue)}</td>
        <td>${fmt(r.wins)}<em>/${fmt(r.battles)}</em></td>
        <td>${fmt(r.taken)}</td>
        <td>${r.biggest ? `${fmt(r.biggest.ships)} ships<br><em>${esc(r.biggest.planet)}</em>` : '–'}</td>
      </tr>`).join('')}</tbody></table></div></section>`;

  const hon = honours(rows);
  const honoursHTML = hon.length ? `<section class="ec-sec"><h3>Honours</h3><div class="ec-honours">${hon.map((h) => `<div class="ec-hon" style="--c:${esc(h.r.color)}">
      <small>${h.title}</small><b>${esc(h.r.name)}</b><span>${h.val}</span><i>${h.what}</i></div>`).join('')}</div></section>` : '';

  const note = R.backfilled ? '<p class="ec-note">Battles, worlds taken and credits earned before 16 Nov were rebuilt from the game\'s history; ships built before then are estimated from the ships left plus those lost.</p>' : '';
  const keep = online ? (won ? 'Keep playing' : 'Keep watching') : 'Close';
  return `<div class="ec-inner ${mode}">
    <header class="ec-head">
      <small>${sub}</small>
      <h1>${head.k}</h1>
      <p>${head.line}</p>
    </header>
    ${art}
    ${you}
    ${records}
    ${table}
    ${honoursHTML}
    <footer class="ec-foot">
      ${note}
      <div class="ec-acts">${won ? '<button id="ec-save">Save the picture</button>' : ''}<button class="go" id="ec-close">${keep}</button></div>
    </footer>
  </div>`;
}

/** Turn the throne picture into a PNG download (2× size). */
export function savePicture(svg, name = 'galaxy-victory.png') {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = 2400; c.height = Math.round((2400 * (img.naturalHeight || 704)) / (img.naturalWidth || 1200));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    c.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  };
  img.src = url;
}

/** Styles for the card (also used by the preview page). */
export const END_CARD_CSS = `
#endcard { position: fixed; inset: 0; z-index: 50; overflow-y: auto; background: radial-gradient(ellipse at 50% 0%, #1a2336, #03040a 70%) #03040a; -webkit-overflow-scrolling: touch; }
#endcard[hidden] { display: none; }
.ec-inner { max-width: 1120px; margin: 0 auto; padding: 34px 24px 40px; color: var(--ink, #dbe4f2); font-family: var(--display, "Chakra Petch", sans-serif); animation: ec-in .7s ease-out both; }
@keyframes ec-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.ec-head { text-align: center; margin-bottom: 22px; }
.ec-head small { display: block; font-size: 12px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--dim, #7d8ba1); }
.ec-head h1 { display: block; margin: 6px 0 6px; font-size: clamp(46px, 9vw, 96px); line-height: 1; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 700; }
.victory .ec-head h1 { background: linear-gradient(#fff6d8, #e8c46a 55%, #9c7226); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 0 22px rgba(232, 196, 106, 0.35)); }
.defeat .ec-head h1, .out .ec-head h1 { color: #ff7b7b; text-shadow: 0 0 26px rgba(255, 90, 90, 0.35); }
.ec-head p { margin: 0; font-size: 17px; }
.ec-art { margin: 0 0 26px; border: 1px solid rgba(232, 196, 106, 0.45); box-shadow: 0 0 0 1px rgba(0,0,0,0.6), 0 20px 60px rgba(0,0,0,0.6), 0 0 80px rgba(232, 196, 106, 0.08); line-height: 0; }
.ec-art svg { width: 100%; height: auto; display: block; }
.defeat .ec-art { filter: saturate(0.8); }
.ec-sec { margin-top: 26px; }
.ec-sec h3 { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--dim, #7d8ba1); margin: 0 0 10px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
.ec-sec h3::after { content: ""; flex: 1; height: 1px; background: var(--line, rgba(140,170,210,0.18)); }
.ec-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.ec-tiles.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.ec-tile { background: rgba(255,255,255,0.035); border: 1px solid var(--line, rgba(140,170,210,0.18)); padding: 11px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ec-tile b { font: 500 24px var(--mono, monospace); font-variant-numeric: tabular-nums; color: var(--signal, #e6eeff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ec-tile b em, .ec-table em { font-style: normal; color: var(--dim, #7d8ba1); font-size: 0.75em; }
.ec-tile small { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim, #7d8ba1); }
.ec-tile i { font-style: normal; font-size: 12px; color: var(--dim, #7d8ba1); line-height: 1.35; }
.ec-scroll { overflow-x: auto; border: 1px solid var(--line, rgba(140,170,210,0.18)); }
.ec-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 860px; }
.ec-table th { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim, #7d8ba1); font-weight: 500; text-align: right; padding: 9px 10px; border-bottom: 1px solid var(--line, rgba(140,170,210,0.18)); white-space: nowrap; }
.ec-table td { text-align: right; padding: 9px 10px; font-family: var(--mono, monospace); font-size: 12.5px; font-variant-numeric: tabular-nums; border-bottom: 1px solid rgba(140,170,210,0.08); white-space: nowrap; }
.ec-table th:nth-child(-n+2), .ec-table td:nth-child(-n+2) { text-align: left; }
.ec-table td:nth-child(2) { font-family: var(--display, sans-serif); font-size: 14px; font-weight: 600; }
.ec-table td:last-child { line-height: 1.3; }
.ec-table tr.win td { background: rgba(232, 196, 106, 0.05); }
.ec-table tr.me td { background: rgba(134, 232, 255, 0.07); }
.ec-table tr:last-child td { border-bottom: 0; }
.ec-who { display: inline-flex; align-items: center; gap: 7px; }
.ec-sw { width: 11px; height: 11px; border-radius: 50%; display: inline-block; box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 0 8px currentColor; }
.ec-tag { font: 600 9.5px var(--display, sans-serif); letter-spacing: 0.12em; text-transform: uppercase; border: 1px solid var(--line, rgba(140,170,210,0.3)); padding: 1px 5px; margin-left: 6px; color: var(--ink, #dbe4f2); vertical-align: 1px; }
.ec-tag.gold { color: #e8c46a; border-color: rgba(232, 196, 106, 0.6); }
.ec-tag.dim { color: var(--dim, #7d8ba1); }
.ec-honours { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
.ec-hon { border: 1px solid var(--line, rgba(140,170,210,0.18)); border-top: 2px solid var(--c); padding: 10px 12px; background: linear-gradient(color-mix(in srgb, var(--c) 9%, transparent), transparent 70%); display: flex; flex-direction: column; gap: 2px; }
.ec-hon small { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #e8c46a; }
.ec-hon b { font-size: 18px; color: var(--c); }
.ec-hon span { font: 500 15px var(--mono, monospace); }
.ec-hon i { font-style: normal; font-size: 12px; color: var(--dim, #7d8ba1); }
.ec-foot { margin-top: 28px; text-align: center; }
.ec-note { color: var(--dim, #7d8ba1); font-size: 12px; max-width: 640px; margin: 0 auto 14px; line-height: 1.5; }
.ec-acts { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.ec-acts button { padding: 10px 20px; font-size: 13px; }
@media (max-width: 640px) {
  .ec-inner { padding: 22px 12px 30px; }
  .ec-head p { font-size: 15px; }
  .ec-tiles, .ec-tiles.four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ec-tile b { font-size: 19px; }
}
`;
