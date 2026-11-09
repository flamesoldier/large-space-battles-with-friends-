// Usage: node tools/test-designer.mjs
// Checks that the ship designer's numbers match what the battle sim actually does, and that
// designs survive crop, save and load unchanged.
import assert from 'node:assert/strict';
import { makeDesign, CLASSES } from '../src/shared/designs.js';
import { Battle } from '../src/sim/battle.js';
import { BT, MULTIBLOCK } from '../src/shared/blocks.js';
import { analyzeDesign, cropDesign, encodeDesign, decodeDesign, weaponFacing } from '../src/shared/shipStats.js';
import { binOf, binOpen, lineOfFire } from '../src/shared/arcs.js';
import { shipyardPrice } from '../src/shared/economy.js';
import { ShipEditor } from '../src/designer/editor.js';
import { makeTestScenario } from '../src/designer/testBattle.js';

let checked = 0;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

for (const cls of Object.keys(CLASSES))
  for (let seed = 1; seed <= 25; seed++) {
    const d = makeDesign(cls, seed * 31 + cls.length);
    const a = analyzeDesign(d);
    const b = new Battle({ designs: [d], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0 }] });
    const e = b.ents[0];
    close(a.maxSpeed, e.maxSpeed, `${d.name} speed`);
    close(a.turn, e.turn, `${d.name} turn`);
    close(a.mass, e.mass, `${d.name} mass`);
    assert.equal(a.weapons.length, e.weapons.length, `${d.name} weapon count`);
    for (const sw of e.weapons) {
      const dw = a.weapons.find((x) => x.cell === sw.cell);
      assert.ok(dw, `${d.name} weapon at ${sw.cell}`);
      assert.equal(sw.omni, false, `${d.name}: weapon at ${sw.cell} fires all round`);
      {
        assert.equal(dw.buried, sw.buried, `${d.name} buried at ${sw.cell}`);
        assert.equal(dw.m0, sw.m0, `${d.name} arc mask at ${sw.cell}`); assert.equal(dw.m1, sw.m1);
        assert.ok(dw.arcDeg < 360, `${d.name}: a ${sw.type} at ${sw.cell} fires all the way round`);
      }
    }
    // Generated test ships are valid designs (they're what a player could build).
    assert.deepEqual(a.errors, [], `${d.name}: ${a.errors.join(' ')}`);
    assert.ok(a.hullClass, `${d.name} has a hull class`);
    // Round trip through crop (with padding) and JSON.
    const W = d.w + 7, H = d.h + 5, grid = new Uint8Array(W * H);
    for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) grid[(y + 3) * W + x + 2] = d.cells[y * d.w + x];
    const c = cropDesign({ w: W, h: H, cells: grid, name: d.name, stance: d.stance });
    assert.equal(c.w, d.w); assert.equal(c.h, d.h); assert.equal(c.hub, d.hub);
    assert.deepEqual(c.cells, d.cells);
    const back = decodeDesign(JSON.parse(JSON.stringify(encodeDesign(c))));
    assert.deepEqual(back.cells, d.cells); assert.equal(back.hub, d.hub); assert.equal(back.stance, d.stance);
    assert.ok(shipyardPrice(d) > a.cost);
    checked++;
  }

// Validation catches the obvious mistakes.
const W = 12, H = 12, g = new Uint8Array(W * H);
g[5 * W + 5] = BT.HUB; g[5 * W + 6] = BT.ARMOR; g[0] = BT.ARMOR; // a loose block
let a = analyzeDesign({ ...cropDesign({ w: W, h: H, cells: g, name: 't', stance: 'line' }) });
assert.ok(a.errors.some((s) => s.includes('not connected')));
g[0] = 0; g[5 * W + 7] = BT.HUB;
a = analyzeDesign(cropDesign({ w: W, h: H, cells: g, name: 't', stance: 'line' }));
assert.ok(a.errors.some((s) => s.includes('one hub')));
g[5 * W + 7] = BT.LANCE; // a single heavy-laser block is not a gun
a = analyzeDesign(cropDesign({ w: W, h: H, cells: g, name: 't', stance: 'line' }));
assert.ok(a.errors.some((s) => s.includes('10×10')));

