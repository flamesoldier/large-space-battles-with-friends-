// Fighter bay exits (owner, Nov 2026): a bay with no straight open line to space can still launch
// if there is a path of empty cells out of the ship, corners allowed. Used by the sim
// (Battle.bayExit) and the designer (analyzeDesign), so both agree on which bays are sealed in.

/**
 * Shortest path of empty cells (4-connected) from the side of a fighter bay unit to the edge of
 * the ship's grid. `group` is the bay's cells; `hp` may be null (undamaged design), otherwise a
 * cell with hp <= 0 counts as empty (shot away).
 * Returns the route as grid coordinates [x0, y0, x1, y1, ...]: the unit's centre, then only the
 * corners of the path (cell centres), then two cells out past the edge of the grid. Null if there
 * is no way out. Cost: one breadth-first search over the grid.
 */
export function bayRoute(types, hp, w, h, group) {
  const n = w * h;
  const empty = (c) => !types[c] || (hp && hp[c] <= 0);
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (const c of group) { const x = c % w, y = (c / w) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  const ox = (bx0 + bx1 + 1) / 2, oy = (by0 + by1 + 1) / 2;
  // A unit on the edge of the grid: straight out (arcs.js normally finds this one first).
  const edge = (x, y) => x === 0 || y === 0 || x === w - 1 || y === h - 1;
  const prev = new Int32Array(n).fill(-2); // -2 unseen, -1 start (next to the unit)
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx >= bx0 && nx <= bx1 && ny >= by0 && ny <= by1) continue; // inside the unit
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return finish([ox, oy, x + 0.5, y + 0.5], DX[k], DY[k]);
      const c = ny * w + nx;
      if (prev[c] !== -2 || !empty(c)) continue;
      prev[c] = -1; queue[qt++] = c;
    }
  }
  while (qh < qt) {
    const c = queue[qh++], x = c % w, y = (c / w) | 0;
    if (edge(x, y)) {
      // Walk back to the unit, then put the points in launch order.
      const cellsBack = [];
      for (let p = c; p >= 0; p = prev[p]) cellsBack.push(p);
      const pts = [ox, oy];
      for (let i = cellsBack.length - 1; i >= 0; i--) pts.push((cellsBack[i] % w) + 0.5, ((cellsBack[i] / w) | 0) + 0.5);
      const dx = x === 0 ? -1 : x === w - 1 ? 1 : 0, dy = dx ? 0 : y === 0 ? -1 : 1;
      return finish(pts, dx, dy);
    }
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const d = ny * w + nx;
      if (prev[d] !== -2 || !empty(d)) continue;
      prev[d] = c; queue[qt++] = d;
    }
  }
  return null;
}

// Add the exit point outside the grid and keep only the corners.
function finish(pts, dx, dy) {
  pts.push(pts[pts.length - 2] + dx * 2, pts[pts.length - 1] + dy * 2);
  // out[0..1] is the unit's centre; from out[2..3] on, drop a point when the path runs straight on through it.
  const out = [pts[0], pts[1], pts[2], pts[3]];
  for (let i = 4; i < pts.length; i += 2) {
    const m = out.length;
    if (m >= 6) {
      const ax = out[m - 2] - out[m - 4], ay = out[m - 1] - out[m - 3], bx = pts[i] - out[m - 2], by = pts[i + 1] - out[m - 1];
      if (ax * by - ay * bx === 0 && ax * bx + ay * by > 0) { out[m - 2] = pts[i]; out[m - 1] = pts[i + 1]; continue; }
    }
    out.push(pts[i], pts[i + 1]);
  }
  return out;
}

/** Route length in blocks (for the designer's hover text). */
export function routeLength(pts) {
  let s = 0;
  for (let i = 2; i < pts.length; i += 2) s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return s;
}
