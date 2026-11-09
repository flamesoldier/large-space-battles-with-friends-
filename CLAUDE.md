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
  The main damage dealer. Range **340** (owner, Nov 2026: was 260, so it still has a reason over point defence at 80). **Shells fly 30 s and missiles 90 s**
  (owner: misses mustn't vanish mid-battle; were 7 s / 45 s), so misses fly on past the fight and
  can still hit something; a shot that does run out fades over its last 2 s in the viewer.
- **Missile launcher**: huge, slow, unguided missile, range 700, flies over friendly ships,
  150 hp (was 100 until PD reached 80) so point defence can shoot it down, fires every 30 s (owner, Nov 2026: was 40 s, blast
  lowered to compensate). Blast hits everything within
  9 blocks with damage `150 × (1 − d/9)²`: one missile craters, a volley tears ships apart.
  All launchers on one ship fire together as a volley. Lead is capped at 3 s.
  **Speed 23** (owner, Nov 2026: +15%, "too slow"; was 20).
- **Guided missile launcher** (`BT.GUIDED` = 11, owner, Nov 2026: a friend wanted guided missiles):
  the heavy missile's exact stats (`guided: true` on the same `kind: 'missile'`, so volleys, aiming
  at the biggest ship, flying over friends and point defence all work the same), **135 cr** a
  launcher. In flight `steerMissile()` turns it toward its target, led like at launch, at up to
  `turn` 0.6 rad/s; if the target dies it looks (every 5 ticks) for the nearest enemy ship within
  `seek` 150, else flies straight. Replays: shot kind 3, plus a point on its path every
  `MISSILE_EVERY` (3) ticks and at its end (`gmRec/gmT/gmX/gmY`, gmT in 0.01 s); the viewer
  (`withGuided()` in `model.js`) turns the points into straight pieces drawn like heavy missiles
  (`a0` = age at the piece's start, so the smoke trail keeps growing). Looks like the missile
  launcher with a green seeker eye; designer key G. Measured (8 all-missile cruisers vs an
  equal-cost mixed fleet, 4 seeds): unguided 28% of missiles hit, score −0.30; guided 85% hit,
  score +0.35 even at 110 cr; the owner then set 135.
- **Point defence** (named **Anti-missile point defence** since Nov 2026: a friend didn't know it
  shoots missiles down; its palette tooltip now says so first): **range 80 against everything, 15 damage
  every 0.2 s** to ships, fighters and missiles alike (owner, Nov 2026, third round; see below;
  `fighterDamage` 15: 40 against fighters was tried in the fighter rework and the owner found it
  too good); missiles first, then fighters, then ships.
  Before: range 30, a burst every 0.2 s, "super close range, high dps" against ships.
- AI (Nov 2026): missile launchers aim at the biggest ship in range (all launchers on a ship
  agree, so volleys still land together), and a ship whose only guns are missiles sets its
  stance distance from missile range (it used to fall back to 60 and dive in).
- **Plasma cannon** (block `BT.LANCE`, weapon kind `'lance'` in code; **was the heavy laser**
  until Nov 2026, when the owner asked for it to be a projectile "to make its destructiveness more
  obvious and cool"): 10×10 multi-block turret, range 650, every 20 s, a 25,000-damage budget,
  1 block wide. Now a **big glowing blue bolt with a long trail** (`K_PLASMA`, replay shot kind 2,
  `drawPlasma` in `renderer.js`; blue for every side) flying at **60 blocks/s** (cannon shells:
  45), aimed with lead (cap 6 s), life 30 s. Each tick `plasmaStep()` burns every live block on
  the segment it crosses, in order, ship after ship, until the budget is spent, then a big blue
  blast (explosion size 5); a blue burst (size 4) each time it breaks into a new hull. **Friendly
  fire on** (owner: "something that powerful has got to carve through friendly ships and enemies
  alike"): it damages allies and wrecks too, never its own gun ship. Aiming (`lanceAim` /
  `lanceCount`): the line through the most enemy ships, each ally on the line counting −2; holds
  fire if a friend is first in line or allies outweigh enemies, checked along the real led
  direction. **Friends that can't move** (`e.still`: defences, and ships with
  every thruster gone, set in `refit()`; owner, Nov 2026: plasma defences in rows hardly fired)
  count only if the bolt's path really runs through their blocks (`raycast`), not the hull-circle
  safety zone kept for ships that move. The bolt **still damages** them (owner's choice; a
  pass-through version was offered and turned down). Measured against the version before: 20
  plasma defences in designer-test rows 11 → 13.8 shots a battle, a world battle with 24 plasma
  defences 9.2 → 10.2, and zero friendly plasma damage to defences in both. **Moving friends are checked where they will be** when the bolt
  reaches them as well as where they are (owner, Nov 2026: bolts fired with a friend flying into
  the line). A ship with no thrusters counts as still only once it has stopped (speed < 1): it
  can drift on at its old speed. Measured (2 × 600 vs 600 + 4 world defence battles): friendly
  ships hit by friendly plasma 126 → 19, enemy ships hit 638 → 543, ship plasma shots 241 → 183
  (a margin of 3 on top barely helped; margin 5 without prediction was worse on both counts).
  So the "1 in 3 shots hits an ally first" figure below is out of date. `LANCE_ALLY_MARGIN` (0) widens the ally check: at 0, about 1 shot in 3 hits an ally
  first and ~4 enemies are killed per ally; at 5 allies are almost never hit but it holds fire
  far more and kills ~40% fewer. Measured at 600 vs 600 (2 seeds): ~2.2 enemy ships hit and ~1.4
  destroyed or broken per shot, ~0.4 allies destroyed. Keeps a 0.6 s blue charge-up glow at the
  gun before it fires and a muzzle flash. Old replays still draw the old white beam (beam kind 2).
  **Its blocks explode when destroyed** (`COOKOFF` in `blocks.js`: 300 peak damage, radius 16,
  ignores friendly fire, hurts its own ship and allies). One destroyed block chain-reacts through
  the whole unit: a battleship loses ~43% of its blocks and an ally flying alongside loses ~260.
  **Plasma blocks have 750 hp** (owner, Nov 2026, was 120: a friend's plasma dreadnoughts lost
  their guns at once; 1,500 was tried first, but small plasma-only ships became far too tanky for
  a squishy back-line weapon, so the owner split the difference). Cook-off blasts scale their damage to plasma blocks by hp / `COOKOFF.refHp`
  (120), so a unit still chain-reacts exactly as before once one block goes. Measured at 1,500 hp (equal-cost
  mixed fleet, 5 seeds; score = enemy ships lost share − own lost share): plasma dreadnoughts
  −0.61 → −0.33 (same ship with heavy armour instead: −0.36), first plasma block lost at 14 s → 61 s,
  plasma shots per ship 1.8 → 5.8; 2,500 hp gave −0.10 (beats the plain ship: too strong). Titans
  barely changed (−0.36 → −0.31): their plasma fires only ~1.5 times a battle whatever its hp. At
  the chosen 750 hp: plasma dreadnoughts −0.51 (plain −0.35), first plasma block lost at 29 s,
  3.7 plasma shots per ship.
- **Fighter bay** (`BT.BAY` = 12, weapon kind `'bay'`; owner, Nov 2026: friends wanted carriers,
  "more similar to missiles"): a **6×6 multi-block unit** (owner: its role is to take up space inside
  ships; was 3×3 in the first version), **225 cr** a unit (6.25 a block), 150 hp a block, keeps
  working while half its blocks survive. Every **30 s, for as long as the battle goes on (no range
  limit, owner)** it launches one **fighter** at the nearest enemy ship (`e.targets`, else
  `foeArmed`), along the open line of fire nearest that direction (the same `arcs.js` rule as guns,
  along the middle of an open slice): a bay on the hull edge launches straight out, one inside
  needs a tunnel of empty cells to space (straight at first; since Nov 2026 it can turn corners, see below). `WEAPON[BT.BAY].range` (600) only sets where a
  carrier stands (stances), the designer shows range "any". The fighter flies straight until clear
  of its ship (`ln` ticks), then `steerFighter()`: heads for its target with a little lead, then
  **circles it `orbit` (14) blocks off its hull** (owner: keep this distance), half each way round; a
  dead or disarmed target → nearest armed enemy ship (every 5 ticks). **Avoids hulls and debris**
  (owner; no real collisions, too costly): `solidAt()` box test on the ship grid at its position
  (inside → turn straight out, 2.5× turn rate) and 0.3 s / 0.7 s ahead (→ steer round, 1.5×).
  Measured: time spent inside a hull or wreck 5.4% → 0.8%. **Fighters aren't made of blocks**: like
  missiles they are separate objects with hit points, kept in their **own list** `this.Fi` (not `P`,
  so removing shells never moves them; dead ones are only removed in `updateFighters()`, which runs
  before `updateProjectiles()` and rebuilds `fgrid`). **They live until killed; no cap** (owner:
  Hobby plan; measured 1,003 ships incl. 120 carriers with 4 bays: 582 fighters at once, 4.4 ms a
  tick, 3.2 MB gzip replay, ~200 MB). Stats (owner, second round): `WEAPON[BT.BAY].fighter` = **hp 150**
  (2 cannon shells, 5 point-defence bursts), speed 30, turn 3 rad/s, **range 60** (it couldn't reach
  big ships it circled at 40), **45 damage every 3 s**; drawn about 3 blocks long (owner: bigger),
  hit radius `FIGHTER_R` 2. Third round (owner): **45 damage every 2.5 s**. Fourth round: **hp 300**
  (4 cannon shells, 20 point-defence bursts; one laser shot still kills it). Fifth round (owner, "pull
  the lever harder"): **hp 450, 45 damage every 1 s**. Measured: fighters live ~11–12 s and fire 4–6
  shots; line 2 bays −0.57, **4 bays −0.38**, heavy armour instead −0.58 (standoff −0.67 / −0.55 /
  −0.71): bays now clearly worth it, 4-bay carriers strongly. 1,003 ships incl. 120 carriers:
  630 fighters at once, 5.1 ms a tick, 4.0 MB gzip replay, ~205 MB. Gun (`fighterGun()`): an **enemy fighter in reach first** (dogfights),
  else a block of the ship it circles; never missiles. **Every weapon can kill them**: shells stop on
  an enemy fighter met before any hull (`fighterOnSegment`), lasers burn out every enemy fighter
  along the beam, plasma bolts kill every fighter they pass (friend or foe), missile and cook-off
  blasts hit fighters in the radius, point defence 15 a burst. **Targeting** (owner): point defence
  prefers missiles, then fighters, then ships; **any other cannon or laser with no enemy ship it can
  reach and bear on shoots fighters, gun by gun** (owner chose this over a whole-ship rule: an idle
  gun should fire). Missiles and plasma never aim at fighters (they only explode on ships).
  Measured with the second-round rules (PD 30 vs ships / 0.2 s, fire every 3 s; simple 44×22 test carrier, equal-credit fleets vs the usual mixed
  enemy, 6 seeds, score = enemy value lost share − own): line 2 bays −0.63, 4 bays −0.65, same hull
  with heavy armour instead −0.61; fighters live ~6 s and fire ~1 shot: most die on the way in to
  guns with no ship in reach (75% of fighter damage is aimed cannon/laser fire when carriers stand
  back; a laser kills one with a single 400 shot at 340). A whole-ship rule (guns only turn on
  fighters while no enemy ship is within the ship's reach) gave fighters 10–14 s and ~7 shots; it
  was offered and the owner chose gun by gun. Replays: shot kind 4 plus a point every
  `MISSILE_EVERY` ticks in the guided-missile columns (`gmRec/gmT/gmX/gmY`), beams of kind 3 for
  fighter guns, explosion size 0 when shot down; the viewer's `fighters()` (`model.js`) turns the
  points into pieces and `drawFighters()` draws a swept-wing craft in the side's colour with an
  engine glow, a trail and a launch flash. The bay is drawn as one hangar (shader type 12, unit
  position via a generalised `unitPos()`): dark deck in a hazard-striped frame with a parked
  fighter. Designer: key **C**, whole-unit stamps (`ShipEditor.stamp(x, y, type)`, editor
  generalised from the 10×10-only plasma code), "sealed in" warning and red X for a bay with no
  way out, hover shows its launch directions, weapon table "1 fighter / 30 s".
- **Fighter rework** (Nov 2026, second chat; owner: "rework the direction or adjust the stats, your
  choice"). The owner's four roles for fighters: (1) look cool as they fight and die, (2) at the
  start absorb a little enemy fire and do small, reliable damage, (3) hunt down ships late in the
  battle when long-range ships are shooting each other, (4) be countered by point defence. Changes:
  - Each bay opens with a **squadron of 3** (`squadron`, `squadronGap` 0.4 s; weapon field `w.sq`,
    declared for every weapon in `arcFields()`), then one every 30 s as before.
  - Fighter **speed 30 → 40**; hp and damage: tried 300 / 30 a second, then the owner chose
    **hp 600, 45 damage a second** (final, live since 10 Nov 2026).
  - Point defence against fighters: `WEAPON[BT.PD].fighterDamage`. 40 a burst was tried; **the
    owner set it back to 15** like everything else ("point defence was too good"): 40 bursts, 8 s
    of one PD, to kill a fighter.
  - **Lasers aimed at a fighter hit it only 30% of the time** (`WEAPON[BT.LASER].fighterHit`; a miss
    is drawn sweeping just past it): one 400 shot always killed one, so artillery swatted every
    fighter on the way in and role 3 never happened.
  - Targeting stays **nearest enemy ship, any range**. A "hunt the ship furthest back from the
    fighting" rule was built and measured, and did worse (fighters flew through the whole enemy
    fleet and its PD); late in a battle nearest already means the artillery left at the back.
  - Viewer: a shot-down fighter **breaks in two and the halves tumble on, burning and smoking,
    for 1.2 s** (`drawFighterDeath`, `F.dead` in `fighters()`; pure function of time, no replay change).
  - **Owner's own test** (the fair one): 100 identical 32×16 cruisers with one bay each vs the
    same cruiser with frame where the bay is, equal credits (so ~110 plain ones), 6 seeds. First
    version (cannons only, 6 thrusters, fighters 300 hp / 30 dps, PD 40 to fighters): bays lost every
    run (−0.16 no PD, −0.11 PD): a bay's ~18 fighters do ~180 damage each, while its 189 cr buys ~4
    cannons. My earlier tests flattered bays (they compared them with heavy armour, not more guns).
    Owner's second version (cannon/laser mix, 12 thrusters): today's 300/30 fighters about even;
    600 hp / 45 dps with PD 40: +0.26 no PD, +0.01 PD; **final (600 / 45, PD 15): +0.26 no PD,
    +0.16 with PD** (bays win all 6 both ways). Owner: fighters should excel in long drawn-out
    fights between tanky ships, and they do. Carrier tests below at final stats: carriers alone vs
    the mixed fleet +0.80 (plain −0.18), 30% carriers +0.34 (plain −0.04), artillery duel +0.39
    (plain +0.06), vs extra-PD enemy +0.45 (plain +0.25). The owner was told PD no longer clearly
    counters them and that all-carrier fleets are very strong; levers if needed: PD
    `fighterDamage`, squadron size, launch interval. 1,122 ships incl. 120 four-bay carriers: 1,440
    fighters at once at the opening, 3.9 ms a tick, 6.5 MB gzip replay. Bench 1,000 vs 1,000 (no bays)
    unchanged: 187.5 s, ~5.4 ms a tick.
  - Earlier measurements at 300 hp / 30 dps / PD 40 (harness in the chat, 8 seeds, 60,000 cr a side vs a generated mixed fleet; score =
    enemy value lost share − own; "delta" = 4-bay carriers minus the same hull with heavy armour in
    the bays). Old (round 5) → rework: carriers alone +0.73 → +0.62; 30% carriers in a mixed fleet
    +0.19 → +0.25; artillery duel (both fleets standoff) +0.04 → **+0.16**; vs an enemy that adds
    PD to its hull skin +0.06 → +0.09 (fighter damage there 33.7k → 12k a battle, but PD shooting
    fighters isn't shooting ships, so they still pay as decoys). In the first minute fighters soak
    ~34k hp of enemy fire in the fleet test. Fighters live ~12 s (was ~18). Pure carrier fleets are
    still strong against fleets with little PD: the levers are squadron size and fighter damage.
  - Against an enemy with **no point defence** (owner asked; the same generated fleet with every PD
    block turned into armour, 8 seeds): deltas carriers alone +0.79, 30% carriers +0.44, artillery
    duel +0.24 (vs +0.62 / +0.25 / +0.16 against the normal mixed fleet); fighters live ~20 s
    instead of ~12 and do ~2.7× the damage. Carriers win hard there, as role 4 intends.
  - Cost: bench 1,000 vs 1,000 (no bays) unchanged (187.5 s, ~5.5 ms a tick). 1,122 ships incl. 120
    four-bay carriers: 1,440 fighters at once at the opening, 3.6 ms a tick, 5.2 MB gzip replay.
- **Fighter bay tunnels with corners** (owner, Nov 2026: "it just needs a path out of the ship"):
  a bay with no straight open line to space can still launch if a path of empty cells (4-connected,
  corners allowed, 1 cell wide is enough) leads to the edge of the ship's grid. `src/shared/bayRoute.js`
  (`bayRoute(types, hp, w, h, group)`: breadth-first search, shortest path, returns the unit's
  centre, the corners and an exit point 2 cells past the edge) is shared by the sim and the
  designer, so both agree which bays are sealed in. Sim: `bayExit()` runs after `lineOfFire` for
  bays; a straight line still wins (those bays launch exactly as before: the owner's cruiser test
  gives the identical result), otherwise the route is stored once in ship-local coordinates
  (`this.fRoutes[w.route] = { e, pts }`; blocks are never added, so it stays open) and a sealed bay
  looks again after losing blocks, at most every 2 s (`w.rtT`). A fighter launched along a route
  **taxis** (`taxiFighter()`, Fi fields `rt`/`rs`/`lx`/`ly`): it follows the points at full speed,
  moving with its carrier, doesn't shoot or steer, and its position is recorded every tick so the
  replay's corners stay sharp; past the exit (or if the carrier dies) it flies free. Designer: the
  hover readout says "fighters taxi out along an N-block tunnel" and draws the route as a dashed
  line with an arrow; the "sealed in" warning and tooltip say tunnels can turn corners. Test in
  `tools/test-designer.mjs` (L-shaped tunnel: designer and sim agree, fighters get out).
- **Point defence, cannons and missiles, Nov 2026 (owner, two rounds)**: first PD range 80 against
  missiles and fighters only (30 against ships kept) with missile hp 300; then the owner chose **PD
  range 80 against everything, a burst every 0.8 s** (was 0.2: "decent but not overpowered against
  ships", and fighters last longer), **cannon range 260 → 340** (so it's still worth picking over PD),
  **missile hp 150** (normal and guided). Flanker/raider circling distance is half the shortest
  weapon range (PD included), so PD flankers now circle at ~40 instead of ~15. Measured (missile
  boats vs the usual mixed fleet, 3 hulls × 4 seeds, share of missiles shot down / missile fleet
  score): old rules 22% / −0.29; PD 80 every 0.8 s with hp 100: 30% / −0.33, **hp 150: 19% / −0.27**,
  hp 200: 12% / −0.31. Fighters (44×22 test carrier, 6 seeds): live ~8–9 s and fire ~2 shots; line
  2 bays −0.61, 4 bays −0.62, same hull with heavy armour −0.66 (standoff −0.67 / −0.70 / −0.70):
  bays now slightly better than more armour. Bench 1,000 vs 1,000: ~6.8 ms a tick (was ~5.9, PD looks
  further and cannons reach more) but battles end sooner (140 s vs 164 s), so the same total work.
  **Fourth round (owner)**: PD **15 damage every 0.2 s** (ships, fighters and missiles), fighters
  **300 hp**, missile hp **left at 150** (owner). Measured: missiles shot down 34%, missile fleet
  score −0.41 (was 22% / −0.29 before any of this: missiles are weaker now; the owner was told);
  fighters live ~8–10 s, ~2 shots, 60% of their damage taken is aimed cannon/laser fire; line 2 bays
  −0.68, 4 bays −0.57, heavy armour instead −0.58 (standoff −0.73 / −0.66 / −0.71): about even.
  Bench 1,000 vs 1,000: 187.5 s, 5.75 ms a tick.
- Future weapons the owner wants: bigger cannons, a medium laser.

Combat rules:
- **Friendly fire off**: allied hulls still block shots but take no damage (except the plasma cannon, which carves through allies too, and cook-offs).
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
- **Stances** chosen per design in the designer (`STANCES` in `battle.js`, `STANCE_INFO` in
  `shipStats.js`). Owner's roles (Nov 2026):
  - **Holding range (owner, Nov 2026, all stances except Skirmisher, Flanker and Raider)**: the
    owner saw a few small ships beat many capital ships because the big ones turned and ran to open
    the range and then none of their guns faced the enemy ("people assume ships move forward to
    that range then fight"). Now a ship closes to its distance, then **holds**: it turns so the most
    firepower bears on its target (`holdFacing()`: `e.face[64]` = damage/s bearing in each
    direction, rebuilt in `refit()`; picks the least turn among directions within 90% of the best,
    so nose guns face it and broadside ships go side on), brakes, and **drifts slowly sideways**
    round the target (`HOLD_DRIFT`, 30% speed, so lines keep moving; without it battles dragged:
    600 vs 600 took 466 s instead of 183). Pressed under 60% of its distance it **backs off slowly,
    still facing the enemy**. Velocity is no longer tied to heading while holding.
    Measured (generated designs, equal credits 40,000, 5 seeds; old → new): artillery battleships vs
    destroyers (line) −0.08 → +0.36, vs destroyers (flank) −0.05 → +0.37, vs frigates (charge)
    +0.35 → +0.56; cruisers artillery vs cruisers line −0.22 → +0.37 (artillery now clearly beats
    front line of the same hull); line battleships vs destroyers −0.11 → +0.06. 600 vs 600: 183 →
    207 s. Bench 1,000 vs 1,000: 187.5 → 191.6 s, 167:68 → 170:75 survivors, same ms a tick.
  - **Artillery** (`standoff`): hangs back at **60% of its longest weapon range** (heavy lasers
    and missiles included; owner: not further, or battles become boring long-range duels),
    then holds there as above.
  - **Skirmisher** (`skirmish`, new Nov 2026, owner): the **old artillery rule on purpose**: 60% of
    its longest range, and when pressed (under 70%) it turns away and opens the range, orbits at
    70–80%, angles in at 80–110%. Its forward guns stop bearing while it runs, so it suits ships
    with guns on the back or sides. Measured with generated (nose-gunned) designs: −0.16 / −0.05 /
    +0.08 / −0.09 in the tests above, i.e. what the old artillery scored.
  - **Front line** (`line`): 45% of its main gun range (cannon, else laser), then holds as above.
  - **Flanker** (`flank`): charges through the enemy line to the biggest enemy within reach
    and circles it close in at full speed (`pickGoal`/`steerGoal`, goal = `e.goal`).
  - **Raider** (`raid`): attack runs: straight in skimming a big ship, out the far side
    (`runPhase`), turn, new target, again.
  - An **Interceptor** (`guard`, defend the artillery) was tried and **removed** (owner: it just
    made big clumps of ships sitting at the back). Saved designs with an unknown stance load as
    `line`.
  - Older ones: charge kept. **Escort and Brawler removed** from the designer (owner, Nov 2026):
    designs saved with them, including ships already in play, load as Front line
    (`decodeDesign`); the sim's `STANCES` still has both. Generated fleets no longer use them.
  Measured (`npm run balance -- 6 40000 --cls destroyer --share 300 --only cannon@line,cannon@standoff,...`):
  every stance within about ±0.1 average; artillery beats PD flankers/raiders (+0.6), PD
  flankers beat front-line, flanking and raiding cannon ships (+0.3). Small corvettes die to lasers (one 400 shot) before reaching a
  goal, so flankers/raiders work from destroyer size up; generated fleets give flank to
  destroyers.
- **Owner's priorities (Nov 2026): battles that look cool, chaotic, huge, lots of destruction
  first; ships killing efficiently second.** After significant combat changes, send him a
  replay: `npm run build:viewer && node tools/replay-page.mjs 600 7 dist/replay.html "Title"`
  writes one self-contained HTML page that plays it (open in any browser).
- **Spacing** (owner, Nov 2026: "the front lines are crowded which is good but too crowded,
  ships should be able to move past each other and there needs to be space to see the
  projectiles"): `Battle.spacing()` every `SPACING_EVERY` (5) ticks; each ship steers and slides
  away from ships whose hulls are within `SPACING_GAP` (25) of its own, **friends and enemies**,
  only sideways or forwards (never backwards), lighter ships giving way more. Exceptions:
  close-in stances (flank, raid, charge, brawl; `e.closeIn`) ignore enemies, nobody dodges an
  enemy close-in ship, and a ship's own goal never pushes it away. Measured at 400 vs 400:
  ships touching another 31% → 9%, median hull gap 7 → 18 blocks. 1,000 vs 1,000 ~4.2 ms a
  tick (fewer collisions pays for the queries). Spread fleets take fewer ships per missile
  blast, so missiles 90 → 75.
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
- Rout: a side under 20% of its starting **value** still armed and outgunned 2:1 **by value** by its
  enemies, counted against it **plus its allies**. Value = credit cost of each ship's design (`e.worth`,
  `teamStartWorth`, `armedWorth` in `battle.js`); owner, Nov 2026: it used to count ships, so 80 cheap
  ships dying fast made a side run with its 20 big ships still fighting (measured: 80 corvettes + 20
  battleships vs an equal-value mixed fleet, 6 seeds: the old rule ran in 3 of them at ~35 s with
  66–71% of the side's value still armed and 18–19 of 20 battleships; the new rule never ran early
  and won all 6). Defences count at their full block value.
  Counted against it **plus its allies** (so a small allied contingent doesn't run while its
  friends are winning). A routed side breaks and runs (its ships flee like disarmed hulks and no
  longer hold the field; `battle.routedTeams`); the others fight on if any are still enemies.
  **The routed side loses** (`battle.routed`, read by `readBattle()`): routed defenders lose the world and their
  surviving ships flee home (`capture()` → `sendHome`). Fixed Nov 2026: a rout used to count as a
  defender win, so 300 attackers that cut 100 defenders down to 13 were "beaten off" in ~60 s.
  Stalemate and time limit still leave the world with its holder.
- Disengagement: 20 s with no damage dealt anywhere, after the first 30 s.
- Time limit: **8 minutes** (owner, Nov 2026; was 4) for world battles, the designer's test battle and
  the Battle simulator (`BATTLE_MAX_TIME` in `rules.js`; the sim's own default is still 240 for bench and tools).
- The owner explicitly does not want a "mutual exhaustion" rule.

## Engineering rules learned the hard way

- Declare every entity field in `makeEntity()` in `battle.js`. Adding fields to some objects
  later changes V8 hidden classes and made the sim about 40% slower.
- The viewer is stateless: everything drawn is a pure function of time (that's what makes
  scrubbing free). Anything new in the replay should follow that pattern.
- Projectile samples must stay contiguous per projectile (an earlier bug interleaved them).
- A shot's flight time is written when it ends, so `toReplay()` first gives every shot still flying
  the rest of its life. Before Nov 2026 those had flight 0 and were never drawn: every plasma
  bolt fired in a battle's last 30 s was invisible (owner noticed in a colossus test). Replays
  recorded before the fix keep the gap.
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
  build on every world instead of stacking their home world): since Nov 2026 the next yard costs
  its list price × (1 + list value of the yards already on that world / `SHIPYARD_CROWDING_VALUE`
  750,000), i.e. +100% per 750,000 cr of yards there (`crowdingMult`, `crowdingSurcharge(list,
  existing)` in `economy.js`). Owner's reason: the previous rule (each yard there added a flat 1% of
  its list price, so the 100th same-cost yard was ~2× the first) let one huge yard pay the
  surcharge once where 100 small ones paid it 100 times. Now the surcharge is a share of the new
  yard's own price, so it's the same share whatever sizes the yards are. List prices, not what was
  paid, so it doesn't compound. (Before that: list × (1 + value / 25,000), far too steep.) Old and
  new surcharges are equal for a 7,500 cr yard; dearer yards now pay more, cheaper ones less.
- **Shipyards can be sold**: **95%** of what was actually paid comes back (owner, Nov 2026; was 50%).
- **Defences** (owner, Nov 2026: a friend lost his home world and wanted static defences): the
  world panel has **Build** for Defences next to Shipyards. A defence is any valid design with
  **no thrusters**, bought outright at **1/5 of its block price** (`DEFENSE_PRICE_SHARE`,
  `defensePrice()` in `economy.js`), any number per order (`MAX_DEFENSE_ORDER` 1,000), built
  at once into the garrison (`buildDefense()` in `world.js`, server action
  `{ type: 'defend', planet, design, count }`). Stored as its own world design with
  `fixed: true`, `speed: 0` and `cost` = the defence price. Defences can't be sent
  (`previewFleet` refuses), count as defenders (a world held only by defences still stops and
  fights fleets), and when destroyed they're gone. **When a world falls, every defence not on the
  new owner's side is destroyed** (`capture()`, "N defences destroyed" in the log), never sent home.
  In battle (`fixed` on scenario ships → `e.fixed` in `battle.js`) they never move or turn and
  nothing shoves them (collisions push the other ship or the debris); `makeBattleScenario` puts
  them in **rows** at the world (owner asked for rows instead of the first version's rings), facing the
  attackers: one block of rows per attacking camp (defences shared out round-robin, each block set
  out from the world far enough to clear its neighbours), biggest in the back row by the world,
  rows about 3× as wide as the block is deep. **Spread out** (owner: back rows couldn't fire
  through): each defence gets its width plus ~0.9× that again as a gap, rows 26 apart, every other
  row shifted half a slot. **The front of a defence (nose, right-hand side in the designer)
  always faces the enemy** (owner's rule: players design for it, e.g. armour in front and guns on
  the sides for ships flying past; the designer's checks and the defence dialog say so). A tried
  auto-turn (`bestFacing`, most guns toward the enemy) was removed at the owner's request. Wider rows (6×, 10×) clear more lines but
  stretch out of reach and kill fewer; every fleet starts outside them (no extra random draws, so battles without defences start
  as before). The designer opened with Design a new defence… (`mode: 'defense'` in the embed
  message) is titled **Defence Designer** (page title, header, "Your defences" in the test dialog), shows the defence price, errors on thrusters, hides the stance, and its test battle
  holds your copies still **in the same staggered rows as a real world** (`layoutDefences()` in
  `battleSetup.js`, shared with `makeBattleScenario`; `makeTestScenario(..., fixed)`): before
  Nov 2026 they were scattered at random and, unable to move, sat inside each other. Owner (Nov
  2026): the **Thruster block is greyed out** in the defence designer (button disabled, key 4
  refused), and **thrusters are removed automatically** (`ed.removeType()`, one undo step, with a
  toast) when it opens and whenever a design is loaded from Start from, the library or Import.
  The defence designer remembers its last design under its own key
  (`lsb.designer.defence.current.v1`) so stripping thrusters never changes the ship the Ship
  Designer reopens with. None of this applies in ship mode. Its "Start from" menu lists **Your defences** first (your own `fixed` world designs, `defence: true`
  in the embed message's `designs`), then Your shipyards; the ship designer doesn't list defences. Measured: 400 attackers (480k cr) beat 86 defences + 90 ships
  (137k cr counting defences at 1/5) in 95 s (`/tmp`-style script; replay sent to the owner).
- Ships a shipyard builds garrison its world and defend it.
- Every ship part has a credit cost (`cost` in `blocks.js`); a ship's price is the sum of its blocks.
  Owner's direction: **weapons and thrusters are expensive, armour and frame cheap**, to push
  players towards armoured designs. Current: frame 1, armour 3, heavy 7, thruster 20,
  hub 40, cannon 50, missile 75, laser 80, point defence 60, plasma cannon 1,500 a unit (15 a block; was 3,500). **Balance pass Nov 2026**
  (`npm run balance`, `tools/balance.mjs`: equal-credit fleets of the same hull with one weapon
  each): at the old prices lasers beat every other weapon (+0.6 average score, most ships died
  to lasers burning into their hub), so laser 45 → 80, cannon 60 → 50, missile 120 → 90 (75 after ship spacing), and
  point defence's damage to missiles 10 → 25 (one PD couldn't stop one missile). Now cannons
  beat lasers, missiles beat cannons, lasers ≈ missiles, and ships with a quarter of their gun
  money on PD beat missile fleets but lose to the rest. `upgradeWorld()` refreshes the stored
  `cost` of every design in a running game. Heavy lasers aren't in the harness yet.
  **Point defence 30 → 60** (owner, Nov 2026, to make missiles better). A counter check by
  target size (`npm run balance -- … --vs <class> --vs-stance line --time 900`) showed lasers
  best against small ships and worst against big ones, as intended, but cannons beating
  missiles against big ships and missiles doing well against corvette swarms. A fix (cannon 60,
  missile 60, missiles holding fire at far corvettes) was offered and **turned down by the
  owner**: missiles firing at small ships is fine, they hit whatever is behind them.
  **Plasma cannon priced at 1,500 a unit** (was 3,500; owner thought it too dear). Measured
  (`/tmp`-style test: the same generated battleship with its plasma cannon vs with it swapped
  for heavy armour, equal-credit fleets, 4–6 seeds, 15-minute battles): it's an **anti-capital
  weapon**. Even at 3,500 plasma battleships beat 75% more plain ones (+0.38); against titans
  at 1,500 they score +0.81 where plain ones score −0.08. Against small ships it's a liability:
  at 3,500, −0.79 vs frigates and −0.53 vs destroyers (plain: −0.06 / +0.04); at 1,200 still
  −0.60 / −0.12. At 1,500 it's about break-even against cruisers (−0.05 vs −0.14 plain).

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
  **Right-click an empty cell picks the Hand tool** and dragging moves the view (owner, Nov 2026;
  it used to deselect the block); picking a block from the palette, or right-clicking the ship
  while the Hand tool is on, goes back to building (no erase). Esc
  still deselects (`block === null`). Right-click/drag on blocks still erases. Opened from the galaxy, the designer sits
  under a top bar with a prominent "← Back to galaxy" button (`.overlay-bar`; the old button
  overlapped the help text and was easy to miss).
- Validation errors block test battles (and should block shipyards): one hub, everything
  connected to it, block limit, heavy lasers as whole separate 10×10 units. Warnings: no weapons,
  buried weapons, guns with under 45° of arc, heavy-laser cook-off, no thrusters, big escorts.
- Designs are saved cropped, in the format above; JSON export stores `cells` as base64.
- Nov 2026 (owner's friends): the designer canvas draws blocks like the replay viewer (`glyph()`,
  `plasmaUnit()` in `designer/app.js`: crystal lasers, gun-port cannons, red PD dishes, missile
  tubes, the plasma machine with its orb). The weapon table shows damage per shot / reload and
  range (hover a row for what the weapon does); damage/s counts point defence too. Opened from
  the galaxy, the test battle's enemy list includes **every design in play in that galaxy**
  (yours and other players', sent once in the first `lsb-designer-embed` message as
  `designs`). Template designs are named "My <class>" by default. The "Start from" menu also
  gets a **"Your shipyards"** group: the designs your own shipyards build (`yard: true` in that
  message), loaded under their own names.
- **Test with your other designs** (owner, Nov 2026: a friend wanted to test a new design together
  with the rest of his fleet): the test dialog's "Also on your side" list adds any number of rows
  (design + count, default count by hull class) from your designs in this game (yours only;
  defences marked and kept `fixed`), your saved library and the samples. `makeTestScenario(...,
  extras)` puts them on team 0 (defences join the rows, ships start behind them), and the enemy
  budget is your whole side. The result table adds a line per design. Rows stay when the dialog
  is reopened. With no extras a test is identical to before (same random draws).
- **Battle simulator** (owner, Nov 2026: new players might never find the designer's Test battle):
  a top-bar button on the galaxy page opens the designer with `mode: 'sim'` (`openDesigner(-1,
  'sim')`, no world): no Build button, `lsb-design-chosen` ignored, and it opens straight into the
  test dialog (titled Battle simulator), starting from a sample destroyer if the remembered design
  can't fight. Everything else is the normal test battle (your side + extras vs any enemy).
- **Start positions** (owner, Nov 2026: "giving the player more strategy is always better"): a
  **Start** picker next to Stance in the ship and defence designers (also explained under "Start
  position" in the side panel): Auto, Front, Middle, Back, Top flank, Bottom flank. Saved with the
  design as `place` (`PLACE_INFO`/`placeOf` in `shipStats.js`); `encodeDesign` writes it only when
  it isn't Auto, so every design saved before (and the live save) loads as Auto with no
  `upgradeWorld` change. The same ship with another position is its own world design
  (`registerDesign` compares it). **Auto starts exactly as before**: `startSpot()` in
  `battleSetup.js` takes the same two random draws per ship, so a battle with every design on Auto
  is identical (checked against the old code on 80 scenarios). Ships: Front starts at the very front
  of its fleet, Middle in the middle, Back well behind (+60 blocks plus the back of the spread),
  Top/Bottom flank out beyond the edge of the fleet's main body on that wing. "Top" is the top of
  the ship as drawn in the designer with the nose toward the enemy, so two facing fleets' top wings
  are on opposite sides of the screen. Defences (`layoutDefences`): Back ones fill the rows by the
  world first, Front ones last (Auto/Middle between, biggest first as before); Top/Bottom flank
  defences stand in their own block of rows beside the main block (40 apart), on that wing. Used
  by world battles and the designer's test battle (`makeTestScenario`). Stance still decides what
  a ship does once the battle starts. One measured battle (182 attackers vs 115 ships + 32
  defences, seed 7): on Auto the attackers lost (33 vs 109 left); with flank wings, a front line
  and artillery at the back they won (26 vs 12).
- **Renaming designs** (owner, Nov 2026): a Rename button on your own shipyards in the world
  panel opens a small dialog; `renameDesign()` in `world.js` (owner only, 1–40 chars, control
  characters stripped) renames the design everywhere and logs it; server action
  `{ type: 'rename', design, name }`.
- **Shipyard shortlist** (owner, Nov 2026): in the New shipyard dialog each design can be starred
  (☆/★, goes to the top) or removed (✕); removed ones sit under "Removed from the list" with a
  Put back button. Kept per browser, per game and player (`lsb.yardlist.v1.<online|local>.<seed>.<player>`
  in localStorage: `{ fav, hidden }` lists of `name|cells` keys); nothing on the server changes.
  New designs get onto the list by being built or saved to the designer library.
- Plasma cannon tooltips (palette and weapon table) end with a capitals warning about friendly
  fire and exploding blocks (`PLASMA_WARNING`), and the designer's check list starts its plasma
  warning with "FRIENDLY FIRE".

The test-fleet generator (`designs.js`) puts missile launchers on the skin and heavy lasers on
the nose or hull edge, where they have a line of fire. It also makes dreadnought, leviathan and
colossus samples for the designer's templates (not used in the generated test fleets).

- **Detailed ship look** (owner, Nov 2026, viewer only: no server, sim or replay cost): from 2.5
  screen pixels per block, hull blocks use shape code `10 + type + 16 × open-sides mask + 256 ×
  var + 32768 if debris` (`hullBlock()` in the fragment shader; var = 0..7 variety, or for
  plasma cannon blocks `u × 10 + v`, the place in its 10×10 unit, from `unitPos()` in `model.js`
  → `e.unit`). Edges facing open space get a bevel lit from the upper left and a dark outline,
  so hulls read as solid plating. **Guns are fixed mounts** (owner: turrets that can't swivel
  looked cheap; barrels were tried and removed): laser = glowing faceted crystal, cannon = gun
  port with a big dark bore and bright rim, point defence = sensor dish with rings, crosshair and
  a red eye, in one fixed red for every side (owner: it blended into the ship colour; `PD_COLOR`),
  missile launcher = four tubes inside hazard stripes. **The plasma cannon is drawn as
  one 10×10 machine**: dark housing with panel lines, machinery in the corners, pipes with blue
  energy flowing inward to a glowing blue orb in a collar; its 1.5 s charge-up glow before each
  shot swells over the orb (the bolt launches from the unit's centre). Armour has rivets, heavy
  armour a raised plate, frame a light truss, thrusters a hot nozzle, the hub a pulsing core.
  Neighbour table `e.nb` (4 ints per block) is built in `ReplayModel` before `e.map` is dropped.
  `uDet` fades the detail in between 2.5 and 7.5 px per block. Software rendering measured ~25%
  slower per frame at mid zoom (headless SwiftShader); a real GPU shouldn't notice.
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
measured at 600 vs 600, median 0.2 s, 90% within 2.6 s. **Since Nov 2026 it is pushed out of its
ship while it overlaps** (owner: debris sitting over its ship looked gross): the piece alone drifts
out along the shortest way at up to `OWN_CLEAR_SPEED` (6) + depth/2 blocks/s faster than the ship.
At 400 vs 400: 99% clear within 1.2 s (was 8.3 s), longest 2.6 s (was 64 s). Debris doesn't collide with other debris
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
  between near neighbours. Every home world also gets at least one lane **inward** (`linkHomesInward()` in
  `galaxyGen.js`; owner, Nov 2026: about 1 home world in 3 only had lanes along the rim). It also
  runs in `upgradeWorld()`, so running games got the missing lanes, logged as "New hyperlane". **Moving along a lane is 10× faster** than normal space. Fleets can fly
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
- The move panel's **"Avoid worlds you don't hold"** (**off by default** since Nov 2026, owner; was on) plans
  round every world not held by you or an ally (a straight flight always exists); with it off the
  route is fastest and the panel lists the hostile stops (marked on the map) and their ships.
  Saves from before this rule (`upgradeWorld`) let fleets already in flight fly straight on.
  Early on almost every hyperlane route passes militia worlds, so with "Avoid" on fleets fly
  through normal space (measured: 4 of 30 destinations from a home world use a lane, 30 of 30
  with Avoid off). The owner thought hyperlanes had broken, so when Avoid is what stops them
  the move panel says so, shows the lane route's time and has a **"Use hyperlanes anyway"**
  button (turns Avoid off).
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
militia strength, travel scale, the 30-minute hold, fog of war, recalling fleets,
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
- Battle time limit is 8 minutes (`BATTLE_MAX_TIME` in `rules.js`, owner, Nov 2026). Battles that
  reach the limit now take up to twice the compute and replay size; watch Railway memory on huge ones.

