# How the big battles work

This is the plan (and a working prototype) for the hardest part of the game: battles with
thousands of player-designed, block-built ships that break apart, rendered as replays you can
scroll around and scrub through.

The short version: **battles are resolved, not played.** When a fleet arrives at a planet, the
server simulates the whole fight headlessly, as fast as the CPU allows, and saves a replay. Players
watch the replay whenever they like. Because nobody is watching live, the simulation never has to
hit 60 fps. A battle that takes 20 seconds of compute is completely fine in an OGame/Travian-style
game where fleets take hours to arrive.

Everything below follows from that.

## Pipeline

```
fleet arrives ─▶ battle job (server, Node worker) ─▶ replay file (.replay.gz) ─▶ browser viewer
                 src/sim/battle.js                    src/shared/replayFormat.js  src/viewer/*
                 same code also runs in the browser   ~2 MB per 1,000 ships       WebGL2, scrubbable
```

The sim and viewer share one language (JavaScript) and one set of block definitions
(`src/shared/blocks.js`), so a ship designed in the editor means exactly the same thing to the
server and to the viewer.

## The simplifications that make it possible

| Decision | Why |
| --- | --- |
| **2D, top-down** | Cuts every cost (collision, rendering, AI, replay size) by an order of magnitude versus 3D. Reads clearly at fleet scale, like Cosmoteer or Reassembly. |
| **Ships are grids of blocks** (1 block = 1 unit) | A hit test is a walk through a small grid instead of a mesh test. Damage, breakage and debris all fall out of the grid naturally. |
| **10 ticks per simulated second** | Plenty for ships that turn and drift. Weapons use exact sweeps, so nothing tunnels through at this rate. |
| **No rigid-body physics** | Ships steer with simple kinematics. Hull rectangles push out of each other (separating-axis test, no bounce or spin). Debris drifts at constant velocity and spin. |
| **Turrets fire freely** | Weapon blocks don't need line of sight out of their own hull. Shots still hit anything in their path, which is where friendly fire comes from. |
| **Debris retires after 25 s** | Old chunks stop being hit-testable (they keep drifting in the replay). This caps the cost of long battles. |

## Simulation (`src/sim/battle.js`)

Each tick:

1. **AI and movement.** Each ship keeps up to 4 nearby targets (re-picked every ~1 s with a
   ring search of the broadphase grid). How it fights depends on its design's **stance**:
   `charge` (dive in to point blank), `brawl` (40% of its shortest weapon range), `line` (60% of
   its main gun range), `standoff` (90% of main gun range, backs off if pressed) or `escort`
   (holds a slot on an arc in front of a big friendly ship, and breaks off to attack anything
   within 250 of it; each big ship takes a limited number of escorts so they spread out).
   Ships ignore fleeing disarmed wrecks unless they are within 150.
   Ships that lose every weapon flee; ships that lose every engine crawl on hub thrusters.
2. **Broadphase rebuild.** A uniform 32-unit grid is rebuilt from scratch with a counting sort:
   two passes over the entities, no allocation, no hash maps.
3. **Projectiles.** Each kinetic round or missile sweeps a segment for this tick. The grid gives
   candidate ships, a bounding-circle test rejects most, and survivors get an exact
   **DDA grid walk** (Amanatides & Woo) in the ship's local block grid, returning the first live
   block. Any ship counts, allied or enemy (only the firing ship is skipped), so rounds that miss
   their target slam into whatever is behind it. With friendly fire off (the default) allied
   hulls still stop the round but take no damage; this costs nothing extra.
