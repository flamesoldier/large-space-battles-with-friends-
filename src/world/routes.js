// Fleet routes. A fleet can fly straight to any world through normal space, or hop along
// hyperlanes at HYPERLANE_SPEEDUP× speed, or mix the two (fly to a lane, ride it, fly off it).
// The planner finds the fastest mix with Dijkstra over every world: lane edges cost
// length / (speed × 10), and every pair of worlds is also joined by a normal-space edge costing
// length / speed. Fleets don't stop at the worlds they pass through.

import { HYPERLANE_SPEEDUP, TRAVEL_SCALE, HOUR_MS } from './rules.js';

/** Galaxy units per hour for a fleet whose slowest ship has this battle top speed. */
export const travelSpeed = (maxSpeed) => maxSpeed * TRAVEL_SCALE;

/** Lane adjacency for a planet list: Map(id → Set of ids). */
export function laneMap(lanes) {
  const m = new Map();
  for (const [a, b] of lanes) {
    if (!m.has(a)) m.set(a, new Set());
    if (!m.has(b)) m.set(b, new Set());
    m.get(a).add(b); m.get(b).add(a);
  }
  return m;
}

/**
 * Fastest route from planet `from` to planet `to` at `speed` units per hour.
 * useLanes = false gives the straight normal-space flight.
 * Returns { hours, legs: [{ from, to, lane, hours }] }.
 */
export function planRoute(planets, lanes, from, to, speed, useLanes = true) {
  const d = (a, b) => Math.hypot(planets[a].x - planets[b].x, planets[a].y - planets[b].y);
  if (from === to) return { hours: 0, legs: [] };
  const adj = lanes instanceof Map ? lanes : laneMap(lanes);
  if (!useLanes || !adj.size) {
    const h = d(from, to) / speed;
    return { hours: h, legs: [{ from, to, lane: false, hours: h }] };
  }
  const n = planets.length, best = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), viaLane = new Uint8Array(n), done = new Uint8Array(n);
  best[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && best[i] < Infinity && (u < 0 || best[i] < best[u])) u = i;
    if (u < 0 || u === to) break;
    done[u] = 1;
    const lanesU = adj.get(u);
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const lane = lanesU ? lanesU.has(v) : false;
      const c = best[u] + d(u, v) / (lane ? speed * HYPERLANE_SPEEDUP : speed);
      // Ties go to the lane (same time, and the route reads better on the map).
      if (c < best[v] - 1e-9 || (lane && Math.abs(c - best[v]) <= 1e-9)) { best[v] = c; prev[v] = u; viaLane[v] = lane ? 1 : 0; }
    }
  }
  const legs = [];
  for (let v = to; v !== from; v = prev[v]) {
    const u = prev[v];
    legs.push({ from: u, to: v, lane: !!viaLane[v], hours: d(u, v) / (viaLane[v] ? speed * HYPERLANE_SPEEDUP : speed) });
  }
  legs.reverse();
  return { hours: best[to], legs };
}

/**
 * Where a fleet is at time t (ms), as a pure function of its plan: { x, y, angle, leg }.
 * fleet: { depart, legs } (legs as planRoute returns them).
 */
export function fleetPosition(planets, fleet, t) {
  let h = Math.max(0, (t - fleet.depart) / HOUR_MS);
  for (let k = 0; k < fleet.legs.length; k++) {
    const L = fleet.legs[k], A = planets[L.from], B = planets[L.to];
    const angle = Math.atan2(B.y - A.y, B.x - A.x);
    if (h <= L.hours || k === fleet.legs.length - 1) {
      const f = L.hours > 0 ? Math.min(1, h / L.hours) : 1;
      return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, angle, leg: k };
    }
    h -= L.hours;
  }
  const P = planets[fleet.to];
  return { x: P.x, y: P.y, angle: 0, leg: 0 };
}
