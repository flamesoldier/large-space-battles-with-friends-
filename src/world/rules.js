// Galaxy and fleet movement rules. Money lives in src/shared/economy.js; this is space and time.

export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;
export const DEFAULT_PLANETS_PER_PLAYER = 7;

// Map scale, in galaxy units. Planets are at least PLANET_SPACING apart (home worlds get more room).
export const PLANET_SPACING = 58;
export const HOME_CLEARANCE = 95;

// Fleet travel. A fleet moves at its slowest ship's battle top speed (blocks per second, from
// shipStats) × TRAVEL_SCALE galaxy units per hour. Neighbouring worlds are ~70–100 units apart,
// so a destroyer (7.7) takes about 10 hours through normal space and one hour along a hyperlane;
// a titan (4.6) about 18 hours and 2 hours.
export const TRAVEL_SCALE = 1;
// Moving along a hyperlane is this many times faster than flying through normal space.
export const HYPERLANE_SPEEDUP = 10;
// Ships slower than this (no real engines) can't leave their world: they are fixed defences.
export const MIN_FLEET_SPEED = 0.5;

// How long a battle may run (simulated seconds). 15 minutes (owner, 13 Nov 2026; was 8, and 4 while
// testing). The designer's test battle and Battle simulator use the same limit.
export const BATTLE_MAX_TIME = 900;

// When a fleet reaches a world it means to attack (or defenders bar its way), the battle waits
// this long so reinforcements from both sides can arrive and join in. Game minutes.
export const BATTLE_HOLD_MIN = 30;

export const HOUR_MS = 3600 * 1000;

// Ten easy-to-tell-apart faction colours, in the order players get them by default.
export const PLAYER_COLORS = ['#86e8ff', '#ffb35c', '#a3f27c', '#ff6fa8', '#c59bff', '#ffe66b', '#5ce0c0', '#ff7a5c', '#7aa7ff', '#e8e8e8'];
export const NEUTRAL_COLOR = '#6e7a8c';
// What a player can pick from when they choose their own colour online: the ten above plus a few more.
export const CHOOSABLE_COLORS = [...PLAYER_COLORS, '#ff4d4d', '#4dff88', '#3d7bff', '#ffa3e0', '#b8ff3d', '#ff9f1a', '#00c2c7', '#a17cff'];
