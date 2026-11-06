# Large Space Battles with Friends: project context

Read this first, then `docs/ARCHITECTURE.md` for how the battle engine works and
`docs/SERVER.md` for the online game. **Current phase: bug fixing and balance on the live game**
(see "Working on the live game" and "Bug fixing and balance" at the end).

## The game

A persistent online space strategy game for a small group of friends (4 to 10 players, about 4 to
start), played like OGame or Travian: build an economy, build fleets, send them out. When fleets
meet, the server resolves the battle headlessly and saves a replay that every player can watch.
Battles are huge (up to thousands of ships), 2D top-down, and chaotic: lasers, shells, missiles,
debris everywhere, hulls breaking apart. Players never control battles directly.

Build order chosen by the owner: hardest part first. Battle engine (done, being polished) →
ship designer (first version done, being tuned) → world, economy and fleets (**galaxy map: first
version done**) → server and accounts (**first version done**: the real game runs online, see
`docs/SERVER.md`). The hot-seat page (`dist/galaxy.html`) still works for testing.

## Status: battle engine

Working and tuned with the owner over several rounds. Stack is plain JavaScript (ES modules),
Node for the server sim and tools, WebGL2 in the browser, esbuild for the single-file viewer.

- `src/shared/blocks.js`: block catalogue and all weapon numbers. Single source of truth.
- `src/shared/designs.js`: ship design format plus a procedural generator for test fleets.
- `src/sim/battle.js`: the battle resolver. `src/sim/spatial.js`: broadphase grid.
- `src/shared/replayFormat.js`: replay container. `src/viewer/`: replay viewer.
- `npm run bench -- 1000` simulates 1,000 vs 1,000 and prints compute time, replay size and
  weapon stats. `npm run build:viewer` writes `dist/viewer.html` (open in a browser).

Ship design format (what the designer must save):
`{ name, cls, w, h, cells: Uint8Array(w*h) of block types, hub: cell index, stance }`.
Cell (i, j) is index `j*w + i`; column `w-1` is the nose (local +x is forward).

## Decisions the owner has made (keep these)

Weapons (numbers in `blocks.js`):
- **Laser**: long range (340), always hits, every ~15 s. Since Nov 2026 (owner's request: "penetrate
  like the heavy laser, to a lesser degree", then "even more damage, maybe 400, every 10 s", then
  15 s) the
  beam carries 400 damage that burns through blocks until spent: about three armour blocks,
  often into a second ship. Holds fire if a friendly ship is first in line. Drawn as a slim
  team-coloured bolt with an impact flash (kept slim so it can't be mistaken for a heavy laser).
- **Cannon**: slow visible shell with a bright trail, aimed with lead, then flies dead straight.
  The main damage dealer. Range 260 (owner, Nov 2026; shell life 7 s so shells reach it).
- **Missile launcher**: huge, slow, unguided missile, range 700, flies over friendly ships,
  100 hp so point defence can shoot it down, fires every 30 s (owner, Nov 2026: was 40 s, blast
  lowered to compensate). Blast hits everything within
  9 blocks with damage `150 × (1 − d/9)²`: one missile craters, a volley tears ships apart.
  All launchers on one ship fire together as a volley. Lead is capped at 3 s.
- **Point defence**: range 30 rapid beam; shoots missiles first, close ships otherwise.
- AI (Nov 2026): missile launchers aim at the biggest ship in range (all launchers on a ship
  agree, so volleys still land together), and a ship whose only guns are missiles sets its
  stance distance from missile range (it used to fall back to 60 and dive in).
- **Heavy laser**: 10×10 multi-block turret, range 650, every 20 s, 25,000-damage beam **1 block
  wide** (owner: a thin cut slices off bigger pieces; `width` in `blocks.js`, was briefly 5) that
  burns through blocks and ships until spent. Drawn to be unmistakable (owner found it hard to
  tell from a laser): a 0.6 s charge-up glow at the gun before it fires (the beam's start is
  attached to the gun ship, so the viewer knows where), then a huge flickering white-hot beam held
  for 0.5 s and fading over 1.6 s, with big muzzle and impact flares. Owner's goal (Nov 2026): **several ships
  cut in half by one shot.** It aims along the line through the most enemy ships (`lanceAim`), and
  **passes harmlessly through allied hulls** further along the line (an exception to the
  friendly-fire rule below: escorts round the gun ship used to stop most shots). Holds fire if a
  friendly ship is first in line. Measured at 600 vs 600: ~3 enemy ships hit and ~2 cut apart or
  destroyed per shot, up to 6. Works while half its blocks survive. **Its blocks explode when destroyed**
  (`COOKOFF` in `blocks.js`: 300 peak damage, radius 16, ignores friendly fire, hurts its own
  ship and allies). One destroyed block chain-reacts through the whole unit: a battleship loses
  ~43% of its blocks and an ally flying alongside loses ~260. The owner asked for it to be huge.
- Future weapons the owner wants: bigger cannons, a medium laser.

Combat rules:
- **Friendly fire off**: allied hulls still block shots but take no damage (except the heavy laser, which passes through them).
- **Firing arcs = line of fire, for every weapon** (missile launchers and heavy lasers too): a
  weapon can fire in any direction where the shot wouldn't pass through its own ship (no fixed
  cone, never 360°). Worked out by `src/shared/arcs.js` (64 direction slices, ray walk through
  the ship's grid), used by both the sim and the designer, and recomputed as blocks are lost, so
  shooting away armour opens arcs. The heavy laser casts its rays from the centre of its 10×10
  unit, through its own blocks. A weapon with no clear direction is buried and can't fire. Flat
  hull-mounted guns get about 90°; guns that stick out get more.
- **Giant ships**: the owner wants ships as big as possible, "even to ridiculous levels". Hull
  classes go past titan to dreadnought, leviathan, colossus and worldbreaker (400,000 blocks,
  grid up to 1024 × 640). Weapons aim at the near side of a big target's hull (range is not
  measured to its centre), big ships track up to 24 targets, and stance distances are measured
  roughly hull to hull, so giants actually fight.
