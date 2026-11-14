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
import { FORTRESSES, loadFortress } from '../src/shared/fortresses.js';
import { defensePrice } from '../src/shared/economy.js';

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
  // Launch waves (owner, 13 Nov 2026): 3 at the start, then 1 every minute.
  {
    const bw = new Battle({ designs: [d], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0 }] });
    const e = bw.ents[0], perBay = new Map();
    bw.launchFighter = (_e, w) => { if (!perBay.has(w)) perBay.set(w, []); perBay.get(w).push(bw.tick / 10); return true; };
    for (bw.tick = 0; bw.tick < 2000; bw.tick++) bw.fire(e); // the bays' launch clock alone, every launch succeeds
    assert.ok(perBay.size >= 1, 'bays launch');
    for (const ts of perBay.values()) {
      const by = (t) => ts.filter((x) => x <= t).length, at = ts.slice(0, 8).map((x) => x.toFixed(1)).join(', ');
      assert.equal(by(10), 3, `3 fighters in the opening wave (${at})`);
      assert.equal(by(59), 3, `nothing more before a minute (${at})`);
      assert.equal(by(70), 4, `1 more a minute later (${at})`);
      assert.equal(by(119), 4, `then a minute's gap (${at})`);
      assert.equal(by(130), 5, `then 1 a minute (${at})`);
      assert.equal(by(190), 6, `and 1 more a minute after that (${at})`);
    }
    console.log(`fighter bay waves: ${[...perBay.values()][0].slice(0, 7).map((x) => x.toFixed(1)).join(', ')} s`);
  }
}

// Flak cannon (owner, 14 Nov 2026): a whole 10x10 unit; picks the most lightly armoured ship in
// range; spreads its fire; its shrapnel damages what it bursts beside.
{
  // A gun platform: frame and hub behind a flak unit at the nose (a defence: no thrusters).
  const w = 14, h = 10, cells = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells[y * w + x] = x >= 4 ? BT.FLAK : BT.FRAME;
  const plat = { name: 'Flak platform', cls: 'cruiser', w, h, cells, hub: 5 * w + 1, stance: 'line' };
  cells[plat.hub] = BT.HUB;
  const a = analyzeDesign(plat);
  assert.ok(a.ok, `flak platform is valid: ${a.errors.join('; ')}`);
  assert.equal(a.weapons.filter((x) => x.type === BT.FLAK && !x.buried).length, 1, 'one flak cannon, not buried');
  const c2 = cells.slice(); c2[0] = BT.FLAK;
  assert.ok(analyzeDesign({ ...plat, cells: c2 }).errors.some((t) => t.includes('Flak cannons must be whole 10×10')), 'bad flak units are refused');
  const ed = new ShipEditor(30, 30); ed.mirror = false; ed.paint(25, 25, BT.HUB); ed.stamp(10, 10, BT.FLAK);
  assert.equal(ed.cells.filter((t) => t === BT.FLAK).length, 100, 'a flak cannon is stamped as one whole unit');
  // Targets: a lightly armoured gunboat (lots of guns, little plating) and an armoured brick.
  const boat = { name: 'Gunboat', cls: 'corvette', w: 6, h: 5, cells: new Uint8Array(30), hub: 2 * 6 + 1, stance: 'line' };
  boat.cells.fill(BT.CANNON); for (let y = 0; y < 5; y++) boat.cells[y * 6] = BT.FRAME; boat.cells[boat.hub] = BT.HUB;
  const brick = { name: 'Brick', cls: 'cruiser', w: 12, h: 10, cells: new Uint8Array(120).fill(BT.HEAVY), hub: 5 * 12 + 2, stance: 'line' };
  brick.cells[brick.hub] = BT.HUB; brick.cells[5 * 12 + 11] = BT.CANNON;
  const fb = new Battle({ designs: [plat, boat, brick], ships: [
    { design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true },
    { design: 1, team: 1, x: 400, y: -60, a: Math.PI, fixed: true },
    { design: 2, team: 1, x: 400, y: 60, a: Math.PI, fixed: true },
  ], seed: 2, maxTime: 60 });
  const boatE = fb.ents[1], brickE = fb.ents[2];
  assert.ok(boatE.light > brickE.light * 10, `the gunboat counts as lightly armoured (${boatE.light.toFixed(1)} vs ${brickE.light.toFixed(2)})`);
  let first = -1, bursts = 0;
  const hp0 = boatE.alive;
  while (!fb.done && fb.tick < 400) {
    fb.step();
    for (let i = 0; i < fb.P.n; i++) if (fb.P.kind[i] === 5 && first < 0) first = fb.P.target[i];
  }
  for (let k = 0; k < fb.R.expS.n; k++) if (fb.R.expS.a[k] === 6) bursts++;
  assert.equal(first, boatE.id, 'flak goes for the lightly armoured ship first');
  assert.ok(bursts >= 3, `flak shells burst (${bursts})`);
  assert.ok(boatE.dead || boatE.hubDead || boatE.alive < hp0, 'its shrapnel damages the gunboat');
  // Spread: four platforms, four identical gunboats: the first shells go to different ships.
  const ships = [];
  for (let k = 0; k < 4; k++) ships.push({ design: 0, team: 0, x: 0, y: -90 + k * 60, a: 0, fixed: true });
  for (let k = 0; k < 4; k++) ships.push({ design: 1, team: 1, x: 450, y: -90 + k * 60, a: Math.PI, fixed: true });
  const sb = new Battle({ designs: [plat, boat], ships, seed: 4, maxTime: 60 });
  const tg = new Set();
  let n = 0;
  sb.addProjectile = ((f) => (kind, ...r) => { if (kind === 5 && n < 4) { n++; tg.add(r[8]); } return f(kind, ...r); })(sb.addProjectile.bind(sb));
  while (sb.tick < 200 && n < 4) sb.step();
  assert.ok(tg.size >= 3, `flak spreads its fire: the first 4 shells went to ${tg.size} different ships`);
  console.log(`flak: picks the gunboat (light ${boatE.light.toFixed(1)}) over the brick (${brickE.light.toFixed(2)}), ${bursts} bursts, first 4 shells of 4 platforms at ${tg.size} different ships`);
}

