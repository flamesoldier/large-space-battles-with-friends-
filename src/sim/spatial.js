// Uniform grid broadphase, rebuilt from scratch every tick with a counting sort.
// No per-tick allocation, no Maps: two passes over the entities and a prefix sum.
// Entities outside the bounds are clamped into edge cells, which is still correct
// because every candidate gets an exact test afterwards.

// One query counter for every grid, so grids holding the same entities (the battle's main grid and its
// per-side ship grids) never mistake each other's "already visited" marks (`e._q`).
let QID = 1;

export class SpatialGrid {
  constructor(cellSize = 32, halfExtent = 6144) {
    this.cs = cellSize;
    this.half = halfExtent;
    this.n = Math.ceil((2 * halfExtent) / cellSize);
    const cells = this.n * this.n;
    this.count = new Int32Array(cells);
    this.start = new Int32Array(cells + 1);
    this.items = new Int32Array(4096);
    this.ents = null;
    this.bx0 = 0; this.bx1 = -1; this.by0 = 0; this.by1 = -1; // cells the last build covered (see build)
  }

  cx(x) {
    const c = Math.floor((x + this.half) / this.cs);
    return c < 0 ? 0 : c >= this.n ? this.n - 1 : c;
  }

  build(ents, margin = 3) {
    // Only the box of cells the entities cover is cleared and summed (and the last build's box cleared), not the
    // whole grid: a battle covers a few thousand of its 147,000 cells (owner, 22 Nov 2026: cheaper movement). Cells
    // outside the box keep count 0, so queries there find nothing, exactly as before.
    const { count, start, n } = this;
    if (this.bx1 >= this.bx0) for (let y = this.by0; y <= this.by1; y++) count.fill(0, y * n + this.bx0, y * n + this.bx1 + 1);
    let total = 0, bx0 = n, bx1 = -1, by0 = n, by1 = -1;
    for (let k = 0; k < ents.length; k++) {
      const e = ents[k];
      const r = e.radius + margin;
      const x0 = this.cx(e.x - r), x1 = this.cx(e.x + r), y0 = this.cx(e.y - r), y1 = this.cx(e.y + r);
      e._gx0 = x0; e._gx1 = x1; e._gy0 = y0; e._gy1 = y1;
      if (x0 < bx0) bx0 = x0; if (x1 > bx1) bx1 = x1; if (y0 < by0) by0 = y0; if (y1 > by1) by1 = y1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) count[y * n + x]++;
      total += (x1 - x0 + 1) * (y1 - y0 + 1);
    }
    this.bx0 = bx0; this.bx1 = bx1; this.by0 = by0; this.by1 = by1;
    if (this.items.length < total) this.items = new Int32Array(total * 2);
    let s = 0;
    for (let y = by0; y <= by1; y++)
      for (let i = y * n + bx0, iEnd = y * n + bx1; i <= iEnd; i++) { start[i] = s; s += count[i]; count[i] = 0; }
    const items = this.items;
    for (let k = 0; k < ents.length; k++) {
      const e = ents[k];
      for (let y = e._gy0; y <= e._gy1; y++)
        for (let x = e._gx0; x <= e._gx1; x++) {
          const c = y * n + x;
          items[start[c] + count[c]++] = k;
        }
    }
    this.ents = ents;
  }

  // The shared counter, for callers that walk the cells themselves (Battle.sweep and friends: `q = ++grid.qid`).
  get qid() { return QID; }
  set qid(v) { QID = v; }

  /** Visit each distinct entity whose cells overlap the AABB. fn(e) returning true stops. */
  queryBox(minX, minY, maxX, maxY, fn) {
    const q = ++QID;
    const { n, start, count, items, ents } = this;
    const x0 = this.cx(minX), x1 = this.cx(maxX), y0 = this.cx(minY), y1 = this.cx(maxY);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const c = y * n + x, s = start[c], m = count[c];
        for (let k = 0; k < m; k++) {
          const e = ents[items[s + k]];
          if (e._q === q) continue;
          e._q = q;
          if (fn(e)) return;
        }
      }
  }

  /** Visit the entities in one square ring of cells round cell (cx, cy) not yet marked with q. */
  visitRing(cx, cy, ring, q, fn) {
    const { n, start, count, items, ents } = this;
    if (!ents) return;
    for (let gy = cy - ring; gy <= cy + ring; gy++) {
      if (gy < 0 || gy >= n) continue;
      const edgeRow = gy === cy - ring || gy === cy + ring;
      for (let gx = cx - ring; gx <= cx + ring; gx += edgeRow ? 1 : 2 * ring || 1) {
        if (gx < 0 || gx >= n) continue;
        const c = gy * n + gx, s = start[c], m = count[c];
        for (let k = 0; k < m; k++) {
          const e = ents[items[s + k]];
          if (e._q === q) continue;
          e._q = q;
          fn(e);
        }
      }
    }
  }

  /** queryRings over several grids of the same cell size at once (ring by ring across all of them). */
  static queryRingsMulti(grids, x, y, maxRings, fn) {
    if (!grids.length) return;
    const q = ++QID, g0 = grids[0], cx = g0.cx(x), cy = g0.cx(y);
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let k = 0; k < grids.length; k++) grids[k].visitRing(cx, cy, ring, q, fn);
      if (fn.done && fn.done(ring)) return;
    }
  }

  /** Visit entities in square rings of cells around (x, y), nearest ring first. */
  queryRings(x, y, maxRings, fn) {
    const q = ++QID;
    const { n, start, count, items, ents } = this;
    const cx = this.cx(x), cy = this.cx(y);
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let gy = cy - ring; gy <= cy + ring; gy++) {
        if (gy < 0 || gy >= n) continue;
        const edgeRow = gy === cy - ring || gy === cy + ring;
        for (let gx = cx - ring; gx <= cx + ring; gx += edgeRow ? 1 : 2 * ring || 1) {
          if (gx < 0 || gx >= n) continue;
          const c = gy * n + gx, s = start[c], m = count[c];
          for (let k = 0; k < m; k++) {
            const e = ents[items[s + k]];
            if (e._q === q) continue;
            e._q = q;
            fn(e);
          }
        }
      }
      if (fn.done && fn.done(ring)) return;
    }
  }
}