// Editor operations.
const ed = new ShipEditor();
const hub = ed.hub(), hx = hub % ed.w, hy = (hub / ed.w) | 0;
ed.paint(hx + 1, hy - 3, BT.ARMOR);
assert.equal(ed.get(hx + 1, hy + 3), BT.ARMOR, 'mirror paints across the hub row');
ed.mirror = false;
ed.checkpoint(); ed.paint(hx + 2, hy, BT.LASER); assert.equal(ed.get(hx + 2, hy), BT.LASER);
ed.undo(); assert.equal(ed.get(hx + 2, hy), 0, 'undo');
ed.redo(); assert.equal(ed.get(hx + 2, hy), BT.LASER, 'redo');
ed.paint(hx, hy, 0); assert.equal(ed.get(hx, hy), BT.HUB, 'the hub cannot be erased');
assert.ok(!ed.stamp(hx, hy), 'heavy laser cannot cover the hub');
assert.ok(ed.stamp(hx + 20, hy));
assert.equal(ed.cells.filter((c) => c === BT.LANCE).length, 100);
ed.paint(hx + 20, hy, BT.ARMOR); // painting over a unit removes the whole unit
assert.equal(ed.cells.filter((c) => c === BT.LANCE).length, 0);
ed.mirror = true;
ed.stamp(hx + 20, hy - 12); // far enough from the axis to mirror
assert.equal(ed.cells.filter((c) => c === BT.LANCE).length, 200);
ed.setCell(hx - 5, hy, BT.HUB); assert.equal(ed.hub(), hy * ed.w + hx - 5, 'placing a hub moves it');
ed.undo(); assert.equal(ed.hub(), hy * ed.w + hx, 'undo moves the hub back');
ed.redo(); assert.equal(ed.hub(), hy * ed.w + hx - 5, 'redo moves it again');
ed.checkpoint(); ed.paint(hx + 30, hy - 20, BT.CANNON); ed.cancelStep();
assert.equal(ed.get(hx + 30, hy - 20), 0, 'cancelled stroke leaves nothing behind');
assert.equal(ed.get(hx + 30, hy + 20), 0, 'or its mirror');
// Fill inside an outline, but never out into open space.
const f = new ShipEditor(); f.mirror = false;
const c0 = f.hub(), fx = c0 % f.w, fy = (c0 / f.w) | 0;
f.rect(fx + 2, fy - 2, fx + 8, fy + 2, BT.ARMOR); f.rect(fx + 3, fy - 1, fx + 7, fy + 1, 0);
assert.ok(!f.fill(0, 0, BT.FRAME), 'fill refuses open space');
assert.ok(f.fill(fx + 5, fy, BT.FRAME)); assert.equal(f.get(fx + 4, fy), BT.FRAME);
assert.equal(f.toDesign().w, 9, 'crop keeps hub to nose');
// Test battle scenarios cost the same on both sides.
const sc = makeTestScenario(makeDesign('cruiser', 5), 6, null, 2);
assert.ok(Math.abs(sc.enemyCost - sc.budget) / sc.budget < 0.1, `budgets ${sc.enemyCost} vs ${sc.budget}`);

// Line of fire: a gun on the end of a spar can fire forward, not back through its own ship.
{
  const cells = new Uint8Array(5); cells.set([BT.ARMOR, BT.HUB, BT.ARMOR, BT.FRAME, BT.CANNON]);
  const f = weaponFacing(cells, 5, 1, 4);
  assert.ok(!f.buried && f.arcDeg > 180 && f.arcDeg < 360, `spar gun arc ${f.arcDeg}`);
  assert.ok(binOpen(f.m0, f.m1, binOf(1, 0)) && !binOpen(f.m0, f.m1, binOf(-1, 0)), 'fires forward, not aft');
  const boxed = new Uint8Array(9).fill(BT.ARMOR); boxed[4] = BT.LASER;
  assert.ok(weaponFacing(boxed, 3, 3, 4).buried, 'enclosed gun is buried');
}

