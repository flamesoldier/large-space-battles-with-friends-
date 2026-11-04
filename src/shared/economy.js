// Every economy number in one place, so it can be tuned in one place. Shared by the ship
// designer, the galaxy map and (later) the server.
//
// How ships are bought: a player buys a shipyard on one of their worlds for one design.
// The shipyard then builds that ship for free every SHIPYARD_INTERVAL_MIN minutes, forever,
// until an enemy takes the world (which destroys every shipyard on it) or the owner sells it.
// A world can hold any number of shipyards, but each one costs more than the last
// (SHIPYARD_CROWDING_SHARE), to push players to build on every world they hold rather than
// stacking everything on their home world. So the only price a player pays is the shipyard's,
// and it is set by the price of the ship it makes.

import { designCost } from './shipStats.js';

export const SHIPYARD_INTERVAL_MIN = 30;

// A shipyard costs this many ships' worth of credits. At 10 it pays for itself after 10 ships
// (5 hours at one ship per 30 min); everything after that is profit while the world holds.
export const SHIPYARD_PRICE_MULT = 10;

/** List price of a shipyard for this design on an empty world. */
export const shipyardPrice = (design) => designCost(design) * SHIPYARD_PRICE_MULT;

// Crowding: every shipyard already on a world adds SHIPYARD_CROWDING_SHARE of its list price to
// the price of the next one there. With 1%, a world's 100th shipyard of the same kind costs 1.99×
// its first, whatever the ship costs. List prices, not what was paid, so it doesn't compound.
// Measured per world, so spreading shipyards over your worlds keeps them at list price.
export const SHIPYARD_CROWDING_SHARE = 0.01;
export const crowdingSurcharge = (existingListValue) => Math.round(existingListValue * SHIPYARD_CROWDING_SHARE);
export const shipyardPriceAt = (design, existingListValue) => shipyardPrice(design) + crowdingSurcharge(existingListValue);

// Selling a shipyard gives back this share of what was actually paid for it.
export const SHIPYARD_SELL_REFUND = 0.5;

// Income: every world pays a fixed number of credits per hour into its owner's global pool.
// Home worlds pay HOME_INCOME; every other world rolls a fixed value in PLANET_INCOME (in
// steps of 50) when the galaxy is made, and keeps it whoever owns it.
export const HOME_INCOME = 1500;
export const PLANET_INCOME = [400, 1000];
export const STARTING_CREDITS = 20000;

// Unclaimed worlds are held by militia ships worth this many hours of the world's income
// (0 = undefended: the first fleet to arrive takes it).
export const NEUTRAL_GARRISON_HOURS = 4;
