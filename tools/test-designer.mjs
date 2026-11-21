// Usage: node tools/test-designer.mjs
// Checks that the ship designer's numbers match what the battle sim actually does, and that
// designs survive crop, save and load unchanged.
import assert from 'node:assert/strict';
import { makeDesign, CLASSES } from '../src/shared/designs.js';
import { Battle } from '../src/sim/battle.js';
import { BT, MULTIBLOCK, SHIELD, WEAPON, shieldRegen, shieldCap } from '../src/shared/blocks.js';
import { analyzeDesign, cropDesign, encodeDesign, decodeDesign, weaponFacing } from '../src/shared/shipStats.js';
import { binOf, binOpen, lineOfFire } from '../src/shared/arcs.js';
import { shipyardPrice } from '../src/shared/economy.js';
import { ShipEditor } from '../src/designer/editor.js';
import { makeTestScenario } from '../src/designer/testBattle.js';
import { FORTRESSES, loadFortress } from '../src/shared/fortresses.js';
import { defensePrice } from '../src/shared/economy.js';
import { packReplay, unpackReplay } from '../src/shared/replayFormat.js';
import { ReplayModel } from '../src/viewer/model.js';

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
  const boatE = fb.ents[1], brickE = fb.ents[2], light0 = [boatE.light, brickE.light];
  assert.ok(boatE.light > brickE.light * 10, `the gunboat counts as lightly armoured (${boatE.light.toFixed(1)} vs ${brickE.light.toFixed(2)})`);
  // Since 21 Nov 2026 (owner) there's no shell: a burst goes off at once about every second, in open space
  // beside or between lightly armoured enemy ships. Watch where bursts go.
  const nearNow = (bt, x, y) => { let best = null, bd = Infinity; for (const e of bt.ents) { if (e.kind !== 0 || e.team === 0 || e.dead) continue; const d = Math.hypot(e.x - x, e.y - y) - e.radius; if (d < bd) { bd = d; best = e; } } return best; };
  const watch = (bt) => { const L = []; bt.flakBurst = ((f) => (x, y, team, owner, W) => { L.push({ t: bt.tick, x, y, owner, inside: bt.blockAt(x, y), near: nearNow(bt, x, y), armed: bt.foeArmed[0].slice() }); return f(x, y, team, owner, W); })(bt.flakBurst.bind(bt)); return L; };
  const near = (bt, p) => p.near;
  const hp0 = boatE.alive, fbL = watch(fb);
  while (!fb.done && fb.tick < 400) fb.step();
  const bursts = fbL.length;
  assert.ok(bursts >= 5, `flak bursts (${bursts})`);
  assert.equal(near(fb, fbL[0]), boatE, 'the first burst goes for the lightly armoured ship');
  { const live = fbL.filter((p) => p.armed.includes(boatE)); assert.ok(live.length >= 2 && live.filter((p) => p.near === boatE).length >= live.length * 0.7, `and most of them while it fights (${live.filter((p) => p.near === boatE).length} of ${live.length})`); }
  assert.ok(boatE.dead || boatE.hubDead || boatE.alive < hp0, 'its shrapnel damages the gunboat');
  assert.ok(fbL.every((p) => !p.inside), 'no burst goes off inside a hull');
  // About every second from one gun.
  for (let k = 1; k < fbL.length; k++) { const g = fbL[k].t - fbL[k - 1].t; assert.ok(g >= 8 && g <= 12, `one burst about every second (${g} ticks)`); }
  // No shells or shrapnel shots in the replay; at most a few hull sparks a burst.
  let shots = 0; for (let k = 0; k < fb.R.shotKind.n; k++) if (fb.R.shotKind.a[k] === 5 || fb.R.shotKind.a[k] === 6) shots++;
  assert.equal(shots, 0, 'no flak shells or shrapnel shots recorded');
  let flashes = 0; for (let k = 0; k < fb.R.expS.n; k++) if (fb.R.expS.a[k] === 10) flashes++;
  assert.equal(flashes, bursts, 'a muzzle flash for every burst');
  // A crowd beats a loner: one gunboat on its own, four packed together, all the same ship.
  {
    const ships = [{ design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true }, { design: 1, team: 1, x: 420, y: -150, a: Math.PI, fixed: true }];
    for (let k = 0; k < 4; k++) ships.push({ design: 1, team: 1, x: 420 + (k % 2) * 16, y: 120 + ((k / 2) | 0) * 16, a: Math.PI, fixed: true });
    const cb = new Battle({ designs: [plat, boat], ships, seed: 7, maxTime: 60 });
    const L = watch(cb);
    while (cb.tick < 300 && L.length < 10) cb.step();
    const toCrowd = L.filter((p) => p.y > 0).length;
    assert.ok(toCrowd >= 7, `flak bursts go for the crowd (${toCrowd} of ${L.length})`);
    // And land between them: within the group's box.
    assert.ok(L.filter((p) => p.y > 0).every((p) => p.x > 400 && p.x < 456 && p.y > 100 && p.y < 156), 'in among the crowd');
  }
  // An allied brick right in front of the platform: shrapnel never hurts it.
  {
    const ab = new Battle({ designs: [plat, boat, brick], ships: [
      { design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true },
      { design: 2, team: 0, x: 40, y: 0, a: 0, fixed: true },
      { design: 1, team: 1, x: 420, y: 0, a: Math.PI, fixed: true },
    ], seed: 6, maxTime: 60 });
    const hpSum = (e) => e.hp.reduce((s, v) => s + Math.max(0, v), 0);
    const ally = ab.ents[1], foe = ab.ents[2], a0 = ally.alive, f0 = hpSum(foe), L = watch(ab);
    while (!ab.done && ab.tick < 300) ab.step();
    assert.ok(L.length >= 5 && (foe.dead || foe.hubDead || hpSum(foe) < f0), `flak reaches past an allied ship to the enemy (${L.length} bursts)`);
    assert.equal(ally.alive, a0, 'flak shrapnel never damages an allied ship');
  }
  // Spread: four platforms, four identical gunboats far apart: the first 4 bursts go to different ships.
  const ships = [];
  for (let k = 0; k < 4; k++) ships.push({ design: 0, team: 0, x: 0, y: -150 + k * 100, a: 0, fixed: true });
  for (let k = 0; k < 4; k++) ships.push({ design: 1, team: 1, x: 450, y: -150 + k * 100, a: Math.PI, fixed: true });
  const sb = new Battle({ designs: [plat, boat], ships, seed: 4, maxTime: 60 });
  const sL = watch(sb);
  while (sb.tick < 200 && sL.length < 4) sb.step();
  const tg = new Set(sL.slice(0, 4).map((p) => near(sb, p).id));
  assert.ok(tg.size >= 3, `flak spreads its fire: the first 4 bursts went to ${tg.size} different ships`);
  // A heavy armour skin protects what's inside (owner, 21 Nov 2026): a burst just off the hull only
  // reaches blocks it can see, so the frame inside the skin is untouched while the skin stands.
  {
    const n = 12, cells = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) cells[y * n + x] = x === 0 || y === 0 || x === n - 1 || y === n - 1 ? BT.HEAVY : BT.FRAME;
    const box = { name: 'Box', cls: 'cruiser', w: n, h: n, cells, hub: 6 * n + 6, stance: 'line' }; cells[box.hub] = BT.HUB;
    const hb = new Battle({ designs: [plat, box], ships: [{ design: 0, team: 0, x: -400, y: 0, a: 0, fixed: true }, { design: 1, team: 1, x: 0, y: 0, a: 0, fixed: true }], seed: 1, maxTime: 10 });
    const e = hb.ents[1], hp0 = Array.from(e.hp);
    hb.flakBurst(-n / 2 - 3, 0, 0, hb.ents[0].id, WEAPON[BT.FLAK]); // 3 blocks off its left side
    let skin = 0, inside = 0;
    for (let k = 0; k < n * n; k++) if (e.hp[k] < hp0[k]) { if (cells[k] === BT.HEAVY) skin++; else inside++; }
    assert.ok(skin >= 5 && inside === 0, `a heavy armour skin takes the burst and nothing inside is touched (${skin} skin blocks hit, ${inside} inside)`);
    assert.ok(e.hp.every((v, k) => cells[k] !== BT.HEAVY || v > 0), 'and the skin holds');
  }
  console.log(`flak: picks the gunboat (light ${light0[0].toFixed(1)}) over the brick (${light0[1].toFixed(2)}), ${bursts} bursts, first bursts of 4 platforms at ${tg.size} different ships`);
}