// The ready-made Aegis fortresses in the defence designer's Start from menu: valid 150,000 cr
// defences (750,000 cr of blocks, no thrusters, nothing buried or sealed in), and they survive a
// save/load round trip like any design.
for (let k = 0; k < FORTRESSES.length; k++) {
  const d = await loadFortress(k), a = analyzeDesign(d);
  assert.ok(a.ok, `${d.name}: ${a.errors.join('; ')}`);
  assert.equal(a.cost, 750000, `${d.name} costs 750,000 cr of blocks`);
  assert.equal(defensePrice(d), 150000, `${d.name} is a 150,000 cr defence`);
  assert.ok(!a.byType[BT.THRUSTER], `${d.name} has no thrusters`);
  assert.equal(a.weapons.filter((w) => w.buried).length, 0, `${d.name}: no buried weapons or sealed bays`);
  const back = decodeDesign(JSON.parse(JSON.stringify(encodeDesign(d))));
  assert.deepEqual([...back.cells], [...d.cells], `${d.name} round-trips`);
}

// Big hollow hulls (owner, 13 Nov 2026): ships can fly into a fortress's open courtyards and lanes
// (collisions use the squares that hold blocks, not the outline box), and a fortress's guns don't
// fire through its own arms (exact own-hull check on big hulls).
{
  const d = await loadFortress(1); // Aegis II: keep, courtyard, six open lanes
  const scen = makeTestScenario(d, 1, null, 1, true);
  const bt = new Battle({ designs: scen.designs, ships: scen.ships, seed: 1, maxTime: 60 });
  const f = bt.byId[0], e = bt.ents.find((o) => o.team === 1 && o.kind === f.kind && o.w * o.h < 2000);
  assert.ok(f.tiles && e, 'the fortress has a tile map');
  // Find open space well inside the fortress's outline (no block within 3 tiles) and a solid spot.
  let open = null, solid = null;
  for (let ty = 3; ty < f.th - 3 && !open; ty++) for (let tx = 3; tx < f.tw - 3; tx++) {
    let empty = true;
    for (let y = -3; y <= 3 && empty; y++) for (let x = -3; x <= 3; x++) if (f.tiles[(ty + y) * f.tw + tx + x]) { empty = false; break; }
    const cx = Math.abs(tx - f.tw / 2) < f.tw / 4 && Math.abs(ty - f.th / 2) < f.th / 4;
    if (empty && cx) { open = [tx, ty]; break; }
  }
  for (let i = 0; i < f.tiles.length && !solid; i++) if (f.tiles[i] && i % f.tw > 2 && i % f.tw < f.tw - 3) solid = [i % f.tw, (i / f.tw) | 0];
  assert.ok(open && solid, 'found open space inside the outline');
  const put = ([tx, ty]) => { const lx = tx * 4 + 2 - f.w / 2, ly = ty * 4 + 2 - f.h / 2; e.x = f.x + lx * f.c - ly * f.s; e.y = f.y + lx * f.s + ly * f.c; e.vx = e.vy = 0; };
  put(open); let x0 = e.x, y0 = e.y; bt.collide(e);
  assert.ok(e.x === x0 && e.y === y0, 'a ship inside the courtyard is not pushed out of the fortress');
  assert.ok(!bt.solidAt(e.x, e.y, 3), 'fighters see the courtyard as open space');
  put(solid); x0 = e.x; y0 = e.y; bt.collide(e);
  assert.ok(e.x !== x0 || e.y !== y0, 'a ship on top of a wall is pushed off it');
  // Every gun's arc is 64 slices; across a hull this size a slice edge runs into its own arms.
  // The exact check stops a shot that would cross its own blocks, and lets clear ones go.
  let blocked = 0, clear = 0;
  for (const w of f.weapons) {
    const wx = f.x + w.lx * f.c - w.ly * f.s, wy = f.y + w.lx * f.s + w.ly * f.c;
    for (let k = 0; k < 64; k++) {
      if (!bt.bears(f, w, wx, wy, wx + Math.cos(k / 64 * 2 * Math.PI + f.a), wy + Math.sin(k / 64 * 2 * Math.PI + f.a))) continue;
      if (bt.ownHullInWay(f, w, wx, wy, k / 64 * 2 * Math.PI + f.a, 600)) blocked++; else clear++;
    }
  }
  assert.ok(clear > blocked * 4 && blocked > 0, `own-hull check: ${blocked} blocked, ${clear} clear`);
  // Small ships skip it entirely.
  assert.equal(bt.ownHullInWay(e, e.weapons[0] || { cell: 0, cells: null }, e.x, e.y, 0, 300), false);
}

console.log(`designer stats match the sim for ${checked} generated designs; validation ok`);
console.log(`${FORTRESSES.length} Aegis fortresses are valid 150,000 cr defences`);
