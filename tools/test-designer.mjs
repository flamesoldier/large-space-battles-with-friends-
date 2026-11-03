// Usage: node tools/test-designer.mjs
// Checks that the ship designer's numbers match what the battle sim actually does, and that
// designs survive crop, save and load unchanged.
import assert from 'node:assert/strict';
import { makeDesign, CLASSES } from '../src/shared/designs.js';
import { Battle } from '../src/sim/battle.js';
import { BT } from '../src/shared/blocks.js';
import { analyzeDesign, cropDesign, encodeDesign, decodeDesign } from '../src/shared/shipStats.js';
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
      assert.equal(dw.omni, sw.omni, `${d.name} omni at ${sw.cell}`);
      if (!sw.omni) {
        assert.equal(dw.buried, sw.buried, `${d.name} buried at ${sw.cell}`);
        close(dw.fx, sw.fx, 'fx'); close(dw.fy, sw.fy, 'fy');
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

console.log(`designer stats match the sim for ${checked} generated designs; validation ok`);