// Shield generator (owner, 15 Nov 2026): a 10x10 unit, not a gun; its ship's shield pool takes every
// hit first and refills all the time; if any of its blocks dies the whole unit explodes.
{
  const w = 30, h = 14, cells = new Uint8Array(w * h).fill(BT.ARMOR);
  for (let y = 2; y < 12; y++) for (let x = 10; x < 20; x++) cells[y * w + x] = BT.SHIELD;
  for (let y = 0; y < h; y++) cells[y * w + w - 1] = BT.CANNON;
  const sd = { name: 'Shielded', cls: 'cruiser', w, h, cells, hub: 7 * w + 2, stance: 'line' };
  cells[sd.hub] = BT.HUB;
  const a = analyzeDesign(sd);
  assert.ok(a.ok, `shielded ship is valid: ${a.errors.join('; ')}`);
  assert.equal(a.shield, SHIELD.capacity, 'one generator gives one generator\'s shield');
  assert.ok(!a.weapons.some((x) => x.type === BT.SHIELD), 'a shield generator is not a weapon');
  const c2 = cells.slice(); c2[2 * w + 9] = BT.SHIELD;
  assert.ok(analyzeDesign({ ...sd, cells: c2 }).errors.some((t) => t.includes('Shield generators must be whole')), 'bad generators are refused');
  const two = cells.slice(); // a second generator right next to the first: warned
  const wide = { ...sd, w: 44, cells: new Uint8Array(44 * h).fill(BT.ARMOR) };
  for (let y = 0; y < h; y++) for (let x = 0; x < 30; x++) wide.cells[y * 44 + x] = two[y * w + x];
  for (let y = 2; y < 12; y++) for (let x = 22; x < 32; x++) wide.cells[y * 44 + x] = BT.SHIELD;
  wide.hub = 7 * 44 + 2;
  assert.ok(analyzeDesign(wide).warnings.some((t) => t.startsWith('Shield generators too close')), 'generators close together are warned about');
  // In battle: blocks take no damage while the shield holds; it refills; a generator that loses a block explodes.
  const b = new Battle({ designs: [sd], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true }], seed: 1, maxTime: 60 });
  const e = b.ents[0], alive0 = e.alive;
  assert.equal(e.shield, SHIELD.capacity, 'starts with a full shield');
  b.damageCell(e, 0, 3000);
  assert.equal(e.alive, alive0, 'a hit the shield can take does no damage to blocks');
  assert.equal(e.shield, SHIELD.capacity - 3000, 'it drains the shield instead');
  for (let k = 0; k < 10; k++) b.step();
  assert.ok(e.shield > SHIELD.capacity - 3000, 'the shield refills');
  b.damageCell(e, 0, 1e6);
  assert.equal(e.shield, 0, 'a huge hit takes the shield down');
  assert.ok(e.alive < alive0, 'and what is left goes through to the blocks');
  b.damageCell(e, 2 * w + 10, 100);
  b.step(); b.step();
  assert.equal(cells.reduce((n, t, i) => n + (t === BT.SHIELD && e.hp[i] > 0 ? 1 : 0), 0), 0, 'one generator block lost: the whole unit is gone');
  assert.equal(e.shieldMax, 0, 'and so is its shield');
  let pops = 0; for (let k = 0; k < b.R.expS.n; k++) if (b.R.expS.a[k] === 7) pops++;
  assert.equal(pops, 1, 'with one explosion');
  // Flak shrapnel drains shields at a reduced rate.
  const b2 = new Battle({ designs: [sd], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true }], seed: 1, maxTime: 60 });
  b2.damageCell(b2.ents[0], 0, 100, WEAPON[BT.FLAK].shieldMult);
  assert.equal(b2.ents[0].shield, SHIELD.capacity - 100 * WEAPON[BT.FLAK].shieldMult, 'flak shrapnel does less to shields');
  // A blast drains the shield by what it would really do to the blocks, not by its full damage on
  // every block (15 Nov 2026: overkill on weak blocks drained more than the blast could destroy).
  {
    const b3 = new Battle({ designs: [sd], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true }], seed: 1, maxTime: 60 });
    const e3 = b3.ents[0];
    let real = 0; // what the same blast does to the blocks of an unshielded copy
    const b4 = new Battle({ designs: [sd], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true }], seed: 1, maxTime: 60 });
    const e4 = b4.ents[0]; e4.shield = 0; e4.shieldMax = 0;
    const hp0 = e4.hp.reduce((s, v) => s + v, 0);
    b4.blast(-14, 0, 9, 150, 1); real = hp0 - e4.hp.reduce((s, v) => s + Math.max(0, v), 0);
    b3.blast(-14, 0, 9, 150, 1);
    assert.ok(Math.abs((SHIELD.capacity - e3.shield) - real) < 1, `a blast drains the shield by the damage it would do (${Math.round(SHIELD.capacity - e3.shield)} vs ${Math.round(real)})`);
  }
  // A generator lost without exploding (cut off) is recorded, so the replay's bubble goes away.
  {
    const b5 = new Battle({ designs: [sd], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true }], seed: 1, maxTime: 60 });
    const e5 = b5.ents[0];
    for (let y = 2; y < 12; y++) for (let x = 10; x < 20; x++) e5.hp[y * w + x] = 0;
    b5.refit(e5);
    const n = b5.R.shV.n;
    assert.equal(e5.shieldMax, 0, 'a cut-off generator takes its shield with it');
    assert.equal(b5.R.shV.a[n - 1], 0, 'and the replay records the shield gone');
  }
  // Pool and refill both add up less with each generator, but never stop growing (owner, 21 Nov 2026):
  // the designer and the sim agree; losing a generator drops to the values for the ones left.
  {
    assert.deepEqual([1, 2, 3, 10, 100].map(shieldCap), [7500, 11769, 15318, 33501, 149645], 'shield pool for 1, 2, 3, 10, 100 generators');
    assert.deepEqual([1, 2, 3, 10, 100].map(shieldRegen), [150, 227, 290, 597, 2377], 'refill rates for 1, 2, 3, 10, 100 generators');
    for (let n = 1; n < 300; n++) {
      assert.ok(shieldCap(n + 1) > shieldCap(n) && shieldRegen(n + 1) > shieldRegen(n), `generator ${n + 1} still adds something`);
      if (n > 1) assert.ok(shieldCap(n + 1) - shieldCap(n) <= shieldCap(n) - shieldCap(n - 1) + 1, `generator ${n + 1} adds no more pool than the one before`);
    }
    const W = 50, H = 14, c3 = new Uint8Array(W * H).fill(BT.ARMOR);
    for (const gx of [2, 20, 38]) for (let y = 2; y < 12; y++) for (let x = gx; x < gx + 10; x++) c3[y * W + x] = BT.SHIELD;
    for (let y = 0; y < H; y++) c3[y * W + W - 1] = BT.CANNON;
    const d3 = { name: 'Three', cls: 'cruiser', w: W, h: H, cells: c3, hub: 7 * W + 15, stance: 'line' }; c3[d3.hub] = BT.HUB;
    const a3 = analyzeDesign(d3);
    assert.equal(a3.shield, shieldCap(3), 'three generators give the three-generator pool');
    const b6 = new Battle({ designs: [d3], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true }], seed: 1, maxTime: 60 });
    const e6 = b6.ents[0];
    assert.ok(Math.abs(a3.shieldRegen - e6.shieldRegen) < 1e-9 && Math.abs(e6.shieldRegen - shieldRegen(3)) < 1e-9, `designer and sim agree on the refill rate (${a3.shieldRegen} / ${e6.shieldRegen})`);
    for (let y = 2; y < 12; y++) for (let x = 38; x < 48; x++) e6.hp[y * W + x] = 0; // cut one off
    b6.refit(e6);
    assert.ok(Math.abs(e6.shieldRegen - shieldRegen(2)) < 1e-9 && e6.shieldMax === shieldCap(2), 'losing a generator drops to the two-generator pool and rate');
  }
  // A shield knocked down stays off until it has refilled SHIELD.restart (25%) of its pool (owner, 21 Nov 2026).
  {
    const W = 30, H = 14, c = new Uint8Array(W * H).fill(BT.ARMOR);
    for (let y = 2; y < 12; y++) for (let x = 2; x < 12; x++) c[y * W + x] = BT.SHIELD;
    for (let y = 0; y < H; y++) c[y * W + W - 1] = BT.CANNON;
    const d = { name: 'Restart', cls: 'cruiser', w: W, h: H, cells: c, hub: 7 * W + 20, stance: 'line' }; c[d.hub] = BT.HUB;
    const b = new Battle({ designs: [d], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0, fixed: true }, { design: 0, team: 1, x: 3000, y: 0, a: Math.PI, fixed: true }], seed: 1, maxTime: 60 });
    const e = b.ents[0], cell = 7 * W + 25;
    b.damageCell(e, cell, e.shieldMax + 50);
    assert.ok(e.shield === 0 && e.shDown && e.hp[cell] < 110, 'a hit bigger than the shield knocks it down and the rest goes through');
    const need = Math.ceil((SHIELD.restart * e.shieldMax) / (e.shieldRegen * 0.1));
    for (let k = 0; k < need - 2; k++) b.step();
    assert.equal(e.shield, 0, 'it stays off while it refills');
    const hp = e.hp[7 * W + 24]; b.damageCell(e, 7 * W + 24, 30);
    assert.equal(e.hp[7 * W + 24], hp - 30, 'hits go straight to the blocks while it is off');
    for (let k = 0; k < 4; k++) b.step();
    assert.ok(!e.shDown && e.shield >= SHIELD.restart * e.shieldMax - 1e-6 && e.shield < SHIELD.restart * e.shieldMax + e.shieldRegen, `it comes back at ${Math.round(SHIELD.restart * 100)}% (${Math.round(e.shield)} of ${e.shieldMax})`);
    // The replay viewer shows no bubble while it's off (it used to fade it in from 0), and a 25% bubble after.
    const back = b.now, mv = new ReplayModel(unpackReplay(packReplay(b.toReplay().meta, b.toReplay().cols))), out = { v: 0, hit: 0, down: -1 };
    for (const t of [30, Math.round(back / 2), back - 3]) assert.equal(mv.shieldAt(mv.ents[0], t, out).v, 0, `no shield drawn while it is down (tick ${t})`);
    assert.ok(mv.shieldAt(mv.ents[0], back + 1, out).v > 0.2, 'the bubble is back once the shield is');
  }
  console.log(`shields: ${[1, 2, 10, 100].map(shieldCap).join('/')} pool, ${[1, 2, 10, 100].map(shieldRegen).join('/')}/s refill for 1/2/10/100 generators, blocks protected, generator explodes whole`);
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