// Missile launchers and heavy lasers need a line of fire too.
{
  const W = 12, H = 12, cells = new Uint8Array(W * H).fill(BT.ARMOR);
  for (let y = 1; y < 11; y++) for (let x = 1; x < 11; x++) cells[y * W + x] = BT.LANCE;
  const group = []; for (let y = 1; y < 11; y++) for (let x = 1; x < 11; x++) group.push(y * W + x);
  assert.ok(weaponFacing(cells, W, H, group[0], group).buried, 'heavy laser boxed in by armour is buried');
  for (let y = 0; y < H; y++) cells[y * W + W - 1] = 0; // open the nose side
  const f = weaponFacing(cells, W - 0, H, group[0], group);
  assert.ok(!f.buried && binOpen(f.m0, f.m1, binOf(1, 0)) && !binOpen(f.m0, f.m1, binOf(-1, 0)), 'heavy laser sees forward only');
  const m = new Uint8Array(9).fill(BT.ARMOR); m[4] = BT.MISSILE;
  assert.ok(weaponFacing(m, 3, 3, 4).buried, 'enclosed missile launcher is buried');
}

// Heavy-laser cook-off: destroying one block chain-reacts, hurts the ship itself and allies,
// even with friendly fire off.
{
  const d = makeDesign('battleship', 4);
  const lance = d.cells.indexOf(BT.LANCE);
  assert.ok(lance >= 0, 'sample battleship has a heavy laser');
  const b = new Battle({ designs: [d], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0 }, { design: 0, team: 0, x: 0, y: d.h + 1, a: 0 }] });
  const [e, ally] = b.ents, before = e.alive, allyBefore = ally.alive;
  b.damageCell(e, lance, 1e6);
  b.resolveCookoffs();
  const lost = before - e.alive, lanceLeft = [...e.types].filter((t, i) => t === BT.LANCE && e.hp[i] > 0).length;
  console.log(`cook-off: one heavy-laser block destroyed -> ${lost} of ${before} blocks of its own ship gone (${lanceLeft} laser blocks left), ally lost ${allyBefore - ally.alive}`);
  assert.ok(lost > 100 && lanceLeft < 50, 'chain reaction takes most of the gun');
}

// Incremental line-of-fire updates after damage match a full re-cast.
{
  const d = makeDesign('battleship', 12);
  const b = new Battle({ designs: [d], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0 }] });
  const e = b.ents[0];
  let rnd = 7;
  for (let round = 0; round < 6; round++) {
    for (let n = 0; n < 60; n++) { rnd = (rnd * 16807) % 2147483647; const c = rnd % e.types.length; if (e.types[c] && c !== e.hub && e.types[c] !== BT.LANCE) b.damageCell(e, c, 1e6); }
    b.refit(e);
    for (const w of e.weapons) {
      const fresh = lineOfFire(e.types, e.hp, e.w, e.h, w.cell, {}, w.cells);
      assert.equal(w.m0, fresh.m0, `incremental arc (round ${round}, cell ${w.cell})`); assert.equal(w.m1, fresh.m1);
    }
  }
}

