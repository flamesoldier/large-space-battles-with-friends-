// Block catalogue shared by the ship designer, the battle sim and the replay viewer.
// 1 block = 1 world unit. Ship local +x is "forward" (the nose).

export const BT = {
  EMPTY: 0,
  HUB: 1, // the ship's core. Destroy it and the whole ship breaks apart.
  ARMOR: 2,
  HEAVY: 3, // heavy armour
  FRAME: 4, // light internal structure
  THRUSTER: 5,
  LASER: 6, // long-range beam: always hits, slow, burns through a block or two
  CANNON: 7, // slow straight-flying shells with a bright trail: the main damage dealer
  MISSILE: 8, // huge, slow, long-range missiles that can be shot down
  PD: 9, // point defence: short-range rapid laser, kills missiles, also hits close ships
  LANCE: 10, // plasma cannon (was the heavy laser): a 10x10 multi-block gun, slow, long range, its bolt carves through ships
  GUIDED: 11, // guided missile launcher (owner, Nov 2026): the heavy missile, but it steers after its target
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
  [BT.HUB]: { name: 'Hub', hp: 60, mass: 4, cost: 40 }, // fragile on purpose (owner): a hit hub and the ship falls apart
  [BT.ARMOR]: { name: 'Armor', hp: 110, mass: 2, cost: 3 },
  [BT.HEAVY]: { name: 'Heavy armor', hp: 240, mass: 4, cost: 7 },
  [BT.FRAME]: { name: 'Frame', hp: 45, mass: 1, cost: 1 },
  [BT.THRUSTER]: { name: 'Thruster', hp: 60, mass: 1.5, thrust: 10, cost: 20 },
  [BT.LASER]: { name: 'Laser', hp: 130, mass: 2, cost: 80 }, // was 45: lasers out-fought everything at equal cost (tools/balance.mjs)
  [BT.CANNON]: { name: 'Cannon', hp: 150, mass: 3, cost: 50 }, // was 60: slow shells lose a lot to wrecks and overkill
  [BT.MISSILE]: { name: 'Missile launcher', hp: 200, mass: 5, cost: 75 }, // was 120, then 90 (spread-out fleets take fewer ships per blast)
  [BT.PD]: { name: 'Anti-missile point defence', hp: 80, mass: 1.5, cost: 60 }, // renamed (owner, Nov 2026): a friend didn't know it shoots missiles down; cost was 30 (makes missiles better)
  [BT.GUIDED]: { name: 'Guided missile launcher', hp: 200, mass: 5, cost: 110 }, // owner, Nov 2026: the missile launcher's stats, steering missiles, dearer
  [BT.LANCE]: { name: 'Plasma cannon', hp: 750, mass: 4, cost: 15 }, // hp was 120 (owner, Nov 2026: plasma ships lost their guns at once); 1,500 a 10x10 unit (was 3,500): an anti-capital weapon, see CLAUDE.md
};

// A destroyed heavy-laser block explodes: blast damage peak * (1 - d / radius)^2 to every block
// in range, on any ship, own and allied included (friendly fire setting ignored). Neighbouring
// heavy-laser blocks it kills explode in turn, so one gun can chain-react.
// Against other plasma blocks the blast scales with their hit points (as if they had `refHp`), so
// tougher plasma blocks (owner, Nov 2026) still chain-react through the whole unit once one goes.
export const COOKOFF = { radius: 16, damage: 300, refHp: 120 };

