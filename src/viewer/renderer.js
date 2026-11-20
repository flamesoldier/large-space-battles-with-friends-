// WebGL2 renderer: every block, shot, beam and spark is one instanced quad.
// Two draw calls per frame (opaque hull blocks, then additive glow effects).
// Per-frame CPU work is filling one Float32Array, with viewport culling and a
// level-of-detail switch that draws a whole ship as one quad when blocks are < ~1px.

import { BT } from '../shared/blocks.js';
import { hash01 } from '../shared/rng.js';
import { lowerBound } from './model.js';

const VS = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in vec3 posA;
layout(location=2) in vec3 sizeShape;
layout(location=3) in vec4 color;
uniform vec2 uCam; uniform vec2 uScale;
out vec2 vUV; out vec4 vCol; flat out highp float vShape; flat out float vAng; flat out vec2 vSize;
void main(){
  float c = cos(posA.z), s = sin(posA.z);
  vec2 l = corner * sizeShape.xy;
  vec2 w = posA.xy + vec2(l.x*c - l.y*s, l.x*s + l.y*c);
  gl_Position = vec4((w - uCam) * uScale, 0.0, 1.0);
  vUV = corner; vCol = color; vShape = sizeShape.z; vAng = posA.z; vSize = sizeShape.xy;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUV; in vec4 vCol; flat in highp float vShape; flat in float vAng; flat in vec2 vSize; out vec4 o;
uniform float uDet;   // 0..1: how much fine detail to draw (by on-screen block size)
uniform float uTime;  // replay time in ticks, for glows that pulse
// Detailed hull block. Shape code = 10 + type + 16 * open-sides mask + 256 * var + 2^20 (DEAD_BIT) if
// it's debris; var is 0..7 for variety, or for plasma cannon blocks u * 10 + v, the block's
// place in its 10x10 unit (the whole unit is drawn as one machine). Edges facing open space get a bevel lit from the upper left of the
// world and a dark outline, so a hull reads as solid plating instead of a grid of tiles; each
// block type has its own surface (plates, rivets, truss, nozzle, lens, turret, tubes, coils).
vec2 rotd(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(v.x * c + v.y * s, -v.x * s + v.y * c); } // into a gun's own frame (barrels along +x)
vec3 hullBlock(int code, vec2 p) {
  int type = code & 15, mask = (code >> 4) & 15, var = (code >> 8) & 4095, hv = var & 7;
  bool dead = code >= 1048576;
  float c = cos(vAng), s = sin(vAng);
  vec2 Lw = vec2(-0.6, -0.8);
  vec2 L = vec2(Lw.x * c + Lw.y * s, -Lw.x * s + Lw.y * c); // light in block space
  vec3 col = vCol.rgb * (0.94 + 0.02 * float(hv));
  float lit = 1.0, ol = 0.0, b;
  if ((mask & 1) == 0) { b = smoothstep(0.45, 1.0, p.x);  lit += b * (L.x * 0.5 - 0.1);  ol = max(ol, smoothstep(0.80, 0.9, p.x)); }
  if ((mask & 2) == 0) { b = smoothstep(0.45, 1.0, -p.x); lit += b * (-L.x * 0.5 - 0.1); ol = max(ol, smoothstep(0.80, 0.9, -p.x)); }
  if ((mask & 4) == 0) { b = smoothstep(0.45, 1.0, p.y);  lit += b * (L.y * 0.5 - 0.1);  ol = max(ol, smoothstep(0.80, 0.9, p.y)); }
  if ((mask & 8) == 0) { b = smoothstep(0.45, 1.0, -p.y); lit += b * (-L.y * 0.5 - 0.1); ol = max(ol, smoothstep(0.80, 0.9, -p.y)); }
  float d = uDet, r = length(p), sh = dot(p, L);
  lit -= smoothstep(0.86, 1.0, max(abs(p.x), abs(p.y))) * 0.08 * d; // faint seams between plates
  vec3 glow = vec3(0.0);
  if (type == 1) {        // hub: glowing core
    float core = 1.0 - smoothstep(0.15, 0.6, r);
    float pulse = dead ? 0.0 : 0.75 + 0.25 * sin(uTime * 0.35);
    lit *= 0.75 + 0.25 * smoothstep(0.75, 0.6, r);
    glow = mix(col, vec3(1.0), 0.5) * core * pulse * d;
  } else if (type == 2) { // armour: plate with rivets in the corners
    float rv = 1.0 - smoothstep(0.06, 0.12, length(abs(p) - 0.66));
    lit += (rv * (0.12 - sh * 0.2) - sh * 0.04) * d;
  } else if (type == 3) { // heavy armour: raised inner plate, groove, rivets
    float m = max(abs(p.x), abs(p.y));
    float groove = smoothstep(0.5, 0.56, m) * (1.0 - smoothstep(0.62, 0.68, m));
    float rv = 1.0 - smoothstep(0.05, 0.1, length(abs(p) - 0.78));
    lit += (step(m, 0.56) * (0.06 - sh * 0.06) - groove * 0.25 + rv * 0.15) * d;
  } else if (type == 4) { // frame: open truss, X braces over a dark interior
    float br = min(abs(p.x - p.y), abs(p.x + p.y));
    float bar = 1.0 - smoothstep(0.08, 0.14, br);
    lit *= mix(1.0, 0.78 + 0.22 * bar, d);
  } else if (type == 5) { // thruster: housing with a nozzle, hot inside
    float ring = smoothstep(0.42, 0.5, r) * (1.0 - smoothstep(0.62, 0.7, r));
    lit *= mix(1.0, 0.55 + ring * 0.7 - sh * 0.1, d);
    if (!dead) glow = vec3(1.0, 0.55, 0.2) * (1.0 - smoothstep(0.0, 0.42, r)) * 0.9 * d;
  } else if (type == 6) { // laser (20 Nov 2026, second look): a glowing crystal between two slim emitter rails, energy running along them to a bright tip; no round turret, so it never reads as a cannon
    float ga = float(var & 7) * 0.7853982;
    vec2 r = rotd(p, ga), rL = rotd(L, ga);
    float base = 0.32 + 0.04 * step(0.5, fract((p.x + p.y) * 2.5));
    // dark faceted cradle round the crystal
    float cradle = 1.0 - smoothstep(0.62, 0.68, abs(r.x + 0.2) * 0.75 + abs(r.y) * 1.1);
    base = mix(base, 0.5 - dot(r, rL) * 0.5, cradle);
    // two slim rails out to the hull edge
    float ry = abs(r.y) - 0.22;
    float rail = step(abs(ry), 0.06) * step(-0.1, r.x) * step(r.x, 0.97);
    base = mix(base, 0.55 + 0.5 * (1.0 - (ry / 0.06) * (ry / 0.06)) - rL.y * sign(r.y) * 0.25, rail);
    // the crystal: a long faceted diamond
    float dm = abs(r.x + 0.22) * 0.85 + abs(r.y) * 1.5;
    float cry = 1.0 - smoothstep(0.42, 0.48, dm);
    float facet = 0.75 + 0.3 * sign((r.x + 0.22) * rL.x + r.y * rL.y + 0.001) * step(0.06, dm);
    lit *= mix(1.0, mix(base, 1.0, cry), d);
    float energy = step(abs(r.y), 0.045) * step(0.15, r.x) * step(r.x, 0.9);
    float tipd = 1.0 - smoothstep(0.05, 0.13, length(r - vec2(0.88, 0.0)));
    float flow = 0.6 + 0.4 * sin(r.x * 18.0 - uTime * 2.5);
    vec3 beam = mix(col, vec3(1.0), 0.45);
    glow = (beam * cry * facet * (dead ? 0.15 : 0.95)
         + vec3(1.0) * (1.0 - smoothstep(0.0, 0.12, dm)) * (dead ? 0.0 : 0.7)
         + beam * energy * flow * (dead ? 0.0 : 0.9)
         + vec3(1.0) * tipd * (dead ? 0.0 : 0.9)
         + beam * rail * step(0.8, r.x) * (dead ? 0.0 : 0.35)) * d;
  } else if (type == 7) { // cannon (20 Nov 2026, second look): a squat octagonal gunmetal turret, one short fat barrel and a big vented muzzle brake; dark, no glow but the ember in the bore
    float ga = float(var & 7) * 0.7853982;
    vec2 r = rotd(p, ga), rL = rotd(L, ga);
    vec2 ar = abs(p);
    col *= 0.78;
    float base = 0.42;
    float bolt = 1.0 - smoothstep(0.05, 0.1, length(ar - 0.8));
    base += bolt * 0.4;
    float oct = max(max(ar.x, ar.y), (ar.x + ar.y) * 0.7071);
    float turret = 1.0 - smoothstep(0.56, 0.6, oct);
    float bevel = turret * smoothstep(0.44, 0.52, oct);
    base = mix(base, 0.85 - dot(p, L) * 0.5, turret);
    base = mix(base, 1.05 - dot(normalize(p + 0.0001), L) * 0.6, bevel);
    base = mix(base, 0.18, (1.0 - smoothstep(0.56, 0.6, oct)) * smoothstep(0.58, 0.6, oct) + (1.0 - turret) * (1.0 - smoothstep(0.6, 0.66, oct)) * 0.6);
    float hw = 0.25;
    float brl = step(abs(r.y), hw) * step(0.3, r.x);
    float brake = step(abs(r.y), 0.36) * step(0.66, r.x) * step(r.x, 0.97);
    float cyl = 1.0 - (r.y / hw) * (r.y / hw);
    base = mix(base, 0.45 + 0.7 * cyl, brl);
    base = mix(base, 0.95 - rL.y * r.y * 1.4, brake);
    float vents = brake * step(abs(abs(r.x - 0.815) - 0.075), 0.022) * step(0.27, abs(r.y));
    base = mix(base, 0.12, vents);
    float bore = step(0.9, r.x) * step(abs(r.y), 0.15);
    base = mix(base, 0.05, bore);
    lit *= mix(1.0, base, d);
    if (!dead) glow = vec3(1.0, 0.42, 0.12) * bore * 0.7 * d;
  } else if (type == 8 || type == 11) { // missile launcher (20 Nov 2026): a pod with two missiles side by side, warheads out of the hull, hazard stripes at the back (guided: green seekers)
    float ga = float(var & 7) * 0.7853982;
    vec2 r = rotd(p, ga), rL = rotd(L, ga);
    vec2 ar = abs(r);
    float stripe = step(0.5, fract((r.x + r.y) * 2.5));
    float back = step(r.x, -0.6);
    float frame = smoothstep(0.8, 0.86, max(ar.x, ar.y));
    float base = 0.42;
    base = mix(base, 0.85 - dot(p, L) * 0.5, frame);
    base = mix(base, 0.3 + 0.65 * stripe, back);
    float sy = ar.y - 0.36, hw = 0.19;
    float body = step(abs(sy), hw) * step(-0.52, r.x) * step(r.x, 0.3);
    float cone = step(abs(sy), hw * clamp((0.86 - r.x) / 0.56, 0.0, 1.0)) * step(0.3, r.x) * step(r.x, 0.86);
    float cyl = 1.0 - (sy / hw) * (sy / hw);
    float fins = step(abs(sy), 0.27) * step(-0.56, r.x) * step(r.x, -0.42) * (1.0 - body);
    base = mix(base, 0.5, fins);
    base = mix(base, 0.6 + 0.5 * cyl - rL.y * sign(r.y) * sy * 1.2, body);
    base = mix(base, 0.95 + 0.3 * cyl, cone);
    base = mix(base, 0.35, body * step(abs(r.x - 0.05), 0.03)); // band round each missile
    lit *= mix(1.0, base, d);
    if (!dead) {
      vec3 tc = type == 11 ? vec3(0.35, 1.0, 0.6) : vec3(1.0, 0.45, 0.2);
      float tipd = 1.0 - smoothstep(0.03, 0.09, length(vec2(r.x - 0.74, sy)));
      glow = tc * (cone * 0.25 + tipd * (type == 11 ? 1.0 : 0.6)) * d;
    }
  } else if (type == 9) { // point defence (20 Nov 2026): a sensor dish with a red eye and twin rapid-fire barrels pointing out of the hull
    float ga = float(var & 7) * 0.7853982;
    vec2 r = rotd(p, ga), rL = rotd(L, ga);
    float R = length(p);
    float base = 0.55;
    float dish = 1.0 - smoothstep(0.5, 0.55, R);
    float rings = (1.0 - smoothstep(0.03, 0.06, abs(R - 0.5))) + (1.0 - smoothstep(0.03, 0.06, abs(R - 0.3)));
    base = mix(base, 0.72 - dot(p, L) * 0.5, dish);
    base += min(rings, 1.0) * 0.3;
    float by = abs(r.y) - 0.17;
    float brl = step(abs(by), 0.065) * step(0.22, r.x) * step(r.x, 0.97);
    base = mix(base, 0.6 + 0.55 * (1.0 - (by / 0.065) * (by / 0.065)), brl);
    base = mix(base, 0.12, brl * step(0.88, r.x) * step(abs(by), 0.03));
    lit *= mix(1.0, base, d);
    if (!dead) glow = vec3(1.0, 0.25, 0.2) * (1.0 - smoothstep(0.08, 0.17, R)) * 0.9 * d;
  } else if (type == 10) { // plasma cannon: the whole 10x10 unit is one machine; since 20 Nov 2026 a coiled emitter barrel runs from the orb out of the hull
    int pos = var - (var / 100) * 100;
    float ga = float(var / 100) * 0.7853982;
    vec2 q = (vec2(float(pos / 10), float(pos - (pos / 10) * 10)) + p * 0.5 + 0.5) / 10.0 - 0.5; // -0.5..0.5 across the unit
    float R = length(q);
    vec2 aq = abs(q);
    // dark housing with panel lines
    float panel = 1.0 - smoothstep(0.004, 0.012, min(abs(fract(q.x * 5.0 + 0.5) - 0.5), abs(fract(q.y * 5.0 + 0.5) - 0.5)) / 5.0);
    float base = 0.5 - panel * 0.12;
    // machinery blocks in the corners
    float box = step(0.3, aq.x) * step(0.3, aq.y) * step(aq.x, 0.46) * step(aq.y, 0.46);
    float boxEdge = box * (1.0 - step(0.31, aq.x) * step(0.31, aq.y) * step(aq.x, 0.45) * step(aq.y, 0.45));
    base += box * (0.25 - dot(q, L) * 0.3) - boxEdge * 0.2;
    // pipes from the edges and corners into the orb
    float ax = min(aq.x, aq.y), dg = abs(aq.x - aq.y) * 0.7071;
    float pipe = (1.0 - smoothstep(0.022, 0.03, ax)) * step(0.2, R) + (1.0 - smoothstep(0.018, 0.026, dg)) * step(0.2, R) * step(R, 0.42);
    float pipeCore = (1.0 - smoothstep(0.0, 0.01, ax)) * step(0.2, R) + (1.0 - smoothstep(0.0, 0.008, dg)) * step(0.2, R) * step(R, 0.42);
    base = mix(base, 0.95 - dot(q, L) * 0.6, min(pipe, 1.0));
    // the emitter barrel: a wide tube from the orb to the hull edge, wound with coils, a heavy muzzle ring
    vec2 rq = rotd(q, ga), rL = rotd(L, ga);
    float bw = 0.085;
    float barrel = step(abs(rq.y), bw) * step(0.17, rq.x) * step(rq.x, 0.49);
    float cylb = 1.0 - (rq.y / bw) * (rq.y / bw);
    float coils = barrel * step(0.55, fract(rq.x * 30.0)) * step(0.24, rq.x) * step(rq.x, 0.41);
    float muzzle = step(abs(rq.y), 0.115) * step(abs(rq.x - 0.45), 0.035);
    base = mix(base, 0.45 + 0.6 * cylb + coils * 0.3, barrel);
    base = mix(base, 1.0 - rL.y * rq.y * 5.0, muzzle);
    pipeCore *= 1.0 - barrel;
    // collar round the orb
    float collar = (1.0 - smoothstep(0.012, 0.022, abs(R - 0.215)));
    base = mix(base, 1.1, collar);
    float orb = 1.0 - smoothstep(0.15, 0.17, R);
    lit *= mix(1.0, base, d);
    if (!dead) {
      float flow = 0.5 + 0.5 * sin(R * 60.0 + uTime * 0.6); // energy running inward along the pipes
      float pulse = 0.8 + 0.2 * sin(uTime * 0.4);
      float beam = barrel * (1.0 - smoothstep(0.0, 0.035, abs(rq.y))) * (0.45 + 0.55 * sin(rq.x * 45.0 - uTime * 1.5));
      glow = (vec3(0.25, 0.55, 1.0) * min(pipeCore, 1.0) * (0.4 + 0.6 * flow)
           + vec3(0.3, 0.65, 1.0) * (beam + coils * 0.35) * (1.0 - muzzle)
           + vec3(0.5, 0.8, 1.0) * muzzle * step(abs(rq.y), 0.05) * 0.8
           + orb * mix(vec3(0.2, 0.5, 1.0), vec3(0.9, 0.97, 1.0), 1.0 - smoothstep(0.0, 0.13, R)) * pulse
           + vec3(0.15, 0.35, 0.9) * (1.0 - smoothstep(0.15, 0.3, R)) * 0.4) * d;
      lit *= 1.0 - orb * d * 0.8;
    } else lit *= 1.0 - orb * d * 0.3;
  } else if (type == 12) { // fighter bay (20 Nov 2026, second look): a dark steel hangar in a thin hazard rim, a lit runway to open doors on the side the fighters leave from, a small grey fighter waiting on it
    int pos = var - (var / 36) * 36;
    float ga = float(var / 36) * 0.7853982;
    vec2 q = (vec2(float(pos / 6), float(pos - (pos / 6) * 6)) + p * 0.5 + 0.5) / 6.0 - 0.5; // -0.5..0.5 across the unit
    vec2 aq = abs(q), rq = rotd(q, ga), rL = rotd(L, ga);
    float m = max(aq.x, aq.y);
    float frame = smoothstep(0.445, 0.455, m);
    float stripe = step(0.5, fract((q.x + q.y) * 10.0));
    // steel deck with panel seams, a runway down the middle toward the doors
    float seam = 1.0 - smoothstep(0.002, 0.005, min(abs(fract(rq.x * 5.0 + 0.5) - 0.5), abs(fract(rq.y * 5.0 + 0.5) - 0.5)) / 5.0);
    float runway = step(abs(rq.y), 0.11) * step(-0.36, rq.x) * step(rq.x, 0.38);
    float edge = runway * step(0.085, abs(rq.y));
    float doors = step(abs(rq.y), 0.16) * step(0.38, rq.x) * step(rq.x, 0.445);
    float doorEdge = doors * step(0.135, abs(rq.y));
    // the fighter: hull, swept wings, tail fins, nose toward the doors
    vec2 f = rq - vec2(-0.08, 0.0);
    float wing = step(abs(f.y), 0.03 + (0.06 - f.x) * 0.9) * step(-0.09, f.x) * step(f.x, 0.04);
    float fus = step(abs(f.y), 0.022 - max(0.0, f.x - 0.08) * 0.25) * step(-0.13, f.x) * step(f.x, 0.16);
    float fin = step(abs(abs(f.y) - 0.05), 0.012) * step(-0.13, f.x) * step(f.x, -0.08);
    float body = max(max(wing, fus), fin) * (1.0 - frame);
    float cockpit = 1.0 - smoothstep(0.008, 0.016, length(vec2(f.x - 0.08, f.y * 1.8)));
    col = mix(col, vec3(0.27, 0.29, 0.33), 1.0 - frame);
    col = mix(col, vec3(0.78, 0.81, 0.86), body);
    float base = 0.8 - seam * 0.25 + runway * 0.12 + edge * 0.35;
    base = mix(base, 0.25, doors);
    base = mix(base, 1.1, doorEdge);
    base = mix(base, 0.3 + 0.85 * stripe, frame);
    base = mix(base, 0.82 - dot(f, rL) * 1.5, body);
    base = mix(base, 0.4, cockpit);
    lit *= mix(1.0, base, d);
    if (!dead) {
      float lamps = edge * step(0.6, fract(rq.x * 14.0)) * (0.5 + 0.5 * sin(uTime * 1.2 - rq.x * 25.0));
      float corner = 1.0 - smoothstep(0.012, 0.022, length(aq - 0.405));
      glow = (vec3(1.0, 0.7, 0.3) * lamps * 0.9 + vec3(1.0, 0.65, 0.25) * corner * 0.8
            + vec3(0.45, 0.8, 1.0) * cockpit * 0.7 + vec3(1.0, 0.55, 0.2) * fus * step(f.x, -0.11) * 0.9
            + vec3(0.3, 0.5, 0.7) * doors * (1.0 - doorEdge) * 0.15) * d;
    }
  }
  else if (type == 13) { // flak cannon: the 10x10 unit is one gun battery; since 20 Nov 2026 four long barrels on a heavy turret point out of the hull
    int pos = var - (var / 100) * 100;
    float ga = float(var / 100) * 0.7853982;
    vec2 q = (vec2(float(pos / 10), float(pos - (pos / 10) * 10)) + p * 0.5 + 0.5) / 10.0 - 0.5; // -0.5..0.5 across the unit
    vec2 aq = abs(q), rq = rotd(q, ga), rL = rotd(L, ga);
    float R = length(q), m = max(aq.x, aq.y);
    // gunmetal deck with diagonal tread plate, a raised armoured rim round the unit
    float tread = 0.5 + 0.5 * step(0.5, fract((q.x - q.y) * 14.0));
    float base = 0.55 + tread * 0.06;
    float rim = smoothstep(0.43, 0.45, m);
    base = mix(base, 0.8 - dot(q, L) * 0.5, rim);
    // ammunition feeds from the corners to the ring
    float feed = (1.0 - smoothstep(0.02, 0.03, abs(aq.x - aq.y) * 0.7071)) * step(0.33, R) * step(m, 0.43);
    base = mix(base, 0.4, feed * (1.0 - rim));
    // the turret ring and its collar
    float ring = 1.0 - smoothstep(0.31, 0.33, R);
    float collar = 1.0 - smoothstep(0.012, 0.024, abs(R - 0.32));
    base = mix(base, 0.72 - dot(q, L) * 0.7, ring);
    base = mix(base, 1.15, collar);
    // four barrels side by side, each with a muzzle brake and a dark bore
    float by = rq.y - (floor(rq.y / 0.09) + 0.5) * 0.09;
    float inB = step(abs(rq.y), 0.18);
    float bw = 0.028;
    float brl = inB * step(abs(by), bw) * step(0.12, rq.x) * step(rq.x, 0.485);
    float brake = inB * step(abs(by), bw * 1.45) * step(abs(rq.x - 0.44), 0.03);
    float cylf = 1.0 - (by / bw) * (by / bw);
    base = mix(base, 0.45 + 0.65 * cylf, brl);
    base = mix(base, 1.0 - rL.y * by * 8.0, brake);
    float bore = brl * step(0.47, rq.x) * step(abs(by), bw * 0.45);
    base = mix(base, 0.1, bore);
    // the mantlet the barrels come out of
    float mant = step(abs(rq.y), 0.2) * step(-0.17, rq.x) * step(rq.x, 0.15) * (1.0 - smoothstep(0.17, 0.2, length(rq * vec2(0.8, 1.0))));
    base = mix(base, 1.0 - dot(rq, rL) * 1.2, mant);
    lit *= mix(1.0, base, d);
    if (!dead) {
      float lights = 1.0 - smoothstep(0.01, 0.022, length(aq - vec2(0.39)));
      glow = (vec3(1.0, 0.62, 0.2) * lights * (0.65 + 0.35 * sin(uTime * 0.7 + q.x * 7.0)) + vec3(1.0, 0.45, 0.15) * bore * 0.8
            + vec3(1.0, 0.6, 0.25) * (1.0 - smoothstep(0.0, 0.025, length(rq + vec2(0.1, 0.0)))) * 0.6) * d;
    }
  }
  else if (type == 15) { // auto gun (20 Nov 2026): the 2x2 unit is one rotary cannon on an armoured mount; its barrels point out of the hull (dir, 45° steps)
    int pos = var & 3, dir = var >> 2;
    vec2 q = (vec2(float(pos / 2), float(pos - (pos / 2) * 2)) + p * 0.5 + 0.5) / 2.0 - 0.5; // -0.5..0.5 across the unit
    vec2 aq = abs(q);
    float ga = float(dir) * 0.7853982, ca = cos(ga), sa = sin(ga);
    vec2 r = vec2(q.x * ca + q.y * sa, -q.x * sa + q.y * ca); // gun frame: barrels along +r.x
    vec2 rL = vec2(L.x * ca + L.y * sa, -L.x * sa + L.y * ca);
    float m = max(aq.x, aq.y), R = length(q);
    // mount: dark plate, bright chamfered rim, a bolt in each corner
    float base = 0.42 + 0.05 * step(0.5, fract((q.x + q.y) * 7.0));
    float rim = smoothstep(0.40, 0.43, m) * (1.0 - smoothstep(0.47, 0.5, m));
    base = mix(base, 0.95 - dot(q, L) * 0.8, rim);
    float bolt = 1.0 - smoothstep(0.025, 0.04, length(aq - vec2(0.36)));
    base = mix(base, 1.1 - dot(aq - vec2(0.36), L) * 6.0, bolt);
    // ammunition box behind the turret, hazard-striped, with a feed chute
    float box = step(abs(r.y), 0.15) * step(-0.46, r.x) * step(r.x, -0.2);
    float hz = step(0.5, fract((r.x + r.y) * 9.0));
    base = mix(base, mix(0.35, 0.95, hz * step(r.x, -0.39)) + 0.25 * step(-0.39, r.x) - dot(r, rL) * 0.3, box);
    // turret: lit dome in a bright collar
    float dome = 1.0 - smoothstep(0.2, 0.215, R);
    float collar = (1.0 - smoothstep(0.215, 0.25, R)) * (1.0 - dome);
    base = mix(base, 0.3, collar * 0.6);
    base = mix(base, 1.2 * (0.72 - dot(q, L) * 1.6) * (1.0 - 0.25 * smoothstep(0.08, 0.2, R)), dome);
    // three barrels in a rotary cluster, round shading, a clamp band and dark bores at the muzzles
    float by = r.y - clamp(floor(r.y / 0.085 + 0.5), -1.0, 1.0) * 0.085;
    float bw = 0.033, onB = step(abs(by), bw) * step(0.06, r.x) * step(r.x, 0.495) * step(abs(r.y), 0.12);
    float cyl = 1.0 - (by / bw) * (by / bw);
    float band = step(abs(r.x - 0.33), 0.028) * step(abs(r.y), 0.13);
    float muzzle = onB * step(0.44, r.x);
    float bore = muzzle * step(abs(by), bw * 0.45);
    base = mix(base, 0.55 + 0.6 * cyl - rL.y * by * 6.0, max(onB, band) * (1.0 - dome));
    base = mix(base, 1.25, band * 0.5 * (1.0 - dome));
    base = mix(base, 0.1, bore);
    lit *= mix(1.0, base, d);
    if (!dead) {
      float heat = 0.55 + 0.45 * sin(uTime * 4.0 + float(var) * 1.7);
      float lamp = 1.0 - smoothstep(0.015, 0.03, length(r - vec2(-0.3, 0.0)));
      glow = (vec3(1.0, 0.55, 0.15) * muzzle * heat * 0.9 + vec3(1.0, 0.9, 0.5) * bore * heat
            + vec3(1.0, 0.75, 0.2) * lamp * (0.6 + 0.4 * sin(uTime * 0.8 + float(var)))
            + vec3(1.0, 0.85, 0.5) * dome * smoothstep(0.08, 0.0, R) * 0.25) * d;
    }
  }
  else if (type == 14) { // shield generator: the 10x10 unit is one emitter, a glowing dish inside a ring of coils
    vec2 q = (vec2(float(var / 10), float(var - (var / 10) * 10)) + p * 0.5 + 0.5) / 10.0 - 0.5;
    vec2 aq = abs(q);
    float R = length(q), m = max(aq.x, aq.y), ang = atan(q.y, q.x);
    float base = 0.5 + 0.06 * step(0.5, fract(R * 12.0));
    float rim = smoothstep(0.44, 0.46, m);
    base = mix(base, 0.8 - dot(q, L) * 0.5, rim);
    // eight coils round the dish
    float coil = 1.0 - smoothstep(0.06, 0.075, length(vec2(R - 0.34, (fract(ang / 0.7854 + 0.5) - 0.5) * 0.27)));
    base = mix(base, 1.0 - dot(q, L) * 0.8, coil);
    float dish = 1.0 - smoothstep(0.24, 0.26, R);
    base = mix(base, 0.7 - dot(q, L) * 0.9, dish);
    lit *= mix(1.0, base, d);
    if (!dead) {
      float pulse = 0.75 + 0.25 * sin(uTime * 0.5 + R * 20.0);
      glow = (vec3(0.35, 0.9, 1.0) * (1.0 - smoothstep(0.0, 0.22, R)) * pulse + vec3(0.3, 0.85, 1.0) * coil * 0.35 * (0.6 + 0.4 * sin(uTime * 0.9 + ang * 4.0))) * d;
    }
  }
  col = col * max(lit, 0.0) + glow;
  return mix(col, col * 0.3, ol * (0.4 + 0.6 * d));
}
void main(){
  if (vShape > 9.5) {
    o = vec4(hullBlock(int(vShape - 10.0 + 0.5), vUV), 1.0);
  } else if (vShape < 0.5) {     // hull block: bevelled tile (far zoom, cheap)
    float e = max(abs(vUV.x), abs(vUV.y));
    float shade = 1.0 - smoothstep(0.6, 1.0, e) * 0.5 - vUV.y * 0.08;
    o = vec4(vCol.rgb * shade, 1.0);
  } else if (vShape < 1.5) {     // soft glow disc
    float a = clamp(1.0 - length(vUV), 0.0, 1.0); a *= a;
    o = vec4(vCol.rgb * a * vCol.a, 0.0);
  } else if (vShape < 2.5) {     // tracer streak, bright head at +x
    float ay = 1.0 - abs(vUV.y); float ax = vUV.x * 0.5 + 0.5;
    float a = ay * ay * ax * ax;
    o = vec4(vCol.rgb * a * vCol.a, 0.0);
  } else if (vShape < 3.5) {     // flat (far-zoom ship silhouette)
    o = vec4(vCol.rgb, 1.0);
  } else {                       // beam: even along its length
    float ay = 1.0 - abs(vUV.y);
    float a = ay * ay * (1.0 - smoothstep(0.85, 1.0, abs(vUV.x)));
    o = vec4(vCol.rgb * a * vCol.a, 0.0);
  }
}`;

const DEAD_BIT = 1048576; // debris flag in a detailed block's shape code (var takes bits 8-19: a 10x10 unit's place + 100 × direction)
const STRIDE = 7; // x, y, angle, sx, sy, shape, rgba(u32)

// Shield bubbles (15 Nov 2026): one quad per shielded ship over its distance map (model.shieldMap), so
// the bubble hugs the hull's real outline (holes in hollow fortresses included) with a rim of even width.
const SVS = `#version 300 es
layout(location=0) in vec2 corner;
uniform vec2 uCam, uScale, uC, uH; uniform float uA;
out vec2 vUV; out vec2 vP;
void main(){
  vP = corner * uH; vUV = corner * 0.5 + 0.5;
  float c = cos(uA), s = sin(uA);
  vec2 w = uC + vec2(vP.x*c - vP.y*s, vP.x*s + vP.y*c);
  gl_Position = vec4((w - uCam) * uScale, 0.0, 1.0);
}`;
const SFS = `#version 300 es
precision highp float;
in vec2 vUV; in vec2 vP; out vec4 o;
uniform sampler2D uMap; uniform float uMaxD, uEdge, uRim, uTime; uniform vec4 uCol;
void main(){
  float d = texture(uMap, vUV).r * uMaxD;            // distance to the hull, in blocks
  float x = d - uEdge;                                // < 0 inside the bubble
  float fw = max(fwidth(x), 1e-3), rw = max(uRim, 2.0 * fw);
  float in1 = 1.0 - smoothstep(-fw, fw, x), g = 1.0 - clamp(-x / rw, 0.0, 1.0);
  float rim = (g * g * 0.8 + smoothstep(1.0 - 1.5 * fw / rw, 1.0, g) * 0.6) * in1;
  float shim = 0.5 + 0.5 * sin(vP.x * 0.9 + uTime * 0.35) * sin(vP.y * 0.9 - uTime * 0.25);
  float a = rim + (0.07 + 0.06 * shim) * in1;
  o = vec4(uCol.rgb * a * uCol.a, 0.0);
}`;

class Batch {
  constructor(cap = 65536) { this.alloc(cap); this.n = 0; }
  alloc(cap) {
    const old = this.f;
    this.buf = new ArrayBuffer(cap * STRIDE * 4);
    this.f = new Float32Array(this.buf); this.u = new Uint32Array(this.buf); this.cap = cap;
    if (old) this.f.set(old);
  }
  push(x, y, a, sx, sy, shape, rgba) {
    if (this.n === this.cap) this.alloc(this.cap * 2);
    const o = this.n++ * STRIDE, f = this.f;
    f[o] = x; f[o + 1] = y; f[o + 2] = a; f[o + 3] = sx; f[o + 4] = sy; f[o + 5] = shape; this.u[o + 6] = rgba;
  }
}

/**
 * Far-zoom shape of a ship or wreck (21 Nov 2026): its blocks merged into cells of k × k blocks.
 * Each cell sits at the mean of its blocks (so edge cells don't stick out), lives until its last
 * block dies, and remembers which blocks it holds so its colour can be worked out per palette.
 * Built once per entity and k (k = 1, 2, 4 … as the camera zooms out), so drawing stays a pure
 * function of time.
 */
function lodCells(e, k) {
  const cache = e.lodC || (e.lodC = new Map());
  let L = cache.get(k);
  if (L) return L;
  const lx = e.lx, ly = e.ly, de = e.death, n = lx.length, ox = e.w / 2, oy = e.h / 2;
  const gw = Math.ceil(e.w / k) + 1, idx = new Map();
  const cell = new Int32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const key = Math.floor((ly[i] + oy) / k) * gw + Math.floor((lx[i] + ox) / k);
    let c = idx.get(key);
    if (c === undefined) { c = m++; idx.set(key, c); }
    cell[i] = c;
  }
  const x = new Float32Array(m), y = new Float32Array(m), cnt = new Float32Array(m), death = new Float32Array(m);
  for (let i = 0; i < n; i++) {
    const c = cell[i];
    x[c] += lx[i]; y[c] += ly[i]; cnt[c]++;
    if (de[i] > death[c]) death[c] = de[i];
  }
  for (let c = 0; c < m; c++) { x[c] /= cnt[c]; y[c] /= cnt[c]; }
  L = { n: m, x, y, death, cell, col: new Uint32Array(m), pal: null };
  cache.set(k, L);
  return L;
}

/** Each cell's colour: the average of its blocks' colours, a little toward the side's colour so
 *  fleets stay easy to tell apart from far away (accent 0 = none, for wrecks). */
function lodColours(e, L, pal, accent) {
  const n = L.n, r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), w = new Float32Array(n);
  const ty = e.type, cell = L.cell;
  for (let i = 0; i < cell.length; i++) {
    const v = pal[ty[i]] >>> 0, c = cell[i];
    r[c] += v & 255; g[c] += (v >>> 8) & 255; b[c] += (v >>> 16) & 255; w[c]++;
  }
  const ar = accent & 255, ag = (accent >>> 8) & 255, ab = (accent >>> 16) & 255, mix = accent ? 0.45 : 0;
  for (let c = 0; c < n; c++) {
    const R = (r[c] / w[c]) * (1 - mix) + ar * mix, G = (g[c] / w[c]) * (1 - mix) + ag * mix, B = (b[c] / w[c]) * (1 - mix) + ab * mix;
    L.col[c] = (255 << 24) | (Math.min(255, B) << 16) | (Math.min(255, G) << 8) | Math.min(255, R);
  }
  L.pal = pal;
}

// little-endian RGBA packed into a u32 (bytes in memory: r, g, b, a)
const rgba = (hex, a = 255) => {
  const v = parseInt(hex.slice(1), 16);
  return ((a & 255) << 24) | ((v & 255) << 16) | (((v >> 8) & 255) << 8) | ((v >> 16) & 255);
};
const shade = (hex, k) => {
  const v = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.min(255, Math.round(((v >> s) & 255) * k)).toString(16).padStart(2, '0');
  return '#' + ch(16) + ch(8) + ch(0);
};

// Point defence is one fixed colour for every side (owner: in the ship's colour it blended in).
const PD_COLOR = '#c2413f';

export const TEAM = [
  { name: 'Azure Compact', armor: '#5c7ea3', heavy: '#41597a', frame: '#90a6c0', hub: '#86e8ff', beam: '#63d4ff', accent: '#86e8ff' },
  { name: 'Ember Dominion', armor: '#a5684f', heavy: '#7a4a38', frame: '#c69c86', hub: '#ffd27a', beam: '#ff7a52', accent: '#ffb35c' },
];

function blockPalette(team, dead) {
  const T = TEAM[team], k = dead ? 0.7 : 1; // wrecks stay readable, just burnt
  const p = [];
  p[BT.HUB] = T.hub; p[BT.ARMOR] = T.armor; p[BT.HEAVY] = T.heavy; p[BT.FRAME] = T.frame;
  p[BT.THRUSTER] = '#3d434f'; p[BT.LASER] = team ? '#ffd9c9' : '#d8f4ff'; p[BT.CANNON] = '#9aa1ab'; p[BT.MISSILE] = '#b9b16c'; p[BT.PD] = PD_COLOR; p[BT.LANCE] = team ? '#8a4f63' : '#5b5f9c'; p[BT.GUIDED] = '#8fb79e'; p[BT.BAY] = '#c9a23c'; p[BT.FLAK] = '#6e6656'; p[BT.AUTO] = '#a7a08e'; p[BT.SHIELD] = '#2b6f7a';
  return p.map((c) => (c ? rgba(dead ? shade(c, k) : c) : 0));
}
const PAL = [[blockPalette(0, false), blockPalette(1, false)], [blockPalette(0, true), blockPalette(1, true)]];

// Player colours (owner's request: ships are always drawn in their player's colour). A "look" is
// every colour one ship needs, built from one accent colour and cached per colour.
const mixHex = (a, b, k) => {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((x >> s) & 255) * (1 - k) + ((y >> s) & 255) * k).toString(16).padStart(2, '0');
  return '#' + ch(16) + ch(8) + ch(0);
};
const LOOKS = new Map();
function lookFor(hex) {
  hex = String(hex).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return null;
  let L = LOOKS.get(hex);
  if (L) return L;
  const armor = shade(mixHex(hex, '#6b7280', 0.35), 0.72);
  const T = { armor, heavy: shade(armor, 0.72), frame: shade(mixHex(hex, '#b8c0cc', 0.5), 0.85), hub: hex };
  const make = (dead) => {
    const p = [];
    p[BT.HUB] = T.hub; p[BT.ARMOR] = T.armor; p[BT.HEAVY] = T.heavy; p[BT.FRAME] = T.frame;
    p[BT.THRUSTER] = '#3d434f'; p[BT.LASER] = mixHex(hex, '#ffffff', 0.75); p[BT.CANNON] = '#9aa1ab'; p[BT.MISSILE] = '#b9b16c';
    p[BT.PD] = PD_COLOR; p[BT.LANCE] = shade(mixHex(hex, '#40404a', 0.5), 0.9); p[BT.GUIDED] = '#8fb79e'; p[BT.BAY] = '#c9a23c'; p[BT.FLAK] = shade(mixHex(hex, '#6e6656', 0.7), 0.95); p[BT.SHIELD] = shade(mixHex(hex, '#2b6f7a', 0.75), 0.95); p[BT.AUTO] = shade(mixHex(hex, '#a7a08e', 0.75), 1);
    return p.map((c) => (c ? rgba(dead ? shade(c, 0.7) : c) : 0));
  };
  L = { pal: [make(false), make(true)], lod: rgba(hex), engine: rgba(hex, 150), accent: hex };
  LOOKS.set(hex, L);
  return L;
}
const DEFAULT_SIDES = TEAM.map((T) => T.accent), DEFAULT_ENGINE = ['#58b8ff', '#ff8a3d'];

/**
 * Colour a replay's ships by player: meta.colors ([start, n, colour] per group of ships) when the
 * replay has it, else sideColors ([attacker, defender]) for every ship on that side, else the
 * usual azure/ember. Effects (beams, missiles) take their side's colour. Returns the two side colours.
 */
export function applyColors(model, sideColors) {
  const nT = model.teams || 2;
  // sideColors come from the galaxy log as [attacker, defender], which is only the side order of
  // the old two-sided replays. Since free-for-all battles the world's side is team 0 and the
  // attackers come after it, so a replay that records its players' colours (meta.colors) must
  // take each side's colour from its own ships (fixed Nov 2026: fighters, missiles, beams and
  // the name labels were drawn in the other player's colour).
  const own = (model.meta.colors || []).length > 0;
  const sides = Array.from({ length: nT }, (_, t) => (own ? null : sideColors?.[t] || null));
  const byShip = new Array(model.meta.shipCount).fill(null);
  for (const [start, n, col] of model.meta.colors || []) for (let k = start; k < start + n && k < byShip.length; k++) byShip[k] = col;
  // A side with no colour given takes the colour of its first ship (the leader's group comes first).
  for (let t = 0; t < nT; t++) if (!sides[t]) for (let k = 0; k < byShip.length; k++) if (byShip[k] && model.ents[k].team === t) { sides[t] = byShip[k]; break; }
  for (let k = 0; k < model.ents.length; k++) {
    const e = model.ents[k];
    e.look = e.parent ? e.parent.look : lookFor(byShip[k] || sides[e.team] || '') || null;
  }
  const out = sides.map((c, t) => (lookFor(c || '') ? c : DEFAULT_SIDES[t] || '#9aa4b4'));
  for (let t = 0; t < nT; t++) {
    const custom = out[t] !== DEFAULT_SIDES[t];
    C.beam[t] = rgba(custom ? out[t] : TEAM[t].beam, 255); C.mGlow[t] = C.beam[t];
    C.mTip[t] = rgba(out[t]); C.lod[t] = rgba(out[t]);
    C.engine[t] = rgba(custom ? out[t] : DEFAULT_ENGINE[t], 150);
    C.pd[t] = rgba(custom ? mixHex(out[t], '#ffffff', 0.6) : ['#bff3ff', '#ffd0b8'][t], 255);
  }
  return out;
}
const LANCE_CHARGE = 6, LANCE_LIFE = 16; // heavy laser: charge-up and beam life, in ticks
const FIGHTER_DEATH = 12; // a shot-down fighter tumbles and burns out over this many ticks (1.2 s)
const alpha2 = (col, k) => (col & 0xffffff) | ((Math.max(0, Math.min(1, k)) * 255) << 24);
const fadeCol = (col, k) => (col & 0xffffff) | ((((col >>> 24) * Math.max(0, Math.min(1, k))) | 0) << 24); // scales the colour's own alpha
const C = {
  tracer: rgba('#ffe7a6', 230), impact: rgba('#ffc46b', 255), spark: rgba('#ff9d47', 255), sparkHot: rgba('#fff1c4', 255),
  missile: rgba('#ffffff', 255), trail: rgba('#ff8a3d', 200), boom: rgba('#ff9b45', 255), boomCore: rgba('#fff4d6', 255),
  engine: [rgba('#58b8ff', 150), rgba('#ff8a3d', 150)], beam: TEAM.map((t) => rgba(t.beam, 255)),
  pd: [rgba('#bff3ff', 255), rgba('#ffd0b8', 255)], beamCore: rgba('#ffffff', 255), pop: rgba('#ffffff', 255),
  mBody: rgba('#c9ccd3'), mTip: TEAM.map((t) => rgba(t.accent)), mFlame: rgba('#ffb04a', 255),
  mGlow: TEAM.map((t) => rgba(t.beam, 255)), smoke: rgba('#9a8f86', 255),
  lod: TEAM.map((t) => rgba(t.accent)), lodDead: rgba('#7a7c86'), hotChunk: rgba('#ff7a2e', 255),
  // Plasma cannon: blue whatever the side (owner: "blue with a trail, that would look like plasma").
  plGlow: rgba('#2f7dff', 255), plBody: rgba('#6fd2ff', 255), plCore: rgba('#f4fcff', 255), plTrail: rgba('#3fa0ff', 220),
  fBody: rgba('#d3d9e3'), fCanopy: rgba('#7fd8ff'), // fighters
  // Flak (14 Nov 2026): hot amber shells, a white flash and a spray of orange shrapnel streaks.
  flShell: rgba('#fff0c2', 255), flTrail: rgba('#ffb347', 210), flFlash: rgba('#fff8e8', 255), flGlow: rgba('#ff9a3c', 255),
  shield: rgba('#6fe8ff', 255),
  autoHalo: rgba('#ff8a1e', 255), autoFlash: rgba('#ffd27a', 255), autoSpark: rgba('#ffb347', 255), flShrap: rgba('#ffc070', 255), tracer: rgba('#ffe58a', 255), tracerHot: rgba('#fffbe8', 255), flSmoke: rgba('#8c8278', 255),
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error('This viewer needs WebGL2, which this browser has turned off.');
    this.gl = gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    this.prog = prog;
    this.uCam = gl.getUniformLocation(prog, 'uCam');
    this.uScale = gl.getUniformLocation(prog, 'uScale');
    this.uDet = gl.getUniformLocation(prog, 'uDet'); this.uTime = gl.getUniformLocation(prog, 'uTime');
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    const S = STRIDE * 4;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, S, 12); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, S, 24); gl.vertexAttribDivisor(3, 1);
    const sp = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, SVS], [gl.FRAGMENT_SHADER, SFS]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(sp, sh);
    }
    gl.linkProgram(sp);
    this.sprog = sp;
    this.su = {};
    for (const n of ['uCam', 'uScale', 'uC', 'uH', 'uA', 'uMap', 'uMaxD', 'uEdge', 'uRim', 'uTime', 'uCol']) this.su[n] = gl.getUniformLocation(sp, n);
    this.shields = []; // shield bubbles to draw this frame: [entity, x, y, angle, alpha, grow]
    this.shTex = new Map(); // entity -> { tex, ver }
    this.shModel = null;
    this.solid = new Batch(1 << 17);
    this.glow = new Batch(1 << 16);
    this.tr = { x: 0, y: 0, a: 0 };
    this.stats = { blocks: 0, effects: 0, ships: 0 };
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** cam: {x, y, zoom} where zoom = CSS pixels per block. t: time in ticks. */
  draw(model, t, cam) {
    this.resize();
    const { gl, solid, glow, tr } = this;
    solid.n = 0; glow.n = 0; this.shields.length = 0;
    if (this.shModel !== model) { for (const v of this.shTex.values()) gl.deleteTexture(v.tex); this.shTex.clear(); this.shModel = model; }
    const cw = this.canvas.clientWidth, chh = this.canvas.clientHeight, z = cam.zoom;
    const hw = cw / 2 / z, hh = chh / 2 / z;
    const vx0 = cam.x - hw, vx1 = cam.x + hw, vy0 = cam.y - hh, vy1 = cam.y + hh;
    const vis = (x, y, r) => x + r > vx0 && x - r < vx1 && y + r > vy0 && y - r < vy1;
    const px = 1 / z; // one CSS pixel in world units
    const lod = z < 0.9;
    const dpr = Math.min(2, window.devicePixelRatio || 1), detail = z * dpr >= 2.5; // detailed blocks from 2.5 screen pixels per block
    let blocks = 0, ships = 0;

    for (const e of model.ents) {
      if (t < e.t0 || t >= e.t1) continue;
      model.transform(e, t, tr);
      if (!vis(tr.x, tr.y, e.radius)) continue;
      const dead = e.kind === 1;
      if (!dead) ships++;
      // Far zoom (owner, 21 Nov 2026: ships turned into coloured squares, "ugly"): the ship's own
      // shape shrunk down. Its blocks are merged into square cells of k × k blocks (k a power of 2,
      // so a cell is about a screen pixel), each drawn in the average colour of its blocks and shown
      // while any of them is alive. A pure function of time like the rest; cells cached per k.
      if (lod) {
        const k = 2 ** Math.max(0, Math.floor(Math.log2(px))); // cells under ~1 px, drawn at least ~1.2 px so they join up
        const L = lodCells(e, k), pal = e.look ? e.look.pal[dead ? 1 : 0] : PAL[dead ? 1 : 0][e.team];
        if (L.pal !== pal) lodColours(e, L, pal, dead ? 0 : (e.look ? e.look.lod : C.lod[e.team]));
        const c = Math.cos(tr.a), s = Math.sin(tr.a), hs = Math.max(k * 0.5, px * 0.6);
        for (let i = 0; i < L.n; i++) {
          if (L.death[i] <= t) continue;
          solid.push(tr.x + L.x[i] * c - L.y[i] * s, tr.y + L.x[i] * s + L.y[i] * c, tr.a, hs, hs, 3, L.col[i]);
          blocks++;
        }
        if (!dead && e.shN) this.drawShield(model, e, t, tr, px);
        continue;
      }
      const c = Math.cos(tr.a), s = Math.sin(tr.a), pal = e.look ? e.look.pal[dead ? 1 : 0] : PAL[dead ? 1 : 0][e.team];
      const lx = e.lx, ly = e.ly, ty = e.type, de = e.death;
      if (!detail) {
        const bs = Math.max(0.5, px * 0.6);
        for (let i = 0; i < lx.length; i++) {
          if (de[i] <= t) continue;
          solid.push(tr.x + lx[i] * c - ly[i] * s, tr.y + lx[i] * s + ly[i] * c, tr.a, bs, bs, 0, pal[ty[i]]);
          blocks++;
        }
      } else {
        // Detailed blocks: which sides are open (for bevels and outlines). Guns are drawn as fixed
        // mounts (owner: static turrets looked cheap). Pure function of time, like the rest.
        const nb = e.nb, un = e.unit, deadBit = dead ? DEAD_BIT : 0;
        for (let i = 0; i < lx.length; i++) {
          if (de[i] <= t) continue;
          const o = i * 4, a0 = nb[o], a1 = nb[o + 1], a2 = nb[o + 2], a3 = nb[o + 3];
          const mask = (a0 >= 0 && de[a0] > t ? 1 : 0) | (a1 >= 0 && de[a1] > t ? 2 : 0) | (a2 >= 0 && de[a2] > t ? 4 : 0) | (a3 >= 0 && de[a3] > t ? 8 : 0);
          const type = ty[i], x = tr.x + lx[i] * c - ly[i] * s, y = tr.y + lx[i] * s + ly[i] * c;
          const v = un[i] ? un[i] - 1 : (i * 2654435761) >>> 29; // weapons: the way they point (+ place in a unit); else variety
          solid.push(x, y, tr.a, 0.5, 0.5, 10 + type + 16 * mask + 256 * v + deadBit, pal[type]);
          blocks++;
        }
      }
      if (!dead) {
        // A flame on each working thruster with open space behind it (nose is local +x, so
        // flames point to -x). Length flickers per thruster as a pure function of time.
        const eng = e.look ? e.look.engine : C.engine[e.team], th = e.thr, tb = e.thrBehind;
        for (let k = 0; th && k < th.length; k++) {
          const i = th[k], b = tb[k];
          if (de[i] <= t || (b >= 0 && de[b] > t)) continue;
          const len = 0.9 + 0.25 * Math.sin(t * 1.9 + k * 2.3) + 0.15 * Math.sin(t * 4.7 + k);
          const fx = lx[i] - 0.5 - len, fy = ly[i];
          glow.push(tr.x + fx * c - fy * s, tr.y + fx * s + fy * c, tr.a, len + 0.2, 0.55, 1, eng);
        }
        if (e.shN) this.drawShield(model, e, t, tr, px);
      } else if (t - e.t0 < 14) {
        const k = 1 - (t - e.t0) / 14;
        glow.push(tr.x, tr.y, 0, e.radius * 1.3, e.radius * 1.3, 1, (C.hotChunk & 0xffffff) | ((k * 170) << 24));
      }
    }

    this.drawEffects(model, t, vis, px);
    this.stats.blocks = blocks; this.stats.ships = ships; this.stats.effects = glow.n;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uCam, cam.x, cam.y);
    gl.uniform2f(this.uScale, (2 * z) / cw, (-2 * z) / chh);
    gl.uniform1f(this.uDet, Math.max(0, Math.min(1, (z * Math.min(2, window.devicePixelRatio || 1) - 2.5) / 5)));
    gl.uniform1f(this.uTime, t);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.disable(gl.BLEND);
    gl.bufferData(gl.ARRAY_BUFFER, solid.f.subarray(0, solid.n * STRIDE), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, solid.n);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bufferData(gl.ARRAY_BUFFER, glow.f.subarray(0, glow.n * STRIDE), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glow.n);
    if (this.shields.length) this.drawShieldPass(model, t, cam, z, cw, chh);
  }

  /** The shield bubbles collected this frame, each one quad over its ship's distance map. */
  drawShieldPass(model, t, cam, z, cw, chh) {
    const gl = this.gl, u = this.su, L = this.shields;
    gl.useProgram(this.sprog);
    gl.uniform2f(u.uCam, cam.x, cam.y);
    gl.uniform2f(u.uScale, (2 * z) / cw, (-2 * z) / chh);
    gl.uniform1f(u.uTime, t);
    gl.uniform1i(u.uMap, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // the vertex array's attribute 0 is the unit quad; the instanced attributes are unused here
    for (let k = 0; k < L.length; k += 6) {
      const e = L[k], M = e.shMap;
      let T = this.shTex.get(e);
      if (!T) { T = { tex: gl.createTexture(), ver: -1 }; this.shTex.set(e, T); }
      gl.bindTexture(gl.TEXTURE_2D, T.tex);
      if (T.ver !== M.ver) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, M.gw, M.gh, 0, gl.RED, gl.UNSIGNED_BYTE, M.d);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        T.ver = M.ver;
      }
      const a = L[k + 3], grow = L[k + 5], hx = (M.gw * M.s) / 2, hy = (M.gh * M.s) / 2;
      const cx = M.ox + hx, cy = M.oy + hy, c = Math.cos(a), s = Math.sin(a);
      gl.uniform2f(u.uC, L[k + 1] + cx * c - cy * s, L[k + 2] + cx * s + cy * c);
      gl.uniform2f(u.uH, hx, hy);
      gl.uniform1f(u.uA, a);
      gl.uniform1f(u.uMaxD, M.maxD);
      gl.uniform1f(u.uEdge, Math.min(M.maxD - 0.5, M.m * grow));
      gl.uniform1f(u.uRim, 1.2 + 0.3 * M.m);
      const col = C.shield;
      gl.uniform4f(u.uCol, (col & 255) / 255, ((col >> 8) & 255) / 255, ((col >> 16) & 255) / 255, L[k + 4]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    }
  }

  /** Shield generators: a bubble hugging the ship, brighter when struck, popping when the shield goes down. */
  drawShield(model, e, t, tr, px) {
    const S = model.shieldAt(e, t, this._sh || (this._sh = { v: 0, hit: 0, down: -1 }));
    if (!(S.v > 0.004) && !(S.down >= 0 && S.down < 10)) return;
    if (!model.shieldMap(e, t, px)) return;
    if (S.v > 0.004) this.shields.push(e, tr.x, tr.y, tr.a, Math.min(1, 0.2 + 0.4 * S.v + Math.min(0.9, S.hit * 6)), 1);
    else { const k = S.down / 10; this.shields.push(e, tr.x, tr.y, tr.a, 1 - k, 1 + k * 0.6); }
  }

  drawEffects(m, t, vis, px) {
    const g = this.glow, dt = m.dt;
    const minW = px * 1.1;
    const alpha = (col, k) => (col & 0xffffff) | ((Math.max(0, Math.min(1, k)) * 255) << 24);

    // Beams: lasers are short coloured bolts; point defence is a thin, quick flicker; heavy
    // lasers charge up for 0.6 s at the gun, then fire a huge white-hot flickering lance that
    // holds for half a second and fades over 1.6 s, so the two can't be mistaken.
    const L = m.laser;
    for (let i = lowerBound(L.t, t); i < L.n && L.t[i] <= t + LANCE_CHARGE; i++)
      if (L.kind[i] === 2) this.drawLanceCharge(m, L, i, t, vis, minW);
    for (let i = lowerBound(L.t, t - LANCE_LIFE); i < L.n && L.t[i] <= t; i++) {
      if (L.kind[i] === 2) { this.drawLance(m, L, i, t, vis, minW); continue; }
      const fg = L.kind[i] === 3; // fighter gun: a short quick flicker in the side's colour
      const pd = L.kind[i] === 1 || fg, life = pd ? 1.5 : 6, age = t - L.t[i];
      if (age > life) continue;
      if (!vis((L.x0[i] + L.x1[i]) / 2, (L.y0[i] + L.y1[i]) / 2, Math.hypot(L.x1[i] - L.x0[i], L.y1[i] - L.y0[i]) / 2 + 20)) continue;
      const B = m.beamAt(i, t, this._beam || (this._beam = { x0: 0, y0: 0, x1: 0, y1: 0 }));
      const x0 = B.x0, y0 = B.y0, x1 = B.x1, y1 = B.y1;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, len = Math.hypot(x1 - x0, y1 - y0) / 2;
      const col = fg ? C.beam[L.team[i]] : pd ? C.pd[L.team[i]] : C.beam[L.team[i]], a = Math.atan2(y1 - y0, x1 - x0);
      if (pd) {
        const k = 1 - age / life;
        g.push(mx, my, a, len, Math.max(0.16, minW), 4, alpha(col, k));
        if (L.hit[i]) g.push(x1, y1, 0, Math.max(0.7, minW * 2), Math.max(0.7, minW * 2), 1, alpha(col, k));
        continue;
      }
      // Laser: a slim coloured bolt (the heavy laser is the big white one). Full strength for
      // 0.1 s, then fades; faint glow, coloured body, thin white core, a flash where it burns in.
      const k = age < 1 ? 1 : 1 - (age - 1) / (life - 1);
      g.push(mx, my, a, len, Math.max(1.3, minW * 2), 4, alpha(C.mGlow[L.team[i]], 0.22 * k));
      g.push(mx, my, a, len, Math.max(0.6, minW), 4, alpha(col, k));
      g.push(mx, my, a, len, Math.max(0.2, minW * 0.45), 4, alpha(C.beamCore, 0.8 * k));
      if (L.hit[i]) {
        const r = 1.6 + (age / life) * 1.6;
        g.push(x1, y1, 0, Math.max(r, minW * 2.5), Math.max(r, minW * 2.5), 1, alpha(col, k));
        if (age < 2) g.push(x1, y1, 0, Math.max(0.8, minW * 1.2), Math.max(0.8, minW * 1.2), 1, alpha(C.beamCore, 1 - age / 2));
      }
    }
    this.drawStraight(m.shell, t, vis, minW, false);
    this.drawStraight(m.missile, t, vis, minW, true);
    if (m.plasma) this.drawPlasma(m.plasma, t, vis, minW);
    if (m.flak) this.drawFlak(m.flak, t, vis, minW);
    if (m.frag) this.drawShrapnel(m.frag, t, vis, minW);
    if (m.auto) this.drawTracers(m.auto, t, vis, minW);
    if (m.fighter) this.drawFighters(m.fighter, t, vis, minW);
    // Detonations: 0 = missile shot down, 1 = cannon shell, 2 = heavy missile, 3 = heavy-laser block cooking off,
    // 4 = plasma bolt bursting into a hull, 5 = plasma bolt's final blast (both blue)
    const E = m.expl;
    const LIFE = [6, 8, 24, 22, 12, 24, 0, 22, 16], BASE = [1, 1.5, 5, 3, 3, 6, 0, 6, 2.5], GROW = [2.5, 5, 15, 16, 9, 20, 0, 24, 8]; // 7: shield generator exploding, 8: explosive cannon shell (20 Nov 2026)
    for (let i = lowerBound(E.t, t - 24); i < E.n && E.t[i] <= t; i++) {
      if (E.s[i] === 6) { this._hasFrag = !!m.frag; this.drawFlakBurst(E, i, t, vis, minW); continue; }
      const sz = E.s[i], life = LIFE[sz] ?? 8, age = t - E.t[i];
      if (age > life || !vis(E.x[i], E.y[i], 20)) continue;
      const u = age / life, base = BASE[sz] ?? 1.5, grow = GROW[sz] ?? 5;
      const r = base + u * grow;
      const pl = sz >= 4;
      g.push(E.x[i], E.y[i], 0, r, r, 1, alpha(sz === 0 ? C.pop : pl ? C.plGlow : C.boom, 1 - u));
      if (u < 0.3) g.push(E.x[i], E.y[i], 0, r * 0.5, r * 0.5, 1, alpha(pl ? C.plCore : C.boomCore, 1 - u / 0.3));
    }
    // Block destruction sparks: 3 fragments each, positions are pure functions of age
    const sp = m.spark, sT = m.sparkT, life = 14;
    for (let i = lowerBound(sT, t - life); i < sT.length && sT[i] <= t; i++) {
      const o = i * 7, age = t - sp[o], u = age / life;
      const x = sp[o + 1], y = sp[o + 2];
      if (!vis(x, y, 12)) continue;
      const vx = sp[o + 3] * dt, vy = sp[o + 4] * dt, id = sp[o + 5];
      if (age < 3) g.push(x + vx * age, y + vy * age, 0, 1.6 * (1 - age / 3) + 0.3, 1.6 * (1 - age / 3) + 0.3, 1, alpha(C.sparkHot, 1 - age / 3));
      for (let j = 0; j < 3; j++) {
        const ang = hash01(id, j) * 6.283, spd = 0.3 + hash01(id, j + 7) * 0.9;
        const fx = x + (vx + Math.cos(ang) * spd) * age, fy = y + (vy + Math.sin(ang) * spd) * age;
        const sz = Math.max(0.28 * (1 - u) + 0.1, minW * 0.8);
        g.push(fx, fy, ang + age * 0.4, sz, sz, 1, alpha(C.spark, 1 - u));
      }
    }
    // Ship death fireballs
    const D = m.death;
    for (let i = lowerBound(D.t, t - 20); i < D.n && D.t[i] <= t; i++) {
      const [t0, x, y, r] = D.d[i];
      if (!vis(x, y, r * 3)) continue;
      const u = (t - t0) / 20, R = r * (0.6 + u * 1.6);
      g.push(x, y, 0, R, R, 1, alpha(C.boom, (1 - u) * 0.9));
      if (u < 0.35) g.push(x, y, 0, R * 0.55, R * 0.55, 1, alpha(C.boomCore, 1 - u / 0.35));
    }
  }

  /** Heavy laser charging: a glow that swells at the gun in the 0.6 s before it fires. */
  drawLanceCharge(m, L, i, t, vis, minW) {
    const u = 1 - (L.t[i] - t) / LANCE_CHARGE; // 0 → 1 as the shot approaches
    if (u <= 0) return;
    const B = m.beamAt(i, t, this._beam || (this._beam = { x0: 0, y0: 0, x1: 0, y1: 0 }));
    if (!vis(B.x0, B.y0, 20)) return;
    const g = this.glow, team = L.team[i], e = u * u;
    const flick = 0.85 + 0.15 * Math.sin(t * 2.9 + i);
    g.push(B.x0, B.y0, 0, Math.max(2 + 9 * e, minW * 4), Math.max(2 + 9 * e, minW * 4), 1, alpha2(C.mGlow[team], 0.6 * e * flick));
    g.push(B.x0, B.y0, 0, Math.max(0.8 + 3 * e, minW * 2), Math.max(0.8 + 3 * e, minW * 2), 1, alpha2(C.beamCore, e));
  }

  drawLance(m, L, i, t, vis, minW) {
    const g = this.glow, age = t - L.t[i], life = LANCE_LIFE;
    if (age > life) return;
    if (!vis((L.x0[i] + L.x1[i]) / 2, (L.y0[i] + L.y1[i]) / 2, Math.hypot(L.x1[i] - L.x0[i], L.y1[i] - L.y0[i]) / 2 + 20)) return;
    const B = m.beamAt(i, t, this._beam || (this._beam = { x0: 0, y0: 0, x1: 0, y1: 0 }));
    const x0 = B.x0, y0 = B.y0, x1 = B.x1, y1 = B.y1;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, len = Math.hypot(x1 - x0, y1 - y0) / 2;
    const a = Math.atan2(y1 - y0, x1 - x0), team = L.team[i];
    // Full strength for 0.5 s with a fast flicker, then fades and narrows. Wide team-coloured
    // bloom, coloured body, broad white-hot core: nothing else on screen is this big or white.
    const hold = 5, f = age < hold ? 1 : 1 - (age - hold) / (life - hold);
    const flick = age < hold ? 0.8 + 0.2 * Math.sin(age * 7.3 + i * 1.7) : 1;
    const wid = 0.55 + 0.45 * f;
    g.push(mx, my, a, len, Math.max(11 * wid, minW * 8), 4, alpha2(C.mGlow[team], 0.32 * f * flick));
    g.push(mx, my, a, len, Math.max(4 * wid, minW * 4), 4, alpha2(C.beam[team], 0.9 * f));
    g.push(mx, my, a, len, Math.max(2 * wid * flick, minW * 2), 4, alpha2(C.beamCore, f));
    // Muzzle flash and the burn where the beam stops.
    const r = 9 * (0.5 + f * 0.7);
    g.push(x0, y0, 0, r, r, 1, alpha2(C.mGlow[team], 0.7 * f));
    g.push(x0, y0, 0, r * 0.45, r * 0.45, 1, alpha2(C.beamCore, f));
    if (L.hit[i]) {
      g.push(x1, y1, 0, r * 1.4, r * 1.4, 1, alpha2(C.boom, f));
      g.push(x1, y1, 0, r * 0.6, r * 0.6, 1, alpha2(C.boomCore, f * flick));
    }
  }

  /**
   * Plasma cannon bolts: a 0.6 s blue charge-up glow at the gun before launch, a muzzle flash,
   * then a big flickering blue-white bolt with a long trail, flying dead straight (position is
   * launch + velocity * age). It carves on through hulls (blue bursts are recorded as explosions).
   */
  drawPlasma(S, t, vis, minW) {
    const g = this.glow, CH = 15; // 1.5 s charge-up: the unit's orb swells and brightens
    for (let i = lowerBound(S.t0, t - S.maxFlight - 1); i < S.n && S.t0[i] <= t + CH; i++) {
      const age = t - S.t0[i];
      if (age < 0) { // charging
        const e = (1 + age / CH) ** 2, fl = 0.9 + 0.1 * Math.sin(t * 5 + i);
        if (!vis(S.x[i], S.y[i], 20)) continue;
        g.push(S.x[i], S.y[i], 0, Math.max(3 + 10 * e, minW * 4) * fl, Math.max(3 + 10 * e, minW * 4) * fl, 1, alpha2(C.plGlow, 0.7 * e));
        g.push(S.x[i], S.y[i], 0, Math.max(1.2 + 2.4 * e, minW * 2), Math.max(1.2 + 2.4 * e, minW * 2), 1, alpha2(C.plCore, 0.3 + 0.7 * e));
        continue;
      }
      if (t > S.t1[i]) continue;
      if (age < 5 && vis(S.x[i], S.y[i], 20)) { // muzzle flash
        const f = 1 - age / 5;
        g.push(S.x[i], S.y[i], 0, 6 + 6 * f, 6 + 6 * f, 1, alpha2(C.plGlow, 0.7 * f));
        g.push(S.x[i], S.y[i], 0, 3 * f + 0.5, 3 * f + 0.5, 1, alpha2(C.plCore, f));
      }
      const vx = S.vx[i], vy = S.vy[i], x = S.x[i] + vx * age, y = S.y[i] + vy * age;
      if (!vis(x, y, 40)) continue;
      const fade = S.hit[i] ? 1 : Math.min(1, (S.t1[i] - t) / 20);
      const a = Math.atan2(vy, vx), c = Math.cos(a), s = Math.sin(a);
      const flick = 0.85 + 0.15 * Math.sin(t * 3.1 + i * 2.3);
      const trail = Math.min(age * Math.hypot(vx, vy), 70) / 2;
      if (trail > 0.5) {
        g.push(x - c * trail, y - s * trail, a, trail, Math.max(5, minW * 5), 2, alpha2(C.plGlow, 0.45 * fade));
        g.push(x - c * trail, y - s * trail, a, trail, Math.max(2, minW * 2), 2, fadeCol(C.plTrail, fade));
      }
      const R = Math.max(12, minW * 12) * flick;
      g.push(x, y, 0, R, R, 1, alpha2(C.plGlow, 0.6 * fade));
      g.push(x, y, 0, Math.max(4.5, minW * 5), Math.max(4.5, minW * 5), 1, alpha2(C.plBody, fade));
      g.push(x, y, 0, Math.max(2, minW * 2.5), Math.max(2, minW * 2.5), 1, alpha2(C.plCore, fade));
    }
  }

  /**
   * Fighters (Nov 2026): a small swept-wing craft in its side's colour with an engine glow and a
   * short trail, flying piece by piece along its recorded path; a flash where it launches.
   */
  drawFighters(F, t, vis, minW) {
    const g = this.glow, sol = this.solid;
    for (let i = lowerBound(F.t0, t - F.maxPiece - FIGHTER_DEATH - 1); i < F.n && F.t0[i] <= t; i++) {
      if (t > F.t1[i]) { if (F.dead[i] && t < F.t1[i] + FIGHTER_DEATH) this.drawFighterDeath(F, i, t, vis, minW); continue; }
      const age = t - F.t0[i], vx = F.vx[i], vy = F.vy[i], x = F.x[i] + vx * age, y = F.y[i] + vy * age;
      if (!vis(x, y, 8)) continue;
      const a = Math.atan2(vy, vx), c = Math.cos(a), s = Math.sin(a), team = F.team[i];
      const k = Math.max(1.9, minW / 0.35); // about 3 blocks long (owner: bigger); stays visible zoomed out
      // Two swept-back wings in the side's colour, a pale fuselage over them, a blue canopy.
      for (const side of [-1, 1]) {
        const wx = x - c * 0.3 * k - s * side * 0.38 * k, wy = y - s * 0.3 * k + c * side * 0.38 * k;
        sol.push(wx, wy, a - side * 1.05, 0.5 * k, 0.15 * k, 0, C.mTip[team]);
      }
      sol.push(x, y, a, 0.8 * k, 0.17 * k, 0, C.fBody);                       // fuselage
      sol.push(x + c * 0.4 * k, y + s * 0.4 * k, a, 0.2 * k, 0.1 * k, 0, C.fCanopy);
      g.push(x - c * 0.9 * k, y - s * 0.9 * k, 0, 0.55 * k, 0.55 * k, 1, C.mFlame);   // engine
      g.push(x - c * 2.4 * k, y - s * 2.4 * k, a, 1.5 * k, Math.max(0.25, minW * 0.6), 2, alpha2(C.mGlow[team], 0.55));
      if (F.launch[i] && age < 6) { const f = 1 - age / 6; g.push(F.x[i], F.y[i], 0, 2.5 + 3 * f, 2.5 + 3 * f, 1, alpha2(C.mGlow[team], 0.8 * f)); }
    }
  }

  /**
   * A shot-down fighter (rework, Nov 2026, owner: they should look cool as they die): it breaks in
   * two and the pieces tumble on along its last heading, slowing, spinning apart, on fire, trailing
   * smoke, and burn out over FIGHTER_DEATH ticks (1.2 s). A pure function
   * of time, like everything else drawn.
   */
  drawFighterDeath(F, i, t, vis, minW) {
    const g = this.glow, sol = this.solid, dt = t - F.t1[i], f = dt / FIGHTER_DEATH, team = F.team[i];
    const vx = F.vx[i], vy = F.vy[i], piece = F.t1[i] - F.t0[i];
    // Where it was hit, then drifting on with its speed bleeding away (distance = v·(1-e^-kt)/k).
    const k = 0.25, drift = (1 - Math.exp(-k * dt)) / k;
    const x0 = F.x[i] + vx * (piece + drift), y0 = F.y[i] + vy * (piece + drift);
    if (!vis(x0, y0, 12)) return;
    const a0 = Math.atan2(vy, vx), size = Math.max(1.9, minW / 0.35);
    const spin = (F.fid[i] & 1 ? 1 : -1) * (0.5 + (F.fid[i] % 7) * 0.08); // rad per tick, each wreck its own
    const fade = 1 - f, hot = Math.max(0, 1 - f * 2.5);
    for (const side of [-1, 1]) { // two halves flying apart
      const sep = (0.4 + dt * 0.3) * size * 0.5, px = x0 - Math.sin(a0) * side * sep, py = y0 + Math.cos(a0) * side * sep;
      const ang = a0 + spin * dt * side;
      sol.push(px, py, ang, 0.55 * size, 0.17 * size, 0, fadeCol(C.fBody, 0.35 + 0.65 * fade));
      sol.push(px - Math.cos(ang) * 0.3 * size, py - Math.sin(ang) * 0.3 * size, ang + side * 1.05, 0.4 * size, 0.13 * size, 0, fadeCol(C.mTip[team], 0.3 + 0.7 * fade));
      // flames licking off each half, flickering
      const fl = 0.6 + 0.4 * Math.sin(dt * 2.3 + side * 1.7 + F.fid[i]);
      g.push(px, py, 0, (1 + 1.4 * hot) * size * fl, (1 + 1.4 * hot) * size * fl, 1, alpha2(C.mFlame, fade));
      g.push(px, py, 0, 2.2 * size * fl, 2.2 * size * fl, 1, alpha2(C.mGlow[team], 0.35 * fade)); // and a wider glow round it
      // smoke trail back along its path
      const tl = Math.min(drift, 14) * Math.hypot(vx, vy) * 0.08 + 1;
      g.push(px - Math.cos(a0) * tl, py - Math.sin(a0) * tl, a0, tl, Math.max(0.35, minW * 0.8) * (1 + f), 2, alpha2(C.smoke, 0.45 * fade));
    }
    if (dt < 3) g.push(x0, y0, 0, (2 + dt) * size * 0.9, (2 + dt) * size * 0.9, 1, alpha2(C.mGlow[team], 0.9 * (1 - dt / 3))); // the hit flash
  }

  /** Shells and heavy missiles: straight-line flight, so position is launch + velocity * age. */
  /** Flak shells: a small hot amber shell with a short bright trail, and a muzzle flash at the battery. */
  drawFlak(S, t, vis, minW) {
    const g = this.glow;
    for (let i = lowerBound(S.t0, t - S.maxFlight - 1); i < S.n && S.t0[i] <= t; i++) {
      if (t > S.t1[i]) continue;
      const age = t - S.t0[i], vx = S.vx[i], vy = S.vy[i];
      if (age < 3 && vis(S.x[i], S.y[i], 12)) {
        const f = 1 - age / 3;
        g.push(S.x[i], S.y[i], 0, 4 + 4 * f, 4 + 4 * f, 1, alpha2(C.flGlow, 0.8 * f));
        g.push(S.x[i], S.y[i], 0, 1.5 + 1.5 * f, 1.5 + 1.5 * f, 1, alpha2(C.flFlash, f));
      }
      const x = S.x[i] + vx * age, y = S.y[i] + vy * age;
      if (!vis(x, y, 10)) continue;
      const a = Math.atan2(vy, vx), c = Math.cos(a), s = Math.sin(a);
      g.push(x - c * 4, y - s * 4, a, 4, Math.max(0.6, minW), 2, C.flTrail);
      g.push(x, y, 0, Math.max(1.1, minW * 1.8), Math.max(1.1, minW * 1.8), 1, C.flShell);
    }
  }

  /**
   * Flak shrapnel: each piece a small hot streak flying straight from the burst until it hits
   * something (a tiny flash there) or burns out (fades over its last second).
   */
  /**
   * Auto gun bullets (shot kind 7). Second look (owner, 20 Nov 2026: "visually more impactful"):
   * a muzzle flash where each leaves the gun, a long hot tracer in an orange glow, and on a hit a
   * flash plus a few sparks kicked back off the hull. All pure functions of time (ticks).
   */
  drawTracers(S, t, vis, minW) {
    const g = this.glow, FLASH = 1.5, HIT = 5;
    for (let i = lowerBound(S.t0, t - S.maxFlight - HIT); i < S.n && S.t0[i] <= t; i++) {
      const age = t - S.t0[i], vx = S.vx[i], vy = S.vy[i];
      const a = Math.atan2(vy, vx), c = Math.cos(a), s = Math.sin(a), sp = Math.hypot(vx, vy);
      if (age < FLASH && vis(S.x[i], S.y[i], 6)) { // muzzle flash: a burst and a short tongue of flame forward
        const k = 1 - age / FLASH, r = Math.max(0.7 + 1.6 * k, minW * 2);
        g.push(S.x[i], S.y[i], 0, r, r, 1, alpha2(C.autoFlash, 0.9 * k));
        g.push(S.x[i] + c * 1.4, S.y[i] + s * 1.4, a, 1.8 * k + 0.4, Math.max(0.55 * k, minW), 2, alpha2(C.tracerHot, k));
      }
      if (t > S.t1[i]) {
        const since = t - S.t1[i];
        if (S.hit[i] && since < HIT) {
          const f = S.t1[i] - S.t0[i], x = S.x[i] + vx * f, y = S.y[i] + vy * f, k = 1 - since / HIT;
          if (!vis(x, y, 8)) continue;
          const r = Math.max(1.0 + 2.6 * (1 - k * k), minW * 2);
          g.push(x, y, 0, r, r, 1, alpha2(C.autoHalo, 0.8 * k));
          if (since < 1.5) g.push(x, y, 0, Math.max(1.5, minW * 2.5), Math.max(1.5, minW * 2.5), 1, alpha2(C.tracerHot, 1 - since / 1.5));
          for (let j = 0; j < 5; j++) { // sparks thrown back off the hull, fanned out
            const sa = a + Math.PI + (hash01(i, j) - 0.5) * 2.4, v = 0.5 + hash01(i, j + 9) * 0.9, d = v * since;
            g.push(x + Math.cos(sa) * d, y + Math.sin(sa) * d, sa, 0.7 + v * 0.7, Math.max(0.16, minW * 0.7), 2, alpha2(C.autoSpark, k));
          }
        }
        continue;
      }
      const x = S.x[i] + vx * age, y = S.y[i] + vy * age;
      if (!vis(x, y, 10)) continue;
      const fade = S.hit[i] ? 1 : Math.min(1, (S.t1[i] - t) / 6);
      const len = Math.min(4.5, age * sp * 0.5 + 0.4), core = Math.min(3.2, age * sp * 0.4 + 0.3);
      g.push(x - c * len, y - s * len, a, len, Math.max(0.6, minW * 1.6), 4, alpha2(C.autoHalo, 0.35 * fade));
      g.push(x - c * core, y - s * core, a, core, Math.max(0.24, minW * 0.8), 4, alpha2(C.tracer, fade));
      g.push(x, y, 0, Math.max(0.5, minW * 1.1), Math.max(0.5, minW * 1.1), 1, alpha2(C.tracerHot, fade));
    }
  }

  drawShrapnel(S, t, vis, minW) {
    const g = this.glow;
    for (let i = lowerBound(S.t0, t - S.maxFlight - 3); i < S.n && S.t0[i] <= t; i++) {
      const age = t - S.t0[i];
      if (t > S.t1[i]) {
        if (S.hit[i] && t - S.t1[i] < 3) { // impact spark
          const f = S.t1[i] - S.t0[i], x = S.x[i] + S.vx[i] * f, y = S.y[i] + S.vy[i] * f, k = 1 - (t - S.t1[i]) / 3;
          if (vis(x, y, 4)) g.push(x, y, 0, Math.max(0.7, minW * 1.5), Math.max(0.7, minW * 1.5), 1, alpha2(C.flShrap, k));
        }
        continue;
      }
      const vx = S.vx[i], vy = S.vy[i], x = S.x[i] + vx * age, y = S.y[i] + vy * age;
      if (!vis(x, y, 6)) continue;
      const fade = S.hit[i] ? 1 : Math.min(1, (S.t1[i] - t) / 10);
      const a = Math.atan2(vy, vx), c = Math.cos(a), s = Math.sin(a), len = Math.min(1.1, age * Math.hypot(vx, vy) * 0.3 + 0.3);
      g.push(x - c * len, y - s * len, a, len, Math.max(0.16, minW * 0.6), 4, alpha2(C.flShrap, 0.85 * fade));
      g.push(x, y, 0, Math.max(0.25, minW * 0.8), Math.max(0.25, minW * 0.8), 1, alpha2(C.flShell, 0.9 * fade));
    }
  }

  /**
   * Flak burst (explosion size 6): a white flash, an amber fireball, a puff of smoke, and a spray of
   * orange shrapnel streaks flying out to about 30 blocks. Directions come from a hash of the
   * explosion's index, so it's a pure function of time like everything else.
   */
  drawFlakBurst(E, i, t, vis, minW) {
    const g = this.glow, age = t - E.t[i], x = E.x[i], y = E.y[i], LIFE = 16;
    if (age > LIFE || !vis(x, y, 34)) return;
    const u = age / LIFE;
    if (age < 2) g.push(x, y, 0, 5 + age * 3, 5 + age * 3, 1, alpha2(C.flFlash, 1 - age / 2));
    if (age < 7) g.push(x, y, 0, 2.5 + age * 1.2, 2.5 + age * 1.2, 1, alpha2(C.flGlow, 0.85 * (1 - age / 7)));
    g.push(x, y, 0, 3 + u * 9, 3 + u * 9, 1, alpha2(C.flSmoke, 0.35 * (1 - u)));
    // Old replays (before shrapnel became real projectiles) drew streaks here instead.
    if (age < 7 && !this._hasFrag) {
      const k = 1 - age / 7, reach = 30 * Math.min(1, age / 4);
      for (let j = 0; j < 16; j++) {
        const ang = hash01(i, j) * 6.283, r = reach * (0.55 + 0.45 * hash01(i, j + 31)), len = 2.2;
        g.push(x + Math.cos(ang) * (r - len), y + Math.sin(ang) * (r - len), ang, len, Math.max(0.3, minW * 0.8), 4, alpha2(C.flShrap, k));
      }
    }
  }

  drawStraight(S, t, vis, minW, heavy) {
    const g = this.glow, sol = this.solid;
    for (let i = lowerBound(S.t0, t - S.maxFlight - 1); i < S.n && S.t0[i] <= t; i++) {
      if (t > S.t1[i]) continue;
      const age = t - S.t0[i], vx = S.vx[i], vy = S.vy[i];
      const x = S.x[i] + vx * age, y = S.y[i] + vy * age;
      if (!vis(x, y, heavy ? 40 : 6)) continue;
      const a = Math.atan2(vy, vx), c = Math.cos(a), s = Math.sin(a);
      // A shot that ran out of flight time (hit 0) fades over its last 2 s instead of vanishing.
      const fade = S.hit[i] ? 1 : Math.min(1, (S.t1[i] - t) / 20);
      if (!heavy) {
        g.push(x - c * 3, y - s * 3, a, 3.2, Math.max(0.45, minW), 2, fade < 1 ? fadeCol(C.trail, fade) : C.trail);
        g.push(x, y, 0, Math.max(0.7, minW * 1.5), Math.max(0.7, minW * 1.5), 1, fade < 1 ? fadeCol(C.missile, fade) : C.missile);
        continue;
      }
      if (fade < 1) { // burnt-out missile: just a fading glow
        g.push(x, y, 0, Math.max(3, minW * 4), Math.max(3, minW * 4), 1, alpha2(C.mGlow[S.team[i]], 0.5 * fade));
        continue;
      }
      // Heavy missile: solid body, hot exhaust plume, and a smoke trail back toward the launcher.
      sol.push(x, y, a, Math.max(1.4, minW * 2), Math.max(0.55, minW), 0, C.mBody);
      sol.push(x + c * 1.5, y + s * 1.5, a, 0.4, 0.4, 0, C.mTip[S.team[i]]);
      g.push(x - c * 3.2, y - s * 3.2, a, 2.2, Math.max(0.9, minW * 1.5), 2, C.mFlame);
      g.push(x, y, 0, Math.max(3, minW * 4), Math.max(3, minW * 4), 1, alpha2(C.mGlow[S.team[i]], 0.5));
      const trail = Math.min((age + (S.a0 ? S.a0[i] : 0)) * Math.hypot(vx, vy), 40) / 2;
      if (trail > 0.5) g.push(x - c * (trail + 3), y - s * (trail + 3), a, trail, Math.max(0.7, minW), 2, alpha2(C.smoke, 0.5));
    }
  }
}
