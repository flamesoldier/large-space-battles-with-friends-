// Every economy number in one place, so it can be tuned in one place. Shared by the ship
// designer, the galaxy map and (later) the server.
//
// How ships are bought: a player buys a shipyard on one of their worlds for one design.
// The shipyard then builds that ship for free every SHIPYARD_INTERVAL_MIN minutes, forever,
// until an enemy takes the world (which destroys every shipyard on it) or the owner sells it.
// A world can hold any number of shipyards, but each one costs more than the last
// (SHIPYARD_CROWDING_CR), to push players to build on every world they hold rather than
// stacking everything on their home world. So the only price a player pays is the shipyard's,
// and it is set by the price of the ship it makes.

import { designCost } from './shipStats.js';

export const SHIPYARD_INTERVAL_MIN = 30;

// A shipyard costs this many ships' worth of credits. At 10 it pays for itself after 10 ships
// (5 hours at one ship per 30 min); everything after that is profit while the world holds.
export const SHIPYARD_PRICE_MULT = 10;

/** List price of a shipyard for this design on an empty world. */
export const shipyardPrice = (design) => designCost(design) * SHIPYARD_PRICE_MULT;

// Crowding: a shipyard costs (1 + V / SHIPYARD_CROWDING_CR) × its list price, where V is the
// list price of all the shipyards already on that world. List prices, not what was paid, so the
// surcharge doesn't compound. At 25,000: a second destroyer yard costs ~1.4×, and a world that
// already holds 100,000 credits of yards charges 5× for the next one.
export const SHIPYARD_CROWDING_CR = 25000;
export const crowdingMult = (existingListValue) => 1 + existingListValue / SHIPYARD_CROWDING_CR;
export const shipyardPriceAt = (design, existingListValue) => Math.round(shipyardPrice(design) * crowdingMult(existingListValue));

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
