// Patch notes shown in the game's Patch notes window (owner, Nov 2026). Newest first.
//
// EVERY UPDATE THAT GOES LIVE ADDS AN ENTRY HERE (or adds lines to today's entry), written for
// players: what changed and what it means for them, no code names. `id` must be unique and new
// for each entry; the button shows a "new" badge until a player has opened the newest one.
// History before this file was written back from the commit log, starting when the game went
// live on Railway (4 Nov 2026).

export const PATCH_NOTES = [
  {
    id: '2026-11-14b', date: '14 Nov 2026', title: 'Rename your worlds; download battle replays',
    items: [
      'You can now rename any world you hold: select it and click Rename next to its name. Everyone sees the new name on the map. Names are up to 24 characters and can\'t match another world\'s name. If the world is taken, the new owner can rename it again.',
      'Every battle in the Combat log now has a Download button next to Watch. It saves the replay as a file, handy for sending a battle to someone when reporting a bug.',
    ],
  },
  {
    id: '2026-11-13c', date: '13 Nov 2026', title: 'Fighters toned down; stronger point defence and plasma',
    items: [
      'Fighter bays still open every battle with 3 fighters, but then launch 1 every minute (was 1 every 30 seconds). Fighters are as tough and hit as hard as before; there are just fewer of them in long battles.',
      'Lasers now hit fighters 65% of the time (was 30%).',
      'Anti-missile point defence now does 30 damage a burst (was 25), to missiles, fighters and ships alike.',
      'Plasma cannons now fire every 10 seconds (was 15).',
      'This applies to every ship and defence already in play, from the next battle on.',
    ],
  },
  {
    id: '2026-11-13b', date: '13 Nov 2026', title: 'Battles can last up to 15 minutes',
    items: [
      'The battle time limit is now 15 minutes (was 8), for world battles, the designer\'s test battle and the Battle simulator. Big sieges get time to play out instead of stopping at the limit (a battle that hits the limit still leaves the world with whoever holds it).',
    ],
  },
  {
    id: '2026-11-13a', date: '13 Nov 2026', title: 'Giant fortresses fixed; point defence fires through allies',
    items: [
      'Ships and fighters can now fly into the open spaces inside giant hollow defences and ships (like the Aegis fortresses\' courtyards and lanes). Before, the whole outline counted as solid, so attackers piled up at its edge.',
      'Giant hulls no longer fire through their own walls: before, plasma bolts and shells could leave through a gap and fly harmlessly through the hull\'s own arms. Guns on giants now only fire along lines that really are clear of their own blocks.',
      'Ships now judge their distance to a giant hollow defence or ship by its real walls, not its outline, so attackers fly right into its lanes and courtyards to fight (charging ships go all the way in to the core).',
      'Point defence now also fires through your own and allied ships at missiles, as it already did at fighters. Before, an allied ship in the way blocked it. Expect more missiles to be shot down.',
    ],
  },
  {
    id: '2026-11-12d', date: '12 Nov 2026', title: 'Stronger point defence, cannons and plasma',
    items: [
      'Anti-missile point defence now does 25 damage a burst (was 15), to missiles, fighters and ships alike. It shoots down more missiles and kills fighters faster.',
      'Cannon shells now do 100 damage (was 75).',
      'Plasma cannons now fire every 15 seconds (was 17).',
      'Weapons are tougher: lasers, cannons, point defence, missile launchers and guided missile launchers all have 300 hit points now (were 80 to 200). Plasma cannons and fighter bays are unchanged.',
      'This applies to every ship and defence already in play, from the next battle on.',
    ],
  },
  {
    id: '2026-11-12c', date: '12 Nov 2026', title: 'Ready-made Aegis fortresses',
    items: [
      'Four giant ready-made defences are now in the Defence Designer: open a world\'s Defences, press Build, then "Design a new defence…", and pick one from "Start from" under "Aegis fortresses". Each costs 150,000 credits and takes 5 hours to build, like any defence.',
      'Aegis Star Citadel: a classic star fort with eight armoured bastions. Aegis Star Citadel II: hollow, with three rings of guns that fire out down six open lanes, and hangars deep inside. Aegis Star Citadel III: five arms fanned forward with a carrier deck in the back. Aegis Star Citadel IV: a giant harpoon nearly 1,000 blocks long, 44 plasma cannons, every gun facing the front.',
      'Remember a defence\'s front (the right-hand side in the designer) always faces the enemy. III and IV put almost everything at the front, so they are weaker if a second enemy comes from behind; I and II are good all round.',
      'You can change them like any design before building: load one, edit it, then build.',
    ],
  },
  {
    id: '2026-11-12b', date: '12 Nov 2026', title: 'Rally points',
    items: [
      'Each of your worlds can now have a rally point: one of your worlds or an ally\'s. Ships its shipyards build then fly straight there as soon as they\'re finished, so your new ships gather in one place by themselves. Ships already at the world don\'t move.',
      'Set it at the bottom of a world\'s panel under "Rally point". On any friendly world, "Send new ships from all my shipyards here" points every world with a shipyard at it in one go, and "Stop sending them here" undoes that. Select a world to see its rally point as a dashed arrow on the map.',
      'New ships on their way to a rally point go round worlds your side doesn\'t hold, so they never get into a fight on the way. While a world is under attack, its new ships stay to defend it.',
      'If the rally point is taken by an enemy (or an alliance ends), it\'s cancelled when the next ship is built and new ships stay at home.',
    ],
  },
  {
    id: '2026-11-12a', date: '12 Nov 2026', title: 'Refresh when the game is updated',
    items: [
      'When the game is updated while you have it open, a bar at the top asks you to refresh. Press "Refresh now" and you\'re on the new version.',
      'Until you refresh, orders from the old page aren\'t accepted, so nothing you send can go wrong because of the update. Nothing is lost: just refresh and give the order again.',
    ],
  },
  {
    id: '2026-11-11i', date: '11 Nov 2026', title: 'Huge battle replays open again',
    items: [
      'Fixed: replays of very big battles with lots of guided missiles got stuck on "Loading the replay". They open now, including battles that were already fought: just press Watch again.',
      'If a replay ever can\'t be opened, the viewer now says so (with a message to send to the game\'s owner) instead of loading for ever.',
    ],
  },
  {
    id: '2026-11-11h', date: '11 Nov 2026', title: 'Trips through several worlds can be called off',
    items: [
      'A fleet on its way through several worlds can now be stopped. Select the fleet and press "Stop at …" (press twice to confirm). It still flies on to the world it is heading for right now, and fights there if that world isn\'t yours or an ally\'s, but it won\'t leave for the worlds after it. Example: a fleet going A → B → C → D, stopped on its way to B, ends its trip at B.',
      'A fleet waiting in a battle on the way stays for that battle, then stays at that world.',
      'Fleets still can\'t be turned back, and a retreating fleet can\'t be stopped.',
    ],
  },
  {
    id: '2026-11-11g', date: '11 Nov 2026', title: 'Ships and defences valued separately',
    items: [
      'A world\'s panel now shows how many credits are in ships and how many are in defences for each player there, plus the total. Defences count at their full block price.',
    ],
  },
  {
    id: '2026-11-11f', date: '11 Nov 2026', title: 'Fleets take empty worlds on the way, plasma fires faster',
    items: [
      'Fleets now take every enemy world on their route, not just the ones with defenders. At an empty enemy world (or an empty unclaimed one) the fleet stops for the usual 30 minutes, takes it (destroying its shipyards) and flies on. The owner gets the same 30 minutes\' warning to rush ships in. Plan for 30 minutes per world on the way.',
      'Plasma cannons now fire every 17 seconds (was 20).',
    ],
  },
  {
    id: '2026-11-11e', date: '11 Nov 2026', title: 'Plasma rebalanced, fleets start closer behind big defences',
    items: [
      'Plasma cannon bolts now carry 5,000 damage (was 25,000). They still cut big ships and defences into pieces, but a giant defence now lasts minutes instead of about 20 seconds. Plasma is still the best answer to titans and battleships.',
      'Tip for big defences: plasma slices through frame (only 45 hp) far more easily than heavy armour (240 hp), and anything cut off from the hub breaks away. Use heavy armour for the core, keep the hub deep inside, and don\'t put your own plasma cannons where they take the first hits: they explode.',
      'Fixed: behind a very big defence (like a colossus) the world\'s own ships started far too far back, so they took ages to join the fight. They now start the same distance behind the defences as they do behind small ones. Same fix in the designer\'s test battle.',
    ],
  },
  {
    id: '2026-11-11d', date: '11 Nov 2026', title: 'Bounties and credit gifts',
    items: [
      'NEW: bounties. After every battle, each group of allies that fought earns 20% of the value of everything its enemies lost there (ships, defences and militia), shared evenly between the allies. You get paid even if you lose the battle, so fighting a bigger player is never a total loss. The battle\'s log entry shows who earned what.',
      'Free-for-alls pay every side: each group is paid for its own enemies\' losses.',
      'Defences now count at their full block price everywhere: in a world\'s "cr of hulls", in battle results and in bounties. A defence bought for 2,000 cr that is 10,000 cr of blocks counts as 10,000. Hover a defence in a world panel to see what it cost to build.',
      'NEW: Send credits. In the Diplomacy window, press Send credits next to any player, type an amount and press Send. It arrives at once and shows in the log.',
    ],
  },
  {
    id: '2026-11-11c', date: '11 Nov 2026', title: 'Battles box',
    items: [
      'The Events box on the galaxy map is now the Battles box: it lists only battles, newest first, each with its Watch button, so one look when you log in shows what\'s been fought. Tap a battle to jump to that world. Mine shows only battles you or your allies were in.',
      'Want everything back (fleets sent, shipyards, alliances, worlds taken without a fight)? Press All in the box. Press it again for battles only. Your choice is remembered.',
    ],
  },
  {
    id: '2026-11-11b', date: '11 Nov 2026', title: 'Play on your phone',
    items: [
      'The whole game now works on a phone. Nothing changes on a computer.',
      'Ship designer on a phone: the grid takes most of the screen, with the blocks and tools in two rows underneath that you swipe sideways. One finger draws; two fingers move around and zoom. Pick Erase to remove blocks. With the Hand tool, tap a block to see what it does and, for a gun, where it can fire. The Stats button (it shows the ship\'s price, in red while the design has a problem) opens the stats and checks over the grid; tap it again to close them.',
      'Galaxy on a phone: a smaller top bar, so the map gets more room; swipe the row of buttons sideways to reach them all. After you tap a world to send a fleet to, the Launch button scrolls into view.',
      'Battle replays on a phone open on the whole battle, and the Back button is a bar along the top, so it no longer covers the play controls.',
      'Fixed: pinching to zoom the galaxy map on a phone or tablet made the map fly off the screen. Pinching now zooms in on the spot between your fingers, and you can move the map with two fingers as you zoom.',
      'NEW: a full-screen button next to − + Fit on the galaxy map (phones and computers). It hides the top bar and side panel so the map fills the screen; tap it again (or press Esc on a computer) to bring them back. You can still tap worlds while full screen: their details are in the panel when you come back.',
      'Turn your phone on its side for more room: the galaxy puts the map and the panel side by side, and the designer puts the blocks down the left.',
    ],
  },
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
