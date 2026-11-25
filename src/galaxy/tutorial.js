// The Tutorial window (owner, 23 Nov 2026: "my friends want a tutorial… a button to click that
// takes them to the tutorial"; he chose a step-by-step guide that only opens from its button).
// Written for players, no code names. Every number comes from the rule files, so the guide stays
// right when a price or a timing changes. `click` is 'Click' or 'Tap' (phones).

import {
  SHIPYARD_INTERVAL_MIN, SHIPS_PER_BUILD, SHIPYARD_PRICE_MULT, SHIPYARD_CROWDING_VALUE, DEFENSE_PRICE_SHARE,
  BOUNTY_SHARE, SHIPYARD_SELL_REFUND, SELL_HOURS, SELL_GAP_HOURS, DEFENSE_BUILD_HOURS, HOME_INCOME, PLANET_INCOME_BASE,
  PLANET_INCOME_PER_LANE, STARTING_CREDITS, NEUTRAL_GARRISON_BASE, NEUTRAL_GARRISON_HOURS,
} from '../shared/economy.js';
import { BATTLE_HOLD_MIN, BATTLE_MAX_TIME } from '../world/rules.js';

const n = (v) => Math.round(v).toLocaleString('en-AU');
const pct = (v) => `${Math.round(v * 100)}%`;
const mins = (h) => { const m = Math.round(h * 60); return m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${n(m / 60)} hours`; };
const holdText = BATTLE_HOLD_MIN % 60 ? `${BATTLE_HOLD_MIN} minutes` : `${BATTLE_HOLD_MIN / 60} hours`;
const buildText = SHIPYARD_INTERVAL_MIN % 60 ? `${SHIPYARD_INTERVAL_MIN} minutes` : `${SHIPYARD_INTERVAL_MIN / 60} hours`;
const lanes = (k) => n(PLANET_INCOME_BASE + PLANET_INCOME_PER_LANE * k);

// Small original pictures, drawn in the page's own colours.
const W = (body) => `<svg class="tut-art" viewBox="0 0 320 110" role="img" aria-hidden="true">${body}</svg>`;
const world = (x, y, r, c, ring = '') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" opacity="0.9"/>${ring}`;
const lane = (x1, y1, x2, y2, c = 'rgba(140,170,210,0.55)', w = 2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}"/>`;
const label = (x, y, t, c = 'var(--dim)', a = 'middle') => `<text x="${x}" y="${y}" fill="${c}" font-size="10" text-anchor="${a}" font-family="var(--mono)">${t}</text>`;
const arrow = (x1, y1, x2, y2, c, dash = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="2.5" ${dash ? `stroke-dasharray="${dash}"` : ''} marker-end="url(#tut-head-${c === 'var(--signal)' ? 'w' : 'a'})"/>`;
const heads = `<defs><marker id="tut-head-a" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--azure)"/></marker><marker id="tut-head-w" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--signal)"/></marker></defs>`;
const MINE = 'var(--azure)', THEM = 'var(--ember)', MILITIA = '#6e7a8c';

const ART = {
  welcome: W(`${heads}${lane(40, 60, 110, 30)}${lane(110, 30, 190, 55)}${lane(190, 55, 270, 35)}${lane(110, 30, 130, 90)}${lane(190, 55, 230, 92)}
    ${world(40, 60, 13, MINE)}${world(110, 30, 8, MINE)}${world(130, 90, 7, MILITIA)}${world(190, 55, 9, MILITIA)}${world(230, 92, 7, MILITIA)}${world(270, 35, 13, THEM)}
    ${arrow(118, 34, 165, 50, MINE)}${label(40, 88, 'you', MINE)}${label(270, 63, 'an enemy', THEM)}${label(190, 80, 'militia')}`),
  income: W(`${lane(70, 55, 160, 55)}${lane(160, 55, 250, 25)}${lane(160, 55, 250, 85)}${lane(160, 55, 160, 100)}${lane(160, 55, 160, 10)}
    ${world(70, 55, 15, MINE)}${world(160, 55, 11, MINE)}${world(250, 25, 6, MILITIA)}${world(250, 85, 6, MILITIA)}
    ${label(70, 88, `home ${n(HOME_INCOME)}/h`, MINE)}${label(205, 52, `4 lanes: ${lanes(4)}/h`, 'var(--ink)', 'start')}`),
  yards: W(`<rect x="30" y="25" width="70" height="60" rx="4" fill="none" stroke="var(--azure)" stroke-width="2"/>${label(65, 50, 'shipyard', MINE)}${label(65, 66, '×3', 'var(--ink)')}
    <circle cx="160" cy="55" r="26" fill="none" stroke="var(--line)" stroke-width="5"/><path d="M160 29 A26 26 0 1 1 134 55" fill="none" stroke="var(--azure)" stroke-width="5"/>${label(160, 59, buildText.replace(' minutes', ' min'), 'var(--ink)')}
    ${[0, 1, 2].map((r) => [0, 1, 2, 3, 4].map((c) => `<rect x="${215 + c * 15}" y="${30 + r * 18}" width="10" height="7" fill="var(--azure)" opacity="0.85"/>`).join('')).join('')}${label(250, 100, `${SHIPS_PER_BUILD * 3} ships, one fleet`, 'var(--ink)')}`),
  design: W(`${(() => { // a little ship on a grid: armour skin, hub, guns at the nose (right), thrusters at the back
    const cell = { A: '#5c7ea3', H: '#86e8ff', F: '#90a6c0', T: '#3d434f', C: '#9aa1ab', L: '#d8f4ff' };
    const rows = ['..AAAAAAA..', '.AFFFFFFCA.', 'TAFFHFFFFLA', 'TAFFFFFFFCA', 'TAFFFFFFFLA', '.AFFFFFFCA.', '..AAAAAAA..'];
    let s = '';
    rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch !== '.') s += `<rect x="${78 + i * 12}" y="${12 + j * 12}" width="11" height="11" fill="${cell[ch]}"/>`; }));
    return s;
  })()}${label(222, 52, 'nose →', 'var(--ink)', 'start')}${label(222, 66, 'faces the enemy', 'var(--dim)', 'start')}${label(40, 52, 'thrusters', 'var(--dim)')}`),
  fleets: W(`${heads}${lane(30, 60, 110, 60)}${lane(110, 60, 190, 60, 'var(--bad)', 3)}${lane(190, 60, 290, 60)}${lane(110, 60, 150, 100)}
    ${world(30, 60, 10, MINE)}${world(110, 60, 10, MINE)}${world(150, 100, 6, MINE)}${world(190, 60, 10, THEM)}${world(290, 60, 10, THEM)}
    ${arrow(118, 52, 160, 52, MINE)}${label(150, 40, 'front line', 'var(--bad)')}${label(70, 85, 'one hop at a time', 'var(--ink)')}`),
  dest: W(`${heads}${lane(40, 70, 120, 40)}${lane(120, 40, 200, 70)}${lane(200, 70, 280, 40)}${lane(40, 70, 70, 100)}
    ${world(40, 70, 11, MINE)}${world(70, 100, 6, MINE)}${world(120, 40, 8, MILITIA)}${world(200, 70, 8, THEM)}${world(280, 40, 12, THEM, '<circle cx="280" cy="40" r="18" fill="none" stroke="var(--signal)" stroke-width="1.5"/>')}
    <path d="M50 64 Q160 -10 266 38" fill="none" stroke="var(--signal)" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#tut-head-w)"/>${label(280, 75, 'destination', 'var(--signal)')}`),
  siege: W(`${world(160, 55, 14, THEM)}<circle cx="160" cy="55" r="30" fill="none" stroke="var(--warn)" stroke-width="2" stroke-dasharray="4 4"/>
    ${[[100, 30], [95, 60], [105, 88]].map(([x, y]) => `<path d="M${x} ${y} l-12 -5 l0 10 z" fill="var(--azure)"/>`).join('')}${[[220, 40], [225, 72]].map(([x, y]) => `<path d="M${x} ${y} l12 -5 l0 10 z" fill="var(--ember)"/>`).join('')}
    ${label(160, 104, `battle in ${holdText}`, 'var(--warn)')}`),
  defence: W(`${world(270, 55, 14, MINE)}${[0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => `<rect x="${215 - r * 26}" y="${14 + c * 24 + (r % 2) * 12}" width="14" height="10" fill="${r === 0 ? '#41597a' : '#5c7ea3'}" stroke="var(--azure)" stroke-width="1"/>`).join('')).join('')}
    ${[[54, 35], [44, 65], [59, 90]].map(([x, y]) => `<path d="M${x} ${y} l-14 -5 l0 10 z" fill="var(--ember)"/>`).join('')}${label(80, 104, `ready in ${mins(DEFENSE_BUILD_HOURS)}`, 'var(--ink)')}`),
  allies: W(`${lane(70, 55, 160, 55)}${lane(160, 55, 250, 55)}${world(70, 55, 14, MINE)}${world(250, 55, 14, '#a3f27c')}${world(160, 55, 9, MILITIA)}
    ${label(70, 90, 'you', MINE)}${label(250, 90, 'your ally', '#a3f27c')}${label(160, 25, 'attack together', 'var(--ink)')}`),
  replays: W(`${[['#ffd35c', 'Legendary'], ['#e879f9', 'Epic'], ['#ff7a45', 'Huge'], ['#5aaeff', 'Large'], ['#5fd39a', 'Medium'], ['#8b98ad', 'Small']].map(([c, t], i) => `<rect x="${20 + (i % 3) * 100}" y="${22 + Math.floor(i / 3) * 40}" width="88" height="26" rx="4" fill="none" stroke="${c}" stroke-width="${i ? 1.5 : 3}"/>${label(64 + (i % 3) * 100, 39 + Math.floor(i / 3) * 40, t, c)}`).join('')}`),
};

