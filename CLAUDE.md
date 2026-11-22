# Large Space Battles with Friends: project context

Read this first, then `docs/ARCHITECTURE.md` for how the battle engine works and
`docs/SERVER.md` for the online game. **Current phase: version 2.0 is live (18 Nov 2026); bug fixing and balance** (see "Version 2.0"
just below; where it disagrees with anything later in this file, 2.0 wins). "Working on the live
game" at the end still applies.

## Version 2.0 (started 18 Nov 2026)

**Branches.** Version 1.0 is finished (the owner and friends completed their game). Its code is
frozen on **`v1.0-stable` (commit 65fcad7): never change that branch.** `main` is now 2.0. Nobody
is playing, so pushing to `main` is safe, but the owner's rules still hold: **show him first, push
only when he says "make it live"**, and after any big change to how battles play send him a replay
page. When 2.0 is ready he starts a fresh game from `/admin` ("Replace the current game"), so 2.0
doesn't have to keep the 1.0 save playable, only load without crashing.

**Why 2.0.** In 1.0 players had to keep logging on to defend their worlds or catch good moments to
attack. 2.0 makes the game play itself between visits: what matters is ship design, where you
build shipyards, which way you push, and diplomacy, not being online. **Players no longer command
fleets at all.**

**Owner's answers (18 Nov 2026), the plan to build:**

1. **Everything about 3× slower than 1.0**: income ÷3 (home 500 cr/h, other worlds 133–333),
   travel ÷3 (`TRAVEL_SCALE`), the battle hold 30 → **180 min** (owner, 18 Nov 2026; first 90: two build cycles, so a
   defender gets two waves of reinforcements), selling a shipyard and building defences 5 → **15 h**.
   Starting credits and militia strength: settle with the test games (militia is "4 h of income",
   so ÷3 income would weaken it; default: keep its credit value as in 1.0).
2. **Shipyards build every 90 minutes, 5 ships each time** (owner chose 5, not 6). **All
   shipyards on a world build at the same moment**: each world has its own 90-minute build clock
   (not one galaxy-wide clock: spreads server load, less predictable), and everything built
   there leaves together as one fleet. That's ~5× more ships compared with the rest of the
   slowed-down game; the owner accepts it because fleets fight until they die, so battles stay
   manageable, and the server gets 3× longer per battle. **The owner plans to raise weapon prices
   and the shipyard crowding tax** (to encourage more, smaller fleets); set the numbers with the
   test games.
