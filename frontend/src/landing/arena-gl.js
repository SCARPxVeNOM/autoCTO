// The arena's building blocks (three.js): the materials its light is drawn with, and its particles.
// arena3d.js puts them on the stage and moves them through the beats.
import * as THREE from "three";

export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
export const ease = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
// Moves `cur` toward `to` at a rate that doesn't depend on the frame rate.
export const damp = (cur, to, rate, dt) => cur + (to - cur) * (1 - Math.exp(-rate * dt));
// 0 before `a`, 1 after `b`, smooth between.
export const span = (x, a, b) => smooth((x - a) / (b - a));

export function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.2, "rgba(255,255,255,.55)"); r.addColorStop(0.5, "rgba(255,255,255,.12)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Value noise, shared by the shaders below.
const NOISE = `
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`;
const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

// ---------- flat light: the lock field, the reticle, the vote gauge ----------
// u runs round a ring from the top, clockwise; v across it. uDraw sweeps it in, uFill lights a share of it in
// uFillColor, and a highlight runs round it.
const HOLO_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HOLO_FRAG = `
uniform vec3 uColor, uFillColor; uniform float uOpacity, uDraw, uFill, uTime, uSpin;
varying vec2 vUv;
void main() {
  if (vUv.x > uDraw) discard;
  float run = pow(fract(vUv.x - uTime * uSpin), 10.0);
  bool filled = vUv.x < uFill;
  vec3 c = filled ? uFillColor * 1.6 : uColor;
  gl_FragColor = vec4(c * (1.0 + 1.2 * run), uOpacity * (filled ? 1.0 : 0.6) * (0.8 + 0.5 * run));
  #include <colorspace_fragment>
}`;
export function holoMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uFillColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uDraw: { value: 1 }, uFill: { value: 0 }, uTime: { value: 0 }, uSpin: { value: 0.08 } },
    vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG, side: THREE.DoubleSide, ...additive,
  });
}

// ---------- the brain, as light: it forms from the bottom up, its folds catch the light at the edges, and
// thoughts flare across it while it works ----------
const BRAIN_VERT = `
varying vec3 vN, vV, vL;
void main() {
  vL = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = -mv.xyz; vN = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}`;
const BRAIN_FRAG = `
uniform vec3 uColor; uniform float uTime, uReveal, uOpacity, uThink;
varying vec3 vN, vV, vL;
${NOISE}
void main() {
  float edge = uReveal * 1.9 - (vL.y + 0.95);
  if (edge < 0.0) discard;
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  float grain = noise3(vL * 9.0 + vec3(0.0, uTime * 0.5, 0.0));
  float fire = smoothstep(0.66, 0.92, noise3(vL * 3.2 + vec3(-uTime * 0.9, uTime * 0.3, uTime * 0.5))) * uThink;
  float line = 1.0 - smoothstep(0.0, 0.05, edge);
  vec3 c = uColor * (0.1 + 1.5 * rim + 0.18 * grain + 2.2 * fire) + vec3(0.9, 0.95, 1.0) * line * 1.4;
  gl_FragColor = vec4(c, uOpacity * (0.16 + 0.85 * rim + 0.7 * fire + line));
  #include <colorspace_fragment>
}`;
export function brainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uReveal: { value: 0 }, uOpacity: { value: 0 }, uThink: { value: 0 } },
    vertexShader: BRAIN_VERT, fragmentShader: BRAIN_FRAG, ...additive,
  });
}

