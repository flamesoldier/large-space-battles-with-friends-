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
out vec2 vUV; out vec4 vCol; flat out float vShape;
void main(){
  float c = cos(posA.z), s = sin(posA.z);
  vec2 l = corner * sizeShape.xy;
  vec2 w = posA.xy + vec2(l.x*c - l.y*s, l.x*s + l.y*c);
  gl_Position = vec4((w - uCam) * uScale, 0.0, 1.0);
  vUV = corner; vCol = color; vShape = sizeShape.z;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUV; in vec4 vCol; flat in float vShape; out vec4 o;
void main(){
  if (vShape < 0.5) {            // hull block: bevelled tile
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

export const TEAM = [
  { name: 'Azure Compact', armor: '#5c7ea3', heavy: '#41597a', frame: '#90a6c0', hub: '#86e8ff', beam: '#63d4ff', accent: '#86e8ff' },
  { name: 'Ember Dominion', armor: '#a5684f', heavy: '#7a4a38', frame: '#c69c86', hub: '#ffd27a', beam: '#ff7a52', accent: '#ffb35c' },
];

function blockPalette(team, dead) {
  const T = TEAM[team], k = dead ? 0.7 : 1; // wrecks stay readable, just burnt
  const p = [];
  p[BT.HUB] = T.hub; p[BT.ARMOR] = T.armor; p[BT.HEAVY] = T.heavy; p[BT.FRAME] = T.frame;
  p[BT.THRUSTER] = '#3d434f'; p[BT.LASER] = team ? '#ffd9c9' : '#d8f4ff'; p[BT.CANNON] = '#9aa1ab'; p[BT.MISSILE] = '#b9b16c'; p[BT.PD] = team ? '#e8a07a' : '#7fc4e0'; p[BT.LANCE] = team ? '#8a4f63' : '#5b5f9c';
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
    p[BT.PD] = shade(mixHex(hex, '#ffffff', 0.3), 0.9); p[BT.LANCE] = shade(mixHex(hex, '#40404a', 0.5), 0.9);
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
const C = {
  tracer: rgba('#ffe7a6', 230), impact: rgba('#ffc46b', 255), spark: rgba('#ff9d47', 255), sparkHot: rgba('#fff1c4', 255),
  missile: rgba('#ffffff', 255), trail: rgba('#ff8a3d', 200), boom: rgba('#ff9b45', 255), boomCore: rgba('#fff4d6', 255),
  engine: [rgba('#58b8ff', 150), rgba('#ff8a3d', 150)], beam: TEAM.map((t) => rgba(t.beam, 255)),
  pd: [rgba('#bff3ff', 255), rgba('#ffd0b8', 255)], beamCore: rgba('#ffffff', 255), pop: rgba('#ffffff', 255),
  mBody: rgba('#c9ccd3'), mTip: TEAM.map((t) => rgba(t.accent)), mFlame: rgba('#ffb04a', 255),
  mGlow: TEAM.map((t) => rgba(t.beam, 255)), smoke: rgba('#9a8f86', 255),
  lod: TEAM.map((t) => rgba(t.accent)), lodDead: rgba('#7a7c86'), hotChunk: rgba('#ff7a2e', 255),
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
      for (let i = 0; i < lx.length; i++) {
        if (de[i] <= t) continue;
        solid.push(tr.x + lx[i] * c - ly[i] * s, tr.y + lx[i] * s + ly[i] * c, tr.a, 0.5, 0.5, 0, pal[ty[i]]);
        blocks++;
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
      const pd = L.kind[i] === 1, life = pd ? 1.5 : 6, age = t - L.t[i];
      if (age > life) continue;
      if (!vis((L.x0[i] + L.x1[i]) / 2, (L.y0[i] + L.y1[i]) / 2, Math.hypot(L.x1[i] - L.x0[i], L.y1[i] - L.y0[i]) / 2 + 20)) continue;
      const B = m.beamAt(i, t, this._beam || (this._beam = { x0: 0, y0: 0, x1: 0, y1: 0 }));
      const x0 = B.x0, y0 = B.y0, x1 = B.x1, y1 = B.y1;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, len = Math.hypot(x1 - x0, y1 - y0) / 2;
      const col = pd ? C.pd[L.team[i]] : C.beam[L.team[i]], a = Math.atan2(y1 - y0, x1 - x0);
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
    // Detonations: 0 = missile shot down, 1 = cannon shell, 2 = heavy missile, 3 = heavy-laser block cooking off
    const E = m.expl;
    const LIFE = [6, 8, 24, 22], BASE = [1, 1.5, 5, 3], GROW = [2.5, 5, 15, 16];
    for (let i = lowerBound(E.t, t - 24); i < E.n && E.t[i] <= t; i++) {
      const sz = E.s[i], life = LIFE[sz] ?? 8, age = t - E.t[i];
      if (age > life || !vis(E.x[i], E.y[i], 20)) continue;
      const u = age / life, base = BASE[sz] ?? 1.5, grow = GROW[sz] ?? 5;
      const r = base + u * grow;
      g.push(E.x[i], E.y[i], 0, r, r, 1, alpha(sz === 0 ? C.pop : C.boom, 1 - u));
      if (u < 0.3) g.push(E.x[i], E.y[i], 0, r * 0.5, r * 0.5, 1, alpha(C.boomCore, 1 - u / 0.3));
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

  /** Shells and heavy missiles: straight-line flight, so position is launch + velocity * age. */
  drawStraight(S, t, vis, minW, heavy) {
    const g = this.glow, sol = this.solid;
    for (let i = lowerBound(S.t0, t - S.maxFlight - 1); i < S.n && S.t0[i] <= t; i++) {
      if (t > S.t1[i]) continue;
      const age = t - S.t0[i], vx = S.vx[i], vy = S.vy[i];
      const x = S.x[i] + vx * age, y = S.y[i] + vy * age;
      if (!vis(x, y, heavy ? 40 : 6)) continue;
      const a = Math.atan2(vy, vx), c = Math.cos(a), s = Math.sin(a);
      if (!heavy) {
        g.push(x - c * 3, y - s * 3, a, 3.2, Math.max(0.45, minW), 2, C.trail);
        g.push(x, y, 0, Math.max(0.7, minW * 1.5), Math.max(0.7, minW * 1.5), 1, C.missile);
        continue;
      }
      // Heavy missile: solid body, hot exhaust plume, and a smoke trail back toward the launcher.
      sol.push(x, y, a, Math.max(1.4, minW * 2), Math.max(0.55, minW), 0, C.mBody);
      sol.push(x + c * 1.5, y + s * 1.5, a, 0.4, 0.4, 0, C.mTip[S.team[i]]);
      g.push(x - c * 3.2, y - s * 3.2, a, 2.2, Math.max(0.9, minW * 1.5), 2, C.mFlame);
      g.push(x, y, 0, Math.max(3, minW * 4), Math.max(3, minW * 4), 1, alpha2(C.mGlow[S.team[i]], 0.5));
      const trail = Math.min(age * Math.hypot(vx, vy), 40) / 2;
      if (trail > 0.5) g.push(x - c * (trail + 3), y - s * (trail + 3), a, trail, Math.max(0.7, minW), 2, alpha2(C.smoke, 0.5));
    }
  }
}
