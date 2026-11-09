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
out vec2 vUV; out vec4 vCol; flat out highp float vShape; flat out float vAng;
void main(){
  float c = cos(posA.z), s = sin(posA.z);
  vec2 l = corner * sizeShape.xy;
  vec2 w = posA.xy + vec2(l.x*c - l.y*s, l.x*s + l.y*c);
  gl_Position = vec4((w - uCam) * uScale, 0.0, 1.0);
  vUV = corner; vCol = color; vShape = sizeShape.z; vAng = posA.z;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUV; in vec4 vCol; flat in highp float vShape; flat in float vAng; out vec4 o;
uniform float uDet;   // 0..1: how much fine detail to draw (by on-screen block size)
uniform float uTime;  // replay time in ticks, for glows that pulse
// Detailed hull block. Shape code = 10 + type + 16 * open-sides mask + 256 * var + 32768 if
// it's debris; var is 0..7 for variety, or for plasma cannon blocks u * 10 + v, the block's
// place in its 10x10 unit (the whole unit is drawn as one machine). Edges facing open space get a bevel lit from the upper left of the
// world and a dark outline, so a hull reads as solid plating instead of a grid of tiles; each
// block type has its own surface (plates, rivets, truss, nozzle, lens, turret, tubes, coils).
vec3 hullBlock(int code, vec2 p) {
  int type = code & 15, mask = (code >> 4) & 15, var = (code >> 8) & 127, hv = var & 7;
  bool dead = code >= 32768;
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
  } else if (type == 6) { // laser: fixed emitter, a faceted crystal in a dark square mount
    float dm = abs(p.x) + abs(p.y);
    float cry = 1.0 - smoothstep(0.5, 0.58, dm);
    float facet = 0.8 + 0.25 * sign(p.x * L.x + p.y * L.y + 0.001) * step(0.08, abs(p.x) + abs(p.y));
    lit *= mix(1.0, mix(0.42, 1.0, cry), d);
    glow = mix(col, vec3(1.0), 0.55) * cry * facet * (dead ? 0.15 : 0.85) * d
         + vec3(1.0) * (1.0 - smoothstep(0.0, 0.14, dm)) * (dead ? 0.0 : 0.6) * d;
  } else if (type == 7) { // cannon: fixed armoured gun port, a big dark bore with a bright rim
    float rim = smoothstep(0.36, 0.42, r) * (1.0 - smoothstep(0.54, 0.6, r));
    float bore = 1.0 - smoothstep(0.36, 0.42, r);
    float bolt = 1.0 - smoothstep(0.05, 0.1, length(abs(p) - 0.74));
    lit *= mix(1.0, 0.8 + rim * (0.55 - sh * 0.5) - bore * 0.72 + bolt * 0.3, d);
    if (!dead) glow = vec3(1.0, 0.45, 0.15) * (1.0 - smoothstep(0.0, 0.25, r)) * 0.35 * d;
  } else if (type == 8 || type == 11) { // missile launcher: four tubes, hazard stripes round the hatch (guided: green seeker eye)
    float tube = 1.0 - smoothstep(0.17, 0.23, length(abs(p) - 0.36));
    float band = smoothstep(0.74, 0.8, max(abs(p.x), abs(p.y)));
    float stripe = step(0.5, fract((p.x + p.y) * 2.5));
    lit *= mix(1.0, (1.0 - tube * 0.7) * mix(1.0, 0.45 + 0.55 * stripe, band), d);
    if (type == 11) { lit *= mix(1.0, smoothstep(0.1, 0.16, r), d); if (!dead) glow = vec3(0.35, 1.0, 0.6) * (1.0 - smoothstep(0.03, 0.1, r)) * 0.9 * d; }
  } else if (type == 9) { // point defence: fixed sensor dish, rings and a crosshair, red eye
    float ring = (1.0 - smoothstep(0.03, 0.07, abs(r - 0.62))) + (1.0 - smoothstep(0.03, 0.07, abs(r - 0.38)));
    float cross = (1.0 - smoothstep(0.03, 0.06, min(abs(p.x), abs(p.y)))) * step(r, 0.62);
    lit *= mix(1.0, 0.62 + 0.35 * min(ring + cross, 1.0) - sh * 0.1, d);
    if (!dead) glow = vec3(1.0, 0.25, 0.2) * (1.0 - smoothstep(0.08, 0.17, r)) * 0.9 * d;
  } else if (type == 10) { // plasma cannon: the whole 10x10 unit is one machine
    vec2 q = (vec2(float(var / 10), float(var - (var / 10) * 10)) + p * 0.5 + 0.5) / 10.0 - 0.5; // -0.5..0.5 across the unit
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
    // collar round the orb
    float collar = (1.0 - smoothstep(0.012, 0.022, abs(R - 0.215)));
    base = mix(base, 1.1, collar);
    float orb = 1.0 - smoothstep(0.15, 0.17, R);
    lit *= mix(1.0, base, d);
    if (!dead) {
      float flow = 0.5 + 0.5 * sin(R * 60.0 + uTime * 0.6); // energy running inward along the pipes
      float pulse = 0.8 + 0.2 * sin(uTime * 0.4);
      glow = (vec3(0.25, 0.55, 1.0) * min(pipeCore, 1.0) * (0.4 + 0.6 * flow)
           + orb * mix(vec3(0.2, 0.5, 1.0), vec3(0.9, 0.97, 1.0), 1.0 - smoothstep(0.0, 0.13, R)) * pulse
           + vec3(0.15, 0.35, 0.9) * (1.0 - smoothstep(0.15, 0.3, R)) * 0.4) * d;
      lit *= 1.0 - orb * d * 0.8;
    } else lit *= 1.0 - orb * d * 0.3;
  } else if (type == 12) { // fighter bay: the 6x6 unit is one hangar, a dark deck in a hazard-striped frame
    vec2 q = (vec2(float(var / 6), float(var - (var / 6) * 6)) + p * 0.5 + 0.5) / 6.0 - 0.5; // -0.5..0.5 across the unit
    vec2 aq = abs(q);
    float m = max(aq.x, aq.y), R = length(q);
    float frame = smoothstep(0.42, 0.435, m);
    float stripe = step(0.5, fract((q.x + q.y) * 8.0));
    float rows = 1.0 - smoothstep(0.003, 0.007, abs(fract(q.y * 6.0 + 0.5) - 0.5) / 6.0);
    float deck = 0.28 + rows * 0.1 * (1.0 - frame);
    // a small fighter parked in the middle, nose forward (+x)
    float body = step(abs(q.y), 0.05 + (0.16 - q.x) * 0.45) * step(-0.14, q.x) * step(q.x, 0.18);
    float base = mix(deck, 0.35 + 0.75 * stripe, frame);
    base = mix(base, 1.05 - dot(q, L) * 0.3, body * (1.0 - frame));
    lit *= mix(1.0, base, d);
    if (!dead) {
      float lights = 1.0 - smoothstep(0.012, 0.025, length(aq - 0.33));
      glow = vec3(1.0, 0.7, 0.3) * lights * (0.6 + 0.4 * sin(uTime * 0.5 + q.x * 9.0)) * d;
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

const STRIDE = 7; // x, y, angle, sx, sy, shape, rgba(u32)

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
  p[BT.THRUSTER] = '#3d434f'; p[BT.LASER] = team ? '#ffd9c9' : '#d8f4ff'; p[BT.CANNON] = '#9aa1ab'; p[BT.MISSILE] = '#b9b16c'; p[BT.PD] = PD_COLOR; p[BT.LANCE] = team ? '#8a4f63' : '#5b5f9c'; p[BT.GUIDED] = '#8fb79e'; p[BT.BAY] = '#c9a23c';
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
    p[BT.PD] = PD_COLOR; p[BT.LANCE] = shade(mixHex(hex, '#40404a', 0.5), 0.9); p[BT.GUIDED] = '#8fb79e'; p[BT.BAY] = '#c9a23c';
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
  const sides = Array.from({ length: nT }, (_, t) => sideColors?.[t] || null);
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
    solid.n = 0; glow.n = 0;
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
      if (lod) {
        // Far zoom: one quad per ship, debris as faint specks.
        if (dead) { if (e.size > 2) solid.push(tr.x, tr.y, tr.a, Math.max(e.w * 0.35, px), Math.max(e.h * 0.35, px), 3, C.lodDead); }
        else solid.push(tr.x, tr.y, tr.a, Math.max(e.w * 0.45, px * 1.2), Math.max(e.h * 0.32, px * 1.2), 3, e.look ? e.look.lod : C.lod[e.team]);
        continue;
      }
      const c = Math.cos(tr.a), s = Math.sin(tr.a), pal = e.look ? e.look.pal[dead ? 1 : 0] : PAL[dead ? 1 : 0][e.team];
      const lx = e.lx, ly = e.ly, ty = e.type, de = e.death;
      if (!detail) {
        for (let i = 0; i < lx.length; i++) {
          if (de[i] <= t) continue;
          solid.push(tr.x + lx[i] * c - ly[i] * s, tr.y + lx[i] * s + ly[i] * c, tr.a, 0.5, 0.5, 0, pal[ty[i]]);
          blocks++;
        }
      } else {
        // Detailed blocks: which sides are open (for bevels and outlines). Guns are drawn as fixed
        // mounts (owner: static turrets looked cheap). Pure function of time, like the rest.
        const nb = e.nb, un = e.unit, deadBit = dead ? 32768 : 0;
        for (let i = 0; i < lx.length; i++) {
          if (de[i] <= t) continue;
          const o = i * 4, a0 = nb[o], a1 = nb[o + 1], a2 = nb[o + 2], a3 = nb[o + 3];
          const mask = (a0 >= 0 && de[a0] > t ? 1 : 0) | (a1 >= 0 && de[a1] > t ? 2 : 0) | (a2 >= 0 && de[a2] > t ? 4 : 0) | (a3 >= 0 && de[a3] > t ? 8 : 0);
          const type = ty[i], x = tr.x + lx[i] * c - ly[i] * s, y = tr.y + lx[i] * s + ly[i] * c;
          const v = (type === BT.LANCE || type === BT.BAY) && un[i] ? un[i] - 1 : (i * 2654435761) >>> 29;
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
    if (m.fighter) this.drawFighters(m.fighter, t, vis, minW);
    // Detonations: 0 = missile shot down, 1 = cannon shell, 2 = heavy missile, 3 = heavy-laser block cooking off,
    // 4 = plasma bolt bursting into a hull, 5 = plasma bolt's final blast (both blue)
    const E = m.expl;
    const LIFE = [6, 8, 24, 22, 12, 24], BASE = [1, 1.5, 5, 3, 3, 6], GROW = [2.5, 5, 15, 16, 9, 20];
    for (let i = lowerBound(E.t, t - 24); i < E.n && E.t[i] <= t; i++) {
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
    for (let i = lowerBound(F.t0, t - F.maxPiece - 1); i < F.n && F.t0[i] <= t; i++) {
      if (t > F.t1[i]) continue;
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

  /** Shells and heavy missiles: straight-line flight, so position is launch + velocity * age. */
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
