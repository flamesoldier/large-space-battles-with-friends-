// Player-arranged defences (owner, 20 Nov 2026: "my players really wanted to build a designable
// defence/fortress by moving all the defences they have on a planet into an arrangement").
//
// A world's owner can place each of their defences there and turn it to any angle. The layout is
// stored on the world as P.layout = { owner, spots: [{ d, x, y, a }] }: d is the world design id,
// (x, y) the centre of the design's grid in battle blocks with the world at (0, 0), a the way its
// nose points (radians, battle frame: x right, y down). Attackers keep today's rule (owner's
// choice): one attacker comes in from the left (angle π); several spread evenly round the world.
//
// Refill rule (owner's choice): the k-th defence of a design at the world takes the k-th spot of
// that design, so spots emptied by losses are refilled by new defences of the same design; any
// beyond the spots are laid out in the usual rows, outside the arranged ones.
//
// Spacing (owner's choice): defences may touch but not overlap. Two blocks overlap when their
// centres are closer than OVERLAP blocks, so blocks side by side (1 apart) are fine at any angle.
//
// Pure functions shared by the world rules (server validation, battles) and the page's editor.

export const LAYOUT_RADIUS = 1000; // every block of an arranged defence stays within this of the world
export const MAX_SPOTS = 2000;
const OVERLAP = 0.9;

const shapes = new WeakMap();
/** A design's blocks as a lookup: { w, h, occ: Uint8Array(w*h), cells: Int32Array of filled indexes, r }. */
export function shapeOf(design) {
  let s = shapes.get(design);
  if (s) return s;
  const { w, h, cells } = design, occ = new Uint8Array(w * h), list = [];
  for (let i = 0; i < w * h; i++) if (cells[i]) { occ[i] = 1; list.push(i); }
  s = { w, h, occ, cells: Int32Array.from(list), r: Math.hypot(w, h) / 2 };
  shapes.set(design, s);
  return s;
}

/** World position of block i of a piece { shape, x, y, a }. */
function blockPos(p, i, out) {
  const S = p.shape, lx = (i % S.w) + 0.5 - S.w / 2, ly = ((i / S.w) | 0) + 0.5 - S.h / 2;
  const c = Math.cos(p.a), s = Math.sin(p.a);
  out[0] = p.x + lx * c - ly * s; out[1] = p.y + lx * s + ly * c;
}

/** Do the boxes of two pieces overlap (separating axis test on their rotated grids)? */
function boxesTouch(A, B) {
  const dx = B.x - A.x, dy = B.y - A.y;
  if (dx * dx + dy * dy > (A.shape.r + B.shape.r + 1) ** 2) return false;
  const axes = [A.a, A.a + Math.PI / 2, B.a, B.a + Math.PI / 2];
  const ext = (p, ux, uy) => {
    const c = Math.cos(p.a), s = Math.sin(p.a);
    return (p.shape.w / 2) * Math.abs(c * ux + s * uy) + (p.shape.h / 2) * Math.abs(-s * ux + c * uy);
  };
  for (const t of axes) {
    const ux = Math.cos(t), uy = Math.sin(t);
    if (Math.abs(dx * ux + dy * uy) >= ext(A, ux, uy) + ext(B, ux, uy) - 0.05) return false;
  }
  return true;
}

/** Do two placed defences overlap block for block? (Touching is fine.) */
export function piecesOverlap(A, B) {
  if (!boxesTouch(A, B)) return false;
  if (A.shape.cells.length > B.shape.cells.length) [A, B] = [B, A];
  const S = B.shape, c = Math.cos(B.a), s = Math.sin(B.a), pos = [0, 0], lim = OVERLAP * OVERLAP;
  for (const i of A.shape.cells) {
    blockPos(A, i, pos);
    // into B's grid coordinates (cell centres at whole numbers + 0.5)
    const dx = pos[0] - B.x, dy = pos[1] - B.y;
    const gx = dx * c + dy * s + S.w / 2, gy = -dx * s + dy * c + S.h / 2;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    for (let y = iy - 1; y <= iy + 1; y++) {
      if (y < 0 || y >= S.h) continue;
      for (let x = ix - 1; x <= ix + 1; x++) {
        if (x < 0 || x >= S.w || !S.occ[y * S.w + x]) continue;
        const ex = gx - (x + 0.5), ey = gy - (y + 0.5);
        if (ex * ex + ey * ey < lim) return true;
      }
    }
  }
  return false;
}

