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

export const HOUR_MS = 3600 * 1000;

// Ten easy-to-tell-apart faction colours, in the order players get them by default.
export const PLAYER_COLORS = ['#86e8ff', '#ffb35c', '#a3f27c', '#ff6fa8', '#c59bff', '#ffe66b', '#5ce0c0', '#ff7a5c', '#7aa7ff', '#e8e8e8'];
export const NEUTRAL_COLOR = '#6e7a8c';
// What a player can pick from when they choose their own colour online: the ten above plus a few more.
export const CHOOSABLE_COLORS = [...PLAYER_COLORS, '#ff4d4d', '#4dff88', '#3d7bff', '#ffa3e0', '#b8ff3d', '#ff9f1a', '#00c2c7', '#a17cff'];
