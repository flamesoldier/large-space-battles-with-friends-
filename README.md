# Large Space Battles with Friends

A persistent online space strategy game for a small group of friends (4–10 players), played
like OGame or Travian: build an economy, build fleets, send them out. When fleets meet, the
battle is resolved on the server and every player can watch it as a replay: thousands of
player-designed ships made of blocks, lasers, kinetic rounds and missiles flying everywhere,
friendly fire, and hulls breaking apart into debris.

## Status

We're building the hardest part first: the battle engine, then the ship designer, then the
galaxy map (world, economy and fleets), then the server. All four have a first version: the game
runs online, each player logging in with their own password (see `docs/SERVER.md`).

- `src/sim/` — headless battle simulator (block-grid ships, hit detection, break-up into debris).
- `src/shared/` — block catalogue, ship design format, replay file format.
- `src/viewer/` — WebGL2 replay viewer with zoom, pan, minimap and a scrubbable timeline.
- `src/designer/` — ship designer: block grid editor with per-block costs, live stats, validation and test battles.
- `src/world/` — the persistent world: galaxy generation, hyperlanes and routes, income, shipyards, fleets and captures (server-ready, no DOM).
- `src/galaxy/` — the galaxy map page: online (served by the game server, with a login) or as a hot-seat game in one browser.
- `server/` — the game server: real-time clock, password logins, player actions, battles in a worker thread, replays on disk.
- `docs/ARCHITECTURE.md` — how it all fits together and measured performance.
- `docs/SERVER.md` — running the game online: passwords, settings, hosting with HTTPS.

Fog of war comes next.

## Try it

Requires Node 18 or newer.

```sh
npm install
npm run build               # writes dist/galaxy.html, dist/designer.html and dist/viewer.html — open them in a browser
npm test                    # checks the designer's stats match the battle sim, and the world rules
npm run bench -- 1000       # simulate a 1,000 vs 1,000 battle and report time and replay size
npm run bench -- 1000 7 --out out/battle.replay.gz
```

To play online with friends:

```sh
npm run admin -- new-game --players "Ann,Ben,Cat,Dan"   # prints each player's password once
npm start                                               # http://localhost:8080
```

Each friend opens the site and types their password. Put it behind HTTPS before sharing it
(`docs/SERVER.md`).

For a quick local game, `dist/galaxy.html`: pick the number of players, then use "Playing as" to take turns.
Build a shipyard on your home world (it opens the ship designer), speed time up, and send the
ships it builds along the hyperlanes to take worlds.

The viewer on its own generates two test fleets, resolves the battle in your browser, then plays it.
Drag to pan, scroll or pinch to zoom, use the minimap to jump around, and scrub the timeline.