// ---------- lines with pulses running along them: the brain's wiring, the vote's network ----------
// Each segment carries aT (0 at its start, 1 at its end) and a phase; uDraw grows the network in.
const PULSE_VERT = `
attribute float aT, aPhase; varying float vT, vPhase;
void main() { vT = aT; vPhase = aPhase; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PULSE_FRAG = `
uniform vec3 uColor; uniform float uTime, uOpacity, uDraw, uSpeed;
varying float vT, vPhase;
void main() {
  if (vPhase > uDraw) discard;
  float pulse = pow(fract(vT - uTime * uSpeed + vPhase * 7.0), 9.0);
  gl_FragColor = vec4(uColor * (1.0 + 2.0 * pulse), uOpacity * (0.16 + 0.95 * pulse));
  #include <colorspace_fragment>
}`;
export function pulseLines(segments) {
  const pos = new Float32Array(segments.length * 6), t = new Float32Array(segments.length * 2), ph = new Float32Array(segments.length * 2);
  segments.forEach(([a, b, phase], i) => {
    pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    t.set([0, 1], i * 2);
    ph.set([phase, phase], i * 2);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aT", new THREE.BufferAttribute(t, 1));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(ph, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uOpacity: { value: 0 }, uDraw: { value: 1 }, uSpeed: { value: 0.9 } },
    vertexShader: PULSE_VERT, fragmentShader: PULSE_FRAG, ...additive,
  });
  return new THREE.LineSegments(geo, mat);
}

// ---------- a path drawn in along its length, with pulses running down it (the bid, the swap) ----------
const PATH_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PATH_FRAG = `
uniform vec3 uColor; uniform float uTime, uDraw, uOpacity, uDir;
varying vec2 vUv;
void main() {
  if (vUv.x > uDraw) discard;
  float along = uDir > 0.0 ? vUv.x : 1.0 - vUv.x;
  float pulse = pow(fract(along * 2.4 - uTime * 0.9), 7.0);
  float ends = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.95, vUv.x);
  gl_FragColor = vec4(uColor * (1.0 + pulse * 1.2), (0.45 + 0.9 * pulse) * ends * uOpacity);
  #include <colorspace_fragment>
}`;
export function pathMaterial(opacity = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uDraw: { value: 0 }, uOpacity: { value: opacity }, uDir: { value: 1 } },
    vertexShader: PATH_VERT, fragmentShader: PATH_FRAG, ...additive,
  });
}

// ---------- a coin that can burn away: points facing `uDir` go first, along a ragged, glowing front ----------
// dissolveKey() below is the same sum in JS: the dust's launch times follow it, so the dust leaves as the metal goes.
const KEY = `float dkey(vec3 p, vec3 dir) { return 0.5 - 0.42 * dot(p.xy, dir.xy) + 0.16 * (noise3(p * 7.0) - 0.5); }`;
export const dissolveKey = (p, dir) => 0.5 - 0.42 * (p.x * dir.x + p.y * dir.y) + 0.16 * (Math.random() - 0.5);
export function dissolvable(material, uniforms) {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDis;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvDis = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vDis; uniform float uDissolve; uniform vec3 uDir, uEdge;\n${NOISE}\n${KEY}`)
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
        if (uDissolve > 0.0) {
          float d = dkey(vDis, uDir) - uDissolve;
          if (d < 0.0) discard;
          gl_FragColor.rgb += uEdge * (1.0 - smoothstep(0.0, 0.07, d)) * 6.0;
        }`);
  };
  material.customProgramCacheKey = () => "dissolve";
}

// ---------- the merge's dust: thousands of points off the target's surface, in its own colours, that leave as
// the metal burns away and fly down the bid's path into the winner. All of it is worked out on the GPU. ----------
const DUST_VERT = `
attribute vec3 aStart, aColor; attribute vec4 aSeed; attribute float aLaunch;
uniform mat4 uFrom; uniform vec3 uTo, uMid; uniform float uTime, uTravel, uScale, uSize;
varying vec3 vColor; varying float vAlpha;
void main() {
  vec3 p0 = (uFrom * vec4(aStart, 1.0)).xyz;
  float life = uTravel * (0.7 + 0.6 * aSeed.x);
  float u = clamp((uTime - aLaunch) / life, 0.0, 1.0);
  float e = u * u * (3.0 - 2.0 * u);
  vec3 j = aSeed.yzw - 0.5;
  vec3 puff = p0 + normalize(j + vec3(0.0, 0.0, 0.4)) * 0.45 * smoothstep(0.0, 0.3, u);
  vec3 mid = uMid + j * 1.5;
  vec3 p = mix(mix(puff, mid, e), mix(mid, uTo + j * 0.3, e), e);
  float a = u * 10.0 + aSeed.x * 6.2832;
  p += vec3(cos(a), sin(a), cos(a * 0.7)) * 0.22 * sin(u * 3.14159);
  float on = step(aLaunch, uTime);
  vColor = aColor * (1.0 + 2.4 * (1.0 - u));
  vAlpha = on * smoothstep(0.0, 0.04, u) * (1.0 - smoothstep(0.86, 1.0, u));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * (0.5 + aSeed.w) * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const DOT_FRAG = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  gl_FragColor = vec4(vColor, smoothstep(0.5, 0.0, d) * vAlpha);
  #include <colorspace_fragment>
}`;
export function makeDust(count) {
  const geo = new THREE.BufferGeometry();
  const attr = (name, size) => geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * size), size));
  attr("position", 3); attr("aStart", 3); attr("aColor", 3); attr("aSeed", 4); attr("aLaunch", 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uFrom: { value: new THREE.Matrix4() }, uTo: { value: new THREE.Vector3() }, uMid: { value: new THREE.Vector3() }, uTime: { value: -1 }, uTravel: { value: 1.2 }, uScale: { value: 300 }, uSize: { value: 0.5 } },
    // Laid over, not added: the dust keeps the colours of the picture it came from.
    vertexShader: DUST_VERT, fragmentShader: DOT_FRAG, transparent: true, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return {
    points,
    // Scatters the points over a coin: `sample(i)` gives [x, y, z] on a unit coin and its colour.
    fill(sample, launchAt) {
      const s = geo.attributes.aStart.array, c = geo.attributes.aColor.array, seed = geo.attributes.aSeed.array, l = geo.attributes.aLaunch.array;
      for (let i = 0; i < count; i++) {
        const [p, col] = sample(i);
        s.set(p, i * 3); c.set([col.r, col.g, col.b], i * 3);
        seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
        l[i] = launchAt(p);
      }
      for (const k of ["aStart", "aColor", "aSeed", "aLaunch"]) geo.attributes[k].needsUpdate = true;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ---------- small particles, worked out on the CPU: bursts, and streams into (or bouncing off) a point ----------
const SPARK_VERT = `
attribute float aSize; attribute float aAlpha; varying vec3 vColor; varying float vAlpha; uniform float uScale;
void main() {
  vColor = color; vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
export function makeSparks(N) {
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 300 } }, vertexShader: SPARK_VERT, fragmentShader: DOT_FRAG, vertexColors: true, ...additive });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const P = Array.from({ length: N }, () => ({ live: false, p: new THREE.Vector3(), v: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), bend: new THREE.Vector3(), c: new THREE.Color() }));
  let next = 0;
  const take = () => { for (let n = 0; n < N; n++) { const o = P[(next + n) % N]; if (!o.live) { next = (next + n + 1) % N; return o; } } return null; };
  const rnd = new THREE.Vector3();
  const sphere = (r) => rnd.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(r);
  return {
    points,
    clear() { for (const o of P) o.live = false; },
    // Out from a point in every direction, slowing down.
    burst(at, colors, n, speed = 4, sizeK = 1) {
      for (let k = 0; k < n; k++) {
        const o = take(); if (!o) return;
        Object.assign(o, { live: true, kind: "burst", age: 0, delay: 0, life: 0.6 + Math.random() * 1.1, size: (0.5 + Math.random() * 1.4) * sizeK });
        o.p.copy(at); o.v.copy(sphere(speed * (0.3 + Math.random()))); o.c.copy(colors[k % colors.length]);
      }
    },
    // In toward `to`, from round it (or from `from`), over `spread` seconds. `stop` > 0 turns them back at that
    // distance from `to`, as if they hit a wall.
    stream(to, color, n, { from = null, spread = 1.2, stop = 0, radius = 3.4, bend = 1.1, life = 0.9, sizeK = 1 } = {}) {
      for (let k = 0; k < n; k++) {
        const o = take(); if (!o) return;
        Object.assign(o, { live: true, kind: "seek", age: 0, delay: Math.random() * spread, life: life + Math.random() * 0.6, size: (0.6 + Math.random() * 1.1) * sizeK, stop });
        if (from) o.from.copy(from).add(sphere(0.25)); else o.from.copy(to).add(sphere(radius)).setZ(to.z + Math.abs(o.from.z - to.z) * 0.6);
        o.to.copy(to); o.bend.copy(sphere(bend)); o.p.copy(o.from); o.c.copy(color);
      }
    },
    update(dt) {
      for (let i = 0; i < N; i++) {
        const o = P[i];
        let a = 0;
        if (o.live) {
          if (o.delay > 0) o.delay -= dt;
          else {
            o.age += dt;
            const u = o.age / o.life;
            if (u >= 1) o.live = false;
            else if (o.kind === "burst") { o.v.multiplyScalar(Math.exp(-2.6 * dt)); o.p.addScaledVector(o.v, dt); a = 1 - u; }
            else {
              const e = u * u;
              o.p.lerpVectors(o.from, o.to, e).addScaledVector(o.bend, Math.sin(u * Math.PI) * 0.6);
              a = Math.min(1, u * 4) * (1 - e * 0.3);
              if (o.stop && o.p.distanceTo(o.to) < o.stop) {
                Object.assign(o, { kind: "burst", age: 0, life: 0.7 });
                o.v.subVectors(o.p, o.to).normalize().multiplyScalar(1.4 + Math.random());
                o.c.multiplyScalar(0.6);
              }
            }
          }
        }
        pos[i * 3] = o.p.x; pos[i * 3 + 1] = o.p.y; pos[i * 3 + 2] = o.p.z;
        col[i * 3] = o.c.r; col[i * 3 + 1] = o.c.g; col[i * 3 + 2] = o.c.b;
        size[i] = o.size || 0; alpha[i] = a;
      }
      for (const k of ["position", "color", "aSize", "aAlpha"]) geo.attributes[k].needsUpdate = true;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ---------- the room: dust hanging in the air, a shaft of light, and the dark behind ----------
const MOTE_VERT = `
attribute vec4 aSeed; uniform float uTime, uScale; varying float vAlpha;
void main() {
  vec3 p = position + vec3(sin(uTime * 0.11 + aSeed.x * 6.28), sin(uTime * 0.07 + aSeed.y * 6.28) * 0.6, cos(uTime * 0.09 + aSeed.z * 6.28)) * 0.35;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vAlpha = (0.25 + 0.75 * aSeed.w) * (0.55 + 0.45 * sin(uTime * 0.8 + aSeed.x * 40.0));
  gl_PointSize = (0.6 + aSeed.w * 1.2) * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const MOTE_FRAG = `
uniform vec3 uColor; uniform float uOpacity; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * vAlpha * uOpacity);
  #include <colorspace_fragment>
}`;
export function makeMotes(n, box) {
  const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    pos.set([(Math.random() - 0.5) * box.x, (Math.random() - 0.5) * box.y, (Math.random() - 0.5) * box.z - 1], i * 3);
    seed.set([Math.random(), Math.random(), Math.random(), Math.random() ** 3], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
  const mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uScale: { value: 300 }, uColor: { value: new THREE.Color() }, uOpacity: { value: 0.5 } }, vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG, ...additive });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

// A cone of light from above: brightest down its middle, gone at its edges and toward its foot.
const SHAFT_VERT = `
varying vec2 vUv; varying vec3 vN, vV;
void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`;
const SHAFT_FRAG = `
uniform vec3 uColor; uniform float uOpacity, uTime;
varying vec2 vUv; varying vec3 vN, vV;
${NOISE}
void main() {
  float face = pow(abs(dot(normalize(vN), normalize(vV))), 2.2);
  float foot = smoothstep(0.0, 0.55, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
  float haze = 0.75 + 0.25 * noise3(vec3(vUv.x * 9.0, vUv.y * 3.0 - uTime * 0.15, uTime * 0.1));
  gl_FragColor = vec4(uColor, uOpacity * face * foot * haze);
  #include <colorspace_fragment>
}`;
export function makeShaft() {
  const geo = new THREE.CylinderGeometry(0.25, 2.6, 10, 48, 1, true);
  geo.translate(0, -5, 0); // the apex at the origin, the cone hanging down from it
  const mat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uTime: { value: 0 } }, vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG, side: THREE.DoubleSide, ...additive });
  return new THREE.Mesh(geo, mat);
}

// The dark the scene floats in: a little lighter low and behind the coins, darker overhead and underfoot.
const SKY_VERT = `varying vec3 vD; void main() { vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = `
uniform vec3 uBase, uGlow; varying vec3 vD;
void main() {
  float glow = pow(max(dot(vD, normalize(vec3(0.0, -0.05, -1.0))), 0.0), 3.0);
  float up = smoothstep(0.0, 0.9, abs(vD.y));
  gl_FragColor = vec4(mix(uBase + uGlow * glow, uBase * 0.55, up), 1.0);
  #include <colorspace_fragment>
}`;
export function makeSky() {
  const mat = new THREE.ShaderMaterial({ uniforms: { uBase: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() } }, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(80, 32, 16), mat);
  sky.renderOrder = -1;
  return sky;
}
