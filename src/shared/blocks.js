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
  CANNON: 7, // slow guided shells with a bright trail: the main damage dealer
  MISSILE: 8, // huge, slow, long-range missiles that can be shot down
  PD: 9, // point defence: short-range rapid laser, kills missiles, also hits close ships
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
};

// Weapon behaviour. Ranges/speeds in world units (blocks) and seconds.
export const WEAPON = {
  // Instant beam, never misses what it's aimed at, but slow to recharge.
  [BT.LASER]: { kind: 'laser', range: 260, damage: 22, cooldown: 2.6 },
  // Slow shell that flies dead straight (aimed with lead at firing), small blast on impact.
  [BT.CANNON]: { kind: 'shell', range: 170, damage: 50, cooldown: 2.0, speed: 45, life: 5.5, splash: 1.6, spread: 0.05 },
  // Heavy missile: unguided, crawls across the map in a straight line, flies over friendly
  // ships, devastating blast. Has hit points, so point defence can shoot it down on the way in.
  [BT.MISSILE]: { kind: 'missile', range: 700, damage: 220, cooldown: 24, speed: 20, life: 45, splash: 4.5, hp: 40, spread: 0.02 },
  // Point defence: shoots the nearest enemy missile in range, otherwise any enemy ship that close.
  [BT.PD]: { kind: 'pd', range: 30, damage: 6, missileDamage: 10, cooldown: 0.2 },
};

// Firing arcs: a weapon faces out of whichever hull sides it is exposed on, and can only
// fire at targets within ARC_DEG of that direction. Missile launchers fire in any direction.
export const ARC_DEG = 100;

export const isWeapon = (t) => t >= BT.LASER && t <= BT.PD;
