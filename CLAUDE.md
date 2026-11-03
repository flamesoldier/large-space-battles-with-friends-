# Large Space Battles with Friends: project context

Read this first, then `docs/ARCHITECTURE.md` for how the battle engine works.

## The game

A persistent online space strategy game for a small group of friends (4 to 10 players, about 4 to
start), played like OGame or Travian: build an economy, build fleets, send them out. When fleets
meet, the server resolves the battle headlessly and saves a replay that every player can watch.
Battles are huge (up to thousands of ships), 2D top-down, and chaotic: lasers, shells, missiles,
debris everywhere, hulls breaking apart. Players never control battles directly.

Build order chosen by the owner: hardest part first. Battle engine (done, being polished) →
ship designer (first version done, being tuned) → **world, economy and fleets (next)**.

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
- **Laser**: long range (260), always hits, low damage, slow recharge.
- **Cannon**: slow visible shell with a bright trail, aimed with lead, then flies dead straight.
  The main damage dealer. Range 200.
- **Missile launcher**: huge, slow, unguided missile, range 700, flies over friendly ships,
  100 hp so point defence can shoot it down, fires every 40 s. Blast hits everything within
  9 blocks with damage `200 × (1 − d/9)²`: one missile craters, a volley tears ships apart.
  All launchers on one ship fire together as a volley. Lead is capped at 3 s.
- **Point defence**: range 30 rapid beam; shoots missiles first, close ships otherwise.
- **Heavy laser**: 10×10 multi-block turret, range 450, every 20 s, 2,500-damage beam that
  burns through blocks and ships until spent (it cuts ships in half). Works while half its blocks
  survive. Holds fire if a friendly ship is first in line. **Its blocks explode when destroyed**
  (`COOKOFF` in `blocks.js`: 260 peak damage, radius 5, ignores friendly fire, hurts its own
  ship and allies). One destroyed block chain-reacts through the whole unit: about 160 blocks
  of a battleship go with it (the gun plus ~60 around it).
- Future weapons the owner wants: bigger cannons, a medium laser.

Combat rules:
- **Friendly fire off**: allied hulls still block shots but take no damage.
- **Firing arcs = line of fire, for every weapon** (missile launchers and heavy lasers too): a
  weapon can fire in any direction where the shot wouldn't pass through its own ship (no fixed
  cone, never 360°). Worked out by `src/shared/arcs.js` (64 direction slices, ray walk through
  the ship's grid), used by both the sim and the designer, and recomputed as blocks are lost, so
  shooting away armour opens arcs. The heavy laser casts its rays from the centre of its 10×10
  unit, through its own blocks. A weapon with no clear direction is buried and can't fire. Flat
  hull-mounted guns get about 90°; guns that stick out get more.
- **Stances** chosen per design (will be a designer option): charge, brawl, line, standoff,
  escort. Escorts take limited slots around a big ship and break off to attack nearby enemies.
- **Debris** must stay clearly visible (wrecks keep most of their colour).

Battle end:
- One side has no ships left that can still fire (disarmed hulks don't count).
- Rout: a side under 20% of its starting ships still armed and outgunned 2:1.
- Disengagement: 20 s with no damage dealt anywhere, after the first 30 s.
- Time limit: 4 minutes for testing; **30 minutes at launch** so every battle resolves.
- The owner explicitly does not want a "mutual exhaustion" rule.

## Engineering rules learned the hard way

- Declare every entity field in `makeEntity()` in `battle.js`. Adding fields to some objects
  later changes V8 hidden classes and made the sim about 40% slower.
- The viewer is stateless: everything drawn is a pure function of time (that's what makes
  scrubbing free). Anything new in the replay should follow that pattern.
- Projectile samples must stay contiguous per projectile (an earlier bug interleaved them).
- Always benchmark after sim changes (`npm run bench -- 1000`); 1,000 vs 1,000 takes about 10 s.
- The demo page re-runs the sim in the browser, so results differ slightly from Node
  (`Math.sin`/`cos` aren't identical across engines). The real game records replays on the
  server, so that's fine.

## Economy rules the owner has set (for the world/economy phase)

- Each world gives a fixed credit income into the player's **global** credit pool.
- Ships aren't bought one at a time. A player buys a **shipyard** on one of their worlds for one
  design; it builds that ship **for free every 30 minutes**, forever.
- The **shipyard's price is set by the price of the ship it makes** (`src/shared/economy.js`:
  currently 10× the ship cost, so a shipyard pays for itself in 5 hours). Not yet confirmed by the owner.
- A world can have any number of shipyards. **All of them are destroyed if an enemy takes the world.**
- Every ship part has a credit cost (`cost` in `blocks.js`); a ship's price is the sum of its blocks.
  Owner's direction: **weapons and thrusters are expensive, armour and frame cheap**, to push
  players towards armoured designs. Current: frame 1, armour 3, heavy 7, thruster 20, PD 30,
  hub 40, laser 45, cannon 60, missile 120, heavy laser 3,500 a unit.

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
  destroyer ≤ 200, cruiser ≤ 500, battleship ≤ 1,200, titan ≤ 3,000. Grid limit 96 × 64.
- Validation errors block test battles (and should block shipyards): one hub, everything
  connected to it, block limit, heavy lasers as whole separate 10×10 units. Warnings: no weapons,
  buried weapons, guns with under 45° of arc, heavy-laser cook-off, no thrusters, big escorts.
- Designs are saved cropped, in the format above; JSON export stores `cells` as base64.

The test-fleet generator (`designs.js`) puts missile launchers on the skin and heavy lasers on
the nose or hull edge, where they have a line of fire.

Still open with the owner: the exact block prices and the shipyard multiplier (placeholders
until there's an income number to balance against), and whether hull class should matter beyond
the block limit.