- **Stances** chosen per design (will be a designer option): charge, brawl, line, standoff,
  escort. Escorts take limited slots around a big ship and break off to attack nearby enemies.
- **Debris** must stay clearly visible (wrecks keep most of their colour).
- **Ships are drawn in their player's colour** in replays (owner, Nov 2026), militia in
  `NEUTRAL_COLOR`. `planEvent` puts `color` on each group, the worker / hot-seat page write
  `meta.colors` = `[start, n, colour]` per group (`shipColors()` in `battleSetup.js`), and the
  viewer's `applyColors()` (`renderer.js`) builds a palette per colour; debris keeps its ship's.
  Beams, missiles and the strength graph use each side's leading colour. Older replays get side
  colours from the combat log entry (`sideColors` in the `lsb-replay` message); designer test
  battles keep azure/ember.

**Free-for-all battles** (owner, Nov 2026: "so much fun"): a battle has any number of sides
(`teams`, up to `MAX_TEAMS` = 16) and a who-fights-whom table (`hostile(a, b)`; `fr[(a << 4) | b]`
is 1 for friends). In the galaxy every player is their own side and shoots only the players they
are at war with, so any mixture of pairwise alliances works. Default is two sides at war, so the
designer, bench and old code paths behave as before (same speed; 1,000 vs 1,000 results within
noise). Targets, the enemy centre ships head for, missiles flying over friends, point defence,
heavy-laser holds and escorts (who may guard an ally's ship) all go through `fr`.

Battle end:
- No two sides still in the fight are enemies (a side with no armed ships, or that routed, is out).
- Rout: a side under 20% of its starting ships still armed and outgunned 2:1 by its enemies,
  counted against it **plus its allies** (so a small allied contingent doesn't run while its
  friends are winning). A routed side breaks and runs (its ships flee like disarmed hulks and no
  longer hold the field; `battle.routedTeams`); the others fight on if any are still enemies.
  **The routed side loses** (`battle.routed`, read by `readBattle()`): routed defenders lose the world and their
  surviving ships flee home (`capture()` → `sendHome`). Fixed Nov 2026: a rout used to count as a
  defender win, so 300 attackers that cut 100 defenders down to 13 were "beaten off" in ~60 s.
  Stalemate and time limit still leave the world with its holder.
- Disengagement: 20 s with no damage dealt anywhere, after the first 30 s.
- Time limit: 4 minutes for testing; **30 minutes at launch** so every battle resolves.
- The owner explicitly does not want a "mutual exhaustion" rule.

## Engineering rules learned the hard way

- Declare every entity field in `makeEntity()` in `battle.js`. Adding fields to some objects
  later changes V8 hidden classes and made the sim about 40% slower.
- The viewer is stateless: everything drawn is a pure function of time (that's what makes
  scrubbing free). Anything new in the replay should follow that pattern.
- Projectile samples must stay contiguous per projectile (an earlier bug interleaved them).
- Always benchmark after sim changes (`npm run bench -- 1000`); 1,000 vs 1,000 takes about 7 s.
- Line of fire is incremental: each weapon stores the cell blocking each of its 64 rays
  (`blk`), and `refit()` only re-casts rays whose blocker died (`updateLineOfFire`). A full
  re-cast per hit was fine for 50 guns but not for a giant with 1,000.
- Replay block indexes (`bdCell`, `chCells`) are 32-bit, because giant ships have more than
  65,535 cells.
- The demo page re-runs the sim in the browser, so results differ slightly from Node
  (`Math.sin`/`cos` aren't identical across engines). The real game records replays on the
  server, so that's fine.

## Economy rules the owner has set (for the world/economy phase)

All money numbers are in `src/shared/economy.js` (placeholders until balanced in play).

- Each world gives a fixed credit income into the player's **global** credit pool. Home worlds
  1,500 cr/h; every other world rolls a fixed 400–1,000 cr/h when the map is made.
- Ships aren't bought one at a time. A player buys a **shipyard** on one of their worlds for one
  design; it builds that ship **for free every 30 minutes**, forever.
- The **shipyard's price is set by the price of the ship it makes** (`src/shared/economy.js`:
  currently 10× the ship cost, so a shipyard pays for itself in 5 hours). Not yet confirmed by the owner.
- A world can have any number of shipyards. **All of them are destroyed if an enemy takes the world.**
- **Shipyards get dearer the more shipyards a world already has** (owner's rule, to make players
  build on every world instead of stacking their home world), but only gently: each yard already
  on a world adds 1% of its list price to the next one there (`SHIPYARD_CROWDING_SHARE`). The
  owner's benchmark: **the 100th shipyard of the same cost on one world is about 2× the first**
  (1.99×), whatever the ship costs. List prices, not what was paid, so it doesn't compound. (An
  earlier version used list × (1 + value / 25,000); the owner found that far too steep.)
