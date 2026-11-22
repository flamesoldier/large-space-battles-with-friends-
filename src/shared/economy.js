// Every economy number in one place, so it can be tuned in one place. Shared by the ship
// designer, the galaxy map and (later) the server.
//
// How ships are bought: a player buys a shipyard on one of their worlds for one design.
// The shipyard then builds that ship for free every SHIPYARD_INTERVAL_MIN minutes, forever,
// until an enemy takes the world (which destroys every shipyard on it) or the owner sells it.
// A world can hold any number of shipyards, but each one costs more than the last
// (SHIPYARD_CROWDING_VALUE), to push players to build on every world they hold rather than
// stacking everything on their home world. So the only price a player pays is the shipyard's,
// and it is set by the price of the ship it makes.

import { designCost } from './shipStats.js';

// Version 2.0 (owner, 18 Nov 2026): every SHIPYARD_INTERVAL_MIN each shipyard builds SHIPS_PER_BUILD
// ships, and all the shipyards on a world build at the same moment (the world's own build clock), so
// everything built there leaves together as one fleet. 1.0 was one ship every 30 min.
export const SHIPYARD_INTERVAL_MIN = 90;
export const SHIPS_PER_BUILD = 5;

// A shipyard costs this many ships' worth of credits. At 10 it pays for itself after 10 ships
// (3 hours at 5 ships per 90 min); everything after that is profit while the world holds.
// 2.0: to be raised with the test games (owner plans dearer weapons and a higher crowding tax).
export const SHIPYARD_PRICE_MULT = 10;

/** List price of a shipyard for this design on an empty world. */
export const shipyardPrice = (design) => designCost(design) * SHIPYARD_PRICE_MULT;

// Crowding (owner, Nov 2026): a new shipyard costs a percentage more than its list price, set by
// the value of the shipyards already on that world: +100% for every SHIPYARD_CROWDING_VALUE
// credits of them (750,000 of yards there → 2×, 1.5 million → 3×). A percentage of the new yard's
// own price, so one big shipyard and many small ones of the same total pay the same share (the
// old rule, a flat 1% of the yards already there, let big shipyards dodge it). List prices, not
// what was paid, so it doesn't compound. Measured per world, so spreading out keeps list price.
// 2.0 (owner, 18 Nov 2026): +100% for every 325,000 cr (1.0: 750,000), for more, smaller fleets.
export const SHIPYARD_CROWDING_VALUE = 325000;
export const crowdingMult = (existingListValue) => 1 + existingListValue / SHIPYARD_CROWDING_VALUE;
export const crowdingSurcharge = (list, existingListValue) => Math.round(list * (existingListValue / SHIPYARD_CROWDING_VALUE));
export const shipyardPriceAt = (design, existingListValue) => shipyardPrice(design) + crowdingSurcharge(shipyardPrice(design), existingListValue);

// Defences (owner, Nov 2026: a friend lost his home world and wanted static defences): built
// from the same blocks but with no thrusters, they never move and can't leave their world.
// Bought once, outright (no shipyard): a defence costs this share of its blocks' price, and when
// it's destroyed it's gone. They are destroyed too if the world falls.
export const DEFENSE_PRICE_SHARE = 0.2;
export const defensePrice = (design) => Math.max(1, Math.round(designCost(design) * DEFENSE_PRICE_SHARE));
// Most defences one order can buy (just a guard against typos).
export const MAX_DEFENSE_ORDER = 1000;

// Bounty (owner, Nov 2026): after every battle each group of allies that fought is paid this share
// of the value (full block price, defences and militia included) its enemies lost there, split
// evenly between the group's players. Nobody tracks who killed whom: in a free-for-all every
// enemy group is paid for the same losses, and the losing side is paid too.
export const BOUNTY_SHARE = 0.1; // 2.0 (owner, 18 Nov 2026: more ships, more fighting); was 0.2

// Selling a shipyard gives back this share of what was actually paid for it.
export const SHIPYARD_SELL_REFUND = 0.65; // 2.0 (owner, 18 Nov 2026); 1.0: 0.95 (before that 0.5)

// Selling a shipyard and building defences take time. 1.0 (owner, Nov 2026): 5 h, so neither could
// be done as a reaction to an attack. 2.0 (owner, 18 Nov 2026): 5 minutes, so defences CAN be built
// in reaction to an attack ("building defences will be much more important"); selling is just as
// quick but pays back less (SHIPYARD_SELL_REFUND). Both in hours. A shipyard being sold stops
// building and pays out when the time is up; defences are paid for up front and join the garrison
// when they're finished. If the world falls first, both are lost.
export const SELL_HOURS = 5 / 60;
export const DEFENSE_BUILD_HOURS = 5 / 60;

// Income: every world pays a fixed number of credits per hour into its owner's global pool.
// Home worlds pay HOME_INCOME. Every other world pays PLANET_INCOME_BASE plus
// PLANET_INCOME_PER_LANE for each hyperlane it has (owner, 22 Nov 2026: more lanes are harder
// to hold, so they should be worth more, and no random incomes). Set when the galaxy is made
// (`planetIncome()`), kept whoever owns it. Generated worlds have 1–7 lanes, ~3.4 on average,
// so 220–820 cr/h, ~460 on average (owner, 22 Nov 2026: a 3-lane world should make at least 420).
export const HOME_INCOME = 500;
export const PLANET_INCOME_BASE = 120;
export const PLANET_INCOME_PER_LANE = 100;
export function planetIncome(lanes) { return PLANET_INCOME_BASE + PLANET_INCOME_PER_LANE * lanes; }
export const STARTING_CREDITS = 20000;

// Unclaimed worlds are held by militia ships worth NEUTRAL_GARRISON_BASE credits plus this many
// hours of the world's income (both 0 = undefended: the first fleet to arrive takes it). 2.0: 12 h
// (1.0: 4). The base (owner, 22 Nov 2026: militia was "too easy to take… enough for 1.5 attacks"):
// a starting player's first siege gathers 2–3 waves of its 20,000-credit start (~20–30k), so
// militia of ~21.5–24k holds against 2 waves and falls to 3, ~1.5 attacks a world on average.
export const NEUTRAL_GARRISON_BASE = 20000;
export const NEUTRAL_GARRISON_HOURS = 12;