// Cannon explosion (owner, 20 Nov 2026): 500 damage into the blocks nearest the impact: 2 heavy
// armour or 11 frame. And the auto gun: a whole 2x2 unit fires bullets; touching units are refused.
{
  const slab = (t) => {
    const w = 30, h = 30, cells = new Uint8Array(w * h).fill(t);
    cells[15 * w + 2] = BT.HUB;
    return { name: 'Slab', cls: 'cruiser', w, h, cells, hub: 15 * w + 2, stance: 'line' };
  };
  for (const [t, want] of [[BT.HEAVY, 2], [BT.FRAME, 11]]) {
    const b = new Battle({ designs: [slab(t), slab(t)], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0 }, { design: 1, team: 1, x: 500, y: 0, a: 0 }], seed: 1 });
    const e = b.ents[0], before = e.hp.filter((v, i) => e.types[i] && v > 0).length;
    b.budgetBlast(e, e.x + 5.3, e.y + 0.4, WEAPON[BT.CANNON].splash, WEAPON[BT.CANNON].damage);
    const after = e.hp.filter((v, i) => e.types[i] && v > 0).length;
    assert.equal(before - after, want, `one cannon shell destroys ${want} ${t === BT.HEAVY ? 'heavy armour' : 'frame'} blocks`);
  }
  const boat = (units) => {
    const w = 12, h = 8, cells = new Uint8Array(w * h);
    for (let j = 1; j < 7; j++) for (let i = 0; i < 10; i++) cells[j * w + i] = j === 1 || j === 6 ? BT.ARMOR : BT.FRAME;
    for (let j = 1; j < 7; j++) cells[j * w] = BT.THRUSTER;
    for (const r of units) cells[r * w + 10] = cells[r * w + 11] = cells[(r + 1) * w + 10] = cells[(r + 1) * w + 11] = BT.AUTO;
    cells[4 * w + 5] = BT.HUB;
    return { name: 'Gunboat', cls: 'frigate', w, h, cells, hub: 4 * w + 5, stance: 'charge' };
  };
  const ok = analyzeDesign(boat([1, 5])), bad = analyzeDesign(boat([2, 4]));
  assert.ok(!ok.errors.length && ok.weapons.filter((x) => x.type === BT.AUTO).length === 2 && ok.cost >= 500, 'two separate auto gun units are two guns');
  assert.ok(bad.errors.some((x) => x.includes('Auto guns')), 'touching auto gun units are refused');
  const ships = [];
  for (let k = 0; k < 6; k++) { ships.push({ design: 0, team: 0, x: -60, y: (k - 3) * 25, a: 0 }); ships.push({ design: 1, team: 1, x: 60, y: (k - 3) * 25, a: Math.PI }); }
  const b = new Battle({ designs: [boat([1, 5]), slab(BT.ARMOR)], ships, seed: 2, maxTime: 60 });
  b.run();
  const K = b.R.shotKind, kinds = K.a.slice(0, K.n ?? K.length);
  assert.ok(Array.from(kinds).filter((k) => k === 7).length > 50, 'auto guns fire bullets (replay shot kind 7)');
  // An auto gun works from whatever side it's on (owner, 20 Nov 2026): a ship holding its range
  // turns so the target sits well inside the gun's arc, not on its edge (where it hardly fired).
  for (const side of ['back', 'top', 'bottom']) {
    const w = 14, h = 14, cells = new Uint8Array(w * h);
    for (let j = 2; j < 12; j++) for (let i = 2; i < 12; i++) cells[j * w + i] = BT.ARMOR;
    for (let j = 4; j < 10; j++) cells[j * w + 2] = BT.THRUSTER;
    cells[7 * w + 7] = BT.HUB;
    const [gx, gy] = side === 'back' ? [0, 6] : side === 'top' ? [6, 0] : [6, 12];
    cells[gy * w + gx] = cells[gy * w + gx + 1] = cells[(gy + 1) * w + gx] = cells[(gy + 1) * w + gx + 1] = BT.AUTO;
    const gun = { name: 'Side gun', cls: 'cruiser', w, h, cells, hub: 7 * w + 7, stance: 'line' };
    const dm = new Uint8Array(36).fill(BT.ARMOR); dm[14] = BT.HUB; dm[20] = BT.CANNON;
    const dummy = { name: 'Dummy', cls: 'frigate', w: 6, h: 6, cells: dm, hub: 14, stance: 'line' };
    const b = new Battle({ designs: [gun, dummy], ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0 }, { design: 1, team: 1, x: 100, y: 0, a: 0, fixed: true }], seed: 3, maxTime: 20 });
    b.run();
    const n = Array.from(b.R.shotKind.a.slice(0, b.R.shotKind.n)).filter((k) => k === 7).length;
    assert.ok(n > 40, `an auto gun on the ${side} of a ship fires (${n} bullets in 20 s)`);
  }
}