- **Shipyards can be sold**: 50% of what was actually paid comes back.
- Ships a shipyard builds garrison its world and defend it.
- Every ship part has a credit cost (`cost` in `blocks.js`); a ship's price is the sum of its blocks.
  Owner's direction: **weapons and thrusters are expensive, armour and frame cheap**, to push
  players towards armoured designs. Current: frame 1, armour 3, heavy 7, thruster 20, PD 30,
  hub 40, cannon 50, laser 80, missile 90, heavy laser 3,500 a unit. **Balance pass Nov 2026**
  (`npm run balance`, `tools/balance.mjs`: equal-credit fleets of the same hull with one weapon
  each): at the old prices lasers beat every other weapon (+0.6 average score, most ships died
  to lasers burning into their hub), so laser 45 → 80, cannon 60 → 50, missile 120 → 90, and
  point defence's damage to missiles 10 → 25 (one PD couldn't stop one missile). Now cannons
  beat lasers, missiles beat cannons, lasers ≈ missiles, and ships with a quarter of their gun
  money on PD beat missile fleets but lose to the rest. `upgradeWorld()` refreshes the stored
  `cost` of every design in a running game. Heavy lasers aren't in the harness yet.

## Status: ship designer

`npm run build` writes `dist/designer.html` (and `dist/viewer.html`); `npm test` checks the
designer's numbers against the sim.