/** The guide's pages, in order: { title, art, html }. */
export function tutorialPages(click = 'Click') {
  return [
    { title: 'Welcome to the galaxy', art: ART.welcome, html: `
      <p>Large Space Battles with Friends is a space strategy game that <b>plays itself while you're away</b>. You never steer fleets or fight battles by hand. Your part is the big decisions:</p>
      <ul><li><b>Designing ships</b>, block by block.</li><li><b>Where you build shipyards</b>, the factories that make those ships.</li><li><b>Which way you push</b>, by pointing your worlds at a target.</li><li><b>Diplomacy</b>: who you ally with, and who you turn on.</li></ul>
      <p>Your ships fly off and fight by themselves, day and night, and every battle is saved as a replay you can watch. Use <b>Next</b> to step through this guide; the <b>Tutorial</b> button at the top brings it back any time.</p>` },

    { title: 'Worlds and credits', art: ART.income, html: `
      <p>The map is a galaxy of worlds joined by <b>hyperlanes</b> (the bright lines). Each world you hold pays credits every hour into one shared pot. Your <b>Credits</b> and <b>Income</b> are at the top of the screen.</p>
      <ul><li>Your <b>home world</b> pays ${n(HOME_INCOME)} cr an hour.</li>
      <li>Every other world pays ${n(PLANET_INCOME_BASE)} cr, plus ${n(PLANET_INCOME_PER_LANE)} for each hyperlane it has: ${lanes(1)} cr/h with 1 lane, ${lanes(3)} with 3, ${lanes(5)} with 5. Crossroads are worth more, but they're harder to hold because enemies can come from more directions.</li>
      <li>You start with ${n(STARTING_CREDITS)} cr.</li></ul>
      <p>${click} any world to see its panel on the right: who holds it, its income, its ships and its shipyards. ${click} empty space to go back to your overview.</p>` },

    { title: 'Shipyards: where ships come from', art: ART.yards, html: `
      <p>You don't buy ships one at a time. You buy a <b>shipyard</b> for one design, and it builds that ship <b>for free, forever</b>.</p>
      <ul><li>Select one of your worlds, open <b>Shipyards</b> and press <b>Build</b>. Pick a design (or make a new one) and buy the yard.</li>
      <li>Every ${buildText}, <b>all the shipyards on a world build at the same moment, ${SHIPS_PER_BUILD} ships each</b>, and everything built there leaves together as one fleet. The world panel's <b>Next fleet</b> row shows how long until it leaves and where it's going.</li>
      <li>A shipyard costs ${SHIPYARD_PRICE_MULT}× the price of its ship.</li>
      <li><b>Spread your yards out.</b> Each world's yards make the next one there dearer: +100% for every ${n(SHIPYARD_CROWDING_VALUE)} cr of yards already on it.</li>
      <li>If an enemy takes the world, <b>its shipyards are destroyed</b>. You can sell a shipyard for ${pct(SHIPYARD_SELL_REFUND)} of what you paid (it takes ${mins(SELL_HOURS)}), but only <b>one every ${SELL_GAP_HOURS} hours</b>, so you can't sell everything when an attack is coming.</li></ul>` },

    { title: 'Designing ships', art: ART.design, html: `
      <p>In the shipyard window choose <b>Design a new ship…</b> to open the <b>Ship Designer</b>. You paint the ship block by block, and its price is the price of its blocks.</p>
      <ul><li>Every ship needs exactly <b>one hub</b>, and every block must connect to it. The hub is fragile: protect it, because if it goes, the ship falls apart.</li>
      <li><b>Thrusters</b> move it; <b>weapons</b> fight; <b>armour</b> and frame hold it together. Hover over (or ${click.toLowerCase()}) a block in the palette to see what it does.</li>
      <li>The <b>nose</b> is the right-hand side of the grid. A gun can fire in any direction where its shot wouldn't pass through its own ship, so guns on the edge cover more.</li>
      <li>Pick a <b>stance</b>: how the ship behaves in battle (Front line, Artillery, Flanker, Raider, Charge, Skirmisher).</li>
      <li>Press <b>Test battle</b> to try the design before you pay. The <b>Battle simulator</b> button at the top pits any designs against each other, for free.</li></ul>` },

    { title: 'Fleets move by themselves', art: ART.fleets, html: `
      <p>New fleets launch on their own and fly <b>along the hyperlanes, one world at a time</b>, deciding again at every world they reach. Fleets don't sit and wait: <b>they fight until they die</b>.</p>
      <ul><li>With no orders, a fleet goes for the <b>nearest enemy</b>: a world of a player you're at war with, a <b>militia</b> world (grey), or one of your or your allies' worlds that an enemy fleet is heading for.</li>
      <li>A small arrow on the map shows where each of your worlds' next fleet will go.</li>
      <li>Lanes between players at war glow <b style="color:var(--bad)">red</b>: that's the front line.</li>
      <li>If an enemy fleet is heading for one of your worlds, <b>your ships there stay to defend it</b>.</li>
      <li>A fleet won't set off for a battle it would arrive too late for. It picks one it can make, or moves up and waits.</li></ul>` },

    { title: 'Aiming your worlds: destinations', art: ART.dest, html: `
      <p>Want to push in one direction? Give a world a <b>destination</b>.</p>
      <ul><li>Select your world, find <b>Destination</b> and press <b>Choose on map</b>, then ${click.toLowerCase()} the world its fleets should go to. It can be an enemy world to attack or a friendly one to gather at.</li>
      <li>Fleets fight any enemy world on the way, then go for the nearest enemy once they arrive.</li>
      <li><b>Send fleets from all my worlds here</b> (on any world's panel) points every one of your worlds at it.</li>
      <li><b>Nearest enemy instead</b> clears the destination.</li></ul>` },

    { title: 'Sieges and battles', art: ART.siege, html: `
      <p>When a fleet reaches a world it attacks, it starts a <b>siege</b>. The battle waits <b>${holdText}</b>, so both sides can send more ships. A ring round the world counts down.</p>
      <ul><li>When it starts, <b>everyone there fights everyone they're at war with</b>, in one battle that lasts up to ${n(BATTLE_MAX_TIME / 60)} minutes. The server fights it out by itself.</li>
      <li>If the attackers win, they take the world. Its shipyards and defences are destroyed and its income goes to the winner. Beaten fleets fall back.</li>
      <li>You earn a <b>bounty</b> of ${pct(BOUNTY_SHARE)} of the value of the enemy ships destroyed in your battles. Allies who fight together share it by the value of the ships each brought into the battle.</li>
      <li><b>Taking turns:</b> once a world beats off an attack, the world that attacked can't attack it again until it gets attacked back from there. The world panel shows this as <b>Can't attack</b> and <b>Safe from</b>.</li>
      <li><b>Militia</b> worlds are how everyone grows at the start. They're well defended (${n(NEUTRAL_GARRISON_BASE)} cr of ships plus ${NEUTRAL_GARRISON_HOURS} hours of the world's income), so the first attack often needs a second wave.</li></ul>` },

    { title: 'Defences', art: ART.defence, html: `
      <p>See a big fleet coming? Build <b>defences</b>: guns that stay at the world and fight every battle there.</p>
      <ul><li>On your world's panel, press <b>Build</b> next to Defences, then <b>Design a new defence…</b> (a defence is a design with <b>no thrusters</b>).</li>
      <li>They cost only ${pct(DEFENSE_PRICE_SHARE)} of their block price and are <b>ready in ${mins(DEFENSE_BUILD_HOURS)}</b>, so you can react to an attack.</li>
      <li>They line up in rows in front of the world. A defence's nose (the right-hand side in the designer) always faces the attackers, so put your armour there.</li>
      <li>If the world falls, its defences are destroyed.</li></ul>` },

    { title: 'Allies and enemies', art: ART.allies, html: `
      <p>Open <b>Diplomacy</b> at the top of the screen. Every other player is either an ally or an enemy, and that can change during the game.</p>
      <ul><li>An alliance needs both players: one proposes, the other accepts.</li>
      <li>Allies' ships defend each other's worlds and join each other's attacks.</li>
      <li>A world taken together goes to whoever got there first. If allies arrive at the same moment, it goes by lot, weighted by the value of the ships each brought: 70,000 cr against 30,000 cr is a 70% chance.</li>
      <li>Either side can break an alliance alone. Each side's ships on the other's worlds then fly home.</li>
      <li>You can also gift credits to another player.</li>
      <li><b>How to win:</b> the galaxy is won the moment one alliance holds every world, militia worlds included. Everyone in that alliance wins.</li></ul>` },

    { title: 'Watching the battles', art: ART.replays, html: `
      <p>Every battle is recorded so you can watch it like a film.</p>
      <ul><li>The <b>Combat log</b> at the top lists your battles. Each is coloured by how much was destroyed compared with every other battle so far, from Small up to Legendary.</li>
      <li><b>Watch</b> plays the replay. <b>Download</b> saves it as a web page you can keep and open in any browser.</li>
      <li>The small <b>Battles</b> window on the map shows the latest fights. ${click} one to jump to its world.</li>
      <li><b>Patch notes</b> at the top lists what's changed in each update.</li></ul>
      <p>That's everything you need to know. Build a shipyard, aim your worlds, and enjoy the fireworks. Good luck, commander.</p>` },
  ];
}
