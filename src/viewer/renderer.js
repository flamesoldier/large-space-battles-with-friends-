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
  p[BT.THRUSTER] = '#3d434f'; p[BT.LASER] = team ? '#ffd9c9' : '#d8f4ff'; p[BT.CANNON] = '#9aa1ab'; p[BT.MISSILE] = '#b9b16c'; p[BT.PD] = team ? '#e8a07a' : '#7fc4e0';
  return p.map((c) => (c ? rgba(dead ? shade(c, k) : c) : 0));
}
const PAL = [[blockPalette(0, false), blockPalette(1, false)], [blockPalette(0, true), blockPalette(1, true)]];
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
        else solid.push(tr.x, tr.y, tr.a, Math.max(e.w * 0.45, px * 1.2), Math.max(e.h * 0.32, px * 1.2), 3, C.lod[e.team]);
        continue;
      }
      const c = Math.cos(tr.a), s = Math.sin(tr.a), pal = PAL[dead ? 1 : 0][e.team];
      const lx = e.lx, ly = e.ly, ty = e.type, de = e.death;
      for (let i = 0; i < lx.length; i++) {
        if (de[i] <= t) continue;
        solid.push(tr.x + lx[i] * c - ly[i] * s, tr.y + lx[i] * s + ly[i] * c, tr.a, 0.5, 0.5, 0, pal[ty[i]]);
        blocks++;
      }
      if (!dead) {
        // engine glow behind the stern
        const r = e.w * 0.5 + 0.8;
        glow.push(tr.x - c * r, tr.y - s * r, tr.a, Math.max(1.6, e.h * 0.18), Math.max(1.2, e.h * 0.22), 1, C.engine[e.team]);
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

    // Kinetic tracers
    const S = m.shot;
    for (let i = lowerBound(S.t0, t - S.maxFlight - 3); i < S.n && S.t0[i] <= t; i++) {
      const t1 = S.t1[i];
      if (t <= t1) {
        const u = t - S.t0[i], x = S.x[i] + S.vx[i] * u, y = S.y[i] + S.vy[i] * u;
        if (!vis(x, y, 4)) continue;
        const a = Math.atan2(S.vy[i], S.vx[i]);
        g.push(x - Math.cos(a) * 2.5, y - Math.sin(a) * 2.5, a, 3, Math.max(0.3, minW), 2, C.tracer);
      } else if (S.hit[i] && t - t1 < 3) {
        const u = t1 - S.t0[i], x = S.x[i] + S.vx[i] * u, y = S.y[i] + S.vy[i] * u;
        if (!vis(x, y, 2)) continue;
        const r = 0.8 + (t - t1) * 0.5;
        g.push(x, y, 0, Math.max(r, minW * 2), Math.max(r, minW * 2), 1, alpha(C.impact, 1 - (t - t1) / 3));
      }
    }
    // Beams: lasers linger 0.4 s and are thick; point defence is a thin, quick flicker.
    const L = m.laser;
    for (let i = lowerBound(L.t, t - 4); i < L.n && L.t[i] <= t; i++) {
      const pd = L.kind[i] === 1, life = pd ? 1.5 : 4, age = t - L.t[i];
      if (age > life) continue;
      const x0 = L.x0[i], y0 = L.y0[i], x1 = L.x1[i], y1 = L.y1[i];
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, len = Math.hypot(x1 - x0, y1 - y0) / 2;
      if (!vis(mx, my, len)) continue;
      const k = 1 - age / life, col = pd ? C.pd[L.team[i]] : C.beam[L.team[i]];
      g.push(mx, my, Math.atan2(y1 - y0, x1 - x0), len, Math.max(pd ? 0.16 : 0.55, minW), 4, alpha(col, k));
      if (!pd) g.push(mx, my, Math.atan2(y1 - y0, x1 - x0), len, Math.max(0.15, minW * 0.5), 4, alpha(C.beamCore, k));
      if (L.hit[i]) { const r = pd ? 0.7 : 1.8; g.push(x1, y1, 0, Math.max(r, minW * 2), Math.max(r, minW * 2), 1, alpha(col, k)); }
    }
    this.drawTracks(m.shell, t, vis, minW, false);
    this.drawTracks(m.missile, t, vis, minW, true);
    // Detonations: 0 = missile shot down, 1 = cannon shell, 2 = heavy missile
    const E = m.expl;
    for (let i = lowerBound(E.t, t - 24); i < E.n && E.t[i] <= t; i++) {
      const sz = E.s[i], life = sz === 2 ? 24 : sz === 1 ? 8 : 6, age = t - E.t[i];
      if (age > life || !vis(E.x[i], E.y[i], 20)) continue;
      const u = age / life, base = sz === 2 ? 4 : sz === 1 ? 1.5 : 1, grow = sz === 2 ? 12 : sz === 1 ? 5 : 2.5;
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

  /** Shells and heavy missiles: interpolate recorded samples, draw head + exhaust trail. */
  drawTracks(M, t, vis, minW, heavy) {
    const g = this.glow, sol = this.solid;
    for (let i = lowerBound(M.t0, t - M.maxLife - 1); i < M.n && M.t0[i] <= t; i++) {
      if (t > M.t1[i]) continue;
      const n = M.sn[i], b = M.s0[i] * 2, u = t - M.t0[i];
      const k = Math.min(n - 2, Math.floor(u / M.every));
      if (k < 0) continue;
      const ta = M.t0[i] + k * M.every, tb = k + 1 === n - 1 ? M.t1[i] : ta + M.every;
      const f = tb > ta ? Math.min(1, (t - ta) / (tb - ta)) : 1;
      const xa = M.xy[b + k * 2], ya = M.xy[b + k * 2 + 1], xb = M.xy[b + k * 2 + 2], yb = M.xy[b + k * 2 + 3];
      const x = xa + (xb - xa) * f, y = ya + (yb - ya) * f;
      if (!vis(x, y, heavy ? 30 : 6)) continue;
      const a = Math.atan2(yb - ya, xb - xa);
      if (!heavy) {
        g.push(x - Math.cos(a) * 3, y - Math.sin(a) * 3, a, 3.2, Math.max(0.45, minW), 2, C.trail);
        g.push(x, y, 0, Math.max(0.7, minW * 1.5), Math.max(0.7, minW * 1.5), 1, C.missile);
        continue;
      }
      // Heavy missile: a solid body, a hot exhaust plume and a fading smoke trail along past samples.
      sol.push(x, y, a, Math.max(1.4, minW * 2), Math.max(0.55, minW), 0, C.mBody);
      sol.push(x + Math.cos(a) * 1.5, y + Math.sin(a) * 1.5, a, 0.4, 0.4, 0, C.mTip[M.team[i]]);
      g.push(x - Math.cos(a) * 3.2, y - Math.sin(a) * 3.2, a, 2.2, Math.max(0.9, minW * 1.5), 2, C.mFlame);
      g.push(x, y, 0, Math.max(3, minW * 4), Math.max(3, minW * 4), 1, alpha2(C.mGlow[M.team[i]], 0.5));
      let px = x, py = y;
      for (let j = k; j >= Math.max(0, k - 6); j--) {
        const sx = M.xy[b + j * 2], sy = M.xy[b + j * 2 + 1];
        const len = Math.hypot(px - sx, py - sy) / 2;
        if (len > 0.01) g.push((px + sx) / 2, (py + sy) / 2, Math.atan2(py - sy, px - sx), len, Math.max(0.6 + (k - j) * 0.15, minW), 4, alpha2(C.smoke, 0.55 * (1 - (k - j) / 7)));
        px = sx; py = sy;
      }
    }
  }
}