4. **Weapons fire.** Four weapon blocks:
   - *Laser*: instant beam, range 260, low damage, slow recharge. The reliable chip damage.
   - *Cannon*: slow shell (range 170) fired with lead, then flies dead straight. Visible trail,
     small blast. Main damage.
   - *Missile launcher*: huge, slow, unguided heavy missile (range 700) aimed with lead, flying
     dead straight over friendly ships. 100 hit points, so point defence can shoot it down. Its
     blast hits every ship and wreck within 9 blocks, with damage falling off as
     `200 × (1 − d/9)²`: one missile craters a hull, a volley tears it apart. All launchers on a
     ship share one 40 s timer and fire together as a rippling volley at the same target.
     Lead is capped at 3 s so slow missiles don't get aimed far off at manoeuvring ships.
   - *Heavy laser*: a 10×10 multi-block turret (fires in any direction) that keeps working while
     half its blocks survive. Range 450, every 20 s. The beam carries 2,500 damage and burns
     through block after block, ship after ship, until that is spent, so it can cut ships in
     half. It holds fire if a friendly ship is first in the line of fire.
   - *Point defence*: range 30 rapid beam. Shoots the nearest enemy missile first (found via a
     second small grid of live missiles), otherwise any enemy ship that close.
   Every weapon aims at a random block of its target so damage spreads over the hull.
   **Firing arcs (line of fire):** every weapon can only fire in directions where its shot
   wouldn't pass through its own ship. `src/shared/arcs.js` splits the circle into 64 slices and
   walks a ray from the gun through the ship's block grid for each (from the centre of the 10×10
   unit for the heavy laser, passing through its own blocks); the open slices are a 64-bit mask
   on the weapon. Aiming is one rotation, one `atan2` and a bit test. Masks are recomputed when
   the ship loses blocks, so armour shot away opens arcs.
   Line of fire is incremental: each weapon remembers the cell blocking each ray, and after
   damage only rays whose blocker died are re-cast.
   **Heavy-laser cook-off:** a destroyed heavy-laser block is queued and, after weapons fire,
   detonates with a blast that ignores friendly fire (`resolveCookoffs()`). The blast kills the
   neighbouring laser blocks, which go off in turn, so the whole unit chain-reacts.
5. **Break-up.** Ships that lost blocks this tick run a flood fill from the hub. Every piece no
   longer connected to the hub becomes a separate debris chunk with its own grid, inheriting
   the ship's velocity plus a kick and spin. Destroying the hub breaks the whole ship into chunks.
   Chunks can still be shot.

## Replay format (`src/shared/replayFormat.js`)

A replay is a JSON header plus columnar typed arrays (all x values together, all y values
together...), which compress far better than row records and load with no parsing.

What gets recorded, and what deliberately does not:

| Stream | Stored as | Reconstructed in the viewer by |
| --- | --- | --- |
| Ship movement | position + angle every 0.4 s, second-order delta encoded, 1/4-block precision | Catmull-Rom spline |
| Cannon shells, heavy missiles | launch time, point, angle, flight time, kind | straight line, pure function of time |
| Laser and point-defence beams | time, kind, shooter id + local origin, hit entity id + local end (world origin/angle/length only for unattached ends) | fade out, both ends following their ships |
| Debris chunks | spawn position, velocity, spin, which blocks | `x0 + v·t`, nothing per frame |
| Block destroyed | time, entity, cell | "is this block alive at t?" check, plus sparks |
| Sparks, fireballs, glows | **not stored** | seeded hashes of the event id |

Because every effect is a pure function of time, the viewer has no simulation state at all.
Scrubbing backwards, jumping to any moment, or playing at 16× costs the same as normal playback.

### Why not a deterministic re-simulation replay?

The alternative is to store only the starting fleets and re-run the sim in the browser. Replays
would be a few KB, but the sim would have to produce bit-identical results on every browser and
CPU. JavaScript's `Math.sin`/`Math.cos` are not guaranteed identical across engines, so that
means rewriting all math in fixed point and never touching floats. Recording costs about 2 MB
per 1,000 ships, which is nothing for a group of friends, and it is robust. We can revisit this if
storage ever matters.

### Performance note

Every entity object gets all its fields in one place (`makeEntity`). Adding a field to some
objects later changes their hidden class in V8 and made the whole sim about 40% slower.

## Rendering (`src/viewer/renderer.js`)

- **WebGL2 instancing.** Every block, tracer, beam and spark is one instance of a single quad.
  Two draw calls per frame: opaque hull blocks, then additive glow effects.
