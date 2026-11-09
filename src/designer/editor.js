// Ship editor state: the block grid, editing operations, mirror symmetry and undo.
// No DOM here, so it can be tested in Node. The grid is always MAX_W x MAX_H (big enough for
// absurd ships); saving crops it to the blocks actually used (cropDesign), which is the format
// the battle sim reads.
//
// Undo stores only the cells each action changed, not copies of the grid: at 1024 x 640 a
// copy is 650 KB, so 200 undo steps of full copies would eat 130 MB.

import { BT, MULTIBLOCK, MAX_W, MAX_H } from '../shared/blocks.js';
import { cropDesign, STANCE_INFO, placeOf } from '../shared/shipStats.js';

const LANCE = MULTIBLOCK[BT.LANCE].size;
const UNDO_LIMIT = 300; // actions
const UNDO_CELLS = 8e6; // total changed cells kept across all undo steps

export class ShipEditor {
  constructor(w = MAX_W, h = MAX_H) {
    this.w = w; this.h = h;
    this.cells = new Uint8Array(w * h);
    this.hubIdx = -1;
    this.name = 'New design';
    this.stance = 'line';
    this.place = 'auto'; // start position in battle (PLACE_INFO)
    this.mirror = true;
    this.undoStack = []; this.redoStack = [];
    this.rec = null; // the action being recorded: { i: [], o: [], n: [] }
    this.quiet = false; // true while undoing/redoing or setting up (writes aren't recorded)
    this.version = 0; // bumps on every change, so the UI knows when to re-analyse
    this.clear(false);
  }

  // ------------------------------------------------------------ basics
  idx(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? y * this.w + x : -1; }
  get(x, y) { const i = this.idx(x, y); return i < 0 ? 0 : this.cells[i]; }
  hub() { return this.hubIdx; }
  /** Mirror axis: the hub's row (so the hub sits on the centreline), else the grid's middle. */
  axis() { return this.hubIdx >= 0 ? (this.hubIdx / this.w) | 0 : (this.h / 2) | 0; }
  mirrorY(y) { return 2 * this.axis() - y; }
  changed() { this.version++; }

  /** Every cell write goes through here: it keeps the hub index and the undo record. */
  write(i, t) {
    const old = this.cells[i];
    if (old === t) return;
    if (!this.quiet) {
      if (!this.rec) this.checkpoint(); // an edit outside any step starts one, so nothing is unrecorded
      this.rec.i.push(i); this.rec.o.push(old); this.rec.n.push(t);
    }
    if (old === BT.HUB && this.hubIdx === i) this.hubIdx = -1;
    if (t === BT.HUB) this.hubIdx = i;
    this.cells[i] = t;
    this.version++;
  }