/** How far a piece's furthest block corner reaches from the world (cheap: its box corners). */
export function pieceReach(p) {
  const c = Math.cos(p.a), s = Math.sin(p.a), hw = p.shape.w / 2, hh = p.shape.h / 2;
  let r = 0;
  for (const [u, v] of [[hw, hh], [hw, -hh], [-hw, hh], [-hw, -hh]]) r = Math.max(r, Math.hypot(p.x + u * c - v * s, p.y + u * s + v * c));
  return r;
}

/**
 * Indexes of pieces that overlap another piece (a grid hash keeps it fast for hundreds).
 * pieces: [{ shape, x, y, a }].
 */
export function overlapping(pieces) {
  const CELL = 64, grid = new Map(), bad = new Set();
  const keys = (p, f) => {
    const r = p.shape.r;
    for (let cx = Math.floor((p.x - r) / CELL); cx <= Math.floor((p.x + r) / CELL); cx++)
      for (let cy = Math.floor((p.y - r) / CELL); cy <= Math.floor((p.y + r) / CELL); cy++) f(`${cx},${cy}`);
  };
  pieces.forEach((p, i) => {
    const seen = new Set();
    keys(p, (k) => {
      for (const j of grid.get(k) || []) {
        if (seen.has(j)) continue;
        seen.add(j);
        if (piecesOverlap(p, pieces[j])) { bad.add(i); bad.add(j); }
      }
    });
    keys(p, (k) => { let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); });
  });
  return bad;
}

/**
 * Check and tidy a layout sent by a player. shapeFor(d) → shape or null if d isn't one of their
 * defence designs. Returns { ok, spots } (rounded) or { ok: false, error }.
 */
export function cleanLayout(spots, shapeFor) {
  if (!Array.isArray(spots)) return { ok: false, error: 'That layout is broken.' };
  if (spots.length > MAX_SPOTS) return { ok: false, error: `At most ${MAX_SPOTS.toLocaleString()} defences can be arranged at one world.` };
  const out = [], pieces = [];
  for (const sp of spots) {
    if (!sp || typeof sp.d !== 'string' || ![sp.x, sp.y, sp.a].every(Number.isFinite)) return { ok: false, error: 'That layout is broken.' };
    const shape = shapeFor(sp.d);
    if (!shape) return { ok: false, error: 'Only your own defences can be arranged.' };
    let a = sp.a % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    const s = { d: sp.d, x: Math.round(sp.x * 10) / 10, y: Math.round(sp.y * 10) / 10, a: Math.round(a * 1000) / 1000 };
    const p = { shape, x: s.x, y: s.y, a: s.a };
    if (pieceReach(p) > LAYOUT_RADIUS) return { ok: false, error: `Keep every defence within ${LAYOUT_RADIUS} blocks of the world.` };
    out.push(s); pieces.push(p);
  }
  if (overlapping(pieces).size) return { ok: false, error: 'Some defences overlap. They can touch, but not overlap.' };
  return { ok: true, spots: out };
}

/**
 * Give arranged defences their spots in a battle. fixed: battle ships { design (scenario index) },
 * info(s) → { wid, owner } (world design id and owner), layout: P.layout. Sets x, y, a on the ones
 * that get a spot and returns { placed, loose } (loose ones still need the usual rows).
 */
export function assignSpots(fixed, info, layout) {
  if (!layout?.spots?.length) return { placed: [], loose: fixed };
  const queues = new Map();
  for (const sp of layout.spots) { let q = queues.get(sp.d); if (!q) queues.set(sp.d, (q = [])); q.push(sp); }
  const placed = [], loose = [];
  for (const s of fixed) {
    const it = info(s), q = it && it.owner === layout.owner ? queues.get(it.wid) : null;
    const sp = q && q.shift();
    if (sp) { s.x = sp.x; s.y = sp.y; s.a = sp.a; placed.push(s); } else loose.push(s);
  }
  return { placed, loose };
}
