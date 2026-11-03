# Large Space Battles with Friends: project context

Read this first, then `docs/ARCHITECTURE.md` for how the battle engine works.

## The game

A persistent online space strategy game for a small group of friends (4 to 10 players, about 4 to
start), played like OGame or Travian: build an economy, build fleets, send them out. When fleets
meet, the server resolves the battle headlessly and saves a replay that every player can watch.
Battles are huge (up to thousands of ships), 2D top-down, and chaotic: lasers, shells, missiles,
debris everywhere, hulls breaking apart. Players never control battles directly.

Build order chosen by the owner: hardest part first. Battle engine (done, being polished) →
**ship designer (next)** → world, economy and fleets last.

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
  survive. Holds fire if a friendly ship is first in line.
- Future weapons the owner wants: bigger cannons, a medium laser.

Combat rules:
- **Friendly fire off**: allied hulls still block shots but take no damage.
- **Firing arcs**: a weapon fires only out of the hull side it is exposed on (100° arc).
  Missile launchers and heavy lasers fire any direction. Fully buried weapons can't fire until
  the armour around them is shot away.
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

## Next: ship designer

What we know the owner wants:
- Players build ships on a block grid around a central hub, choosing armour, frame, thrusters
  and weapons, with the heavy laser placed as one 10×10 unit.
- A stance picker (charge / brawl / line / standoff / escort).
- It saves the design format above, which the battle sim already reads.

Likely needs, still to agree with the owner: validation (everything connected to the hub, hull
class block limits, warning about buried weapons), live stats (mass, speed, turn rate, firepower,
weapon arcs), symmetry/mirror tools, and a way to test a design in a quick battle.
