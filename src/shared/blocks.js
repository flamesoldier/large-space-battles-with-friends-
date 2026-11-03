// Block catalogue shared by the ship designer, the battle sim and the replay viewer.
// 1 block = 1 world unit. Ship local +x is "forward" (the nose).

export const BT = {
  EMPTY: 0,
  HUB: 1, // the ship's core. Destroy it and the whole ship breaks apart.
  ARMOR: 2,
  HEAVY: 3, // heavy armour
  FRAME: 4, // light internal structure
  THRUSTER: 5,
  LASER: 6, // long-range beam: always hits, low damage
  CANNON: 7, // slow straight-flying shells with a bright trail: the main damage dealer
  MISSILE: 8, // huge, slow, long-range missiles that can be shot down
  PD: 9, // point defence: short-range rapid laser, kills missiles, also hits close ships
  LANCE: 10, // heavy laser: a 10x10 multi-block gun, slow, long range, beam cuts through ships
};

// Multi-block weapons: footprint in blocks, and the fraction of those blocks that must
// survive for the gun to keep firing.
export const MULTIBLOCK = {
  [BT.LANCE]: { size: 10, minIntact: 0.5 },
};

// cost: credits per block, paid once when the design is bought (via its shipyard).
// Structure is cheap and weapons and engines are expensive, so a good design spends most of its
// blocks on armour and frame and a fair share of its credits on the few guns that do the work.
// These are the only place prices live; the designer, shipyards and fleets all read them.
export const BLOCKS = {
  [BT.HUB]: { name: 'Hub', hp: 450, mass: 4, cost: 40 },
  [BT.ARMOR]: { name: 'Armor', hp: 110, mass: 2, cost: 3 },
  [BT.HEAVY]: { name: 'Heavy armor', hp: 240, mass: 4, cost: 7 },
  [BT.FRAME]: { name: 'Frame', hp: 45, mass: 1, cost: 1 },
  [BT.THRUSTER]: { name: 'Thruster', hp: 60, mass: 1.5, thrust: 10, cost: 20 },
  [BT.LASER]: { name: 'Laser', hp: 130, mass: 2, cost: 45 },
  [BT.CANNON]: { name: 'Cannon', hp: 150, mass: 3, cost: 60 },
  [BT.MISSILE]: { name: 'Missile launcher', hp: 200, mass: 5, cost: 120 },
  [BT.PD]: { name: 'Point defense', hp: 80, mass: 1.5, cost: 30 },
  [BT.LANCE]: { name: 'Heavy laser', hp: 120, mass: 4, cost: 35 }, // per block; the gun is 10x10 of these (3,500 a gun)
};

// A destroyed heavy-laser block explodes: blast damage peak * (1 - d / radius)^2 to every block
// in range, on any ship, own and allied included (friendly fire setting ignored). Neighbouring
// heavy-laser blocks it kills explode in turn, so one gun can chain-react.
export const COOKOFF = { radius: 5, damage: 260 };

// Weapon behaviour. Ranges/speeds in world units (blocks) and seconds.
export const WEAPON = {
  // Instant beam, never misses what it's aimed at, but slow to recharge.
  [BT.LASER]: { kind: 'laser', range: 260, damage: 32, cooldown: 2.6 },
  // Slow shell that flies dead straight (aimed with lead at firing), small blast on impact.
  [BT.CANNON]: { kind: 'shell', range: 200, damage: 75, cooldown: 2.0, speed: 45, life: 5.5, splash: 1.6, spread: 0.05 },
  // Heavy missile: unguided, crawls across the map in a straight line, flies over friendly
  // ships, devastating blast. Has hit points, so point defence can shoot it down on the way in.
  // Blast damage falls off with distance: peak * (1 - d / splash)^2, applied to every ship
  // (and wreck) in the radius. One missile cratres a hull; a volley tears it apart.
  // All launchers on a ship fire together as a rippling volley at the same target.
  [BT.MISSILE]: { kind: 'missile', range: 700, damage: 200, cooldown: 40, speed: 20, life: 45, splash: 9, hp: 100, spread: 0.02, maxLead: 3 },
  // Point defence: shoots the nearest enemy missile in range, otherwise any enemy ship that close.
  [BT.PD]: { kind: 'pd', range: 30, damage: 6, missileDamage: 10, cooldown: 0.2 },
  // Heavy laser: a 10x10 gun that fires wherever its unit can see past the rest of the ship. The beam carries a damage budget and
  // burns through block after block (and ship after ship) until the budget is spent.
  // It holds fire if a friendly ship is the first thing in the line of fire.
  [BT.LANCE]: { kind: 'lance', range: 450, damage: 2500, cooldown: 20 },
};

// Firing arcs: every weapon can fire in any direction where its shot wouldn't pass through its
// own ship (see arcs.js). The heavy laser looks out from the centre of its 10x10 unit.

export const isWeapon = (t) => t >= BT.LASER && t <= BT.LANCE;

// Hull classes come from block count (the ship designer shows which one a design falls in).
// Limits keep every battle inside the compute budget in docs/ARCHITECTURE.md.
export const HULL_CLASSES = [
  { id: 'corvette', name: 'Corvette', maxBlocks: 40 },
  { id: 'frigate', name: 'Frigate', maxBlocks: 85 },
  { id: 'destroyer', name: 'Destroyer', maxBlocks: 200 },
  { id: 'cruiser', name: 'Cruiser', maxBlocks: 500 },
  { id: 'battleship', name: 'Battleship', maxBlocks: 1200 },
  { id: 'titan', name: 'Titan', maxBlocks: 3000 },
];
export const MAX_BLOCKS = HULL_CLASSES[HULL_CLASSES.length - 1].maxBlocks;
// Largest grid a design may use (width along the nose axis x height).
export const MAX_W = 96, MAX_H = 64;