// Fleets that start far apart fight it out (owner, 19 Nov 2026: a battle "ended" at 34 s with no
// damage because the 20 s with no damage were counted before the fleets had even met).
{
  const designs = [makeDesign('battleship', 3), makeDesign('battleship', 4)];
  const ships = [];
  for (let k = 0; k < 20; k++) {
    ships.push({ design: 0, team: 0, x: -750, y: (k - 10) * 60, a: 0 });
    ships.push({ design: 1, team: 1, x: 750, y: (k - 10) * 60, a: Math.PI });
  }
  const b = new Battle({ designs, ships, seed: 1, maxTime: 900 });
  b.run();
  assert.ok(b.endReason !== 'stalled' && b.lastDamage > 0 && b.tick > 600, `far-apart fleets meet and fight (ended ${b.endReason} at ${b.tick / 10} s)`);
}
// Giant battles (21 Nov 2026): a fight far from the middle (past the old ±8,191-block limit on event
// positions) is recorded where it happens, not pinned to the edge; normal battles keep 1/4 block.
{
  const designs = [makeDesign('destroyer', 5), makeDesign('destroyer', 6)];
  const ships = [];
  for (let k = 0; k < 12; k++) {
    ships.push({ design: 0, team: 0, x: 11000 - 120, y: (k - 6) * 40, a: 0 });
    ships.push({ design: 1, team: 1, x: 11000 + 120, y: (k - 6) * 40, a: Math.PI });
  }
  const b = new Battle({ designs, ships, seed: 2, maxTime: 40 });
  b.run();
  const { meta, cols } = b.toReplay();
  assert.equal(meta.evQ, 2, 'a battle 11,000 blocks out records events in half blocks');
  assert.ok(cols.expX.length > 0 && cols.expX.every((v) => v !== 32767 && v !== -32768), 'no explosion pinned to the edge');
  const m = new ReplayModel(unpackReplay(packReplay(meta, cols)));
  assert.ok(m.expl.n > 0 && m.expl.x.every((x) => x > 10500 && x < 11500), 'explosions decode where the fight was');
  assert.equal(new Battle({ designs, ships: ships.map((s) => ({ ...s, x: s.x - 11000 })), seed: 2, maxTime: 1 }).evQ, 4, 'normal battles keep 1/4 block');
}
// The viewer's per-slice shot lists (liveIndex) give exactly the shots the old "everything fired within
// the longest flight" window gave that are still around, for every kind and many moments.
{
  const { meta, cols } = new Battle({ ...makeTestScenario(makeDesign('cruiser', 2), 40, null), seed: 4, maxTime: 120 }).run().toReplay();
  const m = new ReplayModel(unpackReplay(packReplay(meta, cols)));
  let compared = 0;
  for (const S of [m.shell, m.missile, m.plasma, m.flak, m.auto, m.frag].filter(Boolean)) {
    let maxF = 0;
    for (let i = 0; i < S.n; i++) maxF = Math.max(maxF, S.t1[i] - S.t0[i]);
    for (let t = 0; t < meta.ticks; t += 7.3) {
      const want = [], got = new Set();
      for (let i = 0; i < S.n; i++) if (S.t0[i] >= t - maxF - 6 && S.t0[i] <= t + 15 && t <= S.t1[i] + 5) want.push(i);
      const [a, b] = S.live(t);
      for (let q = a; q < b; q++) got.add(S.liveIdx[q]);
      for (const i of want) assert.ok(got.has(i), `shot ${i} listed at t=${t}`);
      compared += want.length;
    }
  }
  assert.ok(compared > 1000, `live shot lists checked (${compared})`);
}
// A wreck shot through the middle falls apart (owner, 21 Nov 2026: debris "acted like it was together
// when no blocks connected it"), and the replay rebuilds the new piece from the right blocks.
{
  const w = 15, h = 5, cells = new Uint8Array(w * h).fill(BT.ARMOR);
  for (let j = 0; j < h; j++) { cells[j * w] = BT.THRUSTER; cells[j * w + 1] = BT.HEAVY; }
  cells[2 * w + 14] = BT.CANNON; cells[2 * w + 7] = BT.HUB;
  const designs = [{ name: 'bar', cls: 'destroyer', w, h, cells, hub: 2 * w + 7, stance: 'line' }, makeDesign('destroyer', 1)];
  const b = new Battle({ designs, ships: [{ design: 0, team: 0, x: 0, y: 0, a: 0 }, { design: 1, team: 1, x: 3000, y: 0, a: Math.PI }], seed: 1, maxTime: 30 });
  b.step();
  const ship = b.ents[0];
  b.damageCell(ship, ship.hub, 1e9); b.resolveDamage(); // hub gone: one wreck (every block still joined)
  const wreck = b.ents.filter((e) => e.kind !== ship.kind);
  assert.equal(wreck.length, 1, 'the bar breaks into one wreck');
  const wr = wreck[0];
  for (let j = 0; j < wr.h; j++) b.damageCell(wr, j * wr.w + 4, 1e9); // cut a column through it
  b.resolveDamage();
  const pieces = b.ents.filter((e) => e.kind !== ship.kind && !e.dead);
  assert.equal(pieces.length, 2, 'the wreck cut through falls apart into two');
  const small = pieces.find((e) => e !== wr);
  assert.ok(small.alive < wr.alive && small.org === ship.id, 'the smaller piece breaks away, still known as part of the ship');
  for (let k = 0; k < 20; k++) b.step();
  const { meta, cols } = b.toReplay();
  const m = new ReplayModel(unpackReplay(packReplay(meta, cols)));
  const v = m.ents[small.id];
  const want = [];
  for (let i = 0; i < small.types.length; i++) if (small.types[i]) want.push(small.types[i]);
  assert.deepEqual([...v.type].sort(), want.sort(), 'the replay rebuilds the new piece from the same blocks');
}
// Flak and plasma turrets turn to aim (owner, 22 Nov 2026: shots left from very different places than
// the turrets pointed). The viewer finds which turret fired each shot and points it there as it fires.
{
  const w = 40, h = 32, cells = new Uint8Array(w * h);
  for (let y = 4; y < h - 4; y++) for (let x = 2; x < w - 2; x++) cells[y * w + x] = BT.ARMOR;
  const unit = (x0, y0, t) => { for (let y = y0; y < y0 + 10; y++) for (let x = x0; x < x0 + 10; x++) cells[y * w + x] = t; };
  unit(14, 0, BT.FLAK); unit(14, h - 10, BT.FLAK); unit(w - 12, 11, BT.LANCE);
  for (let y = 6; y < h - 6; y += 2) cells[y * w + 2] = BT.THRUSTER;
  cells[16 * w + 6] = BT.HUB;
  const d = { name: 'turrets', cls: 'battleship', w, h, cells, hub: 16 * w + 6, stance: 'line' };
  const b = new Battle({ ...makeTestScenario(d, 4, null, 2), seed: 2, maxTime: 60 });
  b.run();
  const { meta, cols } = b.toReplay();
  const m = new ReplayModel(unpackReplay(packReplay(meta, cols)));
  assert.ok(m.aimStats.shots > 20, `flak and plasma fired (${m.aimStats.shots} shots)`);
  assert.equal(m.aimStats.matched, m.aimStats.shots, 'every flak and plasma shot is traced to the turret that fired it');
  const out = { a: 0, since: 0 }, tr = { x: 0, y: 0, a: 0 };
  let shots = 0, kinds = new Set();
  for (const e of m.ents) {
    if (e.kind !== 0 || !e.aims) continue;
    e.aims.forEach((A, g) => {
      if (!A) return;
      kinds.add(m.designs[e.design]._guns[g].type);
      m.aimAt(e, g, A.t[0] - 50, out);
      assert.ok(Math.abs(out.a - m.designs[e.design]._guns[g].rest) < 1e-6, 'a turret rests pointing out of the hull before it first fires');
      for (let j = 0; j < A.t.length; j++) {
        m.aimAt(e, g, A.t[j], out);
        const dA = Math.abs(Math.atan2(Math.sin(out.a - A.a[j]), Math.cos(out.a - A.a[j])));
        assert.ok(dA < 1e-4 && out.since === 0, 'at the moment it fires the turret points along its shot');
        shots++;
      }
    });
  }
  assert.ok(kinds.has(BT.FLAK) && kinds.has(BT.LANCE), 'flak and plasma turrets both aim');
  // the flak muzzle record's burst gives the true direction: check one against the recorded aim
  const E = m.expl;
  for (let i = 0; i < E.n; i++) if (E.s[i] === 10) {
    const k = i + 1 + [...E.s.subarray(i + 1, i + 40)].indexOf(6);
    const ship = m.ents.find((e) => e.kind === 0 && e.aims && e.aims.some((A) => A && A.t.includes(E.t[i])));
    assert.ok(ship, 'the flak shot belongs to a ship');
    m.transform(ship, E.t[i], tr);
    const g = ship.aims.findIndex((A) => A && A.t.includes(E.t[i]));
    m.aimAt(ship, g, E.t[i], out);
    const want = Math.atan2(E.y[k] - E.y[i], E.x[k] - E.x[i]) - tr.a;
    assert.ok(Math.abs(Math.atan2(Math.sin(out.a - want), Math.cos(out.a - want))) < 1e-4, 'the flak turret points at its burst');
    break;
  }
  console.log(`  turrets: ${shots} flak and plasma shots, each fired with the turret pointing along it`);
}
console.log(`designer stats match the sim for ${checked} generated designs; validation ok`);
console.log(`${FORTRESSES.length} Aegis fortresses are valid 150,000 cr defences`);