- **Culling.** Anything outside the camera is skipped before it reaches the GPU.
- **Level of detail.** Below ~0.9 pixels per block a ship is drawn as one quad in its faction
  colour, so the full-fleet view of 10,000 ships stays cheap. Zoom in and the individual blocks,
  holes and debris appear.
- **Big maps.** Pan by dragging, zoom with wheel or pinch, jump with the minimap. The battlefield
  is unbounded; only what is on screen costs anything.

## Measured numbers

`node tools/bench.mjs <shipsPerSide> 7` on one CPU core (Node 22, single thread), using the
generated test fleets (45% corvettes up to 0.5% titans of ~2,500 blocks each). Re-measured
after line of fire, heavy-laser cook-off, giant-ship targeting, collisions and attached beams:

| Ships (total) | Blocks | Simulated | Compute | Replay (gzip) |
| ---: | ---: | ---: | ---: | ---: |
| 800 | 90k | 202 s | 2.9 s | 1.5 MB |
| 2,000 | 226k | 244 s | 8.2 s | 4.4 MB |
| 4,000 | 451k | 244 s | 21 s | 9.7 MB |
| 10,000 | 1.13M | 244 s | 88 s | 28 MB |

Compared with the first prototype, a 10,000-ship battle went from 61 s to 88 s of compute and
from 19 MB to 28 MB of replay. The extra compute is mostly ship collisions in dense fleets; the
extra replay is mostly cook-off explosions, more beams and the beam attachment data. Even so, a
10,000-ship battle with over a million destructible blocks resolves in about a minute and a
half on one core. For 4 to 10 players, a single small VPS is more than enough. Battles are
independent jobs, so they can also run in parallel worker threads.

The bundled viewer runs the same sim in the browser for the demo (about 3× slower than Node in
practice). In the real game the browser only downloads and plays the replay.

## Limits to set in the game rules

These keep every battle inside the budget above:

- **Blocks per ship by hull class** (for example corvette ≤ 40, titan ≤ 3,000).
- **Total blocks per battle** around 1M. Bigger engagements can be split into waves.
- **Time limit** per battle: 4 simulated minutes while testing, 30 minutes planned for launch so
  every battle comes to a resolution.

