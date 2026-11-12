// The arena's 3D scene (three.js). Coins are metal tokens floating in space, sized by market cap; a bid
// is a glowing arc; a takeover pulls the target down the arc into the winner in a burst of particles.
// It plays a replay from replay.js beat by beat and moves the page's own HTML labels and speech bubble
// over the coins every frame. Drag turns it; a click on a coin is handed back to the page.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { hue } from "@/lib/chain";
import { durationOf } from "./replay";

const TRAVEL = 0.5; // seconds into the merge beat when the target starts down the arc
const IMPACT = 1.9; // ...and when it reaches the winner
const FOV = 32;
const PARTICLES = 900;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
// Moves `cur` toward `to` at a rate that doesn't depend on the frame rate.
const damp = (cur, to, rate, dt) => cur + (to - cur) * (1 - Math.exp(-rate * dt));

// ---------- textures, all drawn on canvases ----------
function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.22, "rgba(255,255,255,.5)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// The reeded edge of a coin, as a bump map.
function reedTexture() {
  const c = document.createElement("canvas"); c.width = 32; c.height = 2;
  const g = c.getContext("2d");
  for (let x = 0; x < 32; x++) { const v = Math.round(128 + 127 * Math.sin((x / 32) * Math.PI * 2)); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, 2); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(110, 1);
  return t;
}
// A coin face: the coin's colours, a milled band, and its picture (or its letters) in the middle.
function drawFace(canvas, symbol, img) {
  const S = canvas.width, g = canvas.getContext("2d"), h = hue(symbol), m = S / 2;
  g.clearRect(0, 0, S, S);
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, `hsl(${h} 70% 58%)`); bg.addColorStop(1, `hsl(${h + 24} 72% 36%)`);
  g.fillStyle = bg; g.beginPath(); g.arc(m, m, m, 0, Math.PI * 2); g.fill();
  g.save(); g.translate(m, m);
  for (let k = 0; k < 144; k++) { g.rotate((Math.PI * 2) / 144); g.fillStyle = k % 2 ? "rgba(255,255,255,.28)" : "rgba(0,0,0,.2)"; g.fillRect(-S * 0.006, -S * 0.445, S * 0.012, S * 0.05); }
  g.restore();
  const R = S * 0.37;
  g.save(); g.beginPath(); g.arc(m, m, R, 0, Math.PI * 2); g.clip();
  if (img) {
    const k = Math.max((2 * R) / img.width, (2 * R) / img.height);
    g.drawImage(img, m - (img.width * k) / 2, m - (img.height * k) / 2, img.width * k, img.height * k);
  } else {
    g.fillStyle = "rgba(0,0,0,.12)"; g.fillRect(0, 0, S, S);
    g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `600 ${S * 0.26}px ${getComputedStyle(document.body).getPropertyValue("--font-pixel") || "system-ui"}`;
    g.fillText(String(symbol).slice(0, 2).toUpperCase(), m, m + S * 0.015);
  }
  g.restore();
  g.lineWidth = S * 0.014; g.strokeStyle = "rgba(255,255,255,.6)"; g.beginPath(); g.arc(m, m, R + S * 0.007, 0, Math.PI * 2); g.stroke();
  g.lineWidth = S * 0.006; g.strokeStyle = "rgba(0,0,0,.25)"; g.beginPath(); g.arc(m, m, R + S * 0.022, 0, Math.PI * 2); g.stroke();
}

