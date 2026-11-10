// Patch notes shown in the game's Patch notes window (owner, Nov 2026). Newest first.
//
// EVERY UPDATE THAT GOES LIVE ADDS AN ENTRY HERE (or adds lines to today's entry), written for
// players: what changed and what it means for them, no code names. `id` must be unique and new
// for each entry; the button shows a "new" badge until a player has opened the newest one.
// History before this file was written back from the commit log, starting when the game went
// live on Railway (4 Nov 2026).

export const PATCH_NOTES = [
  {
    id: '2026-11-11', date: '11 Nov 2026', title: 'Replay colours fixed, fleets start spread out',
    items: [
      'Fixed: in battle replays, each player\'s fighters, missiles, laser beams and the colour by their name were shown in the OTHER player\'s colour. Everything now matches the player\'s own ships. This fixes old replays too.',
      'Fleets now start a battle already spread out, instead of starting in a blob and spreading out once the battle begins. Every ship starts at least 20 blocks from its neighbours, and fleets of big ships get more room. Start positions (Front, Back, flanks) work as before.',
    ],
  },
  {
    id: '2026-11-10b', date: '10 Nov 2026', title: 'Slower selling and building, patch notes',
    items: [
      'NEW: this Patch notes window. Every update to the game will be listed here.',
      'Selling a shipyard now takes 5 hours. It stops building ships straight away and pays out its 95% at the end. You can change your mind with "Keep it". If the world falls first, the shipyard is destroyed and you get nothing.',
      'Building defences now takes 5 hours. You pay when you order them, and they join the world\'s defenders when finished. If the world falls first, the unfinished defences are lost.',
      'Why: an attack only gives 30 minutes\' warning, so selling up or throwing up defences the moment an enemy fleet arrived was too easy. Plan ahead.',
      'The Thruster tooltip in the designer now explains that thrusters also set speed on the galaxy map: a fleet travels at the top speed of its slowest ship.',
    ],
  },
  {
    id: '2026-11-10a', date: '10 Nov 2026', title: 'Carriers, fighters and holding the line',
    items: [
      'NEW BLOCK: Fighter bay (6×6, key C). Opens each battle with a squadron of 3 fighters, then launches one every 30 s for as long as the battle lasts, at any range. Fighters circle the nearest enemy ship and shoot it, dogfight enemy fighters, and fly until shot down (600 hp, 45 damage a second).',
      'Fighter bays need a way out: on the hull edge, or a tunnel of empty cells to space. Tunnels can now turn corners; hover a bay in the designer to see its way out.',
      'Point defence reworked: range 80 against missiles, fighters and ships, 15 damage every 0.2 s. It goes for missiles first, then fighters. Lasers hit fighters only 30% of the time.',
      'Cannon range 260 → 340. Missiles have 150 hp.',
      'Ships no longer turn and run to open the range. Once at their distance they hold, turn so the most guns face the enemy, and drift slowly sideways. Pressed too close, they back off still facing the enemy.',
      'NEW STANCE: Skirmisher keeps the old kiting behaviour (turns away and opens the range when pressed). Good for ships with guns on the back or sides.',
    ],
  },
  {
    id: '2026-11-09', date: '9 Nov 2026', title: 'Guided missiles, Battle simulator, start positions',
    items: [
      'NEW BLOCK: Guided missile launcher (135 cr, key G). The same huge missile, but it steers after its target and finds a new one if its target dies.',
      'Missiles fly 15% faster. Point defence is now called Anti-missile point defence, and its tooltip says what it does.',
      'NEW: Battle simulator button in the top bar: test any designs against each other. Nothing is spent.',
      'NEW: Start positions. Pick where each design starts in battle (Front, Middle, Back, Top flank, Bottom flank, or Auto), next to Stance in the designer. Works for defences too.',
      'Designer test battles: add your other designs to your side, to test a new ship together with your fleet.',
      'Routing is now decided by the value of ships left, not their number, so losing lots of cheap ships no longer makes a side flee with its big ships still fighting.',
      'Battles now last up to 8 minutes (was 4).',
      'Shipyard crowding: each new shipyard on a world costs +100% for every 750,000 cr of shipyards already there.',
      'Plasma cannon blocks have 750 hp (was 120), so plasma ships don\'t lose their guns at once.',
      'Plasma bolts no longer fire through friendly defences or friends flying into the line as often.',
      'Fixed: plasma bolts fired in the last 30 s of a battle were invisible in replays.',
    ],
  },
  {
    id: '2026-11-08', date: '8 Nov 2026', title: 'Defences',
    items: [
      'NEW: Defences. Build fixed defences (any design with no thrusters) at your worlds for a fifth of their block price, from the Defences section of the world panel. They never move, always face the enemy with their front, and stand in rows at the world. All are lost if the world falls.',
      'NEW: Defence Designer, with its own test battles where your defences stand in rows as they would at a world.',
      'Shipyards sell for 95% of what you paid (was 50%).',
      'Plasma cannon price 1,500 a unit (was 3,500). Point defence costs 60 (was 30).',
      'Every home world now has a hyperlane leading inward.',
      '"Avoid worlds you don\'t hold" is now off by default, and the move panel explains when it stops your fleet using hyperlanes, with a one-click fix.',
      'The Escort and Brawler stances were removed; ships that used them now fight as Front line.',
      'Designer: new block looks, a clearer weapon table, test against any design in the game, and rename your designs from the world panel.',
      'New shipyard list: star your favourite designs or hide ones you don\'t use.',
      'Designer: right-click an empty cell to pick the Hand tool and drag the view.',
    ],
  },
  {
    id: '2026-11-07', date: '7 Nov 2026', title: 'The plasma cannon',
    items: [
      'The heavy laser became the Plasma cannon: a big blue bolt that carves through every ship in its path, FRIEND AND FOE ALIKE, and its blocks explode when destroyed.',
      'Cannon shells fly for 30 s and missiles for 90 s, so misses fly on and can still hit something.',
      'Debris that breaks off a ship is pushed clear of it instead of sitting on top.',
      'Ships look far more detailed up close: lit plating, gun ports, laser crystals, missile tubes and point-defence dishes in red.',
    ],
  },
  {
    id: '2026-11-06', date: '6 Nov 2026', title: 'Stances and weapon balance',
    items: [
      'NEW STANCES: Artillery, Front line, Flanker and Raider, chosen per design in the designer.',
      'Ships keep some space between them, so they can move past each other and you can see the shots.',
      'Weapon prices rebalanced: lasers cost more, cannons less. Point defence is stronger against missiles.',
      'Missile launchers aim at the biggest ship in range.',
    ],
  },
  {
    id: '2026-11-05', date: '5 Nov 2026', title: 'Free-for-all battles and tougher debris',
    items: [
      'NEW: Free-for-all battles. Everyone at a world fights one battle together, each player fighting only the players they are at war with. One siege per world.',
      'Lasers burn through several blocks, often into a second ship.',
      'Debris collides with ships and stays solid for the whole battle.',
      'Hubs are fragile (60 hp): a hit hub breaks the whole ship apart.',
      'Ships are drawn in their player\'s colour in replays, with a flame behind each thruster.',
      'The world panel shows ships and move controls first, with shipyards below (you can fold them away).',
    ],
  },
  {
    id: '2026-11-04', date: '4 Nov 2026', title: 'The game goes live',
    items: [
      'The game is online: log in with the password you were given.',
      'Open seats: if your seat had no name, you pick your own name and colour the first time you log in.',
      'Fixed: a side that routs now loses the battle (routed defenders used to keep their world).',
    ],
  },
];
