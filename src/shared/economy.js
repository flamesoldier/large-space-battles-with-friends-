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

export const SHIPYARD_INTERVAL_MIN = 30;

// A shipyard costs this many ships' worth of credits. At 10 it pays for itself after 10 ships
// (5 hours at one ship per 30 min); everything after that is profit while the world holds.
export const SHIPYARD_PRICE_MULT = 10;

/** List price of a shipyard for this design on an empty world. */
export const shipyardPrice = (design) => designCost(design) * SHIPYARD_PRICE_MULT;

// Crowding (owner, Nov 2026): a new shipyard costs a percentage more than its list price, set by
// the value of the shipyards already on that world: +100% for every SHIPYARD_CROWDING_VALUE
// credits of them (750,000 of yards there → 2×, 1.5 million → 3×). A percentage of the new yard's
// own price, so one big shipyard and many small ones of the same total pay the same share (the
// old rule, a flat 1% of the yards already there, let big shipyards dodge it). List prices, not
// what was paid, so it doesn't compound. Measured per world, so spreading out keeps list price.
export const SHIPYARD_CROWDING_VALUE = 750000;
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

// Selling a shipyard gives back this share of what was actually paid for it.
export const SHIPYARD_SELL_REFUND = 0.95; // owner, Nov 2026 (was 0.5)

// Income: every world pays a fixed number of credits per hour into its owner's global pool.
// Home worlds pay HOME_INCOME; every other world rolls a fixed value in PLANET_INCOME (in
// steps of 50) when the galaxy is made, and keeps it whoever owns it.
export const HOME_INCOME = 1500;
export const PLANET_INCOME = [400, 1000];
export const STARTING_CREDITS = 20000;

// Unclaimed worlds are held by militia ships worth this many hours of the world's income
// (0 = undefended: the first fleet to arrive takes it).
export const NEUTRAL_GARRISON_HOURS = 4;