A battle ends early when any of these happens (a 4 s tail lets the last shots land):
- one side has no ships left that can still fire (disarmed hulks don't count);
- rout: a side is down to under 20% of its starting ships still armed and is outgunned 2:1;
- disengagement: 20 s pass with no damage dealt anywhere (after the first 30 s).

## Ship designer (`src/designer/`, `src/shared/shipStats.js`)

The designer edits a 96×64 grid and saves the cropped `{ name, cls, w, h, cells, hub, stance }`
design the sim reads. Every number it shows comes from shared code: block prices and hit points
from `blocks.js`, and speed, turn rate and weapon arcs from `shipStats.js`, which repeats the
formulas in `Battle.refit()` and `Battle.facing()`. `npm test` builds a Battle for 150 generated
designs and checks the two agree, so a stat on screen is the stat in combat.

A ship's price is the sum of its block costs. Players buy a shipyard for a design rather than
single ships; the shipyard's price is a multiple of the ship price (`economy.js`).

The test battle runs the real sim in the page (your design × N vs an equal-cost fleet). The build
embeds the whole viewer page into `designer.html`; "Watch replay" loads it in an iframe overlay and
hands it the packed replay through `postMessage`, so the viewer plays exactly what the designer
resolved, and the designer still works as one file.

## Giant ships

Designs can be up to 1024 × 640 cells and 400,000 blocks. Measured on one core:

| Battle | Compute for 244 s | Replay (gzip) |
| --- | ---: | ---: |
| 2 × 350,000-block ships, duel | 1.8 s | 0.3 MB |
| 1 colossus (100k blocks) + 500 ships per side | 3.7 s | 2.0 MB |
| 2 colossi + 1,000 ships per side | 8.3 s | 4.3 MB |

What made this work: 32-bit block indexes in the replay, incremental line of fire, weapons
aiming at the near side of a big target rather than its centre, more targets per big ship, and
stance distances measured roughly hull to hull. Memory is the real limit: every ship in a
battle has its own `types` + `hp` arrays (5 bytes per cell), so a full-size 1024 × 640 ship is
about 3 MB per copy.

## The galaxy (`src/world/`, `src/galaxy/`)

The persistent world is one plain JSON object, and every rule is a pure function of it plus a
game clock in milliseconds. Nothing in `src/world/` touches the DOM or reads the wall clock, so
the server will run exactly this code; for now `src/galaxy/` runs it in the browser as a hot-seat
game saved in localStorage.

```
world = { clock, seed, radius, players[], planets[], lanes[[a,b]], designs{}, fleets[], log[] }
planet = { id, name, x, y, income, home, owner, yards[{ design, list, paid, next, built }], garrison[{ owner, design, n }] }
fleet  = { id, owner, ships{ designId: n }, from, to, legs[{ from, to, lane, hours }], depart, arrive }
```

**Time is cheap.** Income and shipyard production are linear in time, so `advanceTo(world, t)`
settles any gap in one pass (a shipyard that is 40 cycles behind adds 40 ships at once).
Fleet arrivals are the only discrete events: the driver advances to each arrival in order,
resolves it, and carries on. A server that slept for a week catches up in milliseconds plus the
battles it owes.

**Battles stay outside the rules.** `arrivalPlan()` turns a fleet arriving at a defended world
into a Battle scenario (attacker = team 0, every defending stack = team 1, spawned in group order
so ship k is entity k). The caller runs `src/sim/battle.js` however it likes (the page in slices
with a progress card; the server in a worker) and hands `readBattle()`'s survivor counts to
`completeArrival()`, which applies losses, captures the world (destroying its shipyards) or
sends the beaten attackers home. While a battle runs, the world clock waits at the arrival time,
so nothing can change underneath it.

**Routes.** Fleets can fly straight through normal space or ride hyperlanes at 10× speed. The
planner is Dijkstra over every world, with a normal-space edge between every pair and a lane edge
where there is a lane, so it finds the fastest mix (fly to a lane, ride it, fly off). Under 100
worlds this is trivial. A fleet's position is a pure function of time (`fleetPosition`), like
everything in the replay viewer, so the map never stores fleet positions.

**Stops.** Fleets stop at every world on their route: each leg records when it ends (`legs[k].at`)
and the fleet's next event is the end of its current leg (`fleet.next`). At a stop, defenders at a
world the fleet's side doesn't hold fight it (a battle with `passing: true`); otherwise it flies
on. The planner can be told to avoid hostile worlds (they're dropped as intermediate nodes in the
Dijkstra), and because a straight flight between any two worlds always exists, there is always a
route. Schedules never change after launch, and the clock waits during a battle, so a fleet that
fights its way through keeps its timetable.

**Map generation.** Spawn points go evenly round a ring at 72% of the radius (fair starts), other
worlds by dart throwing with a minimum spacing. Lanes are a Euclidean minimum spanning tree (every
world reachable, no crossings) plus a share of the short neighbour links that cross nothing and
pass no other world. Seeded and deterministic.

The page embeds the ship designer (in "shipyard mode", which shows the price at that world and
posts the chosen design back) and the replay viewer, both as `srcdoc` iframes, so `galaxy.html`
is still one file and the designer's library shares the page's storage.

## What's next for battles

In rough order:

1. ~~Ship designer~~: done (`src/designer/`, see below).
1. ~~Ship collisions~~: on (hull rectangles, any team), about +7% compute at 1,000 vs 1,000.
2. Battle job runner on the server: queue, worker threads, store replays, write losses back to
   the fleets. The world side of this is ready (`arrivalPlan` / `readBattle` / `completeArrival`
   in `src/world/`); what's missing is the server itself.
3. Combat depth: a railgun that punches through several blocks, shields, reactor/power blocks, and smarter AI roles (screens, flankers, capital ships holding
   back).
4. Balance. Battles currently drag on at the end with crippled stragglers; the rout and
   disengage rules help but need tuning against real player designs.
5. Replay streaming for very large battles: load the first minute and fetch the rest while
   playing.
6. If we ever need more headroom: port `battle.js` to Rust compiled to WebAssembly (typically
   5–10× faster), keeping the same replay format.
