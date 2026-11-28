// Patch notes shown in the game's Patch notes window (owner, Nov 2026). Newest first.
//
// EVERY UPDATE THAT GOES LIVE ADDS AN ENTRY HERE (or adds lines to today's entry), written for
// players: what changed and what it means for them, no code names. `id` must be unique and new
// for each entry; the button shows a "new" badge until a player has opened the newest one.
// History before this file was written back from the commit log, starting when the game went
// live on Railway (4 Nov 2026).

export const PATCH_NOTES = [
  {
    id: '2026-11-28-allies-hold', date: '28 Nov 2026', title: "An owner's ally only holds a world against its own enemies",
    items: [
      "Fixed: when the owner of a world was beaten in a battle, an ally of theirs who was there fighting someone else could keep the world for them, even against an attacker the ally wasn't at war with and could never have stopped.",
      "Now the owner only keeps the world if one of their side still in the fight is at war with an attacker still in the fight. Otherwise the winning attacker takes it, and the owner's allies' ships fly home unharmed.",
    ],
  },
  {
    id: '2026-11-28-flak-bursts', date: '28 Nov 2026', title: 'Flak bursts in the open round ships',
    items: [
      'Flak cannons now burst in the empty space round and between enemy ships, a few blocks to about 16 blocks off their hulls and on every side, instead of right against the hull. Battles look more like flak in the movies.',
      'It works the same way against anything from a frigate to an Aegis citadel: the distance is measured from the hull, not the middle of the ship.',
      'Damage is about the same as before: a burst further out reaches more of a hull, so each block it reaches now takes 30 instead of 40. Fighters still take 40.',
    ],
  },
  {
    id: '2026-11-27-neutral-ground', date: '27 Nov 2026', title: "A shared ally's world is neutral ground",
    items: [
      "If two players at war with each other are both allied with a third, that third player's worlds are neutral ground: their fleets can both stop there without fighting.",
      "Fixed: one of them flying in to such a world used to make the other's ships wait there to defend it, and draw the other's fleets in to defend it too, though nobody was going to attack. Now ships only stay to defend a world when a fleet is really coming to attack it.",
    ],
  },
  {
id: '2026-11-27-designer-buttons', date: '27 Nov 2026', title: 'Ship designer buttons stay put',
    items: [
      'The buttons along the top of the ship and defence designers (Start from, Credits, Build shipyard and the rest) no longer shuffle sideways while you place blocks. This was worst on phones.',
      'Start from → Sample frigate works again (it used to do nothing).',
    ],
  },
  {
    id: '2026-11-26-colours', date: '26 Nov 2026', title: 'Player colours easier to tell apart',
    items: [
      'Some player colours were almost the same (two purples, two oranges, two greens). All 18 colours have been spread out so no two look alike.',
      'Your colour changed a little to the new one in its place: oranges stay orange, purples stay purple, and so on. Old replays are shown in the new colours too.',
      'Later the same evening a few colours were swapped round between players so everyone has the colour they wanted.',
    ],
  },
  {
    id: '2026-11-26-share-replays', date: '26 Nov 2026', title: 'Share replays with a link',
    items: [
      'New Share button next to Watch in the combat log: it gives you a link to that battle. Paste it in a group chat and anyone can watch the replay in their browser, phones included, without logging in.',
      'On a phone, Share opens your phone\'s share menu so you can send it straight to Messenger, WhatsApp or anywhere else. On a computer the link is copied, ready to paste.',
      'Downloaded replay files still work on computers, but phones and chat apps can\'t open them, so use Share for those.',
    ],
  },
  {
    id: '2026-11-26-late-join', date: '26 Nov 2026', title: 'Friends can join a game already under way',
    items: [
      'A new player can now join a running galaxy. They get a new home world of their own, in a gap somewhere on the map.',
      'At first no hyperlane reaches a newcomer\'s world: nobody can attack it, and its ships can\'t leave yet. Once a hyperlane joins it to the rest of the galaxy (you\'ll see "New hyperlane" in the log), their fleets set off like everyone else\'s, and the world can be attacked like any other.',
      'If you set a world\'s Destination to a world that no hyperlane reaches, your fleets now go for the nearest enemy instead of waiting.',
    ],
  },
  {
    id: '2026-11-26-combat-search',
    date: '26 Nov 2026',
    title: 'Search the combat log',
    items: [
      'The combat log has a search box: type a player, a world, or a word like "legendary", "huge" or "taken". Every word you type must match, and the start of a word is enough ("bo" finds Bo). It works together with Mine / Allies / Everyone.',
      'Aegis fortresses: their price now follows block prices, so they no longer all cost exactly 150,000. The Defence Designer\'s Start from menu shows each one\'s real price.',
    ],
  },
  {
    id: '2026-11-26-start-spots', date: '26 Nov 2026', title: 'Every player starts a battle in their own spot',
    items: [
      'In battles with three or more players, everyone now starts in a spot of their own round the world: the world\'s owner at the world, everyone else spread evenly round it, allies included.',
      'Before, all the owner\'s allies started together at the world, even two allies who were at war with each other, so they started mixed together and tore into each other straight away. That can\'t happen any more.',
      'Each player\'s spot also starts far enough out that neighbouring fleets don\'t touch at the start.',
      'Start positions (Front, Middle, Back, Top and Bottom flank) work the same in every spot.',
      'Allies still never shoot each other and head for the same enemies, they just come in from different directions.',
    ],
  },
  {
    id: '2026-11-25-line-tool', date: '25 Nov 2026', title: 'Line tool in the ship and defence designers',
    items: [
      'New Line tool next to Pencil (shortcut L): press on one block, drag to another and let go, and it draws a straight line of the selected block between them. You see where it will go while you drag.',
      'Hold Shift while dragging to keep the line perfectly straight or at exactly 45°.',
      'Diagonal lines are drawn as a staircase, so every block touches the next one side to side and stays attached to your ship.',
      'Mirror works with it, a right-button drag draws a line of empty space (erasing), and one Undo removes the whole line.',
    ],
  },
  {
    id: '2026-11-25-gun-balance', date: '25 Nov 2026', title: 'Cannons fire faster and reach further',
    items: [
      'Cannons still miss a lot (that\'s their weakness), so to make up for it they now fire every 9 seconds (was 10) and reach 360 (was 340).',
      'Auto guns are unchanged, but cannons now hold their own against them.',
      'This changes ships already in play from their next battle.',
    ],
  },
  {
    id: '2026-11-25-filters-totals', date: '25 Nov 2026', title: 'Mine / Allies filters, shorter battle reports, fleet values',
    items: [
      'The Combat log and the Battles window now have separate filters: Mine shows only battles you fought in, Allies shows yours and your allies\', and Everyone shows them all. (Mine used to include your allies.) In the Battles window, click Mine or Allies again to go back to everyone\'s.',
      'Battle reports no longer list every beaten fleet and where it fell back to. They just say how many of each player\'s ships fell back.',
      'Where several fleets fly together on one lane, and at worlds under attack, you now see the credit value as well as the number of ships: for each fleet, each player, each alliance and everyone there in all.',
    ],
  },
  {
    id: '2026-11-25-fleet-stances', date: '25 Nov 2026', title: 'Fleet stances: change orders for ships already in play',
    items: [
      'New Fleet stances button at the top of the screen. It lists every design you have in play (ships, shipyards and defences) with its stance and start position.',
      'Change either one and every ship of that design switches at once: in your shipyards, at your worlds and in fleets already flying. It counts from the next battle that starts; a battle already being fought keeps the old orders.',
      'Defences never move, so they have no stance, but you can change which rows they stand in (front, back, a flank…).',
      'Your stance changes are private: nothing is posted in the log.',
    ],
  },
  {
    id: '2026-11-25-arrive-together', date: '25 Nov 2026', title: 'Allies arriving together: the world goes by lot',
    items: [
      'When allies take a world together, it normally goes to whoever got there first. But allied fleets often arrive at exactly the same moment (same speed, leaving the same battle together), and then it was down to chance in the code which of you got it.',
      'Now, if allies arrive together (within a minute of the attack starting), the world goes by lot, weighted by the value of the ships each of you arrived with. If your fleet is worth 70,000 cr and your ally\'s 30,000 cr, you have a 70% chance and they have 30%. Only players who still have ships there at the end can win it.',
      'The world panel shows the odds while the attack is waiting to start, and the battle log says how it went.',
    ],
  },
  {
    id: '2026-11-25-designer-credits', date: '25 Nov 2026', title: 'Your credits in the designers',
    items: [
      'The Ship Designer and Defence Designer now show your credits at the top, kept up to date while you design.',
      'Under the price you can also see how many credits you\'ll have left after building, or how many you\'re short (in red).',
    ],
  },
  {
    id: '2026-11-25-stack-list', date: '25 Nov 2026', title: 'Fleet list under an arrow fixed',
    items: [
      'Clicking a fleet in the "fleets here" list seemed to do nothing: the panel did switch to that fleet, but the list moved it to the top, so everything looked the same. The list now stays in the same order, the fleet you are looking at is clearly highlighted, and the panel says which one it is ("Fleet 2 of 3").',
      'Works for every fleet, yours or anyone else\'s.',
    ],
  },
  {
    id: '2026-11-25-guided', date: '25 Nov 2026', title: 'Guided missiles keep steering',
    items: [
      'Guided missiles sometimes stopped steering and flew straight on. That happened when their target was too close beside them to turn onto, often right after they picked a new target. Now they fly past, turn round and come back for another pass.',
      'When a guided missile\'s target is destroyed, it now looks twice as far for a new one, and picks the enemy it can reach soonest rather than simply the nearest.',
    ],
  },
  {
    id: '2026-11-25-selling', date: '25 Nov 2026', title: 'Selling shipyards: full price, one at a time',
    items: [
      'Selling a shipyard now gives back everything you paid for it (it was 65%), so swapping a design that didn\'t work out no longer costs you a third of it.',
      'But you can only sell one shipyard every 12 hours, counted across all your worlds (shipyards for the same design are sold one at a time too). Selling still takes 5 minutes, so you can no longer sell off a whole world\'s shipyards when an attack is coming.',
      'The world panel shows when your next sale can start. If you call a sale off with Keep it, or the world falls before the sale finishes, you get your sale back straight away.',
    ],
  },
  {
    id: '2026-11-25-stacked-fleets', date: '25 Nov 2026', title: 'See every fleet under an arrow',
    items: [
      'Ships that leave a world together often fly as several fleets along the same lane, drawn on top of each other, so clicking the arrow only showed one of them. Now hovering or clicking a fleet shows how many fleets are there and how many ships they have in all, and the fleet panel lists each one so you can click through them.',
      'Nothing about how fleets move has changed: no ships were going missing.',
    ],
  },
  {
    id: '2026-11-25-bounty', date: '25 Nov 2026', title: 'Fairer bounty between allies',
    items: [
      'When allies fight a battle together, their bounty is now shared by the value of the ships (and defences) each of them brought into the battle, instead of evenly. Bring 100,000 cr of ships alongside an ally who brings 50,000 and you get two thirds.',
      'It counts what went into the battle, not what survived, so losing your ships doesn\'t cost you your share.',
    ],
  },
  {
    id: '2026-11-24-hyperlane', date: '24 Nov 2026', title: 'A new hyperlane',
    items: [
      'Two outer worlds in the bottom-right of the map that sat side by side with no hyperlane between them are now joined. Fleets start using the new lane straight away.',
      'Worlds earn income for each hyperlane they have, so both of those worlds now earn 100 cr/h more.',
    ],
  },
  {
    id: '2026-11-24-autogun', date: '24 Nov 2026', title: 'Faster auto gun bullets',
    items: [
      'Auto gun bullets now fly half as fast again (225 instead of 150), with longer tracer streaks, so they look and feel like real bullets. Damage, range and fire rate are unchanged.',
      'In replays, auto gun bullets now spark exactly where they hit the hull.',
    ],
  },
  {
    id: '2026-11-23-tutorial', date: '23 Nov 2026', title: 'A tutorial',
    items: [
      'New Tutorial button at the top of the screen: a short step-by-step guide to how the game works, from worlds and shipyards to designing ships, how fleets move by themselves, sieges, defences, diplomacy and watching replays. Use Next and Back (or the arrow keys) to step through it, and open it again whenever you like.',
    ],
  },
  {
    id: '2026-11-v2', date: '18 Nov 2026', title: 'Version 2.0: the galaxy plays itself',
    items: [
      'Fleets now move by themselves, so you no longer need to be online to defend or attack. What matters is your ship designs, where you build shipyards, which way you push and your diplomacy.',
      'Every 90 minutes all the shipyards on a world build at the same moment, 5 ships each, and everything built there leaves together as one fleet. Each world has its own build clock: the world panel shows when its next fleet leaves and where it will go, and a small arrow on the map points the way.',
      'Fleets fly along the hyperlanes one world at a time and decide again at every world. With no orders they go for the nearest enemy: an enemy or militia world, or one of your or your allies\' worlds that an enemy fleet is heading for. They never set off for a battle that would start before they got there; they pick the nearest one they can make instead, or wait.',
      'Give a world a Destination and its fleets head there instead, fighting any enemy world on the way, then go for the nearest enemy once they arrive. "Send fleets from all my worlds here" points all your worlds at one world. Move ships, Stop and rally points are gone.',
      'If an enemy fleet is heading for one of your worlds, your ships there stay to defend it, and keep their own orders. Fleets already on their way to a world when a siege starts there turn back if they would arrive after its battle starts. After a battle, whoever holds the world moves first, so a successful defence can strike straight back.',
      'Two enemy fleets setting off at each other\'s worlds along the same hyperlane at the same moment: the one that would arrive later turns back to defend. Lanes between players at war glow red on the map: that\'s the front line.',
      'Everything is about 3× slower: home worlds 500 cr/h, other worlds 130 to 330, fleets fly a third as fast, battles wait 3 hours after the first attackers arrive, and selling a shipyard or building defences takes 15 hours. Speed matters less on hyperlanes: a ship twice as fast is 40% faster there.',
      'New prices: cannons and lasers 120 cr, point defence 90. A world\'s shipyards make the next one there +100% dearer for every 325,000 cr of them. Bounty is 10% of enemy losses.',
    ],
  },
  {
    id: '2026-11-16b', date: '16 Nov 2026', title: 'How the galaxy is won',
    items: [
      'The galaxy is won as soon as one alliance holds every world in it, militia worlds included. Every player in that alliance wins.',
      'Enemies who still have fleets or ships parked on someone else\'s world no longer hold up the win. Players are still knocked out one by one when they have no worlds, ships or fleets left.',
    ],
  },
  {
    id: '2026-11-16a', date: '16 Nov 2026', title: 'Victory and defeat screens',
    items: [
      'When the galaxy is won, everyone gets a full-screen Victory or Defeat card: a picture of the player holding the most worlds on the throne as Emperor of the galaxy, their allies kneeling before it and the fallen players\' torn banners in the hall, plus the final standings and the war\'s records.',
      'Final standings for every player: worlds held (and the most held at once), income, credits earned (income plus bounties), ships built and lost, enemy hulls destroyed in their battles, battles won and fought, worlds taken and their biggest battle. Plus the biggest and longest battles of the war, and honours: Warlord, Tycoon, Shipwright, Conqueror, Veteran and Martyr.',
      'The card is frozen at the moment of victory. You can close it and carry on playing and watching replays as before; the Final results button on the map brings it back. "Save the picture" downloads the throne picture.',
      'Knocked out before the end? You get a card with your own war and the standings so far.',
      'The game now keeps these statistics as it goes. Everything from before today was rebuilt from the game\'s history.',
    ],
  },
  {
    id: '2026-11-15d', date: '15 Nov 2026', title: 'Faster updates, less data',
    items: [
      'Behind the scenes: the game now downloads only what changed in the galaxy instead of the whole galaxy every time anything happens, and doesn\'t download the game page again when it hasn\'t changed. Nothing changes in how it plays; it just uses far less data (handy on phones).',
      'Fixed: "Server error." on every order. The server\'s disk had filled up with battle replays, so the game couldn\'t save. The oldest replays are now cleared automatically when the disk gets nearly full (the newest are always kept), so the game can always save.',
    ],
  },
  {
    id: '2026-11-15c', date: '15 Nov 2026', title: 'Shields: refilling adds up less, bubbles follow the hull',
    items: [
      'Shields still add up in full (5,000 for each generator), but refilling now adds up less and less: one generator refills 100 a second, two 180, three 244, four 295, and no ship ever refills faster than 500 a second. Before, every generator added another 100, so a fortress covered in generators refilled faster than a whole fleet could hurt it and never took any damage.',
      'Ordinary ships with one or two generators barely change. Big defences still get huge shields, but a big enough fleet can now wear them down.',
      'Shield bubbles now follow the real outline of ships and defences, round every arm and through every gap, instead of a box round the whole thing.',
      'Big ships and fortresses now keep their real shape when you zoom out in replays, instead of turning into a plain box.',
      'Fixed: in replays, flak shrapnel sometimes looked as if it flew straight through ships. It always stopped at the hull; replays just drew some pieces at the wrong speed. Now each piece is drawn stopping where it really hit (battles recorded from now on).',
    ],
  },
  {
    id: '2026-11-15b', date: '15 Nov 2026', title: 'Flak and shield fixes',
    items: [
      'Flak shrapnel now does 30 damage a piece (was 60). A whole salvo is still 100 pieces, so it still shreds small, lightly armoured ships and fighters, but big armoured hulls shrug it off far better.',
      'Fixed: flak shells sometimes burst inside a ship or wreck they were flying through, so all their shrapnel hit one spot at once. They now always burst in open space beside their target.',
      'The flak cannon\'s tooltip in the designer now matches how it really works (30 damage a piece, the same to every kind of block, 30% against shields, never bursts inside a hull).',
      'Fixed: explosions (missiles, plasma cook-offs, generators and flak cannons going off) drained a shield by far more than they could actually destroy, because every weak block in the blast counted the blast\'s full damage. A shield now soaks exactly what the explosion would have done to the hull.',
      'Fixed: a ship whose shield generator was cut off from the hub kept showing its shield bubble in replays after the shield was gone.',
      'Shield bubbles now hug the ship\'s real shape: a rounded box round the blocks still there, instead of an oval round the whole design. Long thin ships no longer get huge glowing ends, the corners of big square ships no longer poke out of their shield, and a ship that has lost half its hull no longer has a bubble round the empty space.',
    ],
  },
  {
    id: '2026-11-15a', date: '15 Nov 2026', title: 'New: flak cannons and shield generators',
    items: [
      'New 10×10 weapon in the designer: the Flak cannon (key K, 1,500 cr a unit, the same size and price as the plasma cannon). Every 10 seconds it fires a salvo of 5 shells up to 700 blocks at one enemy ship; each bursts right beside it in a spray of 20 pieces of shrapnel flying every way, and every piece flies on until it hits something: deadly to small, lightly armoured ships and fighters.',
      'Flak goes for the most lightly armoured ship in range first (lots of guns, little armour or frame) and spreads its fire, so a fleet full of flak cannons doesn\'t all shoot the same ship. Its shells fly straight through ships and wrecks to burst in the open beside their target, so they reach the back lines. Its blocks have 200 hp, and once a quarter of them are destroyed the whole cannon blows up (the blast barely hurts the rest of the ship). Shrapnel is stopped by wrecks and allied ships, but never hurts your side. It\'s the answer big ships have been missing against swarms of small ships.',
      'New 10×10 block in the designer: the Shield generator (key E, 1,500 cr a unit). Each one gives its ship a 5,000 shield that soaks up every hit before a single block is damaged, and refills by 100 a second all the time. Generators stack. Flak shrapnel only does 30% damage to shields.',
      'Its blocks are very weak (45 hp): once the shield is down, losing any one of them makes the whole generator explode, hurting your own ship, and its shield is gone. Bury generators deep in armour and keep them well apart (and away from your hub), so big armoured ships get the most out of them.',
    ],
  },
  {
    id: '2026-11-14c', date: '14 Nov 2026', title: 'No more circling in front of fortresses',
    items: [
      'Guided missiles now steer for the part of the ship they were fired at, instead of its centre. Against hollow fortresses (like the Aegis ones) the centre is an open courtyard, so missiles flew in and circled it until they ran out. If that part gets shot away, they head for the nearest part still standing.',
      'Guided missiles that end up too close to their target to turn onto it now fly straight on (and can still hit whatever is ahead) instead of looping round it.',
      'Ships no longer spin on the spot in front of giant fortresses. They now judge their distance from the fortress\'s nearest wall, so they settle at their range and keep their guns on it instead of flip-flopping between flying in and holding back. Ships set to Charge still fly into the courtyards.',
      'Ships holding their distance in a crowd now slide aside to make room instead of turning, so they stay facing the enemy.',
    ],
  },
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
