// Block catalogue shared by the ship designer, the battle sim and the replay viewer.
// 1 block = 1 world unit. Ship local +x is "forward" (the nose).

export const BT = {
  EMPTY: 0,
  HUB: 1, // the ship's core. Destroy it and the whole ship breaks apart.
  ARMOR: 2,
  HEAVY: 3, // heavy armour
  FRAME: 4, // light internal structure
  THRUSTER: 5,
  LASER: 6, // hitscan beam
  CANNON: 7, // kinetic rounds (can hit allies in the line of fire)
  MISSILE: 8, // homing missile launcher
};

export const BLOCKS = {
  [BT.HUB]: { name: 'Hub', hp: 450, mass: 4 },
  [BT.ARMOR]: { name: 'Armor', hp: 110, mass: 2 },
  [BT.HEAVY]: { name: 'Heavy armor', hp: 240, mass: 4 },
  [BT.FRAME]: { name: 'Frame', hp: 45, mass: 1 },
  [BT.THRUSTER]: { name: 'Thruster', hp: 60, mass: 1.5, thrust: 10 },
  [BT.LASER]: { name: 'Laser', hp: 130, mass: 2 },
  [BT.CANNON]: { name: 'Cannon', hp: 160, mass: 3 },
  [BT.MISSILE]: { name: 'Missile launcher', hp: 140, mass: 3 },
};

// Weapon behaviour. Ranges/speeds in world units (blocks) and seconds.
export const WEAPON = {
  [BT.LASER]: { kind: 'laser', range: 95, damage: 24, cooldown: 0.8 },
  [BT.CANNON]: { kind: 'kinetic', range: 150, damage: 55, cooldown: 1.5, speed: 95, spread: 0.035 },
  [BT.MISSILE]: { kind: 'missile', range: 300, damage: 110, cooldown: 8, speed: 45, turn: 2.6, life: 8, splash: 2.6 },
};

export const isWeapon = (t) => t === BT.LASER || t === BT.CANNON || t === BT.MISSILE;