// Weapon behaviour. Ranges/speeds in world units (blocks) and seconds.
export const WEAPON = {
  // Instant beam, never misses what it's aimed at, slow to recharge. Like a small heavy laser,
  // the beam carries a damage budget and burns through block after block until it's spent
  // (about three armour blocks, or a heavy armour block and the one behind it).
  [BT.LASER]: { kind: 'laser', range: 340, damage: 400, cooldown: 15 },
  // Slow shell that flies dead straight (aimed with lead at firing), small blast on impact.
  // life: owner (Nov 2026) doesn't want misses to vanish mid-battle, so a shell flies on for 30 s
  // (1,350 blocks, well past the fight) and can still hit something far behind its target.
  [BT.CANNON]: { kind: 'shell', range: 260, damage: 75, cooldown: 2.0, speed: 45, life: 30, splash: 1.6, spread: 0.05 },
  // Heavy missile: unguided, crawls across the map in a straight line, flies over friendly
  // ships, devastating blast. Has hit points, so point defence can shoot it down on the way in.
  // Blast damage falls off with distance: peak * (1 - d / splash)^2, applied to every ship
  // (and wreck) in the radius. One missile cratres a hull; a volley tears it apart.
  // All launchers on a ship fire together as a rippling volley at the same target.
  [BT.MISSILE]: { kind: 'missile', range: 700, damage: 150, cooldown: 30, speed: 23, life: 90, splash: 9, hp: 100, spread: 0.02, maxLead: 3 }, // life was 45: misses fly on; speed was 20 (owner, Nov 2026: +15%, too slow)
  // Guided missile (owner, Nov 2026): exactly the heavy missile, but in flight it turns toward its
  // target (leading it, up to `turn` rad/s), and picks the nearest enemy within `seek` if that dies.
  [BT.GUIDED]: { kind: 'missile', guided: true, range: 700, damage: 150, cooldown: 30, speed: 23, life: 90, splash: 9, hp: 100, spread: 0.02, maxLead: 3, turn: 0.6, seek: 150 },
  // Point defence: shoots the nearest enemy missile in range, otherwise any enemy ship that close.
  [BT.PD]: { kind: 'pd', range: 30, damage: 32, missileDamage: 25, cooldown: 0.2 }, // owner: super close range, high dps (damage was 6, then 24; missileDamage was 10)
  // Heavy laser: a 10x10 gun that fires wherever its unit can see past the rest of the ship. The beam carries a damage budget and
  // burns through block after block (and ship after ship) until the budget is spent.
  // It holds fire if a friendly ship is the first thing in the line of fire.
  // width: the beam burns a channel this many blocks wide (odd). The owner wants 1: a thin cut
  // slices off bigger pieces of ship than a wide one that vaporises them.
  // Plasma cannon (owner, Nov 2026: was the heavy laser, an instant beam): same range, rate and
  // 25,000 damage budget, but a big glowing bolt that flies at `speed` and carves through every
  // block in its path, ship after ship, friend or foe, until the budget is spent. Aimed with lead
  // (capped at maxLead s) along the line through the most enemy ships. Kind stays 'lance' inside.
  [BT.LANCE]: { kind: 'lance', range: 650, damage: 25000, cooldown: 20, width: 1, speed: 60, life: 30, maxLead: 6 },
};

// Firing arcs: every weapon can fire in any direction where its shot wouldn't pass through its
// own ship (see arcs.js). The heavy laser looks out from the centre of its 10x10 unit.

export const isWeapon = (t) => t >= BT.LASER && t <= BT.GUIDED;

// Hull classes come from block count (the ship designer shows which one a design falls in).
// Ships can be absurdly big: a 350,000-block worldbreaker duel resolves in about 2 s.
export const HULL_CLASSES = [
  { id: 'corvette', name: 'Corvette', maxBlocks: 40 },
  { id: 'frigate', name: 'Frigate', maxBlocks: 85 },
  { id: 'destroyer', name: 'Destroyer', maxBlocks: 200 },
  { id: 'cruiser', name: 'Cruiser', maxBlocks: 500 },
  { id: 'battleship', name: 'Battleship', maxBlocks: 1200 },
  { id: 'titan', name: 'Titan', maxBlocks: 3000 },
  { id: 'dreadnought', name: 'Dreadnought', maxBlocks: 10000 },
  { id: 'leviathan', name: 'Leviathan', maxBlocks: 30000 },
  { id: 'colossus', name: 'Colossus', maxBlocks: 120000 },
  { id: 'worldbreaker', name: 'Worldbreaker', maxBlocks: 400000 },
];
export const MAX_BLOCKS = HULL_CLASSES[HULL_CLASSES.length - 1].maxBlocks;
// Largest grid a design may use (width along the nose axis x height). A full-size ship is about
// 3 MB of memory per copy in a battle (types + hit points per cell), so this is where it stops.
export const MAX_W = 1024, MAX_H = 640;
