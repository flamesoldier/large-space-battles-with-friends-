// Economy rules that the ship designer already needs to show. The world map, income and fleets
// come later; keep every economy number here so it can be tuned in one place.
//
// How ships are bought: a player buys a shipyard on one of their worlds for one design.
// The shipyard then builds that ship for free every SHIPYARD_INTERVAL_MIN minutes, forever,
// until an enemy takes the world (which destroys every shipyard on it). A world can hold any
// number of shipyards. So the only price a player pays is the shipyard's, and it is set by the
// price of the ship it makes.

import { designCost } from './shipStats.js';

export const SHIPYARD_INTERVAL_MIN = 30;

// A shipyard costs this many ships' worth of credits. At 10 it pays for itself after 10 ships
// (5 hours at one ship per 30 min); everything after that is profit while the world holds.
export const SHIPYARD_PRICE_MULT = 10;

export const shipyardPrice = (design) => designCost(design) * SHIPYARD_PRICE_MULT;