// ---- fighter bays (owner, Nov 2026)
{
  const N = MULTIBLOCK[BT.BAY].size;
  // A plain hull with a bay on the top edge, one in the middle with a straight tunnel down to
  // space, and one sealed inside.
  const w = 50, h = 26, cells = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells[y * w + x] = BT.ARMOR;
  for (let y = 4; y < h - 4; y++) cells[y * w] = BT.THRUSTER;
  const hub = 13 * w + 25; cells[hub] = BT.HUB;
  const bay = (x0, y0) => { for (let y = y0; y < y0 + N; y++) for (let x = x0; x < x0 + N; x++) cells[y * w + x] = BT.BAY; };
  bay(4, 0); // edge
  bay(14, 10); for (let y = 10 + N; y < h; y++) for (let x = 14; x < 14 + N; x++) cells[y * w + x] = 0; // tunnel down
  bay(34, 10); // sealed
  cells[13 * w + w - 1] = BT.CANNON;
  const d = { name: 'Carrier test', w, h, cells, hub, stance: 'line' };
  const a = analyzeDesign(d);
  assert.deepEqual(a.errors, [], 'carrier test design is valid');
  const bays = a.weapons.filter((x) => x.type === BT.BAY);
  assert.equal(bays.length, 3, 'three fighter bays');
  const byX = (x) => bays.find((b) => b.group.x0 === x);
  assert.ok(!byX(4).buried && byX(4).arcDeg >= 90, 'an edge bay launches straight out');
  assert.ok(!byX(14).buried && byX(14).arcDeg > 0, 'a bay with a straight tunnel to space can launch');
  assert.ok(byX(34).buried, 'a bay with no way out is sealed in');
  assert.ok(a.warnings.some((t) => t.includes('sealed in')), 'sealed bays get a warning');
  // Designer and sim agree on every bay's way out.
  const b = new Battle({ designs: [d], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0 }] });
  const e = b.ents[0];
  assert.equal(e.weapons.filter((x) => x.type === BT.BAY).length, 3, 'the sim sees three bays');
  for (const sw of e.weapons) { const dw = a.weapons.find((x) => x.cell === sw.cell); assert.ok(dw); assert.equal(sw.m0, dw.m0); assert.equal(sw.m1, dw.m1); }
  // A tunnel with corners (owner, Nov 2026): bay 3 gets an L-shaped corridor out, right then down.
  {
    const c3 = cells.slice();
    for (let x = 34 + N; x < 46; x++) c3[12 * w + x] = 0;
    for (let y = 12; y < h; y++) c3[y * w + 45] = 0;
    const d3 = { ...d, cells: c3 }, a3 = analyzeDesign(d3);
    const bay3 = a3.weapons.find((b) => b.type === BT.BAY && b.group.x0 === 34);
    assert.ok(!bay3.buried && bay3.route && bay3.route.length >= 8, 'a bay with a tunnel that turns a corner can launch');
    assert.ok(!a3.warnings.some((t) => t.includes('sealed in')), 'no sealed warning for a cornered tunnel');
    const b3 = new Battle({ designs: [d3, d3], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0.4 }, { design: 1, team: 1, x: 400, y: 0, a: Math.PI }], maxTime: 30 });
    const e3 = b3.ents[0], sb = e3.weapons.find((x) => x.type === BT.BAY && x.cell === bay3.cell);
    assert.ok(sb && !sb.buried && sb.route >= 0, 'the sim finds the same way out');
    // Its fighters taxi out along the tunnel and come out of the far end, outside the hull.
    let launched = 0, out = 0;
    const add = b3.addFighter.bind(b3); b3.addFighter = (...q) => { add(...q); launched++; };
    for (let t = 0; t < 60; t++) {
      b3.step();
      const F = b3.Fi;
      for (let i = 0; i < F.n; i++) if (F.rt[i] < 0 && F.team[i] === 0) out++;
    }
    assert.ok(launched >= 3 * 3 && out > 0, `fighters launched (${launched}) and got out of the tunnel`);
  }
  // Touching bays are one bad unit.
  const c2 = cells.slice(); for (let y = 0; y < N; y++) c2[y * w + 4 + N] = BT.BAY;
  assert.ok(analyzeDesign({ ...d, cells: c2 }).errors.some((t) => t.includes(`Fighter bays must be whole ${N}×${N}`)), 'bad bay units are refused');
  // The editor places a whole unit round the cursor.
  const ed = new ShipEditor(30, 30); ed.mirror = false; ed.paint(25, 25, BT.HUB);
  ed.stamp(10, 10, BT.BAY);
  assert.equal(ed.cells.filter((t) => t === BT.BAY).length, N * N, 'a bay is stamped as one whole unit');
  // In battle: fighters launch (at any range), fly, shoot and get shot down; replays record them.
  const scen = makeTestScenario(d, 8, null, 3, false, []);
  const bt = new Battle({ designs: scen.designs, ships: scen.ships, seed: 3, maxTime: 240 });
  let most = 0, first = -1;
  while (!bt.done) { bt.step(); most = Math.max(most, bt.Fi.n); if (first < 0 && bt.Fi.n) first = bt.tick; }
  assert.ok(first >= 0 && first < 60, `bays launch from the start, whatever the range (first at tick ${first})`);
  const R = bt.R, kinds = R.shotKind.a.slice(0, R.shotKind.n);
  const launched = kinds.filter((k) => k === 4).length;
  assert.ok(launched >= 8, `fighters launch (${launched})`);
  assert.ok([...R.lasKind.a.slice(0, R.lasKind.n)].includes(3), 'fighters fire their guns');
  let down = 0; for (let k = 0; k < kinds.length; k++) if (kinds[k] === 4 && R.shotHit.a[k] === 2) down++;
  assert.ok(down > 0, 'fighters get shot down');
  const rep = bt.toReplay();
  for (let k = 0; k < rep.cols.shotKind.length; k++) if (rep.cols.shotKind[k] === 4) assert.ok(rep.cols.shotFlight[k] > 0, 'every fighter has a flight time in the replay');
}

console.log(`designer stats match the sim for ${checked} generated designs; validation ok`);
