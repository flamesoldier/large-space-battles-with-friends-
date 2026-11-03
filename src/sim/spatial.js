// Uniform grid broadphase, rebuilt from scratch every tick with a counting sort.
// No per-tick allocation, no Maps: two passes over the entities and a prefix sum.
// Entities outside the bounds are clamped into edge cells, which is still correct
// because every candidate gets an exact test afterwards.

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
    this.qid = 1;
  }

  cx(x) {
    const c = Math.floor((x + this.half) / this.cs);
    return c < 0 ? 0 : c >= this.n ? this.n - 1 : c;
  }

  build(ents, margin = 3) {
    const { count, start, n } = this;
    count.fill(0);
    let total = 0;
    for (let k = 0; k < ents.length; k++) {
      const e = ents[k];
      const r = e.radius + margin;
      const x0 = this.cx(e.x - r), x1 = this.cx(e.x + r), y0 = this.cx(e.y - r), y1 = this.cx(e.y + r);
      e._gx0 = x0; e._gx1 = x1; e._gy0 = y0; e._gy1 = y1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) count[y * n + x]++;
      total += (x1 - x0 + 1) * (y1 - y0 + 1);
    }
    if (this.items.length < total) this.items = new Int32Array(total * 2);
    let s = 0;
    for (let i = 0; i < count.length; i++) { start[i] = s; s += count[i]; count[i] = 0; }
    start[count.length] = s;
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

  /** Visit each distinct entity whose cells overlap the AABB. fn(e) returning true stops. */
  queryBox(minX, minY, maxX, maxY, fn) {
    const q = ++this.qid;
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

  /** Visit entities in square rings of cells around (x, y), nearest ring first. */
  queryRings(x, y, maxRings, fn) {
    const q = ++this.qid;
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