// ---------- shaders ----------
const ARC_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// A line that draws itself in along its length, with bright pulses running from bidder to target.
const ARC_FRAG = `
uniform vec3 uColor; uniform float uTime, uDraw, uFade, uAlpha;
varying vec2 vUv;
void main() {
  if (vUv.x > uDraw) discard;
  float pulse = pow(fract(vUv.x * 2.2 - uTime * 0.85), 7.0);
  float ends = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
  gl_FragColor = vec4(uColor * (1.0 + pulse * 0.8), (0.5 + 0.9 * pulse) * ends * uFade * uAlpha);
  #include <colorspace_fragment>
}`;
const DOT_VERT = `
attribute float aSize; attribute float aAlpha; varying vec3 vColor; varying float vAlpha; uniform float uScale;
void main() {
  vColor = color; vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const DOT_FRAG = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  gl_FragColor = vec4(vColor, smoothstep(0.5, 0.05, d) * vAlpha);
  #include <colorspace_fragment>
}`;

// ---------- particles: bursts, and streams that fly into a coin ----------
function makeParticles() {
  const pos = new Float32Array(PARTICLES * 3), col = new Float32Array(PARTICLES * 3), size = new Float32Array(PARTICLES), alpha = new Float32Array(PARTICLES);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 300 } }, vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, vertexColors: true, transparent: true, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const P = Array.from({ length: PARTICLES }, () => ({ live: false, p: new THREE.Vector3(), v: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), bend: new THREE.Vector3(), c: new THREE.Color() }));
  let next = 0;
  const take = () => { for (let n = 0; n < PARTICLES; n++) { const o = P[(next + n) % PARTICLES]; if (!o.live) { next = (next + n + 1) % PARTICLES; return o; } } return null; };
  const rnd = new THREE.Vector3();
  const sphere = (r) => rnd.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(r);
  return {
    points,
    clear() { for (const o of P) o.live = false; },
    // Out from a point in every direction, slowing down.
    burst(at, colors, n, speed = 4) {
      for (let k = 0; k < n; k++) {
        const o = take(); if (!o) return;
        Object.assign(o, { live: true, kind: "burst", age: 0, delay: 0, life: 0.7 + Math.random() * 1.1, size: 0.6 + Math.random() * 1.6 });
        o.p.copy(at); o.v.copy(sphere(speed * (0.3 + Math.random()))); o.c.copy(colors[k % colors.length]);
      }
    },
    // In toward `to` from all around it (or from `from`), over `spread` seconds. `stop` > 0 bounces them off a ring of that radius.
    stream(to, color, n, { from = null, spread = 1.2, stop = 0, radius = 3.4 } = {}) {
      for (let k = 0; k < n; k++) {
        const o = take(); if (!o) return;
        Object.assign(o, { live: true, kind: "seek", age: 0, delay: Math.random() * spread, life: 0.8 + Math.random() * 0.6, size: 0.7 + Math.random() * 1.2, stop });
        if (from) o.from.copy(from).add(sphere(0.35)); else o.from.copy(to).add(sphere(radius)).setZ(to.z + Math.abs(o.from.z - to.z) * 0.6);
        o.to.copy(to); o.bend.copy(sphere(1.1)); o.p.copy(o.from); o.c.copy(color);
      }
    },
    update(dt) {
      for (let i = 0; i < PARTICLES; i++) {
        const o = P[i];
        let a = 0;
        if (o.live) {
          if (o.delay > 0) o.delay -= dt;
          else {
            o.age += dt;
            const u = o.age / o.life;
            if (u >= 1) o.live = false;
            else if (o.kind === "burst") {
              o.v.multiplyScalar(Math.exp(-2.6 * dt)); o.p.addScaledVector(o.v, dt); a = 1 - u;
            } else {
              const e = u * u;
              o.p.lerpVectors(o.from, o.to, e).addScaledVector(o.bend, Math.sin(u * Math.PI) * 0.6);
              a = Math.min(1, u * 4) * (1 - e * 0.3);
              // Turned away at the ring: bounce back out and fade.
              if (o.stop && o.p.distanceTo(o.to) < o.stop) {
                Object.assign(o, { kind: "burst", age: 0, life: 0.6 });
                o.v.subVectors(o.p, o.to).normalize().multiplyScalar(1.6 + Math.random());
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

/**
 * Builds the scene in `host` (which holds a <canvas>) and starts playing `replay` at beat `start`.
 * labels: Map of coin id -> HTML element placed under that coin. bubble: element placed over the speaking coin.
 * Throws if WebGL isn't available.
 */
export function createArena(host, replay, { calm, start = 0, labels, bubble, onBeat, onPick, iconOf, theme }) {
  const canvas = host.querySelector("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 700 ? 1.75 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  scene.environment = env;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(3, 5, 7); scene.add(key);
  const rim = new THREE.PointLight(0xffffff, 30, 20, 2); rim.position.set(-2, 2, -4); scene.add(rim);
  const world = new THREE.Group(); scene.add(world);
  const disposables = [env, pmrem];
  const keep = (x) => { disposables.push(x); return x; };

  const glow = keep(glowTexture());
  const reeds = keep(reedTexture());
  const C = { primary: new THREE.Color(), up: new THREE.Color(), down: new THREE.Color(), muted: new THREE.Color(), fg: new THREE.Color() };
  let dark = true;

  // ---------- coins ----------
  const B = replay.beats, last = B.length - 1;
  const at = (kind) => B.findIndex((b) => b.kind === kind);
  const iOffer = at("offer"), iMerge = at("merge"), iPassed = at("passed"), iLate = at("late");
  const iLock = at("lock") >= 0 ? at("lock") : iOffer;
  const maxCap = Math.max(...replay.coins.map((c) => Math.max(c.cap, c.before)), 1e-9);
  const radius = (cap) => Math.min(1.2, Math.max(0.48, 1.2 * Math.sqrt(cap / maxCap)));
  const COIN = keep(new THREE.CylinderGeometry(1, 1, 0.16, 96, 1).rotateX(Math.PI / 2));
  const LIP = keep(new THREE.TorusGeometry(0.95, 0.055, 16, 96));
  const coins = replay.coins.map((c, n) => {
    const h = hue(c.symbol);
    const faceCanvas = document.createElement("canvas"); faceCanvas.width = faceCanvas.height = 512;
    drawFace(faceCanvas, c.symbol, null);
    const front = keep(new THREE.CanvasTexture(faceCanvas)); front.colorSpace = THREE.SRGBColorSpace; front.anisotropy = 4;
    front.center.set(0.5, 0.5); front.rotation = -Math.PI / 2;
    const back = keep(front.clone()); back.rotation = Math.PI / 2; back.repeat.set(-1, 1);
    const metal = new THREE.Color().setHSL(((h + 12) % 360) / 360, 0.5, 0.62);
    const edge = keep(new THREE.MeshStandardMaterial({ color: metal, metalness: 1, roughness: 0.32, bumpMap: reeds, bumpScale: 1.5 }));
    const lipMat = keep(new THREE.MeshStandardMaterial({ color: metal, metalness: 1, roughness: 0.22 }));
    // A soft lacquer: shiny enough to catch the light, not so shiny that the picture washes out as it turns.
    const faceMat = (map) => keep(new THREE.MeshPhysicalMaterial({ map, metalness: 0.15, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.35, envMapIntensity: 0.7 }));
    const body = new THREE.Mesh(COIN, [edge, faceMat(front), faceMat(back)]);
    body.userData.id = c.id;
    const spin = new THREE.Group();
    spin.add(body);
    for (const z of [0.08, -0.08]) { const lip = new THREE.Mesh(LIP, lipMat); lip.position.z = z; spin.add(lip); }
    const halo = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glow, transparent: true, depthWrite: false, toneMapped: false })));
    halo.position.z = -0.4;
    const group = new THREE.Group();
    group.add(halo, spin);
    world.add(group);
    // Put the coin's picture on its faces, once the icon list knows it and the image has loaded.
    const paint = () => {
      const src = iconOf?.(c.symbol);
      if (!src || paint.src === src) return;
      paint.src = src;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { drawFace(faceCanvas, c.symbol, img); front.needsUpdate = back.needsUpdate = true; invalidate(); };
      img.src = src;
    };
    return { ...c, h, group, spin, body, halo, paint, base: new THREE.Vector3(), s: radius(c.before), sv: 0, phase: n * 1.7, awake: 0, hover: 0, hue: new THREE.Color(`hsl(${h}, 70%, 56%)`) };
  });
  coins.forEach((c) => c.paint());
  const byId = new Map(coins.map((c) => [c.id, c]));
  const W = byId.get(replay.winner), T = byId.get(replay.target);

  // ---------- the bid's arc, the scan rings, the lock ring, the shockwave, the stars ----------
  const arcU = { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uDraw: { value: 0 }, uFade: { value: 0 } };
  const arcMat = (alpha) => keep(new THREE.ShaderMaterial({ uniforms: { ...arcU, uAlpha: { value: alpha } }, vertexShader: ARC_VERT, fragmentShader: ARC_FRAG, transparent: true, depthWrite: false }));
  const arcCore = new THREE.Mesh(undefined, arcMat(1)), arcGlow = new THREE.Mesh(undefined, arcMat(0.22));
  world.add(arcCore, arcGlow);
  let curve = null;
  const comet = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glow, transparent: true, depthWrite: false, toneMapped: false })));
  comet.scale.setScalar(0.55);
  world.add(comet);

  const RING = keep(new THREE.RingGeometry(0.97, 1, 128));
  const scans = [0, 1, 2].map(() => { const m = new THREE.Mesh(RING, keep(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }))); world.add(m); return m; });
  const wave = new THREE.Mesh(keep(new THREE.RingGeometry(0.9, 1, 128)), keep(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })));
  world.add(wave);
  const circle = keep(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 129 }, (_, k) => new THREE.Vector3(Math.cos((k / 128) * Math.PI * 2), Math.sin((k / 128) * Math.PI * 2), 0))));
  const lockRing = new THREE.Line(circle, keep(new THREE.LineDashedMaterial({ dashSize: 0.07, gapSize: 0.05, transparent: true, toneMapped: false })));
  lockRing.computeLineDistances();
  world.add(lockRing);

  const starGeo = keep(new THREE.BufferGeometry());
  const stars = new Float32Array(700 * 3);
  for (let k = 0; k < 700; k++) {
    const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(14 + Math.random() * 26);
    stars.set([v.x, v.y, v.z], k * 3);
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(stars, 3));
  const starMat = keep(new THREE.PointsMaterial({ size: 0.16, map: glow, transparent: true, depthWrite: false, toneMapped: false, sizeAttenuation: true }));
  const starField = new THREE.Points(starGeo, starMat);
  world.add(starField);

  const fx = makeParticles();
  world.add(fx.points);

  // ---------- layout: the two coins in the deal up front, everyone else further back, under the arc ----------
  let tall = null;
  function layout(aspect) {
    const isTall = aspect < 1.15;
    if (isTall !== tall) {
      tall = isTall;
      W.base.set(...(tall ? [-0.95, 0.55, 0] : [-1.95, 0.3, 0]));
      T.base.set(...(tall ? [1.05, -1.0, 0.5] : [2.05, 0.05, 0.45]));
      coins.filter((c) => c !== W && c !== T).forEach((c, k, rest) => {
        const u = (k + 0.5) / rest.length;
        if (tall) c.base.set(k % 2 ? -1.3 : 1.3, k % 2 ? -1.9 : 1.1, -3 - k * 0.4);
        else c.base.set(rest.length === 1 ? 0.3 : -3.4 + u * 7.4, -0.95 + 0.35 * Math.sin(k * 2.1), -3.6 - (k % 2) * 1.2);
      });
      const mid = new THREE.Vector3().addVectors(W.base, T.base).multiplyScalar(0.5);
      curve = new THREE.QuadraticBezierCurve3(W.base.clone(), mid.add(new THREE.Vector3(0, 1.5 + W.base.distanceTo(T.base) * 0.1, 0.9)), T.base.clone());
      for (const m of [arcCore, arcGlow]) m.geometry?.dispose();
      arcCore.geometry = new THREE.TubeGeometry(curve, 120, 0.022, 8);
      arcGlow.geometry = new THREE.TubeGeometry(curve, 120, 0.075, 10);
    }
    const f = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    if (tall && narrow) {
      // On a phone the brain's words are pinned at the top and the caption sits at the bottom: the coins
      // (about 3.9 units tall) go in the band between, which is about 43% of the height, a little below the middle.
      camera.position.set(0, 0.4, 4.5 / f);
      camera.lookAt(0, 0.3, 0);
      return;
    }
    // Far enough back that the whole deal fits, whatever the shape of the box.
    const [hw, hh] = tall ? [2.75, 3.0] : [4.5, 2.55];
    camera.position.set(0, 0.4, Math.max(hh / f, hw / (f * aspect)));
    camera.lookAt(0, tall ? -0.2 : -0.45, 0);
  }

  // ---------- theme ----------
  function setTheme(colors, isDark) {
    dark = isDark;
    for (const k of Object.keys(C)) C[k].set(colors[k]);
    const blend = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    for (const m of [arcCore.material, arcGlow.material, comet.material, fx.points.material, starMat, wave.material, ...scans.map((s) => s.material), ...coins.map((c) => c.halo.material)]) { m.blending = blend; m.needsUpdate = true; }
    starMat.color.copy(C.muted); starMat.opacity = dark ? 0.75 : 0.5;
    comet.material.color.copy(C.primary);
    rim.color.copy(C.primary);
    invalidate();
  }

  // ---------- the clock ----------
  const durs = B.map((b, k) => durationOf(b, k === last) / 1000);
  let k = Math.min(Math.max(start, 0), last), t = calm ? durs[k] : 0, time = 0, playing = !calm, fired = new Set();
  let shake = 0, flash = 0, leaving = false;
  function enter(n) { k = n; t = calm ? durs[k] : 0; fired = new Set(); onBeat?.(k); invalidate(); }
  const once = (name, when, fn) => { if (!calm && t >= when && !fired.has(name)) { fired.add(name); fn(); } };

  // Effects that happen at a moment in a beat (not shown at all with reduced motion).
  function effects() {
    const b = B[k];
    const tPos = T.group.position;
    if (b.kind === "lock") once("in", 0.2, () => fx.stream(tPos, C.primary, 46, { spread: 1.4 }));
    if (b.kind === "late") once("in", 0.2, () => { fx.stream(tPos, C.muted, 40, { spread: 1.3, stop: T.s * 1.32 }); flash = 1; });
    if (b.kind === "vote") once("in", 0.2, () => fx.stream(tPos, b.yes === false ? C.down : C.up, 60, { spread: 1.4 }));
    if (b.kind === "passed") once("in", 0.3, () => fx.burst(tPos, [C.up], 40, 2.2));
    if (b.kind === "merge") once("hit", IMPACT, () => { fx.burst(W.base, [T.hue, C.up, C.primary], 300, 5); shake = 1; W.sv += 6; });
    if (b.kind === "swap") once("in", 0.3, () => fx.stream(W.base, T.hue, 70, { from: T.base, spread: 2.2 }));
  }

  // ---------- one frame ----------
  let yaw = 0, pitch = 0, vyaw = 0, lastTouch = -99, hovered = null;
  const pointer = new THREE.Vector2(), ray = new THREE.Raycaster();
  let wantHover = false;
  const v = new THREE.Vector3();
  let bw = 0, bh = 0, hostW = 0, hostH = 0, narrow = false;

  function frame(dt) {
    // Paused, a beat still plays through once and then holds on its last frame.
    if (!calm) {
      t += dt;
      if (t >= durs[k]) { if (playing) enter(k === last ? 0 : k + 1); else t = durs[k]; }
    }
    // How far into this beat we are, for the page's step bar.
    host.style.setProperty("--beat", Math.min(t / durs[k], 1).toFixed(3));
    time += calm ? 0 : dt;
    // With reduced motion everything jumps straight to where the beat puts it.
    const toward = (cur, to, rate) => (calm ? to : damp(cur, to, rate, dt));
    effects();

    // Where the beat puts things.
    const merging = k === iMerge, past = iMerge >= 0 && k > iMerge;
    const swallowed = past || (merging && t >= IMPACT);
    const travel = merging ? smooth((t - TRAVEL) / (IMPACT - TRAVEL)) : 0;
    leaving = merging && t > TRAVEL;
    for (const c of coins) {
      let target = radius(c.before);
      if (c === W && swallowed) target = radius(c.cap);
      if (c === T) target = swallowed ? 0 : radius(c.before) * (1 - 0.8 * travel);
      if (c === T && swallowed) { c.s = 0; c.sv = 0; }
      // A little spring, so a coin that grows overshoots and settles.
      if (calm) c.s = target;
      else { c.sv += ((target - c.s) * 70 - c.sv * 11) * dt; c.s += c.sv * dt; }
      c.hover = toward(c.hover, hovered === c ? 1 : 0, 10);
      const s = Math.max(c.s, 0) * (1 + 0.06 * c.hover);
      c.group.visible = s > 0.01;
      c.spin.scale.setScalar(s);
      if (c === T && travel > 0 && !swallowed) c.group.position.copy(curve.getPoint(1 - travel));
      else c.group.position.copy(c.base);
      c.group.position.y += calm ? 0 : Math.sin(time * 0.9 + c.phase) * 0.07;
      c.spin.rotation.y = calm ? -0.2 : Math.sin(time * 0.5 + c.phase) * 0.45 + (c === T ? travel * travel * 14 : 0);
      c.spin.rotation.x = calm ? 0.06 : Math.sin(time * 0.37 + c.phase) * 0.12;
      // Halo: faint in the coin's colour, bright while its brain is awake.
      const b = B[k];
      const awake = (c === W && (b.kind === "think" || b.kind === "offer")) || (c === T && b.kind === "stance") ? 1 : 0;
      c.awake = toward(c.awake, awake, 4);
      const tone = c === T && b.kind === "stance" && b.no ? C.down : C.primary;
      c.halo.material.color.copy(c.hue).lerp(tone, c.awake);
      c.halo.material.opacity = (dark ? 0.22 : 0.16) + c.awake * (dark ? 0.7 : 0.38);
      c.halo.scale.setScalar(s * (3 + c.awake * 0.8 + (c.awake > 0.5 ? Math.sin(time * 4) * 0.15 : 0)));
    }

    // The arc: drawn in with the bid, green once the vote passes, gone once the target is swallowed.
    const arcOn = iOffer >= 0 && k >= iOffer && (iMerge < 0 || k <= iMerge);
    arcU.uDraw.value = arcOn ? (k === iOffer ? (calm ? 1 : smooth((t - 0.3) / 1.1)) : 1) : 0;
    arcU.uFade.value = toward(arcU.uFade.value, arcOn ? (merging ? 1 - clamp01((t - IMPACT + 0.3) / 0.5) : 1) : 0, 6);
    const green = iPassed >= 0 && k >= iPassed ? (k === iPassed && !calm ? clamp01(t / 0.8) : 1) : 0;
    arcU.uColor.value.copy(C.primary).lerp(C.up, green);
    arcU.uTime.value = time;
    arcCore.visible = arcGlow.visible = arcU.uFade.value > 0.01;
    comet.visible = !calm && arcOn && arcU.uDraw.value >= 1 && !merging;
    if (comet.visible) {
      // A spark running along the arc, faded at both ends so it never washes out a coin.
      const u = (time * 0.45) % 1;
      comet.position.copy(curve.getPoint(u));
      comet.material.color.copy(arcU.uColor.value);
      comet.material.opacity = Math.sin(u * Math.PI) ** 1.5;
    }

    // Scan rings around a brain that's thinking.
    const thinker = ["think", "offer"].includes(B[k].kind) ? W : B[k].kind === "stance" ? T : null;
    scans.forEach((m, j) => {
      const ph = (time * 0.55 + j / 3) % 1;
      m.visible = !!thinker && !calm;
      if (!m.visible) return;
      m.position.copy(thinker.group.position);
      m.scale.setScalar(thinker.s * (1.15 + ph * 1.4));
      m.material.color.copy(thinker === T && B[k].no ? C.down : C.primary);
      m.material.opacity = (1 - ph) * 0.55 * thinker.awake;
    });

    // The lock ring: the target's holders have tokens locked, from the first lock until the merge.
    const locked = k >= iLock && !swallowed && T.s > 0.05;
    lockRing.visible = locked;
    if (locked) {
      flash = toward(flash, 0, 1.6);
      lockRing.position.copy(T.group.position);
      lockRing.scale.setScalar(T.s * 1.32);
      lockRing.rotation.z = calm ? 0 : time * 0.25;
      lockRing.material.color.copy(C.primary).lerp(C.down, k === iLate ? Math.max(flash, calm ? 1 : 0) : 0);
      lockRing.material.opacity = 0.85;
    }

    // The shockwave out of the winner as the target lands.
    const since = merging ? t - IMPACT : -1;
    wave.visible = !calm && since >= 0 && since < 1;
    if (wave.visible) { wave.position.copy(W.group.position); wave.scale.setScalar(W.s * (1.1 + since * 3.2)); wave.material.color.copy(C.up); wave.material.opacity = (1 - since) * 0.8; }

    starField.rotation.y = time * 0.008;
    fx.update(calm ? 0 : dt);

    // The view: drag to turn, inertia, then a slow drift back.
    if (!dragging) {
      yaw += vyaw * dt; vyaw = damp(vyaw, 0, 3, dt);
      if (performance.now() - lastTouch > 4000) { yaw = damp(yaw, calm ? 0 : Math.sin(time * 0.12) * 0.2, 0.8, dt); pitch = damp(pitch, 0, 0.8, dt); }
    }
    world.rotation.set(pitch, yaw, 0);
    shake = damp(shake, 0, 5, dt);
    const base = camera.position.clone();
    if (shake > 0.01) camera.position.add(v.set(Math.random() - 0.5, Math.random() - 0.5, 0).multiplyScalar(shake * 0.12));

    if (wantHover) { wantHover = false; hover(); }
    renderer.render(scene, camera);
    camera.position.copy(base);
    place();
  }

  // The page's labels under each coin, and the bubble over whoever is speaking.
  function place() {
    for (const c of coins) {
      const el = labels?.get(c.id);
      if (!el) continue;
      c.group.getWorldPosition(v);
      v.y -= Math.max(c.s, 0.3) + 0.2;
      v.project(camera);
      el.style.transform = `translate3d(${((v.x + 1) / 2) * hostW}px, ${((1 - v.y) / 2) * hostH}px, 0) translateX(-50%)`;
      el.style.opacity = c.group.visible && c.s > 0.2 && !(c === T && leaving) ? "1" : "0";
      el.classList.toggle("hot", hovered === c);
    }
    const b = B[k];
    if (!bubble || narrow) { if (bubble) bubble.style.transform = ""; return; }
    const c = byId.get(b.coin);
    if (!b.quote || !c) return;
    c.group.getWorldPosition(v);
    v.y += c.s + 0.25;
    v.project(camera);
    const x = ((v.x + 1) / 2) * hostW, y = ((1 - v.y) / 2) * hostH;
    const left = Math.min(Math.max(x - bw / 2, 12), hostW - bw - 12);
    const top = Math.max(y - bh - 14, 56);
    bubble.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    bubble.style.setProperty("--tail", `${Math.min(Math.max(x - left, 22), bw - 22)}px`);
  }

  function hover() {
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(coins.filter((c) => c.group.visible).map((c) => c.body), false)[0];
    hovered = hit ? byId.get(hit.object.userData.id) : null;
    canvas.style.cursor = hovered ? "pointer" : "grab";
  }

  // ---------- input ----------
  let dragging = null;
  const toNdc = (e) => { const r = canvas.getBoundingClientRect(); pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  const down = (e) => { dragging = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, at: performance.now() }; vyaw = 0; canvas.setPointerCapture?.(e.pointerId); canvas.style.cursor = "grabbing"; };
  const move = (e) => {
    toNdc(e);
    if (!dragging) { wantHover = true; if (calm) invalidate(); return; }
    const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
    dragging.x = e.clientX; dragging.y = e.clientY;
    yaw += dx * 0.006; pitch = Math.min(0.45, Math.max(-0.45, pitch + dy * 0.004));
    vyaw = dx * 0.006 * 60;
    lastTouch = performance.now();
    invalidate();
  };
  const up = (e) => {
    if (!dragging) return;
    const still = Math.hypot(e.clientX - dragging.x0, e.clientY - dragging.y0) < 6;
    dragging = null;
    canvas.style.cursor = "grab";
    if (still) { toNdc(e); hover(); if (hovered) onPick?.(hovered.id); }
  };
  const cancel = () => { dragging = null; };
  const leave = () => { if (!dragging) { hovered = null; invalidate(); } };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("pointerleave", leave);
  canvas.style.cursor = "grab";

  // ---------- size, visibility, the loop ----------
  function resize() {
    hostW = host.clientWidth; hostH = host.clientHeight;
    narrow = matchMedia("(max-width: 640px)").matches;
    if (!hostW || !hostH) return;
    renderer.setSize(hostW, hostH, false);
    camera.aspect = hostW / hostH;
    camera.updateProjectionMatrix();
    layout(camera.aspect);
    // A size-1 particle is about 5 CSS pixels across at the coins' distance.
    fx.points.material.uniforms.uScale.value = 50 * renderer.getPixelRatio() * (hostH / 560);
    invalidate();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  const bo = bubble ? new ResizeObserver(() => { bw = bubble.offsetWidth; bh = bubble.offsetHeight; invalidate(); }) : null;
  bo?.observe(bubble);

  let raf = 0, pending = 0, visible = false, then = 0;
  const loop = (now) => { raf = requestAnimationFrame(loop); const dt = Math.min(0.05, (now - then) / 1000); then = now; frame(dt); };
  // With reduced motion nothing runs on its own: a frame is drawn only when something changes.
  function invalidate() { if (calm || !raf) { if (!pending) pending = requestAnimationFrame(() => { pending = 0; frame(0); }); } }
  function run() {
    const on = visible && !document.hidden && !calm;
    if (on && !raf) { then = performance.now(); raf = requestAnimationFrame(loop); }
    else if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  document.addEventListener("visibilitychange", run);

  setTheme(theme.colors, theme.dark);
  resize();
  enter(k);

  return {
    setVisible(on) { visible = on; run(); },
    setBeat(n) { fx.clear(); enter(n); },
    setPlaying(on) { playing = on && !calm; },
    setTheme({ colors, dark: d }) { setTheme(colors, d); },
    loadIcons() { coins.forEach((c) => c.paint()); },
    dispose() {
      cancelAnimationFrame(raf); cancelAnimationFrame(pending);
      ro.disconnect(); bo?.disconnect();
      document.removeEventListener("visibilitychange", run);
      for (const [ev, f] of [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", cancel], ["pointerleave", leave]]) canvas.removeEventListener(ev, f);
      arcCore.geometry?.dispose(); arcGlow.geometry?.dispose();
      fx.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}