- `src/shared/shipStats.js`: price, mass, speed, turn rate, firepower, weapon facing/arcs,
  validation, crop and JSON save format. It mirrors `Battle.refit()` and shares `arcs.js` with
  `Battle.facing()`;
  `tools/test-designer.mjs` fails if they drift apart, so change both together.
- `src/shared/economy.js`: shipyard price and build interval.
- `src/designer/editor.js`: grid editing (no DOM): mirror across the hub row, whole 10×10 heavy
  laser units, one movable hub, rectangle and fill tools, undo/redo, crop on save.
- `src/designer/app.js`: the page. Live cost, shipyard price, hull class, stats, weapon table,
  arcs overlay, validation list, stance picker, local library (localStorage), JSON export/import,
  and a test battle (N copies vs an equal-cost mixed fleet or a saved design). The build embeds
  the viewer page in `designer.html`, so the replay plays in an in-page overlay (iframe +
  postMessage): the designer works as a single file, with no pop-ups.
- Hull class comes from block count (`HULL_CLASSES` in `blocks.js`): corvette ≤ 40, frigate ≤ 85,
  destroyer ≤ 200, cruiser ≤ 500, battleship ≤ 1,200, titan ≤ 3,000, dreadnought ≤ 10,000,
  leviathan ≤ 30,000, colossus ≤ 120,000, worldbreaker ≤ 400,000. Grid limit 1024 × 640.
- Built for huge grids: undo stores changed cells only; drawing culls to the visible cells and
  switches to a one-pixel-per-cell bitmap when zoomed out (also used by the minimap); analysis
  of a slow-to-analyse design waits for the end of a stroke. Owner's controls: **mouse wheel
  zooms** (towards the cursor), **WASD / arrow keys pan** smoothly while held (Shift faster),
  plus a Hand tool (H), Space+drag, +/− buttons and a clickable minimap. Q toggles all arcs.
  **Right-click an empty cell (or Esc) deselects the block** (owner, Nov 2026: `block === null`,
  left clicks then do nothing); right-click/drag on blocks still erases, and a right drag that
  starts on an empty cell still erases once it moves. Opened from the galaxy, the designer sits
  under a top bar with a prominent "← Back to galaxy" button (`.overlay-bar`; the old button
  overlapped the help text and was easy to miss).
- Validation errors block test battles (and should block shipyards): one hub, everything
  connected to it, block limit, heavy lasers as whole separate 10×10 units. Warnings: no weapons,
  buried weapons, guns with under 45° of arc, heavy-laser cook-off, no thrusters, big escorts.
- Designs are saved cropped, in the format above; JSON export stores `cells` as base64.

The test-fleet generator (`designs.js`) puts missile launchers on the skin and heavy lasers on
the nose or hull edge, where they have a line of fire. It also makes dreadnought, leviathan and
colossus samples for the designer's templates (not used in the generated test fleets).

- **Engine flames are per thruster** (owner, Nov 2026): the viewer draws a flickering flame
  behind each working thruster block with open space behind it (`e.thr`/`e.thrBehind` in
  `ReplayModel`), instead of one glow behind the whole ship.
- **Hubs are fragile** (60 hp, was 450; owner, Nov 2026): bare hubs with everything shot off
  were floating around the battlefield. A hit hub breaks the whole ship apart.

## Ship collisions (on)

`Battle.collide()`: each ship's hull rectangle is pushed out of any other ship's or **wreck's**
rectangle it overlaps (either team; separating-axis test; the lighter one moves more). The
rectangle is the box round the blocks **still there** (`setBox`, refreshed in `refit()` and for
wrecks when they lose blocks), so nothing bumps into the empty space where half a ship was. Replaced the old
"push apart from allies in the same grid cell once half-overlapped" nudge, which let hulls pass
through each other. Cost: about +7% at 1,000 vs 1,000 (+26% measured at 3,000 vs 3,000 in the
prototype); pairs overlapping by more than 3 blocks went from ~300 to ~6. Rectangles, not exact
blocks, on purpose: block-exact would cost far more.

