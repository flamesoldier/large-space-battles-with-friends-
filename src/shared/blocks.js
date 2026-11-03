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

export const BLOCKS = {
  [BT.HUB]: { name: 'Hub', hp: 450, mass: 4 },
  [BT.ARMOR]: { name: 'Armor', hp: 110, mass: 2 },
  [BT.HEAVY]: { name: 'Heavy armor', hp: 240, mass: 4 },
  [BT.FRAME]: { name: 'Frame', hp: 45, mass: 1 },
  [BT.THRUSTER]: { name: 'Thruster', hp: 60, mass: 1.5, thrust: 10 },
  [BT.LASER]: { name: 'Laser', hp: 130, mass: 2 },
  [BT.CANNON]: { name: 'Cannon', hp: 150, mass: 3 },
  [BT.MISSILE]: { name: 'Missile launcher', hp: 200, mass: 5 },
  [BT.PD]: { name: 'Point defense', hp: 80, mass: 1.5 },
  [BT.LANCE]: { name: 'Heavy laser', hp: 120, mass: 4 }, // per block; the gun is 10x10 of these
};

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
  // Heavy laser: turret-mounted, fires any direction. The beam carries a damage budget and
  // burns through block after block (and ship after ship) until the budget is spent.
  // It holds fire if a friendly ship is the first thing in the line of fire.
  [BT.LANCE]: { kind: 'lance', range: 450, damage: 2500, cooldown: 20 },
};

// Firing arcs: a weapon faces out of whichever hull sides it is exposed on, and can only
// fire at targets within ARC_DEG of that direction. Missile launchers and heavy lasers
// (turrets) fire in any direction.
export const ARC_DEG = 100;

export const isWeapon = (t) => t >= BT.LASER && t <= BT.LANCE;
