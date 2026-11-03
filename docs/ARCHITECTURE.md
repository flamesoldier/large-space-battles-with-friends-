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
| **No rigid-body physics** | Ships steer with simple kinematics and a soft separation nudge. No ship-vs-ship collision response. Debris drifts at constant velocity and spin. |
| **Turrets fire freely** | Weapon blocks don't need line of sight out of their own hull. Shots still hit anything in their path, which is where friendly fire comes from. |
| **Debris retires after 25 s** | Old chunks stop being hit-testable (they keep drifting in the replay). This caps the cost of long battles. |

## Simulation (`src/sim/battle.js`)

Each tick:

1. **AI and movement.** Each ship keeps up to 4 nearby targets (re-picked every ~1 s with a
   ring search of the broadphase grid). It closes to its preferred range, then orbits/broadsides.
   Ships that lose every weapon flee; ships that lose every engine crawl on hub thrusters.
2. **Broadphase rebuild.** A uniform 32-unit grid is rebuilt from scratch with a counting sort:
   two passes over the entities, no allocation, no hash maps.
3. **Projectiles.** Each kinetic round or missile sweeps a segment for this tick. The grid gives
   candidate ships, a bounding-circle test rejects most, and survivors get an exact
   **DDA grid walk** (Amanatides & Woo) in the ship's local block grid, returning the first live
   block. Any ship counts, allied or enemy (only the firing ship is skipped), so rounds that miss
   their target slam into whatever is behind it.
4. **Weapons fire.** Lasers are instant sweeps. Cannons lead their target. Missiles home. Every
   weapon aims at a random block of its target so damage spreads over the hull.
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
| Kinetic rounds | spawn time, position, angle, flight time | straight line, pure function of time |
| Lasers | time, origin, angle, length | fade over 0.25 s |
| Missiles | position every 0.3 s | linear interpolation |
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
generated test fleets (45% corvettes up to 0.5% titans of ~2,500 blocks each):

| Ships | Blocks | Simulated | Compute | Replay (gzip) |
| ---: | ---: | ---: | ---: | ---: |
| 400 | 45k | 126 s | 1.3 s | 0.7 MB |
| 1,000 | 115k | 151 s | 3.3 s | 1.9 MB |
| 2,000 | 224k | 156 s | 6.7 s | 3.7 MB |
| 5,000 | 564k | 184 s | 22 s | 9.7 MB |
| 10,000 | 1.12M | 184 s | 61 s | 19.4 MB |

So a 10,000-ship battle with over a million destructible blocks resolves in about a minute on one
core. For 4 to 10 players, a single small VPS is more than enough. Battles are independent jobs,
so they can also run in parallel worker threads.

The bundled viewer runs the same sim in the browser for the demo (about 3× slower than Node in
practice). In the real game the browser only downloads and plays the replay.

## Limits to set in the game rules

These keep every battle inside the budget above:

- **Blocks per ship by hull class** (for example corvette ≤ 40, titan ≤ 3,000).
- **Total blocks per battle** around 1M. Bigger engagements can be split into waves.
- **Time limit** per battle (currently 3 simulated minutes), after which survivors disengage.

## What's next for battles

In rough order:

1. Ship designer: edit a grid, validate it (connected to hub, class limits), save the same
   `{w, h, cells, hub}` format the sim already uses.
2. Battle job runner on the server: queue, worker threads, store replays, write losses back to
   the fleets.
3. Combat depth: point defence that shoots missiles, kinetic penetration through several blocks,
   shields, reactor/power blocks, and smarter AI roles (screens, flankers, capital ships holding
   back).
4. Balance. Battles currently drag on at the end with crippled stragglers; the rout and
   disengage rules help but need tuning against real player designs.
5. Replay streaming for very large battles: load the first minute and fetch the rest while
   playing.
6. If we ever need more headroom: port `battle.js` to Rust compiled to WebAssembly (typically
   5–10× faster), keeping the same replay format.