**Debris collides with ships too** (owner, Nov 2026: "debris should be part of the battle"): a
ship and a wreck push each other apart by the same rule, so ships plough through light debris
and bounce off big wreck halves. A wreck collides with the ship it broke off from too (owner
didn't like them passing through): only while a piece still overlaps that ship's box right after
breaking off is it let through, until the two are clear (`chunk.parent`, cleared in `collide()`);
measured at 600 vs 600, median 0.2 s, 90% within 2.6 s. Debris doesn't collide with other debris
(pieces of one break-up start overlapping). **Debris stays solid and hittable for the whole
battle** (owner, Nov 2026; `CHUNK_RETIRE_TICKS = Infinity`, was 25 s then 60 s). Battles end on
their own long before the limit (1,000 vs 1,000: 183 s, at most ~1,400 pieces of debris, ~6 ms a
tick), so this costs little. Pushed debris is re-recorded in the replay
(`sv*` columns, at most every `SHOVE_EVERY` = 3 ticks per piece, Int16 positions/velocities), and
the viewer drifts from the last record and blends into the next one (`ReplayModel.transform`):
mean error 0.01 blocks against the sim. Replays from before this have no `sv*` columns and play
as before.

## Beams stay on what they hit

Lasers and point-defence beams fade over 0.4 s / 0.15 s while ships keep moving, so drawn as
fixed world lines they ended up pointing at empty space where the block had been. Each beam now
records the ship that fired it and the entity its end sits on (`lasSrc`/`lasDst` plus local
offsets `lasSX/SY/DX/DY`; ids are 16-bit when the battle has under 65,535 entities). The viewer
draws both ends attached (`ReplayModel.beamAt`). World coordinates are only stored for unattached
ends, so replays grew only ~2%. A beam that ends in empty space (a miss, or a laser that burned
through everything) has its far end fixed in the world (`dst` none). It used to be pinned to the
shooter, so the end swung round as the shooter turned and lasers looked as if they retargeted
wildly (13% of laser shots, fixed Nov 2026). `aimPoint()` never returns a destroyed block (it used to fall back
to the target's centre, often a hole), and point defence aims at a block actually within its
30 range.

## Status: galaxy map (world, economy, fleets)

`npm run build` writes `dist/galaxy.html`, which has the designer and the viewer built in (it's
the main game page now). `npm test` also runs `tools/test-world.mjs` (map generation, routes,
economy, fleets, captures, with real battles).

- `src/world/` is the game state and every rule, as **pure functions on one JSON object** plus a
  game clock (no DOM, no wall clock) so the server can run the same code: `world.js` (players,
  credits, shipyards, garrisons, fleets, arrivals, capture), `galaxyGen.js` (map), `routes.js`
  (route planner, fleet position as a pure function of time), `battleSetup.js` (garrisons →
  Battle scenario → survivor counts), `rules.js` (map, travel and battle-length numbers).
- `src/galaxy/`: the page, built twice: `dist/play.html` is the online game (see the server
  section); `dist/galaxy.html` is a **hot-seat game** saved in localStorage, still handy for quick
  offline tests: a "Playing as" selector picks the player. Speed buttons (pause, 1×, 60×,
  600×, 3,600×; 60× by default) are for testing; time with the page closed counts at 1×, like a
  server. The clock stops while a battle is resolved (in the page, with a progress card).
  Layout: map with a small collapsible **Events** window in its top-left corner; the right-hand
  panel is all for the selected world or fleet. In the world panel the ships and move controls
  come first and the **Shipyards** section sits below them, collapsible (owner's request: yards
  were pushing the move controls down; `ui.yardsOpen` is remembered, Build stays in the header).
- **Combat log** (top-bar button, with a badge for new ones): every battle and every world that
  changed hands, and every siege (Under attack / Attack begins / Joined attack), from the current
  player's side (World taken / World lost / Defended / Repelled / Ambushed / Blocked a fleet),
  ships and credits lost on each side, a Watch button and a Map button. Filter: Mine (you and allies) or Everyone. Replays are saved in IndexedDB
  (`src/galaxy/replayStore.js`, newest 80) so old battles can be watched after a reload; on the
  server they'll be replay files. The world log trims routine entries before battles/captures.
- Map: 2–10 players, one **spawn point** (home world) each, spread evenly round a ring so starts
  are fair; ~7 worlds per player scattered between. Same seed and player count = same map.
- **Hyperlanes**: minimum spanning tree (every world reachable) plus some non-crossing links
  between near neighbours. **Moving along a lane is 10× faster** than normal space. Fleets can fly
  straight to any world through normal space too; the planner (Dijkstra) picks the fastest mix
  and the player can turn lanes off. Fleets can't be recalled.
- **Fleets stop at every world on their route** (owner's rule, so enemies can block or ambush
  them). Passing a friendly world, or one with nobody defending it, they fly straight on. At a
  world they don't hold with defenders there, they fight (`battle.passing`): **win and they take
  that world** (owner's rule) and fly on with the survivors, leaving it empty; lose and the
  survivors fall back.
- **Battles wait 30 minutes** (`BATTLE_HOLD_MIN`, owner's rule) so reinforcements can join. A
  fleet reaching a world it attacks (its destination, or a stop with defenders) starts a **siege**
  (`world.sieges`, **at most one per world**): it holds there (`fleet.wait`), drawn round the world
  with a "Battle in N min" ring. **Every** later fleet whose destination it is joins that siege,
  whoever it's allied with (owner's rule: even if everyone there is currently allied, in case an
  enemy turns up); a fleet only passing stops for it only if someone there is its enemy. The
  owner's and allies' fleets join the garrison, and shipyards keep building. When the hold ends,
  **everyone there fights one free-for-all battle** (`planEvent` → `siegeParties()`): one side per
  player, and **players with no enemy there sit it out**, untouched and not simulated. Starting
  positions: the owner's side holds the world, attackers come in from round it, each group of
  mutual allies together (`camps` in `makeBattleScenario`; two camps = the old left/right layout).
  **Who gets the world** (owner's rule): the owner keeps it if the owner or an ally that fought
  still has armed ships that didn't rout; otherwise the player who started the siege, if they still
  hold the field; otherwise the surviving attacker with the most ships left. The winner's allies
  stay as guests; everyone who fought against the winner falls back. If no one is left holding,
  the owner keeps it. Win: every fleet on the winner's side "re-arrives" (garrisons or flies on,
  delayed by the wait). A world nobody defends is still only taken when the hold ends, so the
  owner can rush ships in. Old saves with several sieges at one world are merged into the first
  (`upgradeWorld`). Battle log entries carry `players` (per side: ships, survived, lost, routed),
  `winner` and `camps` ("N-way" in the text counts groups of allies, not players); the summary
  `ships/survived/lost` [0, 1] are attackers vs the world's side, as before.
- The move panel's **"Avoid worlds you don't hold"** (on by default) plans
  round every world not held by you or an ally (a straight flight always exists); with it off the
  route is fastest and the panel lists the hostile stops (marked on the map) and their ships.
  Saves from before this rule (`upgradeWorld`) let fleets already in flight fly straight on.
- Fleet speed = slowest ship's battle top speed (blocks/s) × `TRAVEL_SCALE` (1) galaxy units per
  hour: a destroyer takes ~10 h between neighbours through space, ~1 h along a lane. Ships under
  `MIN_FLEET_SPEED` can't leave (fixed defences; hub thrusters alone give ~2.5, so rare).
- **Arrivals**: own or allied world → the ships join the garrison (allies' ships station there
  as guests and defend it). Otherwise a siege and a free-for-all battle (above). Taking a world:
  yards destroyed, income and world change hands to the winner by the rule above. Beaten fleets
  fall back to where they came from (or the nearest friendly world).
- A ship survives a battle if it keeps its hub and a working weapon, and comes back at full
  strength (no damage carried between battles yet).
- **Diplomacy** (owner's rule: alliances change during the game): every pair of players is
  allied or enemies (`world.relations`, not transitive). Starting team letters only set who begins
  allied. An alliance needs both sides (propose → accept; proposing back counts as accepting);
  either side can break it alone, which sends each side's ships on the other's worlds home. Diplomacy window in the top bar
  (badge for proposals waiting for you, and a who-is-allied-with-whom grid). Allies station ships
  on each other's worlds, defend together and join
  each other's sieges. **A player with no enemy at a battle sits it out** (owner's rule; replaced
  "allied with both sides sits out" with free-for-all battles): their ships stay at the world idle
  and untouched. If the world then falls to someone they aren't allied with, their ships fly home
  unharmed. Alliance changes during a hold need no special handling: who fights whom is worked out
  when the battle starts. A player with no worlds, ships or fleets is knocked out; when someone has
  been knocked out and everyone left is allied with everyone else, they win.
- Unclaimed worlds are held by **militia** (generated corvettes/frigates/destroyers worth 4 hours
  of the world's income, `NEUTRAL_GARRISON_HOURS`), so taking one is a real battle.
- Designs used in the world are stored in `world.designs` (owner, cost, speed, encoded cells),
  deduplicated per player. The shipyard dialog lists the player's designs in play plus the
  designer library; "Design a new ship…" opens the designer in shipyard mode (its "Build
  shipyard" button shows the crowding-adjusted price and posts the design back).
- Map art is cosmetic and lives only in the page (`src/galaxy/planetArt.js`): each world gets a
  type (rocky, desert, ice, ocean, lava, gas giant, toxic; home worlds Earth-like) from the seed
  and its id, textured with 3D noise on a lit sphere and cached as sprites at three sizes. The
  starfield is a fixed backdrop that doesn't move when you pan or zoom (owner's request).

## Status: server and accounts (`server/`, `docs/SERVER.md`)

The live game. Plain Node, no dependencies (esbuild is a regular dependency so hosts can build).
`npm run build && npm start` serves `dist/play.html` (the galaxy page built with `__ONLINE__`).
The game is made either on the **admin page** (`/admin`, unlocked by the `LSB_ADMIN_PASSWORD`
variable; the owner isn't a command-line user, so this is how he runs it) or with
`npm run admin -- new-game --players "A,B,C"`; both show each player's password once (only scrypt
hashes are kept). The server runs with no game too (players are told it isn't set up yet).
**Hosting: Railway** (owner's choice, step-by-step in `docs/SERVER.md`): deploys from GitHub main,
`railway.json` sets build/start/health check, a volume holds the data (found via
`RAILWAY_VOLUME_MOUNT_PATH`), proxy trust is automatic there.

- **Owner's decision: the password is the player.** No usernames: a friend types the password
  they were given and plays as that player. Keeps random people out and stops players acting as
  each other. Passwords are generated (`xxxx-xxxx-xxxx`, ~59 bits), unique per player, reset
  with `npm run admin -- reset-password <name>` (logs that player out everywhere).
- **Open seats** (owner's request): the admin sets a number of seats and may name some; unnamed
  seats are `claimed: false` ("Player 3") and their player picks name + colour once on first login
  (`claimPlayer` in `world.js`, `claim` action, dialog in the page). Named seats can't rename.
- **Game speed is the admin's** (owner wanted his test speeds back online): admin page sets pause
  / 1× / 60× / 600× / 3600× for the whole galaxy (`Game.setSpeed`, re-anchors the clock) and can
  jump ahead (`Game.jump`). Saved in `game.json` with the clock anchor (`{ world, anchor, speed }`);
  `LSB_SPEED` is only the default for a new game. Players see the speed next to the clock.
- Sessions: random token in an HttpOnly, SameSite=Strict cookie, 30 days, stored hashed in
  `data/sessions.json`. **Every action takes the player from the session, never from the
  request**; keep it that way. Logins rate limited (8 wrong per 15 min per address).
- `server/game.mjs`: the world runs at the admin's speed (real time by default), one lock for everything that
  changes it (tick every second + player actions, each action first catches the world up), battles
  in `server/battleWorker.mjs`, replays in `data/replays/`. Time while the server is down counts.
- The page (`ONLINE` in `src/galaxy/app.js`, `src/galaxy/net.js`): login screen, long poll for
  updates (world sent only when changed), income ticks locally between updates, actions go to
  `POST /api/act`, replays from `GET /api/replay/<id>`. No speed buttons, "Playing as" or new game.
- `npm test` includes `tools/test-server.mjs` (real server on a temp folder: impersonation
  attempts, rate limit, a battle and its replay, password reset, restart).
- Must run behind HTTPS on the internet. Railway provides it; for a self-hosted VPS,
  `docs/SERVER.md` has Caddy with `LSB_TRUST_PROXY=1`.
- Not yet: fog of war (every browser gets the whole world), designer library on the server.

Open with the owner (placeholders now): incomes and starting credits, the crowding share,
the 50% resale, militia strength, travel scale, the 30-minute hold, fog of war, recalling fleets,
damage carried between battles, and the battle size cap (a big late-game garrison can mean thousands of ships; the plan is waves).

Still open with the owner: the exact block prices and the shipyard multiplier (placeholders
until there's an income number to balance against), and whether hull class should matter beyond
the block limit.

## Working on the live game

The game is **live on Railway** and the owner and friends play it. Railway redeploys
automatically on every push to `main` (about 2–3 minutes, roughly a minute of downtime); the
game in progress carries on because it lives on the volume (`/data`: `game.json`,
`accounts.json`, `sessions.json`, `replays/`).

- **The owner isn't a programmer and doesn't use a command line.** Give him exact click-by-click
  steps (Railway dashboard, the `/admin` page, the game), never terminal commands. He is in
  Australia (Sydney time). When something breaks, ask him for the Railway logs: service →
  *Deployments* → newest → *View logs*, pasted or as a screenshot. The server logs logins, failed
  logins, every event and battle, admin actions, and errors with stack traces.
- **Pushing to `main` changes the live game.** Run `npm test` (and `npm run bench -- 1000` after sim
  changes) before pushing. Keep `dist/` built and committed (`npm run build`); Railway also builds.
- **Never break the live save.** `game.json` is `{ world, anchor, speed }` (older: `{ world, wall }`).
  Any change to the world format must load an existing world: add defaults in `upgradeWorld()`
  (`src/world/world.js`) the way `sieges`, `proposals`, `relations` and `fleet.leg` were added.
  Changing a rule number (economy, ranges) applies to the running game immediately, which is fine
  for balance; changing map generation only affects new games.
- **How the owner tests:** on `/admin` he sets the game speed (pause … 3600×) and jumps ahead
  (+30 min … +1 day), and plays other seats from a private/incognito window. Remind him to set
  1× before real play. A fresh test galaxy: "Replace the current game" on `/admin` (new passwords).
- Locally: `npm run build && LSB_ADMIN_PASSWORD=some-long-pass LSB_SPEED=600 npm start`, then
  http://localhost:8080/admin. `npm test` runs designer, world and server tests (~25 s).

## Bug fixing and balance (next phase)

Where the numbers live: block costs, hit points and every weapon number in
`src/shared/blocks.js`; incomes, starting credits, shipyard multiplier, crowding share, resale,
build interval, militia strength in `src/shared/economy.js`; map size, travel scale, hyperlane
speed-up, battle length and the 30-minute hold in `src/world/rules.js`. The open questions listed
above under the galaxy and designer sections are the owner's balance agenda; ask him before
changing a decision listed under "Decisions the owner has made".

Known issues and loose ends (not yet fixed):
- **Open seats nobody takes** still have a home world with income and no defenders, so they are
  free worlds for whoever reaches them first. Possible fix: an admin button that turns unclaimed
  seats into militia worlds. The owner was told to size games to the real group for now.
- Log entries written before a player chose their name keep the old "Player N" text.
- **A battle that keeps crashing the worker** (e.g. out of memory on a huge battle; Railway's trial
  has 0.5 GB) is retried every second and holds the whole game up. Needs a give-up rule
  (resolve as a draw? split into waves?) and a message to players. Related open item: the
  battle size cap / waves for huge late-game garrisons.
- After the admin lowers the speed, a client's local clock can sit a little ahead of the server's
  until the next world update (cosmetic).
- No fog of war: every browser receives the whole world. The designer library is per browser
  (localStorage); designs in play are on the server.
- `npm run admin -- new-game` checks `data/server.pid` to refuse while the server runs; after an
  unclean restart a stale pid file could block it (not used on Railway, where `/admin` is used).
- Battle time limit is still the 4-minute testing value (`BATTLE_MAX_TIME` in `rules.js`); the
  plan for launch is 30 minutes. Check with the owner before changing it.