  // ------------------------------------------------------------ undo
  /** Call before each user action (a stroke, a fill, a load) so it undoes as one step. */
  checkpoint() {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top === this.rec && !top.i.length) return; // reuse an empty step
    this.rec = { i: [], o: [], n: [] };
    this.undoStack.push(this.rec);
    this.redoStack.length = 0;
    let total = 0;
    for (const r of this.undoStack) total += r.i.length;
    while (this.undoStack.length > 1 && (this.undoStack.length > UNDO_LIMIT || total > UNDO_CELLS)) total -= this.undoStack.shift().i.length;
  }

  /** Apply a recorded step backwards (undo) or forwards (redo), without recording. */
  replay(r, back) {
    this.quiet = true;
    if (back) for (let k = r.i.length - 1; k >= 0; k--) this.write(r.i[k], r.o[k]);
    else for (let k = 0; k < r.i.length; k++) this.write(r.i[k], r.n[k]);
    this.quiet = false;
    this.changed();
  }

  undo() {
    while (this.undoStack.length && !this.undoStack[this.undoStack.length - 1].i.length) this.undoStack.pop();
    const r = this.undoStack.pop();
    if (!r) return false;
    if (r === this.rec) this.rec = null;
    this.replay(r, true);
    this.redoStack.push(r);
    return true;
  }

  /** Throw away the step being recorded (a cancelled stroke, a fill that did nothing). */
  cancelStep() {
    const r = this.rec;
    if (!r || this.undoStack[this.undoStack.length - 1] !== r) return;
    this.undoStack.pop();
    this.rec = null;
    if (r.i.length) this.replay(r, true);
  }

  redo() {
    const r = this.redoStack.pop();
    if (!r) return false;
    this.replay(r, false);
    this.undoStack.push(r);
    this.rec = null; // the next edit starts a fresh step
    return true;
  }

  clear(undoable = true) {
    if (undoable) this.checkpoint(); else this.quiet = true;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i]) this.write(i, 0);
    this.write(this.idx((this.w / 2) | 0, (this.h / 2) | 0), BT.HUB);
    this.quiet = false;
    this.changed();
  }

  // ------------------------------------------------------------ editing
  /** Remove the whole heavy-laser unit that cell i belongs to (local flood fill). */
  clearGroupAt(i) {
    const t = this.cells[i], q = [i], seen = new Set(q);
    for (let k = 0; k < q.length; k++) {
      const c = q[k], x = c % this.w;
      for (const n of [x > 0 ? c - 1 : -1, x < this.w - 1 ? c + 1 : -1, c - this.w, c + this.w])
        if (n >= 0 && n < this.cells.length && !seen.has(n) && this.cells[n] === t) { seen.add(n); q.push(n); }
    }
    for (const c of q) this.write(c, 0);
  }

  /** Set one cell (no mirroring). Keeps the one-hub rule and whole heavy-laser units. */
  setCell(x, y, type) {
    const i = this.idx(x, y);
    if (i < 0) return;
    const old = this.cells[i];
    if (old === type) return;
    if (old === BT.HUB && type !== BT.HUB) return; // the hub can be moved, never erased
    if (MULTIBLOCK[old]) this.clearGroupAt(i);
    if (type === BT.HUB && this.hubIdx >= 0) this.write(this.hubIdx, 0);
    this.write(i, type);
  }

  /** Paint with mirror symmetry (the hub is never mirrored: a ship has one). */
  paint(x, y, type) {
    if (MULTIBLOCK[type]) return this.stamp(x, y, type);
    this.setCell(x, y, type);
    if (this.mirror && type !== BT.HUB) {
      const my = this.mirrorY(y);
      if (my !== y) this.setCell(x, my, type);
    }
  }

  erase(x, y) { this.paint(x, y, 0); }

  /** Top-left corner for a heavy-laser unit centred on (x, y). */
  static stampOrigin(x, y) { return [x - (LANCE >> 1) + 1, y - (LANCE >> 1) + 1]; }

  /** Place a whole 10x10 heavy-laser unit centred on (x, y), mirrored if it doesn't overlap itself. */
  stamp(x, y, type = BT.LANCE) {
    const [x0, y0] = ShipEditor.stampOrigin(x, y);
    if (!this.placeUnit(x0, y0, type)) return false;
    if (this.mirror) {
      const my0 = this.mirrorY(y0 + LANCE - 1);
      if (my0 >= y0 + LANCE || my0 + LANCE <= y0) this.placeUnit(x0, my0, type);
    }
    return true;
  }

  placeUnit(x0, y0, type) {
    if (x0 < 0 || y0 < 0 || x0 + LANCE > this.w || y0 + LANCE > this.h) return false;
    for (let y = y0; y < y0 + LANCE; y++)
      for (let x = x0; x < x0 + LANCE; x++) if (this.cells[y * this.w + x] === BT.HUB) return false;
    for (let y = y0; y < y0 + LANCE; y++) for (let x = x0; x < x0 + LANCE; x++) this.setCell(x, y, type);
    return true;
  }

  /** Fill a rectangle (mirrored). Heavy lasers can't be rectangle-filled. */
  rect(ax, ay, bx, by, type) {
    if (MULTIBLOCK[type] || type === BT.HUB) return;
    const x0 = Math.max(0, Math.min(ax, bx)), x1 = Math.min(this.w - 1, Math.max(ax, bx));
    const y0 = Math.max(0, Math.min(ay, by)), y1 = Math.min(this.h - 1, Math.max(ay, by));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.paint(x, y, type);
  }

  /**
   * Flood fill the region of same-type cells at (x, y) with `type` (mirrored).
   * Filling empty space only works inside a closed outline, so it can't flood the whole grid.
   * Returns false if nothing was filled.
   */
  fill(x, y, type) {
    if (MULTIBLOCK[type] || type === BT.HUB) return false;
    const start = this.idx(x, y);
    if (start < 0) return false;
    const from = this.cells[start];
    if (from === type || from === BT.HUB || MULTIBLOCK[from]) return false;
    const seen = new Uint8Array(this.cells.length), q = [start];
    seen[start] = 1;
    for (let k = 0; k < q.length; k++) {
      const c = q[k], cx = c % this.w, cy = (c / this.w) | 0;
      if (from === 0 && (cx === 0 || cy === 0 || cx === this.w - 1 || cy === this.h - 1)) return false; // open to space
      for (const n of [cx > 0 ? c - 1 : -1, cx < this.w - 1 ? c + 1 : -1, c - this.w, c + this.w])
        if (n >= 0 && n < this.cells.length && !seen[n] && this.cells[n] === from) { seen[n] = 1; q.push(n); }
    }
    for (const c of q) this.paint(c % this.w, (c / this.w) | 0, type);
    return true;
  }

  // ------------------------------------------------------------ designs in and out
  /** The design as the battle sim and server will see it (cropped). */
  toDesign() { return cropDesign(this); }

  /** Load a saved-format design, centred in the grid with its hub on the middle row if it fits. */
  load(d) {
    this.checkpoint();
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i]) this.write(i, 0);
    const hy = (d.hub / d.w) | 0;
    let ox = ((this.w - d.w) / 2) | 0, oy = ((this.h / 2) | 0) - hy;
    oy = Math.max(0, Math.min(this.h - d.h, oy));
    ox = Math.max(0, Math.min(this.w - d.w, ox));
    for (let y = 0; y < d.h; y++)
      for (let x = 0; x < d.w; x++) {
        const t = d.cells[y * d.w + x];
        if (t) this.write((y + oy) * this.w + x + ox, t);
      }
    this.name = d.name || 'Unnamed';
    this.stance = STANCE_INFO[d.stance] ? d.stance : 'line';
    this.place = placeOf(d.place);
    this.changed();
  }

  /** Remove every block of one type (thrusters from a defence, say) as one undo step. Returns how many. */
  removeType(t) {
    this.checkpoint();
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === t && t !== BT.HUB) { this.write(i, 0); n++; }
    this.changed();
    return n;
  }

  /** Forget all undo history (after restoring a saved session, say). */
  resetHistory() { this.undoStack.length = 0; this.redoStack.length = 0; this.rec = null; }
}