3. **New fleets launch automatically.** Enemies = players you're at war with **and militia**
   (that's how players expand now). Distance = travel time **along hyperlanes**.
   - **No destination set for the world**: go and fight the nearest enemy target: an enemy world,
     or an enemy fleet. Battles only happen at worlds, so "an enemy fleet" means the world it's at
     or flying to (including your own or an ally's world it's attacking: fleets go to defend).
   - **Destination set** (any world, enemy or friendly; set per world by its owner, plus a "send
     every world's fleets here" button like 1.0's rally-all; replaces rally points): go there,
     fighting enemy worlds on the way (1.0's "stop at every world" rule), then keep seeking the
     nearest enemy after arriving. A friendly destination is a gathering point, not a parking spot.
   - **Fleets never sit and build up** (owner: "they fight till they die"). No "stay home"
     setting. The only ships that stay at a world are pinned ones (point 5).
4. **No manual fleet control**: 1.0's Send fleet, Stop at next world, Avoid worlds you don't
   hold and rally points go. Only the server launches fleets (like 1.0's rally fleets).
5. **No more "swap"** (1.0: two fleets fly past each other and take each other's worlds). Aim: a
   tug of war, the front line moving back and forth one world at a time.
   - **Pinned**: any of your ships at a world that an enemy fleet is heading to stay and defend it
     (not only new ships: this also makes a fleet that just took a world hold it while it's being
     counter-attacked). When the threat is gone they launch as normal.
   - **Hyperlanes only**: fleets choose routes along hyperlanes. Normal space only when there's a
     reason, e.g. a beaten fleet with no friendly world to fall back to along the lanes.
   - **Tie-break**, generalised from "two worlds launch at each other at the same moment": whenever
     two enemy fleets are flying at each other's worlds along the same lane, **the one that would
     arrive later turns back** to defend.
6. **Speed matters less on hyperlanes**: lane speed ∝ speed^0.485 (`log2(1.4)`), so a ship twice
   as fast is 40% faster on a lane (1.0: 100%). Normal-space travel and battle speed unchanged.
7. **No battle size cap** (owner: "the game is large space battles"): if the server struggles,
   optimise, don't cap.
8. **Bounty 20% → 10%** (more ships, more fighting). Everything else unchanged: defences,
   selling shipyards, alliances, credit gifts, victory, every battle and weapon rule.

**Build order (agreed):** (1) this section; (2) the slower numbers, 5-ship world builds, softened
lane speed; (3) the fleet brain (auto launch, targets, destinations, pinned, tie-break, lanes
only), removing manual fleet controls; (4) a headless test game with bot players at high speed:
check for a tug of war, battle sizes and server time, set prices from it; (5) map and panels
(arrows for each world's next fleet, "next fleet in N min", front line, patch notes); (6) send the
owner an offline `dist/galaxy.html` preview and a replay of a typical 2.0 battle, then "make it
live", then he replaces the game on `/admin`.

**Progress:** (1) done 18 Nov 2026. (2) done 18 Nov 2026 on branch `v2-dev` (not live): `SHIPYARD_INTERVAL_MIN` 90, `SHIPS_PER_BUILD` 5, world build clock (`nextBuildAt()` in `world.js`: a new or kept shipyard joins the next build moment of the yards already building there, else a full interval), income 500 / 130–330 (steps of 10), `TRAVEL_SCALE` 1/3, `laneSpeed()` in `routes.js` (`LANE_REF_SPEED` 7.7, `LANE_SPEED_EXP` log2 1.4), hold 90 min, sell/defences 15 h, bounty 10%, militia 12 h of income. (3) done 18 Nov 2026 on `v2-dev` (not live), "the fleet brain" section in `world.js`. Owner added: **before a fleet leaves any world it recalculates the nearest enemy**, so fleets move **one hyperlane hop at a time** and decide again at every world (`moveOn()`). `world.auto` (set by `createWorld`; 1.0 saves have none and keep 1.0 rules, so the old save loads harmlessly) turns it on. A world's build moment is an event (`dueEvent` kind `'build'`); `dispatchAll()` runs after every event (and after every player action on the server): every ship that can fly leaves unless `pinned()` (an enemy fleet's next stop is that world, or an enemy besieges it). `nextHop(world, from, who, goal)`: Dijkstra over lanes only; seeking passes only through friendly worlds; target = nearest non-allied world (militia included) or friendly world under threat. Fleets carry `goal` (from the launching world's `P.dest`, cleared on arrival there). Tie-break `settleSwap()`: only possible for fleets launched at the same moment along one lane; the later arrival turns back, and only if nothing else pins the world (a bug where both stayed was found by the 4-day test). Retreat (`autoRetreatTarget`/`retreatPlan`): friendly lane neighbour (where it came from first), else straight through normal space. `setDestination()`/`destinationAll()` (server actions `dest`, `destAll`; any world, not itself); `fleet`/`rally`/`rallyAll`/`stop` refused in auto worlds. Page: Destination section replaces Rally point, Move ships hidden, fleet panel shows the plan. Tests: `tools/test-world.mjs` "2.0: the fleet brain" (1.0 sections run with `auto: false` via a wrapper) incl. a 4-player 4-day game with stand-in battles: lanes only, no swaps, no idle unpinned ships, militia taken, worlds change hands; `tools/test-server.mjs` checks refusals, destinations and that Ann's ships fight by themselves. **Owner's additions to step 3 (18 Nov 2026):** (a) ships that stay at a world (pinned or waiting) **keep their own orders**: garrison stacks carry `goal` (absent = built there, takes `P.dest` when leaving; `null` = nearest enemy; a world id), `addShips(..., goal)` merges only equal goals, battle groups carry it so survivors go back to the right stack; (b) **fleets that fought together split up afterwards**: `dispatchAll` sends one fleet per player and goal; (c) **no arriving late to a siege**: a fleet doesn't set off for a world with a siege unless it arrives before `startsAt`, it waits instead (`lateForSiege`; owner: otherwise a stream of late fleets keeps the defender pinned so it can never strike back); (d) **after a battle the world's holder moves first** (`dispatchAll(world, first)`, fleets marked `first` = that moment are never turned back by the tie-break), so a successful defender strikes back while the attacker's waiting fleet stays pinned to meet it. `holdReason()` says why ships wait ('pinned' / 'siege' / 'nothing'), used by the test and the world panel. Tests for all four in `tools/test-world.mjs` (the priority test fails with the rule switched off). (e) **owner chose: fleets already on their way when a siege starts turn back** if they'd arrive after its battle starts (`turnBackLate()`, called when a siege is created): the leg is replaced by one from the besieged world back to where it came from, timed so the fleet turns round exactly where it is and takes as long back as it had flown (`f.turned` = the besieged world; the tie-break ignores turned fleets; fleet panel tag "turned back"); retreating fleets carry on. Back home it waits (`lateForSiege`). And **sieges hold 3 hours** (`BATTLE_HOLD_MIN` 180, owner, with this). Test in `tools/test-world.mjs`. **Worlds with 3–5 hyperlanes (owner asked, 18 Nov 2026)**: stand-in battle games (`/tmp`-style script, 4 and 6 players, 2 seeds each, 6 days): no rule problems: fleets went straight back to the friendly world they'd just left in 0–14 of 500–900 hops (~1%), never more than 3 hops in a row without a fight, turned back 45–78 times a game. Well-connected worlds are fought over far more (sieges per world: ~0.7 at 1 lane, ~1 at 2, ~3 at 3–4, ~6 at 5 lanes): crossroads are where the front lines meet, a natural reason to defend them; a world's new ships only go for its one nearest target, so on a crossroads the other directions are only covered by destinations.

**Allies checked, dispatch goes round again (owner, 22 Nov 2026: "in version 2 fleets now move on the galaxy map themselves
does that work with allies?"; then "if it doesn't significantly cost more compute or downloads… do it")**, **live 22 Nov
2026** (owner: "make it live"; no patch notes). Stand-in battle games (`/tmp`-style `allies/run.mjs`: 2 allies vs 2 and vs 1, 3 seeds each, plus both allies setting
the same enemy home as destination, 4 days): allies never besieged or took each other's worlds, fleets flew through and
to allied worlds (0–11 times a game to defend one), guests were held to defend (9–71), allies fought side by side
(2–11 battles), never off a lane. Found, not ally-related: `dispatchAll` went round the worlds once, so a fleet leaving a
world later in the round could free ships at one already passed, and they waited for the next event (once in 8 games:
5 ships, 13 minutes). Now `dispatchAll` repeats `dispatchRound` while a round sends anything (cap `DISPATCH_ROUNDS` 8).
Measured (5 games, 4–10 players, 5 days, stand-in battles): a second round sent ships once in 817 events; world-rule time
731 → 787 ms per 5 game days (noise-level; battles are the server's cost); no change to what is sent to players. Test in
`tools/test-world.mjs` ("2.0 with allies", fails with one round).

**Stronger militia (owner, 22 Nov 2026: "militia planets are too easy to take… a fleet worth 10,000 credits with its first
attack… I don't want militia planets too strong though, enough for 1.5 attacks to take it")**, **live 22 Nov 2026**.
`NEUTRAL_GARRISON_BASE` **20,000** in `economy.js`: militia = 20,000 + 12 h of income (was 12 h only: 1,560–3,960 cr).
Only new galaxies (militia is made in `createWorld`). Measured (`/tmp`-style `mil.mjs`: the sim-galaxy bots, 4 players,
real battles, first 30 game hours, militia base swept via a copied tree): a starting player's first siege happens ~7 h in
and has gathered 2–3 waves (the 3-hour hold), ~20–30k of attackers, so the old militia always fell at once (12/12 first
try). Mean attempts per militia world taken (seeds 5 / 9): base 10k 1.12 / 1.00, **20k 1.57 / 1.43**, 30k 1.80 / 1.75.
At 20k a 3-wave first siege (~29k) usually takes it, a 2-wave one (~21k) usually holds and leaves it weak for the next.
Test in `tools/test-world.mjs`.

**Income from hyperlanes (owner, 22 Nov 2026: "planet income be a base value + an amount for how many hyperlanes connect
the planet, more hyperlanes harder to hold more value… fix planets giving random income")**, **live 22 Nov 2026**: every
non-home world pays `PLANET_INCOME_BASE` 60 + `PLANET_INCOME_PER_LANE` 50 per lane (`planetIncome()` in `economy.js`), set in
`generateGalaxy` after all lanes (incl. `linkHomesInward`); map size 0.5 + 0.1 per lane past the first (≤ 1). Homes stay 500.
Measured over 200 galaxies (2–10 players): lanes 1–7, mean 3.4 (1: 2%, 2: 15%, 3: 37%, 4: 34%, 5: 10%, 6+: 2%), so 110–410
cr/h, mean ~230 like the old random 130–330. The old random draws are still taken, so a seed makes the same map. New
galaxies only (running games keep their incomes; lanes `upgradeWorld` adds don't change income). Test in `tools/test-world.mjs`.
**Doubled the same day** (owner: "new players are going to want to build more shipyards in the first day… a 3 hyperlane
planet should make at least 420"): base **120** + **100** per lane, so 220 / 320 / 420 / 520 / 620 for 1–5 lanes, mean ~460;
**home worlds 850** (`HOME_INCOME`, owner, same day). Militia grows with it (20,000 + 12 h: ~25,000 at a 3-lane world instead of ~22,500; owner: "militia can be stronger"). **Live 22 Nov 2026.**

**Battle colours by credits destroyed (owner, 22 Nov 2026: "5 ships attacking a huge force is coded as important. importance should be in credit value of ships/defences destroyed")**, **live 22 Nov 2026** (owner: "make it live"; no patch notes): `battleSize()` in `galaxy/app.js` now ranks `battleDestroyed(B)` (sum of every side's `lost`: ships and defences that died in the battle, at `worthOf`) instead of ship count; same tiers (Epic top 5% and the costliest, unless nothing died; Huge 20%; Large half; Medium; Small bottom 20%). Chip "Huge · 184k cr destroyed" (`fmtCr`), tooltip "the 3rd costliest of 41 battles", key "Importance:". Defences razed after a captured world are not counted (the battle entry doesn't keep them). Checked in a headless browser with made-up battles (5 ships vs 2,000: Small; 300 vs 300 wiped out: Epic). **Legendary tier (owner, same evening: "a legendary tier for the top battle (most destructive battle in the game so far)… feel free to rearrange colours"), live 22 Nov 2026**: `SIZE_TIERS[0]` 'legendary' = the most destructive battle so far (ties share it; not when nothing died), Epic = the other top 5%; colours Legendary gold (thicker border, slow pulsing glow off under `prefers-reduced-motion`, glowing chip), Epic purple, Huge orange, **Large now blue** (was gold), Medium green, Small grey; key "Legendary (the most destructive)". Also tested 22 Nov 2026: big replays on the owner's Pixel 8a: a 20,000-ship battle (4 sides, 40% newer blocks, 154 MB download, ~2.4–2.9 GB in desktop headless Chrome) opened and played fine; no replay-memory work needed for now.

**Defences and selling, 5 minutes (owner, 18 Nov 2026, after 2.0 went live):** "building defences will be much more important and should be able to be done reactively": `DEFENSE_BUILD_HOURS` and `SELL_HOURS` = 5/60 (were 15 h), **selling a shipyard gives back 65%** (`SHIPYARD_SELL_REFUND`, was 95%). Texts use `fmtHours()` ("5 min"). Test: defences ordered 10 min before a battle are ready for it, ones ordered 2 min before are lost with the world. Live 18 Nov 2026. **No patch notes for now** (owner: nobody is playing; he'll say when to start again).

**Bots (owner, 18 Nov 2026: "they don't have to be good, just basic bots"):** `src/world/bots.js`. A bot is a player with `bot: true` (no password; sessions refused). Every `BOT_EVERY_MIN` (10) game minutes a world event `'bots'` (`dueEvent`, after anything else due then; `world.botNext`) runs `runBots()`: alliance proposals to it are declined; any of its worlds `pinned()` by an enemy gets defences (a generated cruiser with thrusters turned to armour, up to half its credits, ≤ 200, once per world per 3 h); then shipyards for its own generated frigate/destroyer/cruiser/battleship (random, weighted to mid sizes) on the cheapest world, keeping 2 h of income back. Works on the server and the hot-seat page alike (it's an ordinary event); the server saves bot turns once per catch-up. Admin page: **Bots** field when making a game (extra seats "Bot 1"…, after the people; 1+ person, 2–10 seats in all; `bots` in `/api/admin/new-game`, `--bots` on the command line) and **Make it a bot** per seat (`makeBot()` in `world.js`, `/api/admin/make-bot`: an open seat becomes "Bot N", a named one keeps its name; its password is deleted). Diplomacy window tags bots and hides Propose. Names "Bot N" are reserved. Tests in `tools/test-world.mjs` and `tools/test-server.mjs`. Live 18 Nov 2026.

**Bots earn double (owner, 22 Nov 2026: "i found the ai too easy my designs destroy them… give them double the income as a
normal player would get so that i can play test games against them")**, **live 22 Nov 2026** (no patch notes): `BOT_INCOME_MULT` 2 in
`economy.js`; `incomeMult()` in `world.js` used by `advanceTo` (credits and stats) and `incomeOf` (so totals in the
standings, diplomacy window and the bots' own 2-hour reserve show it). A single world's income in its panel and the
capture log's "+N cr/h" stay the normal figure; militia strength unchanged. Applies to bots in a running game at once.
Test in `tools/test-world.mjs`.

**Turn-taking (owner, 19 Nov 2026)**, after playtesting against bots at 600×: a world kept being attacked and never struck back. Not the server pausing for battles (reproduced with no server, stand-in battles, exact game time: one world pinned 92% of the time, up to 12 h in a row): an enemy neighbour launching every 90 min keeps a fleet always in flight, so `pinned()` never let go. Owner's rule: "planet 1 attacks planet 2, planet 1 cannot attack again till planet 2 attacks planet 1; planet 1 can still attack planet 3 and planet 3 could still attack planet 2; if planet 2 gets conquered… that refreshes it". `world.locks` = `[{ from, to, by, def, at }]` (`upgradeWorld` default []): `addLock()` in `siegeEnds` for every fleet beaten off at a player's world (not militia, which never attacks back; origin = the fleet's leg `from`); `liftLocks()` when a fleet of `def` from `to` arrives to attack `from` (siege or joining one); `capture()` drops every lock to or from the world. `nextHop` skips locked lanes into non-allied worlds; a destination cut off by locks falls back to seeking. World panel rows **Can't attack** / **Safe from**. Fleets already flying when the lock is made carry on. After it: worst world pinned 47% (longest stretches = attacks from two different neighbours in turn, which the rule allows). Test in `tools/test-world.mjs` (fails with 2,837 locked launches with the rule off). Also: in 2.0 games fleets joining an allied attack are no longer logged (they flooded the battle log); a new enemy arriving at a siege still is.

**2.0 prices (owner, 18 Nov 2026):** cannon **120** (1.0: 50), laser **120** (80), point defence **90** (60) in `blocks.js`; shipyard crowding tax **+100% per 325,000 cr** of yards already on a world (`SHIPYARD_CROWDING_VALUE`, 1.0: 750,000; read as the same straight-line rule with a smaller number). Generated ship prices now: frigate ~950, destroyer ~1,200, cruiser ~2,600, battleship ~6,000, titan ~13,700. The Aegis fortresses were regenerated with the `tools/fortress-gen` commands so they stay exactly 750,000 cr.

**(4) Test games, first round (18 Nov 2026): `tools/sim-galaxy.mjs`** (`--players --seed --days --budget-min --out`): bots buy a shipyard whenever they can afford one, on their cheapest world, random design from their own frigate/destroyer/cruiser mix (same mix for every bot, so it's fair; an earlier version gave bots different hull sizes and the ones with dear designs couldn't build); no destinations or defences. Real battles one at a time like the server's worker; prints worlds/yards/ships per half day and where ships are (flying / in a siege / pinned / waiting for a siege), then battle sizes, compute, replay MB, memory, income vs bounty; writes `battles.csv` and the biggest and typical replays. 4 players, seed 5, 6 game days:
- **Shipyard 10× (now)**: a good tug of war (worlds 7/7/8/9 at day 6, 68 captures, 26 taken back) but **runaway growth**: yards ~double every 1.3 days (77/54/85/51 at day 6), **bounty is ~4× world income** (e.g. 1.27M vs 287k), biggest battle 118 → 730 → 2,456 → 3,058–3,796 ships (days 1/3/5/6). Server fine so far (worst battle 36 s, 527 MB peak, 43 MB of replays a game day, ~1% of the CPU) but heading for 10–20k-ship battles by day ~10.
- **20×**: slower (yards 34/0/23/26 at day 6, bounty ≈ income), but one bot knocked out on day 3 and the front froze (15/0/8/8 from day 4); biggest battle still 4,000 by day 6.
- 30× / 50× (unfair first-version bots): one bot took the galaxy by day 4.
- **Ships pile up at the front**: battles are big because whole armies wait at front worlds, pinned or waiting for a 3-hour siege to end (Bot1 at day 6 in one run: ~3,700 pinned + ~4,900 waiting of ~9,700 ships), not because they're idle. Raised with the owner with the options.
- **Owner's verdict (18 Nov 2026): "a success".** Huge battles are what he wants ("we will find other ways later so Railway can handle it"); the runaway economy is fine (1.0's game lasted 8 days); no economy change. He noted the bots never build battleships, titans or defences, as real players would.

**Redirect (owner, 18 Nov 2026):** a fleet with no orders of its own (none given, or it has reached its destination) goes for the nearest target it can reach **before that target's battle starts**; it only waits if every target is like that. A fleet still on its way to a destination waits as before. `nextHop(world, from, who, goal, ships)`: with `goal` null and `ships` given, any world with a siege whose `startsAt` comes before these ships could arrive (path length / `laneSpeed`) is neither a target nor a way through (the first version only skipped it as a target, so ships whose route ran through a besieged friendly world waited; caught on the page). `holdReason` says 'siege' when only late targets are left. Test in `tools/test-world.mjs`.

**Wait rather than wander (owner, 19 Nov 2026):** "one of my fleets that couldn't make it to a battle tried to get to a front line across the galaxy, the fight finished and it turned back around, it should have waited". In `nextHop` (seeking with ships known) a target whose battle these ships would miss now counts as *time until its battle starts + the trip there* (`waitDist`, as lane distance at their speed) instead of being skipped; Dijkstra stops once nothing left can beat it (`lateBest`), and if the late target wins the ships wait (null → `holdReason` 'siege') and decide again after the battle. Stand-in bot games (3 seeds, 3 days): fleets going straight back the way they came 13.8% → 4.5% of hops, hops 1,164 → 601. Test in `tools/test-world.mjs` (late by a minute: waits; late by 90% of the trip with another target a bit further: goes there). **Then move up and wait** (owner, same day: "some fleets wait 2 or 3 planets away from the fight, they may as well keep moving towards the fight then wait"): when the late target wins (`lateT`), `nextHop` returns the first hop along the friendly path to it, and null (wait) only once the fleet is next to it. Bot games: back-the-way-they-came 3.4% of 1,029 hops. Test in `tools/test-world.mjs`. Live 19 Nov 2026.

**Normal space at half lane speed (owner, 19 Nov 2026):** beaten fleets with no friendly lane neighbour retreat straight through normal space, which at 10× slower took a day or more, and a fleet whose destination fell meanwhile kept that world pinned the whole time. Offered: no routs, faster normal space, or (my suggestion) retreating fleets don't pin + re-route if their destination falls; owner chose **faster normal space**. `SPACE_VS_LANE` 0.5 in `rules.js`: in auto worlds `retreatPlan()` flies at `laneSpeed(speed) × 0.5` (only retreats use normal space in 2.0; 1.0 travel unchanged). Test in `tools/test-world.mjs`. Live 19 Nov 2026.

**Destination chosen on the map (owner, 19 Nov 2026: "click select target then click the planet on the map, I don't want to select it from a list"):** the Destination section's list is gone: a **Fleets from here go to** row, **Choose on map** (`destPick` = the world being set, in `galaxy/app.js`; crosshair cursor, a white dashed arrow from the world to the one under the pointer, hover ring; a click on another world calls `setDest`; empty space, the world itself, Esc or Cancel stop; `select()` clears it), **Show X** and **Nearest enemy instead**. `destPick` is in the panel signature. Checked in a headless browser on `dist/galaxy.html` (set, clear, Esc).

**(5) Map and panels done 18 Nov 2026 (not live):** lanes between players at war glow red (front lines); every world of yours with shipyards draws an arrow part-way along the lane its next fleet will take (`nextFleetOf()` / `nextFleets()` in `galaxy/app.js`, refreshed ~3× a second); the world panel's **Next fleet** row ("10 ships in 1 h 30 min → Hesugon Prime (for Oridis)"); map key updated (Hyperlane / Front line / Where your next fleet goes); patch notes entry `2026-11-v2` written for players (date to be set when it goes live). Checked in a headless browser with a mid-game galaxy (bots, stand-in battles): no page errors.

**(6) Preview sent 18 Nov 2026:** `dist/galaxy.html` (offline hot-seat game with every 2.0 rule) and two replay pages from the 10× test game (`node tools/replay-page.mjs --file <packed replay> <out> <title>`, new option): a typical 179-ship battle and the biggest, 3,796 ships (15 MB page). **Live 18 Nov 2026** (owner: "make it live"): `v2-dev` pushed to `main`; he starts the fresh game on `/admin`. Patch notes entry `2026-11-v2` dated 18 Nov 2026.

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
- **Point defence fires through its own and allied ships at missiles and fighters** (owner, 13 Nov
  2026: "that's needed"). Fighters always worked this way; at missiles an allied ship in the way
  used to soak the burst (`firePD`), now only an enemy ship does. Bench 1,000 vs 1,000: missiles shot
  down 33% → 40%, missile hits 64% → 57%. Bursts at ships still stop on what's in the way.
- AI (Nov 2026): missile launchers aim at the biggest ship in range (all launchers on a ship
  agree, so volleys still land together), and a ship whose only guns are missiles sets its
  stance distance from missile range (it used to fall back to 60 and dive in).
- **Plasma cannon** (block `BT.LANCE`, weapon kind `'lance'` in code; **was the heavy laser**
  until Nov 2026, when the owner asked for it to be a projectile "to make its destructiveness more
  obvious and cool"): 10×10 multi-block turret, range 650, every **17 s** (owner, 11 Nov 2026, was 20: "a bit weaker now"), a **5,000-damage budget**
  (owner, 11 Nov 2026, was 25,000: a colossus defence fell in ~20 s. Almost all of it is pieces
  cut off from the hub, not blocks burnt: 25,000 burnt ~5% and ~90% broke off. Measured with
  `/tmp`-style harnesses, generated plasma battleships vs the same ship with heavy armour in place
  of the plasma, 60,000 cr a side, 3 seeds, advantage 25k → 5k: vs titans +0.93 → +0.96,
  battleships +0.49 → +0.35, cruisers +0.10 → +0.13, destroyers ≈ 0 both; a generated 97k-block
  colossus defence vs 90k cr of plasma battleships: destroyed in ~20 s → 4–6 min (10,000: 1–1.5
  min). Replays sent of "Bastion", a frame-cored 51k-block fortress with plasma at its nose: it
  still falls in under a minute at 5,000 (frame 45 hp is cut ~100 deep, its own nose plasma cooks
  off, hub reachable): design decides. NB `battle.now` counts ticks (0.1 s), not seconds),
  1 block wide (**reload 10 s since 13 Nov 2026**, see "Fighter nerf, plasma buff"). Now a **big glowing blue bolt with a long trail** (`K_PLASMA`, replay shot kind 2,
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
- **Fighter nerf, plasma buff, 13 Nov 2026** (owner: "fighters are op… they bog down the enemy who
  eventually die"; he first chose 3 / 2 at 1 min / then 1 a minute, then before it went live
  changed to this). Where the numbers above disagree, these win:
  - Bays launch **3 at the start, then 1 every minute** (`waves: [3]`, `cooldown` 60 on
    `WEAPON[BT.BAY]`; was squadron 3 then 1 every 30 s). Sim: `w.sq` = fighters left in the current
    wave, `w.wv` = wave index (declared in `arcFields()`); entries after the first in `waves` size
    the next waves, then every wave is 1. The old schedule is `waves: [3, 1]`, `cooldown: 30`. Test in
    `tools/test-designer.mjs` checks the launch times.
  - **Lasers hit fighters 65%** of the time (`fighterHit` 0.3 → 0.65).
  - **Point defence 30 a burst** to everything (`damage`, `missileDamage`, `fighterDamage`; was 25).
  - **Plasma reload 10 s** (was 15).
  Measured against the live version (`/tmp/live` worktree of d454161): owner's-style mirror test (100
  32×16 cannon/laser/PD cruisers with one bay vs 108 with frame there, 6 seeds, 15-min limit, battles
  12–15 min): 0.00 (≈2,000 fighters a battle) → −0.14 (≈1,050; bays lose all 6). The 3 / 2 / 1-a-minute
  version alone gave −0.08. 4-bay 44×22 carriers vs the mixed fleet (120k cr, 6 seeds, ~4-min
  battles): −0.43 → −0.47 (heavy armour instead −0.51 → −0.54). Generated plasma battleships vs the
  same ship with heavy armour, vs the mixed fleet (60k, 4 seeds): −0.12 vs −0.37 → −0.06 vs −0.51.
  Bench 1,000 vs 1,000: 207 → 197 s, 5.3 → 5.0 ms a tick, missiles shot down 40% both.
- **Fighter bay tunnels with corners** (owner, Nov 2026, live since 10 Nov: "it just needs a path out of the ship"):
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
- **Weapon buff, 12 Nov 2026 (owner: "point defence, cannons and plasma cannons are not good
  enough")**: PD **25 damage a burst** (was 15; `damage`, `missileDamage` and `fighterDamage` all
  25), cannon shell **100** (was 75), plasma reload **15 s** (was 17), and **300 hp for laser,
  cannon, PD, missile and guided launcher blocks** (were 130 / 150 / 80 / 200 / 200; plasma and
  bays unchanged). Where the numbers above disagree, these win. Bench 1,000 vs 1,000: 244 s → 182 s,
  missiles shot down 27% → 33%, 4.7 → 6.4 ms a tick (same total work, shorter battles).
- **Flak cannon** (`BT.FLAK` = 13, weapon kind `'flak'`; owner, 14 Nov 2026: big ships had no answer to
  swarms of small ships; he turned down rule changes (plasma-first targeting, longer gun ranges, tougher
  armour) and asked for a new weapon): a **10×10 unit, 1,500 cr** (15 a block, the plasma cannon's size and
  price), **200 hp a block** (owner, 15 Nov 2026: 750 → 200 → 750 with the blow-up → "way too tanky", 200 again), **once `FLAK_POP.after` (25) of its 100 blocks are destroyed the whole unit blows up**
  (`flakPops` queue → `resolveCookoffs()`, `w.popped`; recExplosion size 3 plus a blast of radius 8, peak
  30, barely hurting the ship). The owner suggested 1 block: measured below, that lost big ships the fight. Range 700. **Every 10 s a salvo** (owner, 15 Nov 2026: "in line with plasma"; was 5 s)
  of `salvo` 5 shells, `salvoGap` 0.3 s apart, all at one ship** (owner, 14 Nov 2026: one shell was
  "underwhelming for the equal most powerful weapon"; `w.sq` = shells left in the salvo, `w.ft` = its
  target, declared in `arcFields()`), each landing within `scatter` 6 blocks of the aim point. Shells fly
  at 75 blocks/s (lead capped 4 s) with a **proximity fuse** (`K_FLAK` = 5): **a shell flies through every ship and wreck, friend or
  foe** (owner, 15 Nov 2026: "so it can get to the backlines and explode in empty space next to a ship";
  before that it burst on the first enemy hull) and bursts within `fuse` 6 of its target's live-block box
  (`boxGap()`, checked at 4 points per tick), or where it was aimed. **The shrapnel is real projectiles** (owner, 14 Nov 2026, third round: "still underwhelming";
  `K_FRAG` = 6, replay shot kind 6, `meta.shotSpeed[6]`): `flakBurst()` throws `fragments` 20 pieces (owner, 14 Nov 2026: was 30, "visually overpowering") at
  `fragSpeed` 90 (±15%), each flying up to `fragLife` 4 s until it meets something: **any** ship or wreck
  stops it (`sweep(..., -1)`), but only enemies take its `damage` 30 (60 until 15 Nov 2026) (allied hulls shield, owner's
  rule); enemy fighters on its path take it too. Directions are **uniformly random all round** (`cone` 0; owner: "more random", the
  earlier 0.6 of pieces in a forward cone ±`coneW` 0.7 rad looked lopsided). Drawn slimmer since then. **Shrapnel is queued in `this.fragQ` and added
  after the projectile loop** (`updateProjectiles()` → `moveProjectiles()`, then the queue): adding
  inside the loop could grow `this.P` while the loop held the old arrays, which ran away and used 6+ GB in
  the 3,758-ship Elenris battle. Viewer: `drawShrapnel()` (hot streaks, impact sparks, fade at the end of
  their life); `drawFlakBurst()` only draws its own streaks for older replays without shot kind 6.
  **Targeting** (`fireFlak()`, owner: "prioritising lightly armoured ships, a high weapon to armour and
  frame ratio"; "battles could have hundreds of these so you would want them not to target the same
  place"): every armed enemy ship in range, score = `e.light` (credits of guns per armour/heavy/frame
  block + 10, set in `refit()`) ÷ (1 + 1.5 × `e.flakIn`, flak shells already on their way to it) × random
  0.75–1.25; with no ship, the nearest enemy fighter. Replays: shot kind 5 (`meta.shotSpeed[5]`), explosion
  size 6; viewer `drawFlak()` (amber shell, muzzle flash) and `drawFlakBurst()` (flash, fireball, smoke, 16
  shrapnel streaks from a hash of the explosion index), shader type 13 (gunmetal battery, four barrels in
  an armoured ring, ammunition feeds, amber lights). Designer: key **K**, whole-unit stamp, `flakUnit()`,
  weapon table "40 × 60 / 5 s"; designer firepower counts the whole burst. Tests in `tools/test-designer.mjs`.
  Tuned on the owner's Draisgon Major replay (Nate's 16 "Dreadnought Mk.2", 438k, vs Cupcake's 226k swarm
  with 23 plasma destroyers), rebuilt from the replay, 3–4 seeds: today 1–7 dreadnoughts survive (56–94%
  of Nate lost). Nate's plasma → flak, Cupcake keeps plasma: first version (40 dmg, all-round, stopped by
  wrecks) 2–5; through wrecks + cone 0.6 + 60 dmg **11–13** (19–31% lost). Even money (8 dreadnoughts) Cupcake
  still wins (0–1 left, 16–25% of his lost). Both sides' plasma → flak (the owner's test) 15/16. Elenris
  Minor (3,758 ships) with every plasma → flak: 147 s compute vs 148 s. Bench 1,000 vs 1,000 identical.
  **With 5-shell salvos** (current): Nate-only flak 14–15 of 16 left (6–13% lost, battles ~85 s); even money
  (8 dreadnoughts) Nate wins 3 of 4 (5–6 of 8 left) and the 4th is mutual destruction (Cupcake 91% lost);
  both sides flak 15–16. Elenris with every plasma → flak 129 s compute (plasma 148 s). The owner was told
  even-money flak dreadnoughts now beat the plasma swarm; levers: `salvo`, `damage`, `cooldown`.
  **With real shrapnel** (current, 3 seeds each): Nate-only flak 15–16 of 16 left (0–6% lost), the swarm
  breaks in ~50 s; even money (8 dreadnoughts) Nate wins all 3 (5, 7, 8 of 8 left; Cupcake 82–84% lost);
  both sides flak 16/16. Elenris with every plasma (472 units) → flak: 95 s compute, ~650 MB like the
  plasma version (143 s), 20.5 MB replay (plasma 25.5 MB). Bench 1,000 vs 1,000 identical.
  **20 random pieces** (current), on the real Draisgon replay b29415 (388 Cupcake ships vs 16
  dreadnoughts), 3 seeds: as fought with plasma Nate keeps 2–7 (battles ~4 min); Nate's plasma → flak:
  14–15 of 16 left, Cupcake routs in 65–72 s with 95–106 ships left.
  **Pass-through shells + 200 hp** (current), owner's Zephorka replay b3751 (3 sides: Cupcake 824 +
  ally flamesoldier 130 vs Nate 158 incl. 18 "My titan" with 3 plasma each), 3 seeds: as fought Nate keeps
  8–10 and loses; Nate's plasma → flak (54 units): Nate wins all 3 (39–53 of 158 left; Cupcake 39–50 of
  824, flamesoldier 4–6 of 130), 140–153 s. Bench 1,000 vs 1,000 identical.
  **Reload 10 s** (current): Zephorka, Nate flak, 3 seeds: Cupcake still routs, but narrowly (Nate 11–18
  of 158 left, Cupcake 27–53, flamesoldier 4–6; 284–322 s). Owner's spam test: 10 flak "My titan"
  (14,527 cr, standoff) vs 76 "flak boats" (hub + flak unit + 19 thrusters, 1,920 cr), 4 seeds: boats on
  Front line or Charge lose every time (titans keep 7–10); boats on Artillery win 2 of 4 (titans keep
  2, 8, 6, 1): at 420 out they're beyond the titans' cannons and lasers, so it's flak against 2.5× the
  flak.
  **Unit blows up after N lost blocks, 750 hp** (spam test, 6 seeds per stance, titan wins; Zephorka 3 seeds,
  Nate wins): N = 1 (owner's idea): line 1/6, artillery 0/6, charge 1/6, Zephorka 1/3 (titans lose all 30
  flak units within 60 s, then their other guns); N = 10: line 5/6, artillery 0/6; **N = 25 (chosen
  pending the owner): line 6/6, artillery 6/6, charge 6/6, Zephorka 3/3** (Nate 10–24 of 158 left);
  never (old half-intact rule only, 750 hp): 18/18 and Zephorka 3/3. Owner: "way too tanky".
  **200 hp, blow-up at 25, shrapnel weaker against plating** (`WEAPON[BT.FLAK].vs`, `FRAG_VS` in battle.js:
  share of damage to frame / armour / heavy; tried 0.75 / 0.5 / 0.3, **now back to 1 / 1 / 1**). Same tests (spam line / artillery /
  charge wins of 6; Zephorka Nate wins of 3): full damage 5 / 0 / 5, Zephorka 3/3 (7–15 of 158 left);
  0.75/0.5/0.3: 6 / 0 / 5, Zephorka 1 win, 1 loss, 1 both wiped out (7–15 min battles); 0.5/0.35/0.2: 6 / 0 /
  6, Zephorka 0/3 (Cupcake keeps 141–209 of 824; with plasma 439–499). Artillery flak boats always win at
  200 hp: from 420 out only flak and missiles reach, and their 76 flak strip the titans' 70 surface guns
  each (679 → 372 in 15 s) while the titans' frame survives.
- **Shield generator** (`BT.SHIELD` = 14; owner, 15 Nov 2026: "shields keep ships alive, ships then get to
  fire for longer, making big ships good again"; to go with flak, which still lost to pure flak boats on
  Artillery): a **10×10 unit, 1,500 cr** (plasma's price), **45 hp a block**, not a weapon (`e.gens`, not in
  `e.weapons`; `analyzeDesign` returns `shield`, `shieldRegen`, `gens`). Each working generator adds
  `SHIELD.capacity` **5,000** (owner: "enough to block a single plasma hit") to the ship's pool
  (`e.shield`/`e.shieldMax`), refilled at `SHIELD.regen` **100/s** each, all the time (owner wanted it
  to regenerate so players defend generators; 100 is my pick, see below). **Every hit on the ship drains
  the pool first** (`shieldAbsorb()` in `damageCell()`, and in the laser and plasma budget loops so a
  shield soaks the beam or bolt); damage it can't take goes through. Own cook-offs and blasts too.
  **Flak shrapnel drains shields at `WEAPON[BT.FLAK].shieldMult` 0.3.** **If any generator block dies the
  whole unit explodes** (`flakPops` queue → `resolvePops()` → `popShield()`; `killCells()` so the ship's
  own remaining shield doesn't stop it; explosion size 7; blast `SHIELD.radius` 20 / peak `damage` 200
  from its centre, anyone; less than plasma's per-block cook-off) and its share of pool and regen is
  gone. A blast kills 45 hp blocks out to ~10.5 from the centre, so generators within ~6 blocks of each
  other chain (designer warns), and one near the hub can break the ship (the 3-generator titan test
  below put one by the hub and did worse than 2). A generator cut off from the ship is lost quietly
  (`refit`). `resolveCookoffs()` now runs pops, then plasma cook-offs, then pops again. Replays: `shT/shEnt/shV`
  (shield fraction ×255 when it moves ≥ 4 steps, ≥ 0.3 s apart, or hits 0/full); viewer `shieldAt()` in
  `model.js`, `drawShield()` (glow shape 5: bubble with bright rim, brighter when struck, a popping ring when
  it collapses; drawn at every zoom), shader type 14 (teal emitter dish in a ring of 8 coils). Designer:
  key **E**, `shieldUnit()`, Shield stat row. Tests in `tools/test-designer.mjs`.
  Measured (spam test as for flak: 10 "My titan" with flak vs equal-cost flak boats, 6 seeds, titan wins;
  2 generators at columns 8 and 54, rows 10–19, replacing frame, so titans cost 17,527 and face 90 boats):
  no shields line 5 / artillery 0 / charge 5; **2 gens, regen 50: 6 / 3 / 6; regen 100: 6 / 5 / 6**; regen
  200: 6 / 6 / 6; 3 gens (one by the hub, 98 boats), regen 50: 6 / 1 / 6. Zephorka (Nate flak + 2 gens on
  each titan, regen 100, 3 seeds): Nate wins 3/3 (11–17 of 158 left; without shields also 3/3). Flak
  shrapnel back to full damage against plating (`vs` all 1, owner: "he wins at Zephorka with the full
  damage"). Bench 1,000 vs 1,000 identical.
- **Flak and shield fixes, 15 Nov 2026 (owner)**. Where the numbers above disagree, these win:
  - **Shrapnel 30 a piece** (`WEAPON[BT.FLAK].damage`, was 60).
  - **Flak never bursts inside a hull**: shells fly through ships and wrecks, so ~3% of bursts went off
    inside a wreck, an ally or another enemy (never the target: the fuse stops that) and all 20 pieces
    hit one spot. At burst, if the point is on a live block (`blockAt()`), `flakOpen()` moves it along
    the shell's path to the nearest open space (back first, never behind the gun; ahead never inside the
    target's box), and the shot's flight time follows. Harness (300 v 300 generated, team 0 plasma →
    flak, team 1 plasma → shields, 4× the big ships, 2 seeds): 74/2,050 and 55/2,319 inside → 0. Test in
    `tools/test-designer.mjs` (3 of 15 inside without the fix).
  - **Blasts drain shields by what they'd really do**: `blast()` and `splash()` pass
    `min(damage, block hp)` to `damageCell` (identical for unshielded hulls). Before, overkill on weak
    blocks counted in full (and plasma cook-offs' `LANCE_COOK_SCALE` 6.25× on plasma blocks): a missile on
    a frame-cored test ship drained 6,349, now 4,797, exactly what it destroys unshielded. A generator
    going off still empties the pool, but a generator only dies once the pool is already ~0.
  - **Cut-off generators are recorded** (`recShield(e, true)` in `refit`): with no generator left nothing
    recorded the shield, so the replay bubble stayed up.
  - **Viewer: the bubble is a rounded box round the live blocks** (`liveBox()` in `model.js`, cached 0.3 s;
    `drawShield()`; glow shape `5 + corner radius / 1000`, fragment shader gets `vSize` and draws a
    rounded-rect distance field with a rim of even width, `fwidth` for anti-aliasing). The old ellipse
    round the design grid cut through the corners of big square ships (corner at 1.14× its radius),
    gave long thin ships huge glowing ends, and stayed full size round lost hull.
  - Designer flak tooltip rewritten from the live numbers (pieces per block kind, shield share, never
    bursts inside a hull, `FLAK_POP` numbers).
- **Shield refilling stacks less, 15 Nov 2026 (owner: "20 shield generators on an Aegis citadel makes it
  basically unkillable"; his rule: each extra generator adds 80% of the one before)**. `shieldRegen(n)` in
  `blocks.js` = `SHIELD.regen × (1 − stack^n) / (1 − stack)`, `SHIELD.stack` 0.8: 100, 180, 244, 295, …, never
  above 500/s. Capacity still 5,000 each, in full. Used by `refit`/`popShield`/start in the sim and by
  `analyzeDesign` (test checks they agree). Not a bug: a shield is all-or-nothing, so once total refill beat
  the attackers' damage per second nothing ever got through. Measured (`/tmp`-style harness: generators
  added inside an Aegis fortress, buried, ≥ 14 apart, ≥ 30 from the hub; designer-test layout vs an
  equal-value mixed fleet, 15-min limit, 2 seeds): Citadel III with 80 generators, old rule: shield never
  went down, 0% hull lost (the fleet did ~10,000/s, refill was 8,000/s); new rule: shield down at 48 s, 39–43%
  hull lost, still routs them. III with 40: old 12–29% hull lost, new 39–57%; III with 20: old 31–98%, new
  34–100%; II with 20 is destroyed either way (as with none). Tried too: n^0.75 (80 gens: 10–30% lost) and 90%
  per generator (cap 1,000/s; 48–98%). Ships with 2 generators: 200 → 180/s.
- **Shield pool and refill both taper, 21 Nov 2026 (owner: "balance recharge rates of shields to be cost effective and
  balanced from 1 to 100+ shields on one ship"; chose option B: "start with a bigger shield amount and recharge and each
  additional shield adds less")**, live 21 Nov 2026. Where the shield lines above disagree, this wins:
  `shieldCap(n)` = `SHIELD.capacity` 7,500 × n^`capExp` 0.65 and `shieldRegen(n)` = `SHIELD.regen` 150 × n^`regenExp`
  0.6 (both rounded; `SHIELD.stack` is gone): pool 7,500 / 11,769 / 33,501 (10) / 149,645 (100) / ~235k (200), refill
  150 / 227 / 597 / 2,377 / 3,603 a second. The sim counts working generators (`shieldLost()` in `battle.js`, used by
  `refit` and `popShield`) instead of dividing the pool by 5,000. Finding first shown to the owner: under the old rule
  (5,000 each in full, refill capped at 500/s) **big stacks were the best value, not the worst**: the full-stacking pool
  made a leviathan with 25, a colossus with 60–100 or an Aegis with 200 lose nothing to an equal-value fleet, whatever
  the refill, while 1–2 generators on a battleship/titan barely helped (focus fire drains 5,000 in ~15 s). Measured
  (`/tmp`-style `sh.mjs`: n generators buried in generated battleship/titan/dreadnought/leviathan/colossus (`makeDesign(cls,
  11)`, 6/4/3/2/1 copies) and Aegis I (as a defence), ≥ 14 apart, vs `makeTestScenario`'s equal-value mixed fleet, 15-min
  limit, 4 seeds; score gain over the same ship with no generators, enemy paid for them): old → new: battleship 1 gen +0.12
  → +0.51, titan 2 −0.06 → −0.04, dreadnought 4 +0.27 → +0.36, dreadnought 7 +0.38 → +0.58, leviathan 10 +0.52 → +0.35,
  leviathan 18 +0.55 → +0.55, leviathan 25 +1.27 (untouchable) → +1.12 (12% lost), colossus 30 +0.68 → +0.94, colossus 60
  +0.94 (untouchable) → +0.65, colossus 100 +0.93 (untouchable) → +0.40, Aegis 100 +1.03 → +0.18, Aegis 200 +1.62
  (untouchable) → +0.65. Also tried (pool, refill): linear refill and n^0.85/0.75/0.65/0.5 refill alone (stronger big
  stacks), both n^0.7 or n^0.75, 5,000·n^0.8 + 100·n^0.65, 7,500·n^0.7 + 150·n^0.6 (colossus 60/100 still untouchable),
  10,000·n^0.65 + 200·n^0.55 (battleship +0.90, too strong), 7,500·n^0.6 + 150·n^0.55. Single battles swing a lot
  (outcomes are near all-or-nothing), so ±0.3 is noise. Bench 1,000 vs 1,000 identical (no shields). Designer tooltip
  lists 1/2/10/100. Tests in `tools/test-designer.mjs`. Replay sent: "New shields: colossus with 60 generators". **Live 21 Nov 2026.**
- **Shields restart at 25%, 21 Nov 2026 (owner: "it looks a little weird with the shield continually popping on and
  off what if it needs to regen 25% of the shield pool before it reactivates")**: a hit that empties the pool sets
  `e.shDown` (`shieldAbsorb`); while down the refill goes into `e.shCharge` and the shield stays 0 (absorbs nothing, the
  replay keeps the bubble off), until `SHIELD.restart` (0.25) × `shieldMax`, then it comes back with that much. Entity
  fields declared in `makeEntity`. Same colossus-60 battle: shield off/on 306 → 3 times. Measured (same harness, 4 seeds,
  gain vs no generators, before → after): battleship 1 +0.51 → +0.46, titan 2 −0.04 → +0.11, dreadnought 7 +0.58 → +0.26,
  leviathan 10 +0.35 → +0.38, leviathan 25 +1.12 → +1.13, colossus 60 +0.65 → +0.95 and 100 +0.40 → +0.94 (untouchable in
  all 4 again: it sits on the edge, earlier runs were split), Aegis 100 +0.18 → +0.11, Aegis 200 +0.65 → +0.26. Designer
  tooltip says it. Test in `tools/test-designer.mjs`. **Live 21 Nov 2026 together with the taper below** (owner: "if your
  happy with it make it live"; no patch notes).
- **No bubble while a shield is down (owner, 22 Nov 2026: "make it so the shield disappears when it's not active")**:
  `shieldAt()` in `model.js` smoothed between records, so from the 0 record to the 25% one it drew the bubble
  growing back in while the shield was really off. It no longer interpolates up from 0 (popping ring, then
  nothing, then the bubble at 25%). Viewer only, so old replays get it too. Test in `tools/test-designer.mjs`
  (fails with the old line). **Live 22 Nov 2026**, no patch notes.
- **Shield bubbles hug the hull; shrapnel drawn right; big ships keep their shape zoomed out (15 Nov 2026,
  owner)**:
  - **Bubble = distance map** (replaces the rounded box below): `ReplayModel.shieldMap(e, t)` builds a grid
    over the live blocks plus a margin (cells `s` blocks wide, ≤ ~160 a side), each cell's Euclidean
    distance to the nearest live block (two dead-reckoning sweeps), as bytes over 0..`maxD`; rebuilt only
    when the live-block count changes, checked every 0.3 s of replay time. Margin `m` = min(12, 3 + 5% of
    the shorter half side). Renderer: its own program (`SVS`/`SFS`), one quad per shielded ship drawn
    after the glow pass (`drawShieldPass`), an R8 texture per ship (`shTex`, freed when the model changes);
    the edge is where distance = `m` (× growth for the popping ring), rim of even width, `fwidth` AA. Holes
    in hollow fortresses get their own inner rim. The old glow shape 5 and `liveBox` are gone.
  - **Shrapnel speed is in the replay** (`shotSpd`, Uint8 per shot: speed × 200 / `shotSpeed`, 0 =
    nominal). The sim picks each piece's speed in 0.5% steps (170–230 → 85–115%) so it's exact. The viewer
    drew every piece at the nominal 90, so a slow piece that hit was drawn up to 50 blocks past the hull
    (mean 6.3 blocks off); now mean 0.24, worst 0.65 (test in `tools/test-designer.mjs`). In the sim
    shrapnel really did stop (153 of ~850k piece-ticks ended inside a block). Old replays keep the error.
  - **Fewer pieces measured, not changed**: 324 flak units both sides (600 v 600 generated ×6 big ships),
    20 pieces × 30 vs 7 × 90: 12.1 → 11.4 s compute (−6%), 5.6 → 4.8 MB replay, peak projectiles 9.4k →
    5.1k; 300 v 300: no measurable compute change. Owner told it isn't worth the gameplay change.
  - **Fleet view draws big ships' blocks**: past ~60 px across on screen a ship isn't drawn as one quad
    (Aegis was a plain box); blocks at least ~1 px (`bs`). **Replaced 21 Nov 2026** (owner: "when I zoom
    out the ships are replaced with coloured squares, this looks ugly"; **live 21 Nov 2026**, no patch notes): in fleet
    view (zoom < 0.9 px a block) every ship and wreck is its own shape shrunk down. `lodCells(e, k)` in
    `renderer.js` merges its blocks into k × k cells (k = 2^floor(log2(px per block)), so a cell is under
    ~1 px, drawn at least 1.2 px so they join up), each at the mean of its blocks and alive until its last
    block dies (pure function of time; cached per entity and k); `lodColours()` = average of the blocks'
    palette colours mixed 45% toward the side's colour (wrecks: none). Quads drawn ≈ screen pixels the
    ships cover, whatever the battle size. No sim, replay or server change.
- **Flak rework: bursts, no shell, no shrapnel (live 21 Nov 2026; owner, 21 Nov 2026: "fire once every 2-3 seconds and at random
  space between heavy concentrations of enemy ships with no primary projectile just fire then flak burst… random
  bursts going throughout the battlefield for looks and for practical purposes its meant to take out large
  quantities of weak back line (thrusters and a weapon) ships that just don't die because other weapons can't reach
  them"; and earlier "you can't really see the flak projectiles only the explosions")**, on `v2-dev`, not live. Where
  the flak lines above disagree, this wins. `WEAPON[BT.FLAK]`: range 700, `cooldown` 2.5 (×0.8–1.2), `damage` **40**
  peak, `radius` 16, `scatter` 4, `shieldMult` 0.3 (`fragSpeed` kept only for old replays' `meta.shotSpeed[6]`).
  `fireFlak()`: looks at up to `FLAK_PICKS` (16) random armed enemy ships in range it bears on, score = (`light` +
  0.05) × (1 + `crowd`) × random 0.6–1.4, ×0.4 if a burst went for it in the last `FLAK_RECENT` (30) ticks
  (`e.flakIn` is now that tick); `countCrowd()` (cached `FLAK_CROWD_EVERY` 10 ticks; entity fields `crowd`,
  `crowdT`, `crowdN`) counts its side's ships within `FLAK_CROWD_R` (40) of its hull and its nearest one. The burst
  lands at a random 30–70% point between it and that neighbour (alone: just off its hull toward the gun), moved out
  of any hull (6 random tries, then toward the gun). Records explosion **10** (muzzle flash at the gun) and **6**
  (the burst). `flakBurst(x, y, team, owner, W)`: an area blast, every enemy block within `radius` takes `damage` ×
  (1 − d/R) × `FRAG_VS` (min block hp, so shields soak what it does), enemy fighters too; friends never, wrecks yes.
  `flakBurstValue(W)` (blocks.js, damage × radius × 0.7 ≈ measured 460 a burst) is flak's firepower for `e.face`
  and the designer. K_FLAK shells / K_FRAG code paths stay only so nothing breaks; no new replay has shot kinds 5/6.
  Viewer: `drawFlakBurst` (new replays: flash, shockwave ring to ~R (glow shape **5**), fireball, 14 streaks,
  embers, smoke 4 s, `FLAK_LIFE` 40), size 10 flash; replays with shot kind 6 keep the old look (`_hasFrag` =
  `m.frag.n > 0`); size 9 (hull spark, `drawFlakHit`) is only in never-live v2-dev replays.
  Why a blast: with instant shrapnel rays (an intermediate version) 98% of bursts went to the right ships but 58% of
  pieces hit nothing and each 325-cr back-line boat took ~1,400 damage to kill; recording a spark per hit was 780k
  records, nearly what the shrapnel shots had cost. Measured (`/tmp`-style `backline.mjs`: 6 flak battleships + 47
  destroyers vs 38 destroyers + 222 back-line missile boats (hub, 6 thrusters, 2 launchers, frame, artillery), 120k
  cr a side, 3 seeds): live flak 50–115 boats killed, flak side loses; instant shrapnel ~85; blast peak 80: ~165,
  peak 60: ~157, **peak 40: ~150 killed (half gone at 82–100 s), flak side wins keeping 4–5 of 6 battleships**,
  peak 30: ~130. Same flak side vs 19 generated battleships (equal value): flak doing no damage 10 left (= live
  flak: the old flak did almost nothing to them), peak 40 3–7 left. 4 × 1,000 generated with 40% new-block
  ships, 5-min limit, live → now: raw replay 71 → 52 MB, gzip 24 → 17 MB, compute 71 → 68 s. Compute is ships, not
  flak (cpu profile: step 14%, grid build 12%, collide 8%, sweep 7%, refit 6%, fire 5%; flak not in the top 18).
  Bench 1,000 vs 1,000 identical. Tests in `tools/test-designer.mjs` (lightly armoured target, every 2–3 s, never
  inside a hull, no shot kinds 5/6, a flash per burst, a crowd of four beats a loner and the bursts land among them,
  allies untouched, spread over 4 targets). Replay sent: "Flak vs back-line swarm".
- **Flak, second round (owner, 21 Nov 2026: "change the flak explosion to not have a shockwave… change the fire rate
  to be every 1 second… the damage on the enemy ships from each explosion seemed to be a perfect amount… if a ship had
  an outside layer of heavy armor I would want that to protect the blocks inside… still much less damage to
  shields")**, on `v2-dev`, not live. Where the flak lines above disagree, these win: `cooldown` **1** (×0.8–1.2); no
  shockwave ring in `drawFlakBurst` (glow shape 5 is left in the shader, unused); **armour shields what's behind it**:
  `flakReach(e, gx, gy, i, j, d)` walks the line from the block back to the burst every half block and multiplies
  by `FLAK_SHADE` for each live block crossed (heavy armour 0, armour 0.5, anything else 1). Hiding behind *any* block
  was tried first: damage per burst 470 → 147 and back-line boats killed fell to ~60 even at 1 s (frame skins shielded
  everything). Shields still take 30% (`shieldMult`). Measured: damage per burst ~435 (was 470, the amount the owner
  liked); backline test ~178 of 222 boats killed, half gone at ~40 s, flak side keeps 6/6 battleships; vs 19 generated
  battleships 2–9 left; a 24×12 frame-filled hull hit by 300 bursts just off it, damage reaching the inside per burst:
  frame skin 1,581, armour skin 641, **heavy armour skin 38**. Generated battleships' surfaces are half armour already
  and half exposed guns/thrusters/plasma, so a skin can't cover those. 4 × 1,000 mixed, 5 min: 49 s compute (live 71),
  50 MB raw / 17 MB gzip. Test in `tools/test-designer.mjs` (heavy skin takes the burst, nothing inside touched; bursts
  about every second). Replay sent: "Flak every second".
- **Flak, third round (owner, 21 Nov 2026: "explosions then shrapnel that we cant see hits ships… does 40 damage to the
  first block in its explosion radius so all blocks block all damage but no damage drop-off… less damage to shields
  but if a shielded ship is hit heaps of times… may have to reduce it to 10%")**, on `v2-dev`, not live. Where the
  flak lines above disagree, these win: `flakBurst` gives **a flat `damage` (40) to every enemy block within `radius`
  (16) that the burst can see**: `flakHidden(e, gx, gy, i, j, d)` (half-block steps from the block back to the burst)
  skips any block with **any** live block of that ship between it and the burst; no drop-off; fighters in the radius
  take 40 flat. `FLAK_SHADE`/`flakReach` are gone. **`shieldMult` 0.1** (was 0.3). `flakBurstValue` = damage × radius
  × 0.5 (≈ measured 320 a burst). Measured: backline test ~173 of 222 boats killed (half gone at ~56 s), flak side
  keeps 6/6 battleships; vs 19 generated battleships 2–3 left; repeated bursts 4 blocks off one side of a 24×12 hull,
  first damage inside after 2 bursts (frame skin), 3 (armour, 110 hp), 10 (heavy armour, 240 hp); shield drain per
  burst on a one-generator ship (5,000, refills 100/s) 121 at 30% → **40 at 10%**: at 30% 4 flak guns broke it in 13 s,
  at 10% 1–3 guns never do, 4 take 82 s, 10 take 16 s. Bench identical. Tests unchanged (the heavy-skin test still
  holds: skin takes the burst, nothing inside touched). Replay sent: "Flak: 40 to every block it can see".
- **Flak firing animation, and the whole flak rework live 21 Nov 2026** (owner: "there is no projectile for the flak
  weapons it doesn't look like they're firing… give them a better firing animation and then make it live"; no patch
  notes, as asked). Viewer only: `drawFlakFire()` for explosion size 10 (recorded at the gun right before its burst,
  size 6, same tick; it looks ahead up to 40 records at that tick for the size 6 to aim at): glow at the gun, a
  white-hot flash 6 blocks out toward the burst (the barrels' end), a cone of 5 fire jets (middle 12 blocks), 8 sparks
  flung ahead, a smoke puff drifting forward; ~1 s. All three flak rounds above went live with it.
- **Turning turrets, a new flak firing look, red cannon muzzles (owner, 22 Nov 2026: "big weapons (flak and plasma)
  sometimes look all jumbled up… shots come from very different places than the turrets are pointing. The animation when
  a flak is firing looks cheap. Cannon turrets sometimes don't have red on the end of their barrel and blend into the
  ship")**, on `v2-dev`, not live. Viewer only (no sim, replay or server change; old replays get it too):
  - **Flak and plasma turrets turn to aim.** `ReplayModel.matchAims()` (model.js) finds which turret fired each shot: a
    plasma bolt (shot kind 2) starts at its gun's centre and a flak muzzle record (explosion 10) is at its gun's centre
    with its burst (6) in the same tick, so each is matched to the turret whose centre is there then (per 20-tick window
    every turret goes into a 24-block grid as a circle covering its path; tolerance 2.5 + 2% of its distance from the
    ship's centre). **Live 22 Nov 2026** (owner: "make it all live"; no patch notes). `unitPos()` also fills `d._guns` (`{ type, lx, ly, rest }`, rest = the old out-of-the-hull direction)
    and `d._gunOf`; entities get `e.gun` (turret per block) and `e.aims[g] = { t, a }` (ship-local). `aimAt(e, g, t)`:
    pure function of time; turns onto the next shot just before it (`AIM_RATE` 0.25 rad/tick, or faster if shots come
    quicker), holds, back to rest after `AIM_IDLE` 40 ticks (`AIM_RETURN` 15). Wrecks keep the aim they had when they
    broke off. Measured: every shot matched (751/751, 10,587/10,587, 30,478/30,478); load +~0.2 s for a 3,200-ship battle
    with 2,800 turrets (1.0 → 1.2 s in Node), ~1 µs per turret per second of battle, so a 20,000-ship flak-heavy giant
    would add a few seconds.
  - Shader: detailed blocks (shape > 9.5) are always 0.5 a side, so the VS uses 0.5 and the size slot carries the
    turret's aim (`vSize.x`) and ticks since it fired (`vSize.y`), both `highp`. Flak: the barrels and mantlet turn, the
    four barrels fire in a ripple (barrel order 1, 3, 0, 2, 0.7 ticks apart, `FLAK_RIPPLE` in renderer.js), each kicks
    back 0.6 blocks and glows hot for 1 s. Plasma: the coiled barrel turns and kicks back; the muzzle flash is at the
    barrel's end (4.6 blocks out), the charge glow still on the orb.
  - **Flak firing, second look** (`drawFlakFire`): per barrel, from its own muzzle: white-hot flash, a short tongue of
    flame, two side jets from the muzzle brake, a glow, two smoke puffs drifting on (~2 s); a spent casing tumbles out
    of each side. The big glow over the whole turret and the fan of five jets are gone.
  - **Cannons**: the outline drawn along open edges was painting over glows, and guns point out of the hull, so the
    cannon's red ember sat right under it and vanished (it only showed on cannons pointing at a neighbour). Glows now go
    on after the outline (every block type), and the cannon has a bigger red-hot bore, a red rim on the muzzle brake's
    end and a soft red halo, shown from 60% strength even before full detail zoom.
  - The fragment shader declares `precision highp int` and `highp uTime`: shape codes reach ~1.25 M, past mediump
    ints' guaranteed 2^15, and on GPUs that really use 16-bit mediump (some phones) 10×10 units not pointing at the nose
    would decode as garbage. Not seen on a computer; a possible cause of "jumbled" big weapons on a phone.
  - Test in `tools/test-designer.mjs` (every flak and plasma shot traced to its turret, the turret points along each
    shot as it fires and rests before the first). Replay sent: "Turning turrets".
  - **Plasma barrel redrawn (owner, same day: "make the plasma barrel look a bit more professional, currently it's just
    a few white blocks")**: gunmetal whatever the side's colour (`col` mixed to grey on the barrel parts): a bevelled
    breech block at the orb's collar with a seam and two blue status lamps, a tapering accelerator of two shaded
    half-cylinder rails wound with raised coil bands (blue seams between them) round an open dark channel with blue
    energy pulsing out along it, a muzzle collar and two tapering focusing prongs with the glow between them. It
    **charges up**: for the 0.6 s before a shot `vSize.y` is minus the ticks left (`aimAt` now also gives `out.next`;
    plasma only, so flak's ripple is untouched) and the channel brightens, and it stays bright ~1 s after firing.
    Replay sent: "Plasma barrel".
- **Flak bursts walk to the hull, radius 20 (owner, 22 Nov 2026: "flak shots doing nothing… the ships were out of the
  range of the flak explosions… increase the damage range… really big ships might break flak?")**, **live 22 Nov 2026**
  with the turning turrets and plasma barrel (owner: "make it all live"; no patch notes). Where the flak lines above
  disagree, this wins. He was right: the burst was put a share of the target's size from its centre (alone: `radius ×
  0.8 + fuse` toward the gun; crowded: 30–70% between two ships' centres), so next to big, long or far-apart ships it
  went off in empty space. Measured (8 gunships with 2 flak + 2 plasma vs equal-value fleets, 2 seeds; bursts that hurt
  nothing): mixed 3%, battleships 17%, titans 37%, frigates 2%. Now `fireFlak()` takes that spot only as a start,
  walks from it a block at a time toward a random live block of the target (`aimPoint`; from at most 400 blocks out) and
  bursts `FLAK_STAND` 2–6 blocks short of the first hull it meets (any hull; inside-a-hull handling unchanged). Empty
  bursts → 0% for all four, 1% (10 of 854) against a generated colossus; fireFlak ~0.3 ms a burst there. **`radius` 16 →
  20**: damage per burst 435 / 437 / 430 / 444 (old) → 480 / 638 / 551 / 418 (mixed / battleships / titans / frigates).
  At radius 16 with the walk small-ship damage fell to ~370 (crowd bursts used to land between two small ships).
  Designer tooltip: "a few blocks off an enemy hull". Test in `tools/test-designer.mjs` (flak vs titans and
  dreadnoughts: < 5% empty; old code 15 of 59). Bench identical. Replay sent: "Flak bursts next to the hull".
- **Flak range 900, fighter bays 45 hp (owner, 22 Nov 2026**, after asking whether flak goes for "hundreds" of back-line
  boats made of thrusters + a bay or plasma: "900 range would be fine it's meant to be a long range weapon… fighter
  bays can have their health nerfed as that should be built inside ships… 45 health per block same as frame… make a
  note for players in its tooltip that it's very fragile. Plasma is already weak so I'll leave that"), **live 22 Nov
  2026**, no patch notes. `WEAPON[BT.FLAK].range` 700 → **900** (flak ships on Artillery now stand at 540, 60% of
  it); `BLOCKS[BT.BAY].hp` 150 → **45**; designer bay tooltips start "VERY FRAGILE… build it deep inside the ship".
  Targeting was already right: `e.light` (gun credits ÷ (armour/heavy/frame blocks + 10)) makes an unarmoured boat
  score far above any warship, × crowd. Measured (`/tmp`-style `boats.mjs`: 6 of my 56×40 gunships (2 flak, 2 plasma)
  + 30 destroyers, ~93k cr, vs 20 destroyers in front + 75 bay boats (hub, 2 thruster columns, frame, bay; 510 cr) +
  25 plasma boats (1,949 cr) on Artillery behind, ~110k cr, 3 seeds): ~80% of the enemy ships flak hurt were boats;
  ~30% of bursts went at fighters (flak's fallback when no ship is in range). Boats killed, before → now: bay 19 → 42
  of 75, plasma 10 → 16 of 25; same gunships with flak swapped for heavy armour: bay 11 → 12, plasma 9 → 10. The boat
  side still won every run of that (my gunship is a rough design). Bench identical.
- **Replay downloads are a playable web page (owner, 22 Nov 2026: "when players download a replay for it to be a
  standalone playable in a browser file")**, **live 22 Nov 2026**. The combat log's Download now saves
  `battle-<world>-<id>.html` instead of `.lsbreplay`: `src/galaxy/replayFile.js` `replayPageParts(viewerDoc, meta)` gives
  the page before and after the replay (built in the browser as `Blob([head, base64, tail])`, base64 via FileReader
  data URL, so no giant JS string). The page holds `<script id="lsb-meta" type="application/json">` (id, title, sides,
  teams, computeMs, planet, t, log text, sideColors), `<script id="lsb-viewer">` (the viewer page, JSON, `<` escaped)
  and `<script id="lsb-replay" type="text/plain">` (the packed replay gzipped, base64; to read one for a bug report:
  take that text, base64-decode, gunzip, `unpackReplay()`). It loads the viewer into an iframe from a blob URL and posts
  `lsb-replay` like the game page; errors show in the page. Checked: a page built from a test battle opens from
  `file://` in headless Chrome with the right title (one containing `</script>`), side names and colours and no
  errors; the browser's gzip + base64 + fetch(data:) round trip is byte-identical. ~340 KB for a small battle (viewer
  ~170 KB + the replay gzip × 1.33).
- **Cannon rework and auto gun (owner, 20 Nov 2026: "more like a cannon and less like a machine gun")**. Where
  the numbers above disagree, these win:
  - **Cannon**: one explosive shell every **10 s** doing **500** (was 100 every 2 s; same damage per second).
    `budget: true` on `WEAPON[BT.CANNON]`: `budgetBlast()` in `battle.js` spends the 500 on the hit ship's
    live blocks nearest the impact first (out to `splash` 8 blocks), each taking what it has left: 2 heavy
    armour (240) or 11 frame (45), as the owner put it. Shields soak it like any hit. Explosion size **8**
    (viewer `LIFE/BASE/GROW[8]`, between a shell hit and a missile blast). Price unchanged (120).
  - **Auto gun** (`BT.AUTO` = 15, the last type the viewer's shape code can hold; the rift engine, 16, is drawn as type 0): a **2×2 unit**, **250 cr**
    (62.5 a block), **300 hp a block**, keeps firing while 2 of 4 survive (`MULTIBLOCK`), range **150**,
    **55** damage every **0.3 s**, bullets at **150 blocks/s**, `spread` 0.07 rad, **life 3 s** (not 30: at
    3+ shots a second long-lived misses would swamp battles). `kind: 'shell', auto: true` → projectile kind
    `K_AUTO` (7), replay shot kind **7** (`meta.shotSpeed[7]`); a bullet damages only the block it hits
    (`damageCell(hitE, hitCell)`; a 0.6 splash radius missed the block on ~70% of hits, found by measuring);
    no explosion is recorded per bullet: the viewer's `drawTracers()` draws yellow tracers and a spark where
    each ends. Idle auto guns shoot fighters like cannons. Shader type 15 (twin barrels, ammo drum),
    designer key **U** (WASD pans), `autoUnit()`, tooltip, weapon table, "must be whole 2×2 units" error.
  - **Second round (owner, 20 Nov 2026: "the fire rate was not as fast as I expected")**: **500 cr** a unit
    (125 a block), **every 0.1 s** (one bullet a tick; auto guns reload with no jitter, `w.cd = max(0, cd) +
    cooldown`, else a 0.1 s gun skipped ticks), **bullets live 10 s**. Where this disagrees with the line
    above, this wins. Measured: ~8–10 bullets a gun a second; same harness (now 1,863 cr vs 1,317 cr boats,
    60k a side, 4 seeds): charge vs cannon line −0.08, line vs line −0.13, line vs standoff −0.27; 54 auto vs
    46 cannon boats starting 600 / 120 apart: auto keeps 37 / 42 of 54, cannons 2 / 3 of 46 (90% of bullets
    hit). Load: 500 auto boats (1,500 guns) vs 707 cannon boats: 80 s battle, 3.6 s compute (4.5 ms a tick),
    343k bullets, peak 3,022 projectiles, 3.2 MB gzip replay, 64 MB heap. Bench (no auto guns) unchanged.
    **Cannon rework and auto gun live 20 Nov 2026.** Fixed 21 Nov 2026 (owner: "random blue and orange glows next to ships"):
    the viewer drew explosion size 8 blue (an old `sz >= 4` = plasma rule); now only 4, 5 (plasma) and 7 (shield pop) are blue. Live 21 Nov 2026.
  - **Third round (owner, 20 Nov 2026: "make the blocks look better, make sure it works from whatever side
    they are attached, bullets visually more impactful, maybe a 0.2 fire rate and 200 range")**, on `v2-dev`,
    not live. Where this disagrees with the lines above, this wins:
    - **Every 0.2 s, range 200** (damage 55, speed 150, life 10 s unchanged; so half the damage per second).
    - **Guns off the nose hardly fired** (an auto gun on the back of a ship: 0–17 bullets in 20 s against a
      target anywhere round it). Not the gun: `holdFacing()` took the least turn among equally good directions,
      which for a gun not facing forward is the very edge of its arc, so the target sat on the border and the
      gun (a few blocks off the ship's centre) mostly didn't bear. Now `refit()` also builds `e.faceIn` /
      `e.faceInMax`: each direction counts the least firepower within `FACE_MARGIN` (4) slices either side, the
      widest margin (4…0) that still keeps 90% of the best firepower; `holdFacing` picks from that. Applies to
      every ship holding range (broadside ships too); nose guns facing the target are unchanged. Back gun now
      75–97 bullets in 20 s from every direction. Test in `tools/test-designer.mjs` (back/top/bottom gun fires;
      fails with `FACE_MARGIN` 0). Bench 1,000 vs 1,000: 189.0 → 182.8 s, 7.00 → 6.89 ms a tick, survivors
      206:79 → 211:83.
    - **New look**: a rotary cannon on an armoured mount (bolted chamfered rim, lit dome in a collar, three
      barrels with a clamp band and glowing muzzles, hazard-striped ammunition box behind). **Barrels point out
      of the hull**: the middle of the gun's widest open run of arc slices (`arcCentre()` in `arcs.js`), in 45°
      steps; the viewer stores it in the unit code (`unitPos()` in `model.js`: 1 + position + 4 × dir, shader
      `var & 3` / `var >> 2`), the designer's `autoUnit()` rotates the same way.
    - **Bullets** (`drawTracers`): muzzle flash at the gun for 0.15 s, longer tracer (≤ 4.5) in an orange glow
      with a hot head, and on a hit a flash plus 5 sparks kicked back off the hull for 0.5 s. Viewer only.
    - Measured (`/tmp`-style harness: 18×10 hulls, 3 nose auto units 1,845 cr ×33 vs 8 cannons 1,305 cr ×46,
      60k a side, 4 seeds; live → now): line vs line −0.01 → −0.21, auto guns on the hull side +0.13 → +0.20,
      charge vs line −0.12 → −0.15, line vs cannon standoff −0.27 → −0.18. Damage 110 (same dps as live) was
      tried: −0.15 / +0.09 / −0.16 / −0.15, not clearly better; left at 55 pending the owner.
    - **Every weapon block redrawn the same way (owner, 20 Nov 2026, after seeing the auto gun: "do the same
      with the other weapons, the blocks not the projectiles")**. This reverses the older "guns are fixed mounts,
      barrels were tried and removed" look below: barrels now point **out of the hull**, which the owner asked for.
      `src/shared/weaponLook.js` (viewer and designer): single-block weapons point away from their open
      neighbours (`openDir`, the 8 cells round it, outside the grid counts as open; buried or evenly open: the
      nose); multi-block units along the middle of their widest open arc (`unitDir`; a tunnelled fighter bay down
      its tunnel's first stretch; shields don't point). 45° steps. Looks: **laser** round housing, crystal core,
      tapered focusing barrel with rings and a glowing lens; **cannon** armoured turret, one thick barrel with a
      slotted muzzle brake, ember bore; **point defence** the red dish and eye plus twin barrels; **missile /
      guided** a pod of two missiles, warheads out (orange / green seekers), hazard stripes at the back;
      **plasma** the old machine plus a coiled emitter barrel from the orb to the hull edge with blue energy
      running along it; **flak** four long barrels with muzzle brakes out of a mantlet; **fighter bay** the
      parked fighter (wings, cockpit, engine glow) and running launch chevrons face the way fighters leave.
      Shader: `unitPos()` in `model.js` now also codes single weapons (1 + dir) and unit direction (1 + place +
      n² × dir), `e.unit` is Uint16; the shape code's var field is 12 bits (`(code >> 8) & 4095`) and the
      debris flag moved to 2^20 (`DEAD_BIT`); helper `rotd()`. Designer: `gunGlyph()`, and `plasmaUnit` /
      `flakUnit` / `bayUnit` take the weapon. Old replays get the new look too (it's worked out from the
      designs). No sim, replay or server change.
      **Second pass (owner, same evening: "make laser and cannons look more different", and he didn't like the
      bay; he confirmed barrels on guns are wanted now despite the earlier no):** **laser** = a long glowing
      faceted crystal between two slim rails, a pulsing energy line to a bright tip, no round turret (so it
      never reads as a cannon); **cannon** = a squat dark octagonal gunmetal turret (`col *= 0.78`), short fat
      barrel, big vented muzzle brake, ember in the bore, no other glow; **fighter bay** = dark steel hangar
      deck with panel seams (colour overridden from the bay's gold, which made the old deck and fighter look
      yellow), thin hazard rim, a runway with running amber lamps to dark open doors on the exit side, a small
      grey fighter (fins, cockpit, engine glow) nose to the doors. Designer `gunGlyph` / `bayUnit` match.
    - **Third round and the new weapon looks live 20 Nov 2026** (owner: "make it live"; no patch notes, as asked).
  - **Fourth round (owner, 21 Nov 2026: "half the fire rate double the damage but make the bullets look like
    they're firing faster")**, on `v2-dev`, not live: **every 0.4 s, 110 damage** (same damage per second). The
    viewer draws every recorded bullet twice, the second `AUTO_GHOST` (2) ticks behind on the same line with its
    own muzzle flash and hit sparks (`drawTracers`), so it still looks like a bullet every 0.2 s; `LIVE_POST`
    6 → 10 in `model.js` so the late copy's sparks aren't cut off. Measured (`/tmp`-style duel: the auto-gun
    brawler vs the generated mixed fleet, 60k cr, 4 seeds): bullets halved (≈ 8–13k → 4–6k a battle), the brawlers
    a little weaker (5/6/4/6 of 18 left vs 7/7/8/5; 110 overkills 45-hp frame); 712-ship mixed battle replay 8 →
    7 MB raw. Side-gun test now uses a heavy-armour target (a small armour one died in ~10 s) and checks bullets
    per second. Bench unchanged. Replay sent: "Auto gun: every 0.4 s, 110 damage, drawn as two tracers".
  - Measured (16×10 hull, 3 auto gun units 1,113 cr vs 8 cannons 1,317 cr, 60k cr a side, 4 seeds; score =
    enemy ships lost share − own): auto charge vs cannon line −0.06, line vs line −0.03, line vs cannon
    standoff −0.16; starting at 120 apart auto guns win (27/54 left vs 9/46). A third of bullets hit allied
    hulls in a crowd (allied hulls block shots, owner's rule). Bench 1,000 vs 1,000: 11.6 → 11.8 s compute,
    cannon shells 95k → 26k, replay 3.42 → 2.69 MB gzip, survivors 200:75 → 206:79. Tests in
    `tools/test-designer.mjs` (2 heavy / 11 frame, whole units, bullets fired).
- **Doomsday Interdimensional Rift Engine** (`BT.RIFT` = 16, weapon kind `'rift'`; owner, 22 Nov 2026, inspired by his
  Elenris Minor replay b28350, where 1,440 guided missiles circled a hollow fortress's courtyard, the bug fixed 14 Nov:
  "a 100*100 sized weapon fragile and explosive but can be put inside ships… doesn't need line of sight… 30 seconds to
  start firing… green… 150,000 credits… summon this effect at an empty space in the middle of enemy ships slowly adding
  more and more green projectiles that start swirling over another 30 seconds and then for them all to be released").
  **Live 22 Nov 2026** (fifth round below). Owner's answers: **fires again and again** (charge 30 s, swirl 30 s, release, charge again:
  ~1 rift a minute); released projectiles **fly straight and explode**; **point defence can't shoot them down**;
  strength: **"focus on it looking good first, we will balance it later"** (every number is a first guess).
  - `blocks.js`: 100×100 unit (`MULTIBLOCK` size 100), **15 cr a block = 150,000**, **20 hp**, mass 1. `WEAPON[BT.RIFT]` =
    `{ charge 30, swirl 30, count 200, damage 150, splash 8, speed 50, life 10, radius 45, orbit 25, cooldown 60, range 0 }`.
    `RIFT_POP` `{ after 50, radius 70, damage 900 }`: once 50 of its 10,000 blocks are destroyed the whole engine
    detonates (killCells, explosion **12**, `blast(..., anyone)` hurting its own ship). A plasma bolt that reaches it
    (5,000 budget, ~250 of its blocks) always sets it off: the demo ship needed a 16-block heavy belt to live long
    enough (an 8-block mixed skin lost both engines at ~19 s to 430k of generated ships). `isWeapon` includes it.
  - `src/shared/rift.js` (sim and viewer): `riftParticle(k, n, seed, age, out)` = where projectile k is `age` s after its
    rift opened (appears at `riftSpawnAt` = 92% of the swirl × k/n, spirals out from the eye over 1.6 s to its orbit
    0.22–1.0 × radius, every one the same way round, the vortex speeding up to 2.5× by release; `vx/vy` = its release
    direction, the orbit bent 0.75 rad outward), `riftSpeedStep` (85–115%, in `shotSpd` steps), `riftHash`. **The swirl
    is never simulated or recorded**: nothing exists until release, then the sim makes real projectiles from these
    positions and the viewer draws the swirl from the same function (test: shots start < 0.3 blocks from it).
  - Sim (`battle.js`): one weapon per unit with `omni: true`, skipped by `facing`/`updateLineOfFire`, `e.face`, stance
    ranges and flak's `gunCost` (so a rift ship isn't flak's favourite target and doesn't stand at range 0). `fire()` →
    `fireRift()`: charged (`w.sq` 0) → `riftSpot()` (of up to `RIFT_PICKS` 24 armed enemies, the most enemy value within
    `RIFT_NEAR` 200 × random, ×0.15 near an open rift so engines spread out; centre = value-weighted middle of those
    enemies, moved out in rings of 8 to the nearest point with no hull box within `RIFT_CLEAR` 20), snapped to the
    replay grid, recorded, `w.sq` 1, `w.cd` = swirl; then `releaseRift()`: `K_RIFT` (8) projectiles, owner -1, fly over
    friendly ships (`sweep(..., team)`), `blast()` on the first enemy ship or wreck (explosion **11**), not in the missile
    grid (PD can't see them). `updateRifts()` (after resolveDamage): a rift whose engine popped, broke off or died
    collapses; an open rift sets `lastClosing` so a quiet swirl doesn't end the battle as stalled. Pops queue through
    `flakPops` → `popRift()`.
  - Replay: columns `rfT0 rfT1 rfX rfY rfN rfSeed rfTeam rfEnd rfSrc rfLX rfLY` (end 0 released, 1 collapsed, 2 open
    at the battle's end), shot kind **8** (`meta.shotSpeed[8]`), explosions 11 and 12. Old replays have none.
  - Viewer: **shape code type 0 = the rift engine** (the type field is 4 bits and empty cells are never drawn), the var
    field is now **14 bits** (`& 16383`, a 100×100 place needs 9,999) and `DEAD_BIT` **2^22** (codes stay < 2^24, exact in a
    float). Shader: gunmetal housing, chamfered rim, four corner pylons, a coiled outer ring and a counter-turning inner
    ring of emitter plates with glowing slots, a green spiral vortex with a white eye; size slot = charge (0..1) and 1 +
    rift fill while open (`ReplayModel.riftEngines(e, t)` from `e.rfEng`: engine centres, `blk` engine per block, each
    engine's [open, end] ticks, matched by `rfSrc` + `rfLX/LY`). `drawRiftEngine` glow over the ship at any zoom;
    `drawRifts` (opening flash and ring, deep-green well, rims, 3 turning spiral arms, every projectile with a 3-step
    curved trail, crackling arcs re-picked every 0.3 s, release burst and shock ring, or a collapse sucking them into the
    eye), `drawRiftShots` (green orbs with trails), `drawRiftBoom` (11 green blast; 12 detonation fireball, ring,
    streaks, `RIFT_BOOM` 60 ticks). All pure functions of time; ring = glow shape 5 again.
  - Designer: key **V**, palette colour, `riftUnit()` drawing, tooltip and weapon-table hint, "count × damage / ~60 s",
    range "any"; `analyzeDesign` treats it as omni (never buried, no arc), damage/s = count × damage / 60, left out of
    min/max range, error "must be whole 100×100 units", warning "EXPLOSIVE…". Galaxy thumbnail colour.
  - Measured (`/tmp`-style: 2 hand-built 162×148 "Rift Dreadnoughts" (engine in a 16-block heavy belt, cannons/lasers/PD
    on the skin, 255,571 cr, Artillery, Back) + 102 generated escorts vs an equal-value mixed fleet, 3 seeds): 5–7 rifts a
    battle, 54–90% of projectiles hit (in a 40-frigate test only 10%), 1–2 engines detonate; seed 3 the rift side won by
    rout. Bench 1,000 vs 1,000 identical shot for shot. Test in `tools/test-designer.mjs`. Replay sent: "Doomsday
    Interdimensional Rift Engine" (seed 3: 5 rifts, two collapse).
  - **Second round (owner, 22 Nov 2026: "I like the green projectile, the rift, lighting and see the block design but I
    don't like the green circles around the attack. The projectiles should hit enemy ships as they circle around as
    well and can you get the circling to look more similar to how the rockets circled in the replay")**, on `v2-dev`,
    not live. Where the rift lines above disagree, these win:
    - **Swirl shaped like the replay's missiles.** Measured in b28350 (607 missiles looping 3+ times between 100 and
      160 s round one point): **285 clockwise, 322 anticlockwise**, each on its own loop (fitted radius 45–90) whose
      centre sat 16–54 blocks off the middle, so the loops overlap in a rosette with a bright knot at the centre and
      long thin trails. `riftParticle` now: loop radius `rho` = radius × (0.28–0.5), its centre `rho` × (0.75–1.25)
      from the eye (so the loop passes back near it), half each way round, starting at the eye, loop centres turning
      round the eye at `PREC` 0.09 rad/s, speed `orbit` (28) × (1 + `ACCEL` 0.6 × age / swirl); release along its
      loop. `radius` 45 → **60** (the swirl reaches ~60 from the eye), `RIFT_CLEAR` 20 → **30**.
    - **Swirling projectiles hit enemy ships**: `stepRifts()` (after `fire`, before cook-offs) sweeps each live
      projectile from last tick's swirl point to this tick's (`sweep(..., team, shipsOnly)`: friends and wrecks are
      flown through), a hit = the same blast + explosion 11, the projectile is gone (`r.alive`) and recorded in
      **`rkRift` / `rkK` / `rkT`**; only survivors are released. Demo battles (same harness, 3 seeds): ~40% of
      projectiles hit ships while swirling (seed 1: ~555 of 1,400), the rest released.
    - **No rings**: every glow-shape-5 ring is gone (opening, rim, inner, release, collapse, blast 11, detonation 12)
      and so are the spiral arms; a faint haze, the bright eye, the projectiles with 7-step (0.7 s) thin trails and
      the arcs stay. Viewer `rift.dieAt[i][k]` = tick a swirling projectile hit (from `rk*`), not drawn after it.
    - Test in `tools/test-designer.mjs` (swirl hits on a still enemy, survivors released from the swirl, a green
      blast for every hit). Bench identical. Replay sent: "Doomsday Interdimensional Rift Engine" (seed 1, 7 rifts).
  - **Third round (owner, 22 Nov 2026: "the projectiles need to also hit debris and the targeting needs to be a little
    more in the middle of enemy ships, 2/4 of the rifts mostly missed the enemy fleet… make more projectiles, 500
    instead of 200 maybe")**, on `v2-dev`, not live. Where the lines above disagree, these win:
    - **Why rifts missed**: they opened among the enemy (16 / 26 enemy ships within 100 of the centre) but the fleet flew
      on during the 30 s swirl (1 / 1 left at release). **Rifts now drift with the enemy**: `driftRift()` every
      `RIFT_TRACK` (5) ticks heads for the value-weighted middle of the enemy ships within `RIFT_FOLLOW` (150) of the
      centre (velocity half old, half (target − centre) / 1.5 s, capped `RIFT_DRIFT` 15 blocks/s), straight lines
      between, points recorded as **`rpRift / rpT / rpX / rpY`** on the replay grid (viewer `rift.path[i]`,
      `rift.at(i, t, out)` joins them exactly). `releaseRift` brings the centre up to the tick first (fire runs before
      stepRifts). Spot: `RIFT_NEAR` 200 → **150**, `RIFT_CLEAR` 30 → **15**. Same battle (seed 1): enemies within 100 at
      release 1 / 1 / 4 / 28 / 1 / 4 → 9 / 5 / 12 / 19 / 6 / 4 (fewer than at open because the swirl kills them).
    - **Swirling projectiles hit debris** (and enemy ships; they still fly through friendly ships): `sweep(..., team)`
      without shipsOnly. Debris takes most of them: 1,611 of 2,624 swirl hits in seed 1 were on wrecks, each blast
      leaving more wreckage for the next.
    - **`count` 200 → 1,000** (owner said 500): at 500, ~94% were used up before release (~40 released per rift); at
      1,000 the swirl grinds a hole through the wreckage and ~400 per rift get released (1,500: ~960, and the rift side
      routs the enemy before the third rift). Seed 1 at 1,000: 5 rifts, 4,172 green blasts, 1,660 released. Viewer: the
      trail's centre points are worked out once per rift per frame; ~20 ms frame JS with two full rifts (software GL).
    - Test now 120 frigates (40 died during the first swirl at 1,000), checks the release against the drifted centre,
      counts swirl + released hits. Bench identical. Replay sent: "Doomsday Interdimensional Rift Engine" (seed 1).
  - **Fourth round (owner, 22 Nov 2026: "the rift moving is to strong with proper targeting it should become balanced…
    one rift has probably 15 nearby ships which is perfect, the other rift has maybe 2")**, on `v2-dev`, not live. Where
    the lines above disagree, these win: **rifts no longer drift** (`driftRift` gone; the `rp*` columns stay in the
    format, always empty, the viewer still reads them). **New aim** (`riftSpot`): the old one scored a ship's
    surroundings by *value* and opened at their value-weighted middle, so one big ship pulled the spot into empty space
    (v2's 1:30 rift: 3 enemies within 100). Now up to `RIFT_PICKS` 40 armed enemy ships are candidate centres, each
    scored by `riftCrowd()` (enemy ships within `RIFT_REACH` 70 count 1, out to `RIFT_OUTER` 110 count ½; ×0.15 within 160
    of an open rift; × random 0.9–1.1); the best moves to the middle of the ships round it (3 mean-shift steps), then to
    the nearest clear spot (`RIFT_CLEAR` 15) within `RIFT_SHIFT` 40, else opens right there. Same demo battles (3 seeds,
    13 rifts): enemies within 100 at open 15–44 (one late rift 7, when few were left); of those ~60% are destroyed before
    release, the rest fly out of reach. Test checks no drift points and ≥ 12 enemies within 100 at open. Bench identical.
    Replay sent: "Doomsday Rift Engine v4" (seed 1).
  - **Friendly ships stop rift projectiles (owner, 22 Nov 2026: "make projectiles hit friendly ships but do no damage
    and then make it live")**: swirling and released projectiles explode on the first ship of any side or wreck they
    meet (`sweep(..., -1)` with no team skipped); the blast is the usual `blast(..., team)`, so friends take nothing
    (enemies within the splash still do). Test: an unarmed friendly cruiser moved into the swirl gets green blasts and
    loses no hp to them. **The whole rift engine is live 22 Nov 2026** (no patch notes, as asked).
- **Mega thruster** (`BT.MEGA` = 17; owner, 22 Nov 2026: "it's difficult to fit so many thrusters on a big ship… same size,
  10 times as powerful, 10 times as expensive, 5 times the HP"; "no need to send me replays… make it live"), **live 22 Nov
  2026**, no patch notes: one block, thrust **100**, **200 cr**, **300 hp**, mass **15** (owner, same night: "should weigh 10
  times more too"; it was 1.5 at first, so it now only saves space, not weight). `isThruster(t)` in `blocks.js` (thruster or mega) is used wherever thrust is counted or thrusters are banned: sim
  `refit` (and kept out of flak's `gunCost`), `analyzeDesign`, `defenseProblem`, bot forts, the designer (palette key **T**,
  tooltip, purple ringed glyph, defence mode greys it out and strips it, `ed.removeType` takes a list, sim screen's
  ship/defence split). Top speed is still capped at 22. Viewer: shape code type field is 4 bits, so it's drawn as shader type 5
  (thruster) with var 8+ (`type == 5 && var >= 8`: heavier housing, two rings, blue-white core); `e.thrMega` makes its flame
  2.2× longer and 1.5× wider. Test in `tools/test-designer.mjs` (numbers, designer = sim, flak, save/load, viewer). Bench
  identical. A generated titan with its thrusters swapped: 4.6 → 22 top speed (at mass 1.5).
- **Block tooltips shortened (owner, 22 Nov 2026: "reduce them all to a very short summary of need to know information")**,
  **live 22 Nov 2026**, no patch notes: each palette tooltip is the stats line + one short line (`BLOCK_HINT` in
  `designer/app.js`, functions of the block's `WEAPON` entry so numbers follow `blocks.js`). Owner's wording: "protect" not
  "bury"; heavy armour isn't special against flak (no block lets flak through). Block names **Armour** / **Heavy armour** (were
  "Armor"). Reviewed in the doc "Block tooltips: current and suggested". The weapon-table hover texts (`SHOT_HINT`) are unchanged.
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
  - **Holding range (owner, Nov 2026, live since 10 Nov; all stances except Skirmisher, Flanker and Raider)**: the
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
  - **Getting into the enemy formation (owner, 22 Nov 2026: "2 stance types that are supposed to fly through enemy
    lines… fleets are packed so tight that it's impossible… I want them to have the opportunity to fly into enemy
    formations", plus "ship movement also takes compute")**, on `v2-dev`, **not live**. Measured first (`/tmp`-style
    `pen.mjs`/`why.mjs`/`eval.mjs`, scenarios: flank/raid attackers vs a line+artillery defence, big-ship knives, a wall
    of cruisers/battleships, an even fight, the bench mix): knives were **not** jammed on enemy hulls (~95% of top speed
    on the way in, touching an enemy ~1% of the time); what kept them out: (1) goals were the nearest big-ish ship, i.e.
    the enemy's front row (70% of goals were Front line ships); (2) raiders turned back 6 s / 80 blocks after a pass;
    (3) they start behind their own line and most of their bumping (4–8 per 100 ticks) was against friends; (4) most
    then die crossing open space under fire (that part is design/balance, not movement; told the owner). Changes (flank
    and raid only, `e.knife`): **goals deeper** (`pickGoal`: `log(mass) − d/200 + depth/GOAL_DEPTH(100)` clamped −2…+3,
    depth = how far behind the enemy's middle along our middle → theirs (`ownCx/ownCy` added in `teamStats`), reach
    `GOAL_REACH` 900 (was 600), every enemy looked at when ≤ `GOAL_SAMPLE` 24, else 24 random (was 12 draws: with 12
    enemies the best was missed 35% of the time)); **raiders run out** `RAID_OUT` 150 past the target or `RAID_OUT_T`
    10 s (was 80 / 6 s); **threading** (`threadGap`, every `THREAD_EVERY` 10 ticks while on the way in: 13 headings
    `THREAD_STEP` 0.16 rad apart round the wanted one, cost = hulls (friend, foe, wrecks ≥ 3 radius, not its goal)
    across the path over `THREAD_LOOK` 2.5 s, nearer counts more, + small-turn and keep-the-same-gap terms; heading
    offset `e.thrA`; spacing still slides it sideways but doesn't bend its heading); **friends make room** (threadGap
    adds a sideways push `wayX/wayY` to friendly non-knife, non-fixed ships on its path, used ×1.5 in their next
    `spacing`); **slide, don't bounce** (`collide`: a knife touching a *ship* keeps its speed along the hull, head-on
    goes round its `orbit` side; wrecks are ploughed as before; a first version scaled speed ×0.9 per touching tick and
    left big knives crawling against wrecks 7% of the time). Result with knives made unkillable (movement only, 3 seeds
    each; before → after): flankers past the enemy's middle 31/45/54% → 60/82/90% (front/big/wall), inside the formation
    12–24% → 19–30% of the time, raiders past the middle 68/26/91% → 87/46/100% (fewer passes, 5.6 → 3.4, as each runs
    further). In normal battles they still mostly die on the way in (life ~same), raiders make ~2× the passes (0.3 →
    0.6), outcomes unchanged (value lost shares within ±0.05). Test in `tools/test-designer.mjs` (fails on the old code:
    the flanker went for the front row 96% of the time). Replays sent: "Flankers and raiders: BEFORE / AFTER".
  - **Second round (owner, 22 Nov 2026: "in movies I see ships move past each other broadsiding each other… the armies go
    straight into one another and then break out into a chaotic melee. Would it help if enemy ships also help move out
    of the way… number one priority is that battles look good… enemy ships can cooperate… number 2 is that ships try to
    win")**, on `v2-dev`, not live. Asked who charges in; **owner chose: only close-in stances** (Front line keeps holding
    at 45%). Changes: `e.knife` now also covers **Charge** (and the old Brawler): it threads (`thread` while `d > pr ×
    1.5`, its target counts as its goal in `threadGap`), slides along hulls and gets room made; **ships of both sides make
    way** (threadGap's sideways push goes to any non-close-in, non-fixed ship on the path except what it's going for);
    **strafing passes**: a flanker or raider whose goal's hull is within 0.9 × `e.reach` (main gun range, set in `refit`)
    turns its hull to `holdFacing` on the goal while still travelling along its run / circle (`face` in `move()`: the turn
    goes to `face`, thrust along `desired`; the crowd only slides it). Measured (same `eval.mjs` scenarios, 3 seeds): ships
    within 40 of an enemy hull (both sides, all stances) ~5% of the time before and after, close-in ships ~15% before and
    after: still not a melee, because the close-in ships die crossing the gap and Front line holds at range. Tried (not
    kept, offered to the owner as option B): close-in ships fly in at 1.6× speed while on the way in + Auto start at the
    front for close-in designs: close-in ships in contact 15% → 34% in the even test, inside the enemy formation 26% of
    their time (was 5%), but they die sooner (life 61 → 32 s). Replays sent: "Even fight: live / A (enemies make way,
    broadside passes) / B (A + charge speed + start at the front)". Test in `tools/test-designer.mjs` (an enemy cruiser
    in a charging corvette's path gets a make-way push; its target doesn't).
  - **Third round (owner, 22 Nov 2026: broadside passes are what he wanted; "the extra speed for charging isn't needed
    players will design their front line ships with a lot of speed anyway"; "make both fleets entirely out of close-in
    designs… hopefully we should get a complete mix of both sides")**, on `v2-dev`, not live. Option B (charge speed,
    front start) dropped. Test: `/tmp`-style `page3.mjs`, both sides 80 corvette Charge, 80 frigate Raid, 70 destroyer
    Flank, 40 cruiser Charge, 20 cruiser Flank, 10 battleship Raid, mix = share of enemies among each armed ship's 6
    nearest armed ships (0.5 = fully mixed), at 60–90 s: live ~0.26–0.33, A ~0.23–0.36. What doesn't help: close-in ships
    making way for each other too (~0.27), a keep-right passing rule in `threadGap` and head-on slides (~0.33). **What
    helped: Charge ships pick their goal like flankers** (`pickGoal` in `think()` for `charge` too, so the deep goal is
    `targets[0]` and they dive for big ships deep in the formation, still holding point blank when they get there):
    ~0.33–0.38 (two seeds). Picture: the fleets close into two or three mixed blobs by ~60 s rather than a clean line;
    each blob still leans to its side. Normal mixes without Charge ships unchanged; bench 1,000 vs 1,000 199 s / 12.3 s
    compute. Replays sent: "All close-in fleets: LIVE / NEW".
  - **Fourth round (owner, 22 Nov 2026: "the front lines are still way too congested most ships are just running into
    each other… in a totally close-in on both sides scenario… ships should be going at full speed all the time unless
    slowing down turning")**, on `v2-dev`, not live. Measured (`/tmp`-style `speed.mjs`, same all-close-in battle, from
    first contact, speed as a share of top speed): Charge 77% mean / 23% of the time under half speed, Raider 80% / 19%,
    Flanker 79% / 20%; of the slow moments ~1/3 touching a hull (2/3 of those by a wreck), ~1/2 turning, ~1/3–1/2 the
    crowd-spacing slide pushing it backwards (close-in ships on the way in skipped the "never backwards" rule other ships
    get, since that sat inside the heading bend they don't use). Changes: **spacing never slides a threading or strafing
    close-in ship backwards** against its way; **Charge ships with a goal circle it point blank at full speed** like
    flankers (`steerGoal`, so they strafe it with `face` too) instead of braking to hold beside it. After: Charge 89–90% /
    13–14%, Raider 92–97% / 7–13%, Flanker 88–93% / 10–15% (seeds 2 and 3); mix at 40 s 0.18 → 0.23–0.30, 60–120 s
    0.31–0.43. Tried and dropped: close-in ships sliding along wrecks too (Charge 89% → 77%: they ground along debris).
    Bench 1,000 vs 1,000: 188 s / 11.0 s compute. Replay sent: "All close-in fleets: full speed".
  - **Fifth round: room to see the fight (owner, 22 Nov 2026, phone screenshot of the full-speed replay: "the congestion is
    the real enemy… 2 sides mashed together there is no space to see their weapons fire or miss or cool maneuvers… we might
    need to do another full rework of how all ships move")**, on `v2-dev`, not live. Measured (same all-close-in battle,
    gap = each armed ship's distance hull to hull to its nearest armed ship, rough hull circles): median gap 10 → 2 blocks
    from 30 to 60 s, 80% of ships under 10 blocks; fleets were already packed before they met (20 s: median 14, 30% under
    10). Causes: in an all-close-in battle there was **no spacing between sides at all** (close-in ships ignored enemies and
    nobody moved from an enemy close-in ship); fleets start 20 blocks apart; everyone piled onto the same deep goals.
    Changes: **`START_GAP` 20 → 50** in `battleSetup.js` (fleets start spread out; the biggest single gain: median gap at
    60–80 s 2–5 → 17–22); **`spacing()`: every ship keeps clear of every other, friend and foe**, gap **`SPACING_GAP` 25 →
    40**, its own goal/target only `SPACING_GOAL` 0.4 of that, and it **looks `SPACING_LOOK` 1.2 s ahead** (closest approach
    on current velocities, blended 60/40 with now); `NEAR_MARGIN` 20 → 50 so the neighbour lists reach that far; close-in ships
    on their way in **turn** round others again (only strafing ones just slide); **goals spread** (`pickGoal` subtracts
    `HUNT_SPREAD` 1 × friends already going for it ÷ (radius / 10); `e.hunters` counted in `teamStats`); **Charge ships with
    a goal make point-blank strafing passes** like raiders (`CHARGE_SIDE` 20 off the hull, `CHARGE_OUT` 80 out the far side)
    instead of circling on top of it. Tried and dropped: long runs out 200–400 blocks for every close-in stance (no gain:
    test ships do ~8 blocks/s, so they never got far), Flanker passes / wider circles. After (seeds 2 / 3): median gap at
    40 / 60 / 80 / 100 s 34 / 30 / 20 / 16 and 33 / 31 / 29 / 30 (was 7 / 2 / 2 / 5 and 9 / 5 / 5 / 6), ships under 10 blocks
    4–28% (was 64–85%), speed ~110% of top (shoves), mix 0.37–0.39 at 100 s; compute per battle second 35 → 32 ms (fewer
    collisions). Mixed fights (flank/raid/line/artillery both sides) about the same length and losses. Bench 1,000 vs 1,000:
    169 s / 11.8 s compute / 226:88 (bench uses its own start layout). Tests: the flanker test now passes at 75% on the
    battleship (the raider goes for it too), the start-position test compares Auto with the flank distance. Replays sent:
    "All close-in fleets: spaced out", "Mixed fight: live / spaced out".
  - **All five rounds above (getting into the formation through room to see the fight) and the movement compute work went
    live together on 22 Nov 2026** (owner: "That's a lot more spaced out nice, make it live"; no patch notes).
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
  ships touching another 31% → 9%, median hull gap 7 → 18 blocks. **Since 22 Nov 2026 (v2-dev) gap 40, enemies too, 1.2 s look-ahead: see "Fifth round" under Stances.** 1,000 vs 1,000 ~4.2 ms a
  tick (fewer collisions pays for the queries). Spread fleets take fewer ships per missile
  blast, so missiles 90 → 75.
- **Debris** must stay clearly visible (wrecks keep most of their colour).
- **Ships are drawn in their player's colour** in replays (owner, Nov 2026), militia in
  `NEUTRAL_COLOR`. **Fixed 11 Nov 2026** (owner: fighters and the name labels showed the other
  player's colour): the galaxy log's `sideColors` are [attacker, defender], but since free-for-all
  battles the world's side is team 0, so `applyColors()` now ignores `sideColors` whenever the
  replay has `meta.colors` and takes each side's colour from its own ships (fixes old replays too). `planEvent` puts `color` on each group, the worker / hot-seat page write
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
- Disengagement: 20 s with no damage dealt anywhere, after the first 30 s. **Ships still flying in count as engaging** (owner, 19 Nov 2026: a 2.0 battle whose fleets started far apart "ended" at 34 s with no damage, because the 20 s were counted from the start): `this.lastClosing` = last tick an armed ship's distance to its target was over 1.1× its stance distance (`move()`); stalled = no damage *and* nobody closing for 20 s. Test in `tools/test-designer.mjs`; bench unchanged.
- Time limit: **15 minutes** (owner, 13 Nov 2026; was 8, before that 4) for world battles, the designer's test battle and
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
- **Movement compute (22 Nov 2026, with the flanker/raider work)**: (1) **neighbour lists**: `refreshNear(e)` every
  `SPACING_EVERY` (5) ticks keeps everything within `e.radius + NEAR_MARGIN` (20) + its radius in `e.nbr`; `spacing`
  and the every-tick `collide` read it instead of each querying the grid (`collide` refreshes early if the ship moved
  `NEAR_MOVE` 8 from where the list was made, e.g. shoved or teleported by a test). Wrecks made last tick aren't in the
  grid yet, so `this.newChunks` covers them and `makeChunk` also pushes a new piece into nearby ships' lists. Missed
  touching neighbours vs a full query: 0.05–0.07% (all wrecks). (2) **per-side ship grids** (`buildTeamGrids`,
  `TEAM_CELL` 64): `think()` searches only its enemies' grids ring by ring (`SpatialGrid.queryRingsMulti`, ring limits
  converted from the old 32-block rings) instead of every ship and wreck round it (250 entities a search → enemies
  only). (3) **`SpatialGrid.build` only clears and sums the box of cells its entities cover** (and last build's box),
  not all 147,000 cells: exactly the same query results (same battle shot for shot), main grid build 1.55 → 0.69 s in
  the bench. **The "already visited" counter is shared by every grid** (module `QID`; `grid.qid` is a getter/setter
  for `sweep`/`lanceCount`-style callers): grids holding the same entities must not reuse each other's marks (a
  per-grid counter broke dedupe and tripled raycasts during this work). Movement + target picking per ship-tick
  4.35 → 2.58 µs (−41%); whole battles −15–18% compute at equal length (600 v 600, 3 seeds, 240 s each). Bench 1,000 vs
  1,000: 244 s / 14.4 s compute / 162:61 → 186 s / 11.2 s / 212:84 (bench battles swing; raycasts 1.72M → 1.57M).
- Line of fire is incremental: each weapon stores the cell blocking each of its 64 rays
  (`blk`), and `refit()` only re-casts rays whose blocker died (`updateLineOfFire`). A full
  re-cast per hit was fine for 50 guns but not for a giant with 1,000.
- **Arcs are 64 slices (5.6°), too coarse for giants**: across a 1,000-block hull a slice edge is
  50+ blocks wide, so shots left through a gap and flew through the hull's own far arms (shots never
  hurt their own ship, so they passed through; owner saw it with Aegis plasma, 13 Nov 2026). Hulls of
  `BIG_HULL_CELLS` or more now check the real shot line through their own grid before firing
  (`ownHullInWay()`: cannons, lasers, plasma, guns shooting fighters, and point defence bursts at
  ships; missiles fly over ships so are exempt, and **point defence still shoots through its own hull
  at missiles and fighters**, owner: "that's needed"); a blocked shot waits 0.3 s and tries again. Aegis II at 400,000 cr: shots
  through its own hull 243 → 16; IV at 750,000: 114 → 4. Small ships skip it (bench identical).
- Replay block indexes (`bdCell`, `chCells`) are 32-bit, because giant ships have more than
  65,535 cells.
- **Never spread a big list into a call** (`a.push(...b)`, `Math.max(...b)`) in the viewer or sim:
  past ~100k items it throws "Maximum call stack size exceeded". `withGuided()` did this with
  guided-missile pieces, so a few-thousand-ship battle with guided missiles stuck on "Loading the
  replay" for everyone (11 Nov 2026; fixed in the viewer, so old replays open too). Collect big
  results in typed arrays sized up front (sparks are now one `Float32Array`), and the viewer now
  shows "This replay couldn't be opened" with the error instead of hanging.
- **Giant battles (owner, 21 Nov 2026: "the most epic and massive battles imaginable"; **live 21 Nov 2026**, no patch notes; memory is no
  worry, Railway allows 8 GB and the biggest battle so far used ~800 MB).** Stress tests (`/tmp`-style
  `giant.mjs`: generated fleets through `makeBattleScenario` with camps round the world, all at war,
  like the worker): 4,000 ships 14 s compute / 330 MB; **20,000 ships (4 × 5,000) 187 s / 1.6 GB peak,
  full 15 min, 130 MB raw / 38 MB gzip replay**, opens in the viewer in ~14 s with ~700 MB heap; 36,000
  ships (6 camps) start within ±3,000 blocks. No crash anywhere. Fixed on the way:
  - **Event positions per battle** (`evQFor()` in `battle.js`, `this.evQ` → `meta.evQ`, which the viewer
    already read): shots, explosions, beams, shoved debris and guided points are Int16, so at the fixed
    1/4 block anything past ±8,191 was pinned to the edge. Battles whose ships start within ~5,190
    blocks keep 1/4 (bench identical shot for shot); further out 1/2, 1 or 2 blocks (`EV_SPARE` 3,000 for
    shots flying on). Only matters past ~150,000 ships. Test in `tools/test-designer.mjs`.
  - **Start spots 9× faster, identical**: `fleetSpots()` took 23 s for 20,000 ships in one camp and 158 s
    for 50,000 (most first spots are taken, each ship tried thousands of candidates). A `taken` cell map
    (cells wholly inside a placed box grown by the smallest ship's half size + gap) rejects candidates
    the full test would reject, and ring directions are cached (`ringDirs`): 20,000 → 2.5 s, positions
    checked identical to the old code for 50–20,000 ships.
  - **Viewer skips what can't be on screen**: the draw loop placed every ship and wreck every frame
    (~100,000 at 20,000 ships). `renderer.lastPos` keeps each one's last centre and time; with
    `model.speeds()` (per entity: track steps, wreck drift, shove blends; one wild shove used to make a
    global limit useless) anything that couldn't have reached the screen is skipped. Pixel-identical
    screenshots against the old viewer. 20,000-ship replay, frame JS (software GL): zoomed in 25 → 11 ms,
    mid zoom 31 → 20, whole battle unchanged (everything is on screen then).
  - **Per-slice shot lists** (`liveIndex()` in `model.js`, `S.live(t)` / `S.liveIdx`, slices of 16 ticks):
    every frame looked at all shots fired within the longest flight of the kind (shells 30 s, missiles
    90 s), ~20 for each still flying in a 4,000-ship battle. Test in `tools/test-designer.mjs`.
  - `Math.min(...ranges)` in `analyzeDesign` (a giant ship with >100k guns), `rowDepth` in
    `layoutDefences` and `ships.push(...mine)` in the designer test battle no longer spread lists into calls.
  - Viewer debug hook: `window.battleViewer.renderer` and `.drawMs` (time to prepare the last frame).
  - Not fixed: the hot-seat page's `ReplayStore.put` reads every stored replay (`getAll`) to prune to
    80; with giant replays that's GBs (online play fetches replays from the server, so unaffected).
  - **With the newer blocks (owner, 21 Nov 2026: "the new blocks weren't in the test"; `makeDesign` uses
    none of flak, shields, auto guns or bays)**: `/tmp`-style `newdesigns.mjs` hand-builds an auto-gun
    brawler (20×11, 5 auto units, charge), a carrier (30×22, 4 bays on the hull edges, cannons, standoff)
    and a flak battleship (44×31, 2 flak, 1 shield, auto guns, lasers, line), all valid with no
    warnings; `giant2.mjs` makes 40% of each army those (50/30/20). **4 × 5,000: 11 min compute, 3.3 GB
    peak, full 15 min, 508 MB raw / 175 MB gzip replay** (shots 15.6M: 8.3M shrapnel pieces = 35 MB gzip,
    6.6M auto bullets = 42 MB; block deaths 7.5M; 291k wrecks). ReplayModel builds it in Node in ~31 s at
    ~3.4 GB rss (12 s of it GC). 4 × 2,500: 4.4 min, 1.7 GB, 82 MB gzip, opens in headless Chrome in 37 s;
    4 × 1,000: 26 MB, 12 s, frames 150–300 ms on software GL zoomed out (auto tracers ~32 ms of it). The
    20,000 one couldn't be checked as a 232 MB replay page. Ideas offered, not done: shrapnel as one record
    per burst (20 pieces share t0/x/y/team), compact auto bullets, leaner viewer memory (drop raw columns
    after decoding, per-block arrays for 291k wrecks). `straight()` in `model.js` now lists shots in typed
    arrays (no measurable change). 6 of 43M event coords clamped in the 15-minute 20,000-ship battle
    (stragglers far out; `EV_SPARE` could grow).
- **Wrecks fall apart when shot through (live 21 Nov 2026, no patch notes; owner, 21 Nov 2026: "some debris acted like it was together
  when no blocks connected it")**: `resolveDamage` only looked for loose pieces on ships; a wreck that
  lost blocks just refit its box. `splitChunk(e)` floods it; the biggest connected piece stays the wreck,
  every other one leaves through `makeChunk(e, cells, 0.5)`. Replays describe every wreck in the grid of
  the ship it first broke off (the viewer looks blocks up in `parent.design`), so a piece of a wreck is
  recorded against that ship: entity fields `org` (ship id), `oi`/`oj` (its grid's place in the ship's
  grid), `ow` (ship grid width); `chParent` = `org`, `chMinI/J` and `chCells` converted to ship-grid
  terms. No viewer or format change, old replays unchanged. Bench 1,000 vs 1,000: battle 183 → 244 s
  (wreck pieces spread and block more shots), survivors 211:83 → 162:61, debris pieces 6.5k → 11.9k,
  6.8 ms a tick (was 7.4), replay 2.66 → 3.28 MB gzip. Test in `tools/test-designer.mjs` (fails with it off).
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
- **Selling a shipyard and building defences take 5 hours** (owner, Nov 2026: so neither can be
  done in reaction to an attack, which gives only 30 minutes' warning; `SELL_HOURS`,
  `DEFENSE_BUILD_HOURS` in `economy.js`). Both are **jobs** in `world.jobs` (`{ id, kind: 'sell' |
  'defence', planet, owner, done, ... }`, added by `upgradeWorld`), finished by a `'job'` event in
  `dueEvent` (at the same moment jobs go before fleets and sieges, so defences finished on time
  fight). A yard being sold has `sellAt`, **stops building at once** and pays out at the end;
  **Keep it** (`cancelSale`, server action `unsell`) calls it off and it builds again a full
  interval later (my choice, offered to the owner). Defences are **paid up front** and join the
  garrison when done. If the world falls first, `capture()` drops its jobs: no payout, unfinished
  defences lost ("N unfinished defences lost" in the log).
- **Defences** (owner, Nov 2026: a friend lost his home world and wanted static defences): the
  world panel has **Build** for Defences next to Shipyards. A defence is any valid design with
  **no thrusters**, bought at **1/5 of its block price** (`DEFENSE_PRICE_SHARE`,
  `defensePrice()` in `economy.js`), any number per order (`MAX_DEFENSE_ORDER` 1,000), built
  into the garrison 5 hours after ordering (see above; `buildDefense()` in `world.js`, server action
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
- **Arranged defences (owner, 20 Nov 2026, "highly requested": players place every defence at a world
  and turn it, to build their own fortress)**, **live 21 Nov 2026** (with blueprints, Build missing and the click fix; no patch notes, as asked). Owner's answers: attackers keep
  **today's rule** (one attacker from the left, several spread evenly round the world: camps at
  2πc/n); **any angle, 15° snaps**; **new defences refill placed spots of their design first**, extras
  go in the usual rows; **touching allowed, not overlapping**.
  - **Stored at the top level**, `world.layouts[planetId] = { owner, spots }` (not on the planet: worldSync
    re-sends a planet whenever anything there changes, and a big layout is ~80 KB); `layoutAt(world, id)`
    returns it only while its owner holds the world. **`LAYOUT_RADIUS` 3,000** (owner asked whether
    1,000 was enough: an Aegis IV alone reaches ~590 from its centre, so two side by side didn't fit).
  - **Blueprints** (owner, same evening: "a way to save designs to quickly remake them at other
    worlds"): `world.blueprints[pid] = [{ id, name, spots }]` (top level for the same reason; ≤
    `MAX_BLUEPRINTS` 20, names 1–40 chars, saving under an existing name, any case, replaces it; spots
    checked by `cleanLayout` against the player's own defence designs). `saveBlueprint` /
    `deleteBlueprint` in `world.js`, server actions `blueprint { name, spots }` / `unblueprint { id }`.
    Arranger: **Blueprints…** panel (name + Save as blueprint; Load / Delete per blueprint). Loading lays
    the blueprint out with this world's defences filling its spots and the rest as empty spots; the
    arranger gets every defence design of the player's (`openArranger`), so missing ones can be drawn.
    **Build missing (N · cost)** appears whenever there are empty spots: saves the arrangement, then
    orders `buildDefense` for each design's empty spots (usual price and build time; they fill their
    spots when done). The world panel shows **Arrange defences…** at worlds with no defences too when
    the player has a blueprint. Tests: blueprint save / replace / not your design / no name / delete in
    `tools/test-world.mjs`, refusals in `tools/test-server.mjs`; browser-checked (save at home, load at a
    second world with no defences, Build missing ordered all 21 and saved the layout).
  - `src/world/defenceLayout.js` (pure, shared): layout `{ owner, spots: [{ d, x, y, a }] }` (world
    design id, grid centre in battle blocks with the world at 0,0, nose angle; battle frame x right, y
    down). `shapeOf`, `piecesOverlap` (box SAT prefilter, then block-exact: two blocks overlap when
    their centres are < 0.9 apart, so side-by-side blocks touch at any angle), `overlapping`,
    `pieceReach`, `cleanLayout` (validates and rounds: own fixed designs only, within `LAYOUT_RADIUS`, ≤ `MAX_SPOTS` 2,000, no overlaps), `assignSpots` (the k-th defence of a design takes
    the k-th spot of that design; owner must be the layout's owner).
  - World: `setLayout(world, pid, planet, spots)` (owner of the world only; [] = back to automatic rows;
    no log entry), server action `{ type: 'layout', planet, spots }`; `capture()` deletes the world's layout;
    `planEvent` passes `layoutAt(world, P.id)` to `makeBattleScenario`, which
    keeps a fixed ship → `{ wid, owner }` map, places arranged ones with `assignSpots`, and lays the
    rest with `layoutDefences(..., around = placed)`: each block of rows starts beyond the arranged
    ones in its direction (`defenceReach(around, phi) + 40`). Fleets already start clear via
    `defenceReach` of all defences. No layout = identical to before (tests and bench unchanged).
  - Page: `src/galaxy/arrange.js` (`openArrange`, `arrangeOpen`), opened by **Arrange defences…** in
    the world panel's Defences section (`openArranger()` in `galaxy/app.js`), with a line saying how
    many stand where the player put them, how many are in rows, and empty spots. Full-screen canvas:
    defences drawn from their blocks (`BLOCK_COLOR` sprites), the world, the 1,000-block limit ring,
    a red **ATTACKERS** arrow and dashed arrows for two attackers; **the view is the battle frame turned half round** (owner, 21 Nov 2026: the designer says enemies come from the right, the arranger said left): `toScreen`/`toWorld` negate, `S.cam` is in view coordinates, sprites drawn at `p.a + π`, so attackers come from the right and noses face right as in the Defence Designer; stored spots and battles unchanged (replays still show one attacker coming from the left); **live 21 Nov 2026** with the zoomed-out ships change; drag to
    move (snaps blocks to whole-block lines when turned a multiple of 90°), round handle to turn
    (Shift snaps 15°; on touch it snaps near each 15° step), ⟲/⟳ 15° (Q/E, turns a group round its
    centre), Shift+click / Shift+drag box to select several, Select all (A), Remove empty spots
    (Delete), Re-lay automatically, Fit (F), Save (the canvas size is re-read on every draw and pointer event, `syncSize()` + a ResizeObserver: owner, 20 Nov 2026, clicks often missed because the hint line wrapping after opening changed the canvas height and stretched the picture away from the hit test; hit margin 6 px, 12 on touch); wheel / pinch zoom, drag empty space to pan; Esc
    deselects then leaves (asks if unsaved). Unplaced defences start where one-attacker rows would put
    them (amber dashed outline) and are saved where shown; empty spots (lost defences) are faint and
    saved after the filled ones so new defences refill them; overlaps and out-of-range pieces turn
    red and block Save. Keys are captured while it's open (the galaxy keydown returns early). Phones:
    swipeable bar with Back and Save first.
    **Clicks pick real blocks (owner, 23 Nov 2026: "clicking on the gaps selects the citadel")**, **live 23 Nov 2026** (no patch notes):
    `pieceAt()` keeps its box test as a quick check, then `nearBlock()` needs one of the piece's own blocks within the hit
    margin (6 px, 12 on touch, at most 40 blocks), so the gaps and courtyards of hollow fortresses select what's in them.
    Checked on Aegis II–IV shapes (4,000 random clicks each: every click on a block hits, every click with no block
    within 3 cells misses).
  - Tests: `tools/test-world.mjs` "arranged defences" (touching OK, overlap / too far / not owner / not
    your design refused, battle stands the first 4 of 6 walls exactly as placed, extras in rows beyond
    them toward the attacker, survivors take the first spots, [] resets, capture drops it);
    `tools/test-server.mjs` (Ben can't arrange Ann's world, broken layouts refused). Checked in a
    headless browser on `dist/galaxy.html` (drag, overlap turns red and Save refuses, save stores
    `P.layout`, phone layout). Replay sent: 21 arranged defences (a crescent of walls, bastions behind,
    pickets on the flanks) vs 120 attackers.
- **Aegis fortresses** (owner, 12 Nov 2026: a friend said you couldn't build giant fortresses):
  four ready-made defences in the **Defence Designer's Start from menu** (group "Aegis fortresses",
  `addFortressTemplates()` in `designer/app.js`, defence mode only), each exactly 750,000 cr of blocks
  = a 150,000 cr defence, no thrusters. `src/shared/fortresses.js` holds them (cells gzip + base64,
  ~100 KB for all four; `loadFortress(k)` unpacks with DecompressionStream). Made by generator
  scripts in `tools/fortress-gen/` (README there has the exact commands; they reproduce the packed
  designs exactly); `tools/test-designer.mjs` checks they stay valid (cost, no buried weapons or
  sealed bays). I: Vauban star fort, 8 bastions + ravelins, solid core. II: hollow, 6 arms, keep +
  courtyard + middle wall + bastions, guns in three rings firing down 6 open lanes, hangars deep
  inside with tunnels. III: 5 arms fanned forward (0, ±40, ±80°) + rear shield carrier deck (201
  bays). IV: the owner's pick of "no wasted back": harpoon 999 × 626, 44 plasma (closest pair 13
  blocks apart, past cook-off reach), only forward-bearing guns, PD thinned, 46 bays, thick spear
  neck (a thin one was cut and the front half broke off). Measured (fortress vs a generated mixed
  fleet, designer test layout, 8-min limit; enemy value lost): at 750,000 cr (508 ships) I is
  disarmed (105k), II holds 8 min (395–440k), III routs them (~605k), IV routs them (607k, 235–320 s);
  at 150,000 cr all rout the attackers in 1–2 min. Facing backwards (enemy behind), 400k: II routs,
  III holds (232k), IV holds (116k). Defences at 1/5 of block value make a good giant defence beat ~5×
  its price in ships; the owner was told the lever is `DEFENSE_PRICE_SHARE`.
- **Bounty** (owner, Nov 2026, `BOUNTY_SHARE` 0.2 in `economy.js`, `payBounties()` in `world.js`,
  called from `siegeEnds`): after every battle the players who fought are put in groups of mutual
  allies; each group is paid 20% of everything lost there by the players and militia at war with
  it, split **evenly** between the group's players whatever each brought (owner turned down an
  underdog multiplier as favouritism). Nobody tracks who killed whom: in a free-for-all every
  enemy group is paid for the same losses, and losers are paid too. Militia kills pay (owner:
  "keeps the rule consistent"); militia is never paid. Defences razed when the world falls count
  as lost. Log entry text ends "Bounty (20% of enemy losses): A +n cr, …"; `battle.bounty` =
  `{ playerId: credits }`. Owner's worked example is a test in `tools/test-world.mjs`.
- **A design's worth is its full block price** (owner, Nov 2026: "I might have paid 2,000 for
  defences but it is equal to 10,000 of ships"): `world.designs[id].worth` (`worthOf()`), set in
  `registerDesign` and refreshed by `upgradeWorld`; `cost` stays the purchase price (a defence's
  1/5). Battle `value`/`lost`, `fleetValue`, a world's "cr of hulls" and bounties use worth.
- **Credit gifts** (owner, Nov 2026): Send credits in the Diplomacy window, to any player, ally or
  enemy, whole credits up to what you have, instant, logged (`giveCredits()`, server action
  `{ type: 'gift', player, amount }`).
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
  **Replaced 22 Nov 2026 (owner: "the combat simulator button should lead to a screen where i can select what ships i
  want to fight… several designs against… several designs… every ship currently in the game selectable… a search
  function like typing gob to find the ship called goblin")**, live 22 Nov 2026: in `mode: 'sim'` the designer opens
  `#sim` (full-screen section in `designer/index.html`, code under "battle simulator" in `designer/app.js`) instead of the
  test dialog. Two sides, each a search box (name starts-with first, then contains, then owner or hull class; Enter adds
  the top match; up to 80 shown, grouped In this game / On the designer screen / Saved in this browser / Samples when
  empty) and a fleet list (rows of design + count 0–1,000, default `DEFAULT_COPIES`, ✕, Clear, totals). Choices: every
  design in `world.designs` (all players' and militia; the galaxy now sends `fixed` for every design), the design on the
  designer screen, the browser library, samples, and **on side 2 only (owner, same day: "defences should be listed at
  least for the defending side… test how their fleet would go against a fortress") defences**: groups Defences in this
  game (any `fixed` or thruster-less design), Saved defences, Aegis fortresses (`loadFortresses()`, unpacked once when the
  screen opens). Side 2 is headed "defends"; its defences stand in rows round the origin facing side 1
  (`layoutDefences(..., [π], 2)`), side 2's ships start behind them and side 1 clear of them (`defenceReach`); Swap sides
  keeps defences on side 2; a defence over 3,000 blocks defaults to 1 copy; prices show "defence, N cr to build (M cr of
  blocks)", results count block value. Fleets
  are remembered per browser (`lsb.sim.fleets.v1`, keys `group|owner|name|hash`). Fight / Stop, seed, Swap sides;
  `makeVersusScenario(sides, seed)` in `testBattle.js` (both sides placed with `fleetSpots` like the test battle's
  flying ships); result dialog `#sim-res` (winner, per side and per design: ships, survived, value, lost) and Watch
  replay (`playReplay(back)`, Back returns to the result). Ship designer button hides the screen; the designer's
  top-right button reads Battle simulator in this mode and brings it back. Keys are ignored while it's open. Phones:
  sides stack. Checked in headless Chrome on `dist/galaxy.html` (search, add, fight, replay and back, phone, defences
  only on side 2, a defence row in the replay). **Live 22 Nov 2026** with the combat log change (owner: "make it live"; no
  patch notes). **Fixed 22 Nov 2026 (owner: "I added 1500 of a type of ship but it didn't add value to the total credits
  after 1000 ships")**, **live 22 Nov 2026** (with the mega thruster): each fleet row was cut to 1,000 silently (the box still showed 1,500,
  totals and the fight used 1,000). Now `SIM_MAX` 20,000 per row (the biggest battles tested), `simCount()`; leaving a
  box puts the number really used back in it, with a toast if it was cut. Checked in headless Chrome (1,500 counts
  1,500; 25,000 → 20,000 shown). A huge fight runs in the player's own browser, so it can take minutes (Stop works).
  The owner thought the log card's text line was "the battle number and the ships, redundant": that was the
  made-up text in the preview's fake battles; real entries carry the battle's story there, unchanged.
- **Start positions** (owner, Nov 2026: "giving the player more strategy is always better"): a
  **Start** picker next to Stance in the ship and defence designers (also explained under "Start
  position" in the side panel): Auto, Front, Middle, Back, Top flank, Bottom flank. Saved with the
  design as `place` (`PLACE_INFO`/`placeOf` in `shipStats.js`); `encodeDesign` writes it only when
  it isn't Auto, so every design saved before (and the live save) loads as Auto with no
  `upgradeWorld` change. The same ship with another position is its own world design
  (`registerDesign` compares it). **Auto started exactly as before** (until fleets were spread out on 11 Nov, below): `startSpot()` in
  `battleSetup.js` takes the same two random draws per ship, so a battle with every design on Auto
  is identical (checked against the old code on 80 scenarios). Ships: Front starts at the very front
  of its fleet, Middle in the middle, Back well behind (+60 blocks plus the back of the spread),
  Top/Bottom flank out beyond the edge of the fleet's main body on that wing. "Top" is the top of
  the ship as drawn in the designer with the nose toward the enemy, so two facing fleets' top wings
  are on opposite sides of the screen. Defences (`layoutDefences`): Back ones fill the rows by the
  world first, Front ones last (Auto/Middle between, biggest first as before); Top/Bottom flank
  defences stand in their own block of rows beside the main block (40 apart), on that wing.
  **Each camp starts clear of the defences on its own side only** (`defenceReach(fixed, designs,
  phi)`, owner, 11 Nov 2026: behind a colossus defence the owner's fleet started ~700 blocks too
  far back because every camp cleared the defences' furthest corner in any direction); same in
  the designer test battle. Small defences: identical starts. Used
  by world battles and the designer's test battle (`makeTestScenario`). **Fleets start spread out** (owner, 11 Nov
  2026: ships started in a blob and spread out once the battle began; measured 62–100% of ships
  overlapping another at the start, now none): `fleetSpots()` in `battleSetup.js` sizes each camp's
  area from its ships' real footprints (Σ (w+20)(h+20) × 1.25, about 3:1 wide), takes each ship's
  `startSpot()` as before, then, biggest ships first, moves any ship overlapping one already
  placed to the nearest spot with **`START_GAP` (20) blocks clear** all round (never more than its
  own length forward). Used by world battles and the designer test battle; the bench and
  `designs.js` scenarios keep their old layout. 2,342 ships placed in ~0.35 s. Battles start a
  little further apart (300 v 300 mixed: 115 → 150 s). Stance still decides what
  a ship does once the battle starts. One measured battle (182 attackers vs 115 ships + 32
  defences, seed 7): on Auto the attackers lost (33 vs 109 left); with flank wings, a front line
  and artillery at the back they won (26 vs 12).
- **Renaming worlds** (owner, 14 Nov 2026: only a world you hold): Rename button by the world's name
  in its panel (same dialog as designs, `openRename(null, planetId)`); `renamePlanet()` in `world.js`
  (1–24 chars, control characters stripped, spaces collapsed, no clash with another world's name
  ignoring case; logged), server action `{ type: 'renamePlanet', planet, name }`. Old log text keeps
  the old name; nothing looks worlds up by name.
- **Renaming designs** (owner, Nov 2026): a Rename button on your own shipyards in the world
  panel opens a small dialog; `renameDesign()` in `world.js` (owner only, 1–40 chars, control
  characters stripped) renames the design everywhere and logs it; server action
  `{ type: 'rename', design, name }`.
- **Shipyard shortlist** (owner, Nov 2026): in the New shipyard dialog each design can be starred
  (☆/★, goes to the top) or removed (✕); removed ones sit under "Removed from the list" with a
  Put back button. Kept per browser, per game and player (`lsb.yardlist.v1.<online|local>.<seed>.<player>`
  in localStorage: `{ fav, hidden }` lists of `name|cells` keys); nothing on the server changes.
  New designs get onto the list by being built or saved to the designer library.
- The **Thruster** palette tooltip (and the Top speed stat's hover text) says thrusters also set
  galaxy map speed: a fleet travels at its slowest ship's top speed (owner, Nov 2026).
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

**Big hollow hulls collide by their blocks, not their box** (owner, 13 Nov 2026: ships couldn't get
inside an Aegis fortress's outline though it's open space there): hulls of at least
`BIG_HULL_CELLS` (6,400 = 80 × 80) cells keep a tile map (`e.tiles`, one bit per `TILE` 4 × 4
cells holding a live block; `buildTiles()` from `refit`, `fitChunkBox` and chunk creation).
`collide()` keeps the box test as the broad check, then `tileOverlap()` runs the same 4-axis test
against each solid tile of the big one (pushes summed, deepest overlap used), and `solidAt()`
(fighters' hull avoidance) checks the tiles too, so fighters fly into courtyards. Smaller hulls
are untouched: `npm run bench -- 1000` is identical shot for shot. Measured on Aegis IV at
750,000 cr: enemy ships inside its outline at once 7 → 27.
With every attacker on Charge (500,000 cr): up to 95 inside Aegis II at once (was 6), and II is
then destroyed from the inside (IV still routs them). `aimInRange()` on a big target now picks
squares near the gun from the tile map: random picks over the whole 1,000-block hull were nearly
always out of a short-range gun's reach, and with ships inside, that was 64% of the compute (the
charge battle took 88 s, now 32 s; the old code 30 s).
**Distance to a big hollow target is to its real blocks** (owner, 13 Nov 2026: charging ships
crept in and none reached the middle): stance distances used centre distance − 0.8 × radius, which
for a fortress is its outline, so ships stopped there. Now `gapTo(e, tg)` walks tg's tile map from
e toward tg's centre and returns the distance to the first square holding a block (cached 5 ticks,
`e.gapTo/gapT/gap`); used by `move()` and flankers' `steerGoal()`. `spacing()` keeps ships clear of
a big hull's real blocks (`nearTile()`), not a circle round it. All-charge, 500,000 cr: closest
attacker to the hub, Aegis II 160 → 8 blocks, IV 694 → 383; most inside at once 112 / 108.
The tile map is filled in `refit()`'s own pass over the hull (`prepTiles`), not a second one.
**Holding ships use the nearest real block, not the way in** (owner, 14 Nov 2026: ships and rockets
"dance in a circle right in front of" an Aegis fortress). Three causes, all fixed: (1) `gapTo` along
the line to the centre jumped between a wall (~85) and an open lane (~165) as a ship moved a few
blocks, so Front line / Artillery / Skirmisher ships flipped between closing in and holding. Every
stance except Charge now uses `nearGap()`: a chamfer distance map over the tile map (`e.tdist`,
rebuilt at most once a second after `tdirty`), smooth as the ship moves. Charge keeps `gapTo` so it
still flies down lanes. (2) A holding ship took the crowd-spacing bend as a turn, and `holdFacing`
(least turn among good headings) then kept it, so it rotated on the spot: holding ships now only
slide away from a crowd, never turn for it (this applies to every battle). (3) Guided missiles
can't turn tighter than speed/turn (~38 blocks) and orbited targets that ended up beside them: a
target at distance D and bearing θ with D < 2r·sin|θ| is unreachable, so the missile gives up
(`P.target` = −2) and flies straight. Measured (Aegis II/IV vs the mixed fleet, 2 seeds each):
Front line ships turning >2π in 30 s while staying within 120 blocks 30/6/7/1 → 0/1/0/0; guided
missiles turning >2π 17/3/11/1 → 2/0/0/0. Outcomes (4 fortresses × 3 seeds, 8-min limit): 9 of 12
the same; fortress battles last longer and lean slightly to the fortress (A3: 516/634/510k attacker
value lost → 424/559/613k). Bench 1,000 vs 1,000: 197 → 182 s, ~6.4 ms a tick.
**Guided missiles steer for the block they were launched at** (owner's replay, 14 Nov 2026: a 3,758-ship
3-way battle at Elenris Minor against "SpaceFortress_A", an Aegis II-like hollow fortress). They steered
for the target's centre, which in a hollow fortress is open courtyard (its hub sits 188 blocks off
centre), so they flew in and orbited it at their turning radius (38) until their 90 s ran out: 1,551 of
Nate's 14,961 missiles looped 3+ times. Now the aimed point is kept in the target's frame (`P.ax/P.ay`,
`setMissileAim()` at launch); on a big hull `missileAimLive()` (every 5 ticks) moves it to a nearby
square still holding a block if that one was shot away; a missile that re-seeks a big hull aims at its
nearest block (`nearTile`). The D < 2r·sin|θ| give-up stays as the backstop. Rebuilt from the replay
(designs, teams, start positions; `/tmp`-style script, seed 1): missiles looping 3+ times 881 → 0, 1+
times 2,054 → 710 (mostly one turn to a new target); ships spinning in place 366 → 195 (Front line
103 → 19, Artillery 128 → 43). Skirmishers unchanged (108 → 114): in a crowded fight their target
flips between the fortress (~400 away, "angle in") and nearby enemies (~150, "turn away"), so they
keep turning; that's the Skirmisher rule itself and was raised with the owner, not changed.

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
  Layout: map with a small collapsible **Battles** window in its top-left corner (owner, 11 Nov 2026: only
  fought battles, entries with `e.battle`, so players can scan and watch them; its **All** button,
  `ui.allEvents`, brings back every log entry, since fleets, yards and diplomacy appear nowhere else); the right-hand
  panel is all for the selected world or fleet. In the world panel the ships and move controls
  come first and the **Shipyards** section sits below them, collapsible (owner's request: yards
  were pushing the move controls down; `ui.yardsOpen` is remembered, Build stays in the header).
- **Replay download** (owner, 14 Nov 2026, for bug reports; **since 22 Nov 2026 a playable .html page**, see "Replay downloads are a playable web page"): a Download button next to Watch in the
  combat log (`downloadReplay()` in `galaxy/app.js`) saves `battle-<world>-<id>.lsbreplay`:
  `LSBREPLAY1\n<json: id, title, sides, teams, planet, t, log text>\n` then the packed replay gzipped.
  To read one: split off the two header lines, gunzip the rest, `unpackReplay()`.
- **Combat log** (top-bar button, with a badge for new ones): every battle and every world that
  changed hands, and every siege (Under attack / Attack begins / Joined attack), from the current
  player's side (World taken / World lost / Defended / Repelled / Ambushed / Blocked a fleet). **Since 22 Nov 2026
  (owner: "i only want battles in combat log… colour coded for how big the battles are compared to other battles";
  **live 22 Nov 2026**) only entries with a battle** (`isCombat`; sieges and fight-free captures are gone from it and its
  badge, still in the Battles window's All), **each coloured by size**: `battleSize()` in `galaxy/app.js` ranks the
  battle's total ships (all sides) against every battle in the log (not the filtered list): Epic ≥ 95% of the others
  (and always the biggest), Huge ≥ 80%, Large ≥ 50%, Medium ≥ 20%, Small below; card border tint, a chip "Huge · 2,400
  ships" (tooltip: "the 3rd biggest of 41 battles"), a key at the top. The Battles window's battle lines get the same
  colour on their left edge. Before:
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
  and the player can turn lanes off. Fleets can't be recalled, **but a multi-world trip can be
  called off** (owner, 11 Nov 2026; friends agreed, for the late-game fight): `stopFleet()` in
  `world.js` (server action `{ type: 'stop', fleet }`, "Stop at <next world>" button in the fleet
  panel, two clicks) cuts `legs` after the leg in flight and sets `to`/`arrive` to that stop, so the
  fleet still arrives there on time (and fights if it isn't its side's) but goes no further. A fleet
  holding in a siege on the way stays for it, then stops there. Not for retreating fleets.
- **Rally points** (owner, 12 Nov 2026: "late game with so many ships being built it's hard to gather
  them"): `P.rally = { to, owner }` (optional, no `upgradeWorld` change), set with `setRally()` /
  `rallyAll()` in `world.js` (server actions `{ type: 'rally', planet, to | null }`, `{ type:
  'rallyAll', to, on }`); must be the owner's or an ally's world, not itself. `advanceTo()` collects
  ships its yards build at worlds with a rally point and `sendToRally()` launches them as one fleet
  per world (`fleet.rally = true`), routed with lanes and **avoid on** (never fights on the way).
  Only new ships move. Stay home while the world has a siege. A rally point that isn't friendly
  any more is cancelled (logged) at the next build; `capture()` drops the fallen world's own.
  `advanceTo` returns the number of fleets launched: the server's `catchUp()` saves and tells
  clients; the **online page calls `advanceTo(..., { rally: false })`** so only the server launches
  them. UI: "Rally point" section in the world panel (picker; on friendly worlds "Send new ships
  from all my shipyards here" / "Stop sending them here"), dashed arrow on the map for the
  selected world. Tests in `tools/test-world.mjs` and `tools/test-server.mjs`.
- **Fleets stop at every world on their route** (owner's rule, so enemies can block or ambush
  them). Passing a friendly world they fly straight on. **At any world they don't hold** (owner, 11
  Nov 2026: empty enemy worlds used to be flown past; now a siege, taken at the end of the hold, then
  fly on: `planEvent` returns `siege` for every non-allied stop) they fight any defenders (`battle.passing`): **win and they take
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
  when the battle starts. A player with no worlds, ships or fleets is knocked out. **Victory** (owner, 16 Nov
  2026): as soon as every world is held by players who are all allied with each other (no militia world
  left), they win, plus any player still in who is allied with all of them; enemies left with only
  fleets or guest ships don't stop it (`checkPlayers`, also run by `upgradeWorld`, exported as `checkWin`).
  Before: someone knocked out and everyone left allied, whatever the worlds.
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

- **End-of-game screens** (owner, 16 Nov 2026: the old one-line victory banner was too understated
  for a game that runs for weeks): `src/world/stats.js` keeps `world.stats` (per player: ships built,
  defences built, ships lost and their value, enemy value lost in their battles, income earned,
  bounty, battles fought/won, worlds taken, most worlds at once, biggest battle; galaxy: battles,
  ships destroyed, biggest and longest battle), updated from `advanceTo`, `finishJob`, `siegeEnds`
  and `capture`. Games from before rebuild it once in `upgradeWorld` (`backfillStats`: battles and
  captures from the log, income from who held each world when by walking captures back from today's
  owners, ships built ≈ ships left + ships lost; `backfilled: true`; owner chose not to show a note about it). When the
  galaxy is won `checkPlayers` calls `finalize()`: `world.final` freezes the standings, so the card
  shows the moment of victory while play carries on. Throne = the winner with the most worlds then
  (ties: income, credits earned). Page: `src/galaxy/endCard.js` (full-screen `#endcard`: Victory /
  Defeat / Knocked out, Your war tiles, war records, standings table, honours, Save the picture as
  PNG) and `src/galaxy/throneArt.js` (original SVG: the "Emperor of the galaxy" on the throne in their colour, other
  winners kneeling with swords, fallen players' torn banners). Opens by itself once per browser
  (`lsb.endcard.v1.<online|local>.<seed>.<player>.<win|out>`), the banner's Final results / Your
  results button reopens it, Esc closes. Tests in `tools/test-world.mjs`.

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

## Phones (owner, 11 Nov 2026: "make it so I can do everything on my phone, but don't change how it plays on computer")

Every phone change is behind one condition, so computers never see it: CSS
`@media (max-width: 640px), (pointer: coarse) and (max-height: 500px)` (portrait phones, and
touch screens on their side), JS `PHONE` in `galaxy/app.js` with the same query. Phone-only extras:
`(pointer: coarse) and (max-height: 500px) and (min-width: 641px)` (landscape). Checked by
screenshotting the old and new build at 1440×900, 1100×800 and 800×900 against the same saved
game: identical apart from animation. **Keep new phone styling inside these queries.**
- Galaxy: slim top bar, buttons in one swipeable row (`.topbtns`, `display: contents` on computers);
  "Tap" instead of "Click" in hints when there's no mouse (`CLICK`, `(hover: none) and (pointer: coarse)`);
  after picking a move target the Launch button scrolls into view; inputs 16 px (stops iPhone
  zoom-on-focus); landscape puts map and panel side by side. Replay overlays (galaxy and designer)
  get their Back button as a bar along the top instead of floating over the viewer's controls.
- Designer: header is one swipeable row with Test battle / Build shipyard first; grid fills the
  screen; blocks are a two-row swipeable strip and tools a one-row strip (`.tools`,
  `display: contents` on computers); the phone-only **Stats** button (shows the price, red when the
  design isn't valid) opens `#stats` over the grid (`#app.show-stats`). Touch: one finger draws, two
  fingers pan/zoom (already there), Erase is in the palette; with the Hand tool **a tap shows the
  cell's readout and gun arc** until the next touch (`touchInspect`, never set by a mouse). A
  one-time toast explains the touch controls (`lsb.designer.touchhint.v1`). Landscape: palette down the left.
- Viewer: under 760 px wide, or a touch screen on its side, a replay opens on the whole battle
  (the 2.2 px/block minimum zoom left phones looking at empty space between fleets).
- **Galaxy pinch fixed** (owner: "zoomed in and the map disappeared"; an older bug, not from the phone
  work): during a pinch the one-finger drag measured from the other finger's position, so each step
  jumped the map by the fingers' spread. Now two fingers zoom with their spread and pan with their
  midpoint; the one-finger drag is off while two touches are down and restarts from its own finger.
- **Full-screen map button** (owner, 11 Nov 2026, phones and computers; the one deliberate computer
  change): `#full` in `.nav` after Fit. `setMapOnly()` toggles `#app.map-only` (top bar and side panel
  hidden, map fills the window) and asks for browser full screen where allowed (iPhones refuse for
  pages; map-only still works there). Leaving browser full screen (Esc) leaves map-only; Esc also
  leaves it (after cancelling a move, before deselecting).
- The admin page already worked on phones.

## Working on the live game

- **Patch notes (owner, Nov 2026): every update that goes live adds an entry** to
  `src/shared/patchNotes.js` (newest first, written for players, new unique `id`; or add lines to
  today's entry). The galaxy page's **Patch notes** button (next to Battle simulator and
  Diplomacy) shows them, with a "new" badge until the browser has opened the newest one
  (`lsb.patchnotes.seen.v1`). History was written back from the commit log from launch (4 Nov).

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
- **Out-of-date pages are told to refresh** (owner, 12 Nov 2026, a friend's idea: old pages could
  send outdated or invalid orders). `tools/build-viewer.mjs` stamps `dist/play.html` with
  `<meta name="lsb-build" content="<sha256 of the page, 12 hex>">`; the server reads it from the page
  it serves (`currentBuild()` in `server.mjs`, re-read when the file changes) and adds `build` to
  every `/api/state` and `/api/act` answer. The page sends its own as the `X-LSB-Build` header
  (`BUILD` in `net.js`). `/api/act` with another or no build id → **409 `{ outdated: true }`, not
  carried out**; the page then shows the `#update` bar ("Refresh now", `location.reload()`), and also
  as soon as a state answer carries another build. Server-only changes don't change the page hash, so
  they don't prompt. Tests: `tools/test-server.mjs` sends the header and checks refusals.
- **Only what changed is sent (owner, 15 Nov 2026: Railway bills egress, $0.05/GB; ~58 GB in the first 11
  days).** The server used to send every open tab the whole world (designs and log included) on every
  change, the whole world again in every `/api/act` answer, and the replay id list on every 25 s poll.
  Now: `server/worldSync.mjs` cuts the world into pieces (each element of a top-level array, each entry of
  a top-level object with > 8 entries, every other top-level value whole), named by a 12-char sha1 of
  their JSON, kept as JSON text taken at layout time (the live world drifts between versions: clock,
  credits, yards' ships). Every distinct layout gets an id (`sid`, starting at `Date.now()` so ids keep
  rising across restarts); the page sends the id it holds as `wv` (query param on `/api/state`, header
  `X-LSB-WV` on `/api/act`) and gets `wdelta` = `{ from, sid, keys, drop, vals }`: layouts of changed keys
  (arrays as `[start, count]` runs of its old layout plus new hashes) and only the pieces it lacks; an
  unknown or -1 `from` gets everything. The world still goes only when `worldVersion` moved on since the
  page's layout (as before; the page runs the clock forward itself). `src/galaxy/worldDelta.js`
  (`WorldCopy`, used by `net.js`) remembers the last 6 layouts (so an answer that crossed a newer one still
  applies; an older one is ignored), rebuilds a fresh world by joining JSON text and parsing it (no shared
  objects; the page mutates its copy), and on any mismatch asks for everything again. Replay ids go only
  when the count changed (`rc` param / `X-LSB-RC`). The game page has an `ETag` (304 when unchanged; was
  ~330 KB every load). `/admin` shows **Data sent to players** since the server started, by kind
  (`TRAFFIC` in `server.mjs`, +400 bytes a response for headers). Tests: `tools/test-sync.mjs` (300 random
  world changes, a page 7 versions behind, a late answer; 3% of the bytes) and `tools/test-server.mjs`
  (deltas in act answers, replay list, 304); the test client rebuilds worlds with `WorldCopy`.
- **Disk full (owner, 15 Nov 2026)**: the Railway volume (500 MB, made on the trial; Hobby allows 5 GB, grown
  live in the volume's Settings) filled with replays after a massive battle; every `save()` threw ENOSPC, so
  every order answered "Server error." though it had happened in memory. Now `save()` never throws: on
  failure it deletes the half-written `game.json.tmp`, on ENOSPC prunes replays and retries, else records
  `saveError` (shown on `/admin`, logged "SAVE FAILED" at most once a minute). `pruneReplays(need)` deletes
  the oldest replays (by battle number) whenever free space (`statfsSync`) drops under min(300 MB, a fifth of
  the disk) + need, keeping the newest 10; run before every save and every replay write (`storeReplay`
  never throws: a replay that can't be written is dropped, not the battle). The replay list's version is
  `replayVer` (the page's `rc`), bumped on add and delete. `/admin` has a **Storage** section (disk size,
  free, replays). Test: `tools/test-storage.mjs`.
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
- Battle time limit is 15 minutes (`BATTLE_MAX_TIME` in `rules.js`, owner, 13 Nov 2026; was 8). Battles
  that reach the limit take up to ~2× the compute and replay size of the 8-minute limit; watch Railway
  memory on huge ones.

