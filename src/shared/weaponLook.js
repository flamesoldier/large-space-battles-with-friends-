// Which way a weapon block is drawn pointing (owner, 20 Nov 2026: after the auto gun's barrels were
// turned to point out of the hull, "do the same with the other weapons"). Looks only: the sim never
// reads this. Shared by the replay viewer (model.js) and the ship designer so both draw the same.
//
// Directions are 0..7 in 45° steps from the nose (local +x), turning toward +y (down the grid).
import { arcCentre } from './arcs.js';

export const lookAngle = (dir) => dir * (Math.PI / 4);
const toDir = (ang) => ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;

/**
 * A single-block weapon points away from its open neighbours (the 8 cells round it; outside the
 * grid counts as open), so a gun on the top edge points up and one on a corner points diagonally.
 * Buried, or open evenly on opposite sides: the nose.
 */
export function openDir(cells, w, h, i) {
  const x = i % w, y = (i / w) | 0;
  let sx = 0, sy = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx]) continue;
    const k = dx && dy ? 0.7 : 1;
    sx += dx * k; sy += dy * k;
  }
  return sx * sx + sy * sy < 0.01 ? 0 : toDir(Math.atan2(sy, sx));
}

/**
 * A multi-block weapon (plasma, flak, fighter bay, auto gun) points along the middle of its widest
 * open line of fire (m0/m1 from arcs.js); a fighter bay with only a tunnel out points down the
 * tunnel's first stretch (`route` from bayRoute). Neither: the nose.
 */
export function unitDir({ m0 = 0, m1 = 0, route = null }) {
  if (m0 || m1) return toDir(arcCentre(m0, m1));
  if (route && route.length >= 4) return toDir(Math.atan2(route[3] - route[1], route[2] - route[0]));
  return 0;
}
