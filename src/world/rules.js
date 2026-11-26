// Galaxy and fleet movement rules. Money lives in src/shared/economy.js; this is space and time.

export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;
export const DEFAULT_PLANETS_PER_PLAYER = 7;

// Map scale, in galaxy units. Planets are at least PLANET_SPACING apart (home worlds get more room).
export const PLANET_SPACING = 58;
export const HOME_CLEARANCE = 95;

// Fleet travel. A fleet moves at its slowest ship's battle top speed (blocks per second, from
// shipStats) × TRAVEL_SCALE galaxy units per hour. Neighbouring worlds are ~70–100 units apart.
// 2.0 (owner, 18 Nov 2026): a third of 1.0's speed (TRAVEL_SCALE was 1), so a destroyer (7.7) takes
// about 30 hours through normal space and ~3 hours along a hyperlane.
export const TRAVEL_SCALE = 1 / 3;
// Moving along a hyperlane is this many times faster than flying through normal space, for a fleet
// whose slowest ship has LANE_REF_SPEED. On lanes speed counts for less (2.0, owner: in 1.0 everyone
// needed all-fast ships): lane speed ∝ speed^LANE_SPEED_EXP, so a ship twice as fast is 2^0.485 =
// 1.4× (40%) faster on a lane, half as fast is 0.71×. Normal space keeps full speed.
export const HYPERLANE_SPEEDUP = 10;
// 2.0 (owner, 19 Nov 2026): normal space is only half as fast as the same fleet on a hyperlane (was
// 10× slower). Only beaten fleets with no friendly lane neighbour fly through normal space in 2.0; at
// 10× a retreat could take a day or more, and a fleet heading for a world that fell meanwhile kept
// that world pinned the whole time.
export const SPACE_VS_LANE = 0.5;
export const LANE_REF_SPEED = 7.7; // a typical destroyer: its lane time is exactly 10× faster than space
export const LANE_SPEED_EXP = Math.log2(1.4);
// Ships slower than this (no real engines) can't leave their world: they are fixed defences.
export const MIN_FLEET_SPEED = 0.5;

// How long a battle may run (simulated seconds). 15 minutes (owner, 13 Nov 2026; was 8, and 4 while
// testing). The designer's test battle and Battle simulator use the same limit.
export const BATTLE_MAX_TIME = 900;

// When a fleet reaches a world it means to attack (or defenders bar its way), the battle waits
// this long so reinforcements from both sides can arrive and join in. Game minutes.
// 2.0: 180 (owner, 18 Nov 2026; 1.0: 30), two build cycles, so each side gets two waves of
// reinforcements and fleets a few hyperlane hops away still make it.
export const BATTLE_HOLD_MIN = 180;

// Allies arriving together (owner, 25 Nov 2026): when allied attackers' fleets reach a world within
// this many game minutes of the siege opening, the world they take goes to one of them by lot,
// each one's chance = the credit value of the ships they arrived with (70k vs 30k: 70% / 30%).
// Otherwise the player who started the siege takes it, as before.
export const ARRIVE_TOGETHER_MIN = 1;

export const HOUR_MS = 3600 * 1000;

// Ten easy-to-tell-apart faction colours, in the order players get them by default.
// Respread 26 Nov 2026 (owner: "the 2 purples and the 2 oranges are too similar"): the old 18 had
// pairs only 6–10 apart (CIEDE2000; orange/orange 6.4, purple/purple 10.0, green/green 8.6); now no
// two of the 18 are closer than 15 and no two of the first ten closer than 18.7. Each slot keeps the
// same family where it could (Player 2 is still orange), so players don't suddenly change colour.
export const PLAYER_COLORS = ['#5ce8ff', '#ff9a1f', '#8fe04a', '#ff4f9a', '#b77cff', '#ffe23d', '#2fd1a0', '#ff5a3a', '#5b8cff', '#ececec'];
export const NEUTRAL_COLOR = '#6e7a8c';
// What a player can pick from when they choose their own colour online: the ten above plus a few more.
export const CHOOSABLE_COLORS = [...PLAYER_COLORS, '#f89890', '#309800', '#00b0f0', '#f8b8f8', '#989000', '#b07840', '#009878', '#e800e8'];
// The palette before 26 Nov 2026, slot for slot: upgradeWorld moves players on to the new colour in
// the same slot, and the replay viewer draws old replays in the new colours.
const OLD_COLORS = ['#86e8ff', '#ffb35c', '#a3f27c', '#ff6fa8', '#c59bff', '#ffe66b', '#5ce0c0', '#ff7a5c', '#7aa7ff', '#e8e8e8', '#ff4d4d', '#4dff88', '#3d7bff', '#ffa3e0', '#b8ff3d', '#ff9f1a', '#00c2c7', '#a17cff'];
// Owner, 26 Nov 2026 (after the first remap went live): "swap the oranges, the greens, the purples and the
// (player 7 / player 17 one) so that my players get the colours they want". These four pairs of new colours trade
// places: old #ffb35c → brown, old #ff9f1a → orange, and so on.
export const COLOR_SWAP = Object.fromEntries([['#ff9a1f', '#b07840'], ['#8fe04a', '#309800'], ['#b77cff', '#e800e8'], ['#2fd1a0', '#009878']]
  .flatMap(([a, b]) => [[a, b], [b, a]]));
// Second request the same evening (owner: "player 15 wants the player 3 colour and player 11 wants the player 8 colour";
// "player N" = slot N of CHOOSABLE_COLORS): olive ↔ light green, salmon ↔ red-orange. Swapped, so if someone already
// had the wanted colour they take the other one and no two players share a colour.
export const COLOR_SWAP2 = Object.fromEntries([['#989000', '#8fe04a'], ['#f89890', '#ff5a3a']].flatMap(([a, b]) => [[a, b], [b, a]]));
export const RECOLOR = Object.fromEntries(OLD_COLORS.map((c, k) => [c, COLOR_SWAP[CHOOSABLE_COLORS[k]] || CHOOSABLE_COLORS[k]]));
/** A colour from the old palette → its new one; anything else unchanged. */
export const recolor = (c) => (typeof c === 'string' && RECOLOR[c.toLowerCase()]) || c;
