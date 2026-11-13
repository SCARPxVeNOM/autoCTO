// The arena's 3D scene (three.js): the latest takeover, filmed in nine beats. The coins are the metal tokens
// built in Blender (scripts/arena-assets.py), sized by market cap; brains, fields and the bid are drawn in light.
// Every frame is worked out from the beat and the time into it, so a jump, a pause or reduced motion all land on
// the same picture. Each beat has its own camera move, and the page's own HTML (labels, the brain's bubble, the
// beat's readout) is moved over the scene every frame.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import ASSETS from "@/assets/arena.glb?url";
import { hue } from "@/lib/chain";
import { durationOf } from "./replay";
import { brainMaterial, clamp01, damp, dissolvable, dissolveKey, ease, glowTexture, holoMaterial, makeDust, makeMotes, makeShaft, makeSky, makeSparks, pathMaterial, pulseLines, smooth, span } from "./arena-gl";

const FOV = 30;
// Phones and small machines get a lighter picture: no depth of field or shadows, fewer particles.
const LITE = matchMedia("(max-width: 640px), (pointer: coarse)").matches || (navigator.hardwareConcurrency || 8) <= 4;
const Q = LITE
  ? { dpr: 1.25, dof: false, shadows: false, dust: 4000, motes: 160, sparks: 1000, samples: 0 }
  : { dpr: 1.5, dof: true, shadows: true, dust: 14000, motes: 460, sparks: 1800, samples: 4 };
// The merge, in seconds into its beat: the approval runs down the bid to the winner, the winner leans in,
// the target burns away into dust that flies into the winner, its treasury follows, and the dust lands.
const M = { spark: [0.15, 0.8], lean: [0.5, 1.3], burn: [1.2, 2.8], treasury: 1.7, impact: 3.3 };
// The rival's brain weighs its three answers in turn, then gives one.
const WEIGH = [["accept", 1.9], ["counter", 2.6], ["reject", 3.3]], DECIDE = 4.0;
const LIGHT = 1; // the layer everything drawn in light lives on: left out of the depth of field's depth pass

const invSmooth = (y) => 0.5 - Math.sin(Math.asin(1 - 2 * clamp01(y)) / 3);
const lerp = (a, b, x) => a + (b - a) * x;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

let loading = null;
const loadAssets = () => (loading ||= new GLTFLoader().loadAsync(ASSETS).then((gltf) => {
  const geo = {};
  gltf.scene.traverse((o) => { if (o.isMesh) geo[o.name] = o.geometry; });
  return geo;
}));

// A coin face: the coin's colours, a milled band, and its picture (or its letters) in the middle.
function drawFace(canvas, symbol, img) {
  const S = canvas.width, g = canvas.getContext("2d"), h = hue(symbol), m = S / 2;
  g.clearRect(0, 0, S, S);
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, `hsl(${h} 46% 52%)`); bg.addColorStop(1, `hsl(${h + 18} 50% 30%)`);
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  g.save(); g.translate(m, m);
  for (let k = 0; k < 160; k++) { g.rotate((Math.PI * 2) / 160); g.fillStyle = k % 2 ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.24)"; g.fillRect(-S * 0.005, -S * 0.49, S * 0.01, S * 0.05); }
  g.restore();
  const R = S * 0.4;
  g.save(); g.beginPath(); g.arc(m, m, R, 0, Math.PI * 2); g.clip();
  if (img) {
    const k = Math.max((2 * R) / img.width, (2 * R) / img.height);
    g.drawImage(img, m - (img.width * k) / 2, m - (img.height * k) / 2, img.width * k, img.height * k);
  } else {
    g.fillStyle = "rgba(0,0,0,.14)"; g.fillRect(0, 0, S, S);
    g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `600 ${S * 0.28}px ${getComputedStyle(document.body).getPropertyValue("--font-pixel") || "system-ui"}`;
    g.fillText(String(symbol).slice(0, 2).toUpperCase(), m, m + S * 0.015);
  }
  g.restore();
  g.lineWidth = S * 0.016; g.strokeStyle = "rgba(255,255,255,.55)"; g.beginPath(); g.arc(m, m, R + S * 0.008, 0, Math.PI * 2); g.stroke();
  g.lineWidth = S * 0.008; g.strokeStyle = "rgba(0,0,0,.3)"; g.beginPath(); g.arc(m, m, R + S * 0.026, 0, Math.PI * 2); g.stroke();
}

/**
 * Builds the scene in `host` (which holds a <canvas>) and starts playing `replay` at beat `start`.
 * labels: Map of coin id -> HTML element placed under that coin. bubble: element placed over the speaking coin.
 * hud: element placed beside the beat's subject (its content is the page's). Resolves once the assets have
 * loaded; rejects if WebGL isn't available.
 */
export async function createArena(host, replay, { calm, start = 0, labels, bubble, hud, onBeat, onPick, iconOf, theme }) {
  const G = await loadAssets();
  const canvas = host.querySelector("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = Q.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.42;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
  camera.layers.enable(LIGHT);
  const disposables = [env, pmrem];
  const keep = (x) => { disposables.push(x); return x; };
  const lit = (o) => { o.traverse((x) => x.layers.set(LIGHT)); return o; };

  const glow = keep(glowTexture());
  const C = { primary: new THREE.Color(), up: new THREE.Color(), down: new THREE.Color(), muted: new THREE.Color(), fg: new THREE.Color(), warn: new THREE.Color(), bg: new THREE.Color() };

  // ---------- the room ----------
  const sky = makeSky(); keep(sky.geometry); keep(sky.material);
  scene.add(sky);
  scene.fog = new THREE.FogExp2(0x000000, 0.03);
  const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
  key.castShadow = Q.shadows;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
  key.shadow.radius = 5; key.shadow.bias = -0.0005;
  const fill = new THREE.DirectionalLight(0x9db2c7, 0.55);
  const rimL = new THREE.SpotLight(0xffffff, 40, 30, 0.7, 0.7, 1.6);
  const rimR = new THREE.SpotLight(0xe6edf5, 32, 30, 0.7, 0.7, 1.6);
  const brainLight = new THREE.PointLight(0xffffff, 0, 5, 2);
  const flash = new THREE.PointLight(0xffffff, 0, 14, 2);
  scene.add(key, key.target, fill, rimL, rimR, brainLight, flash);
  const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(60, 60)), keep(new THREE.ShadowMaterial({ opacity: 0.5 })));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  const pool = lit(new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)), keep(new THREE.MeshBasicMaterial({ map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))));
  pool.rotation.x = -Math.PI / 2;
  const shaft = lit(makeShaft()); keep(shaft.geometry); keep(shaft.material);
  const motes = lit(makeMotes(Q.motes, V(18, 9, 12))); keep(motes.geometry); keep(motes.material);
  const world = new THREE.Group();
  scene.add(floor, pool, shaft, motes, world);

  // ---------- coins: the Blender coin, its picture on both faces (and embossed), its rim and reeded edge in metal ----------
  const B = replay.beats, last = B.length - 1;
  const I = Object.fromEntries(["lock", "think", "offer", "late", "stance", "vote", "passed", "merge", "swap"].map((kind) => [kind, B.findIndex((b) => b.kind === kind)]));
  const beatOf = (kind) => (I[kind] >= 0 ? B[I[kind]] : {});
  const maxCap = Math.max(...replay.coins.map((c) => Math.max(c.cap, c.before)), 1e-9);
  const radius = (cap) => Math.min(1.2, Math.max(0.48, 1.2 * Math.sqrt(cap / maxCap)));
  const coins = replay.coins.map((c, n) => {
    const h = hue(c.symbol);
    const faceCanvas = document.createElement("canvas"); faceCanvas.width = faceCanvas.height = 512;
    drawFace(faceCanvas, c.symbol, null);
    const tex = keep(new THREE.CanvasTexture(faceCanvas));
    tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 8;
    const metal = new THREE.Color().setHSL(h / 360, 0.2, 0.6);
    const dis = { uDissolve: { value: 0 }, uDir: { value: V(-1, 0, 0) }, uEdge: { value: new THREE.Color() } };
    // The face is lacquered paint over metal, embossed by its own picture; the rim and edge are bare metal.
    const materials = () => ({
      face: keep(new THREE.MeshPhysicalMaterial({ map: tex, bumpMap: tex, bumpScale: 1.6, metalness: 0.35, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.2 })),
      rim: keep(new THREE.MeshPhysicalMaterial({ color: metal, metalness: 1, roughness: 0.26 })),
      edge: keep(new THREE.MeshPhysicalMaterial({ color: metal, metalness: 1, roughness: 0.34 })),
    });
    // The coin burns away in the merge; its small copies (the bid, the counter, the holders' coins) don't.
    const mats = materials(), plain = materials();
    for (const m of Object.values(mats)) dissolvable(m, dis);
    const parts = (scale = 1, { face, rim, edge } = mats) => {
      const g = new THREE.Group();
      for (const [geo, mat] of [[G.coin_face, face], [G.coin_rim, rim], [G.coin_edge, edge]]) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = Q.shadows; mesh.userData.id = c.id;
        g.add(mesh);
      }
      g.scale.setScalar(scale);
      return g;
    };
    const spin = parts();
    const halo = lit(new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))));
    halo.position.z = -0.5;
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
      img.onload = () => { drawFace(faceCanvas, c.symbol, img); tex.needsUpdate = true; invalidate(); };
      img.src = src;
    };
    return { ...c, h, group, spin, halo, parts, paint, faceCanvas, mats, plain, metal, dis, base: V(), s: radius(c.before), sv: 0, phase: n * 1.7, presence: 0.4, hover: 0, hue: new THREE.Color(`hsl(${h}, 62%, 58%)`) };
  });
  coins.forEach((c) => c.paint());
  const byId = new Map(coins.map((c) => [c.id, c]));
  const W = byId.get(replay.winner), T = byId.get(replay.target);
  const others = coins.filter((c) => c !== W && c !== T);
  const meshes = coins.flatMap((c) => c.spin.children);

  // ---------- brains: the Blender brain in light, wired with points on its surface ----------
  function makeBrain(owner) {
    const rig = new THREE.Group();
    const mat = keep(brainMaterial());
    const mesh = new THREE.Mesh(G.brain, mat);
    const sampler = new MeshSurfaceSampler(mesh).build();
    const pts = Array.from({ length: 140 }, () => { const p = V(); sampler.sample(p); return p.multiplyScalar(1.03); });
    const segs = [];
    pts.forEach((a, i) => pts.map((b, j) => [j, a.distanceToSquared(b)]).filter(([j]) => j !== i).sort((x, y) => x[1] - y[1]).slice(0, 2)
      .forEach(([j]) => { if (j > i) segs.push([a, pts[j], Math.random()]); }));
    const wires = pulseLines(segs); keep(wires.geometry); keep(wires.material);
    const nodeMat = keep(new THREE.PointsMaterial({ map: glow, size: 0.09, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const nodes = new THREE.Points(keep(new THREE.BufferGeometry().setFromPoints(pts)), nodeMat);
    rig.add(mesh, wires, nodes);
    rig.scale.setScalar(0.72);
    owner.group.add(lit(rig));
    return { rig, mat, wires, nodeMat, owner, on: 0 };
  }
  const brains = { W: makeBrain(W), T: makeBrain(T) };

  // The brain's charge running down into its coin and out across the face: branching lines, grown in.
  function circuit(owner) {
    const s = radius(owner.before), segs = [];
    const top = V(0, s + 0.12, 0.05 * s);
    for (let b = 0; b < 7; b++) {
      const a = -0.9 + (1.8 * b) / 6 + (Math.random() - 0.5) * 0.2;
      const pts = [top, V(Math.sin(a) * s * 0.9, Math.cos(a) * s * 0.9, 0.1 * s)];
      let p = pts[1].clone();
      for (let n = 0; n < 4; n++) {
        const toward = V((Math.random() - 0.5) * 1.2 * s, (Math.random() - 0.6) * 1.2 * s, 0).sub(V(p.x, p.y, 0)).multiplyScalar(0.35);
        p = p.clone().add(toward).setZ(0.105 * s);
        if (Math.hypot(p.x, p.y) > 0.78 * s) p.multiplyScalar((0.78 * s) / Math.hypot(p.x, p.y)).setZ(0.105 * s);
        pts.push(p);
      }
      pts.slice(1).forEach((q, i) => segs.push([pts[i], q, (i + Math.random() * 0.3) / pts.length]));
    }
    const lines = lit(pulseLines(segs)); keep(lines.geometry); keep(lines.material);
    lines.material.uniforms.uSpeed.value = 1.6;
    owner.group.add(lines);
    return lines;
  }
  const wiring = circuit(W);

  // ---------- light pieces from Blender: the lock field, padlock, reticle, vote gauge, approval mark ----------
  const holo = (geo) => { const m = lit(new THREE.Mesh(geo, keep(holoMaterial()))); return m; };
  const lockField = holo(G.lock_field);
  const reticle = holo(G.reticle);
  const gauge = holo(G.gauge), gaugeTicks = holo(G.gauge_ticks);
  const notch = lit(new THREE.Mesh(keep(new THREE.PlaneGeometry(0.018, 0.24)), keep(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))));
  T.group.add(lockField, reticle, gauge, gaugeTicks, notch);
  const steel = keep(new THREE.MeshPhysicalMaterial({ color: 0xd3d9e0, metalness: 1, roughness: 0.22, emissive: new THREE.Color(), emissiveIntensity: 1 }));
  const padlock = new THREE.Group(), shackle = new THREE.Mesh(G.padlock_shackle, steel);
  padlock.add(new THREE.Mesh(G.padlock_body, steel), shackle);
  T.group.add(padlock);
  const tickMat = keep(new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.25, emissive: new THREE.Color(), emissiveIntensity: 2.2 }));
  const approval = new THREE.Group();
  const approvalRing = holo(G.approval_ring);
  approval.add(approvalRing, new THREE.Mesh(G.approval_tick, tickMat));
  T.group.add(approval);

  // The bid's path, its first targeting beam, and the bid itself: a small coin of the bidder's riding the path.
  const pathCore = lit(new THREE.Mesh(undefined, keep(pathMaterial(1)))), pathGlow = lit(new THREE.Mesh(undefined, keep(pathMaterial(0.2))));
  const beam = lit(new THREE.Mesh(undefined, keep(pathMaterial(1))));
  const packet = W.parts(0.15, W.plain), packetGlow = lit(new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))));
  const counter = T.parts(0.13, T.plain);
  world.add(pathCore, pathGlow, beam, packet, packetGlow, counter);
  let curve = null;

  // Pools: rings that pulse outward, and glowing dots (holders, the late buyer, sparks running down a path).
  const rings = Array.from({ length: 8 }, () => { const m = holo(G.ring_thin); world.add(m); return m; });
  const dots = Array.from({ length: 14 }, () => { const s = lit(new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })))); world.add(s); return s; });
  const net = { lines: null, at: -1 }; // the vote's network, built when the vote begins
  const swaps = []; // the swap's two paths per holder: in to the winner, then out to the holder
  // Each holder's coins in the swap: one of the target's going in, one of the winner's coming back.
  // The late buyer's tokens, and the voters' locked tokens: small coins of the target's.
  const lateCoin = T.parts(0.14, T.plain), voterCoins = Array.from({ length: 6 }, () => T.parts(0.12, T.plain));
  world.add(lateCoin, ...voterCoins);
  const minis = Array.from({ length: 4 }, () => { const m = { give: T.parts(0.15, T.plain), get: W.parts(0.15, W.plain) }; world.add(m.give, m.get); return m; });
  const sparks = makeSparks(Q.sparks); lit(sparks.points); world.add(sparks.points);
  const dust = makeDust(Q.dust); lit(dust.points); world.add(dust.points);
  let dustFor = -1;

  // ---------- post: bloom, depth of field (big screens), tone mapping ----------
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: Q.samples });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.5, 0.88);
  composer.addPass(bloom);
  let bokeh = null;
  if (Q.dof) {
    bokeh = new BokehPass(scene, camera, { focus: 10, aperture: 0.0016, maxblur: 0.0055 });
    const render = bokeh.render.bind(bokeh);
    bokeh.render = (...a) => { camera.layers.disable(LIGHT); render(...a); camera.layers.enable(LIGHT); };
    composer.addPass(bokeh);
  }
  composer.addPass(new OutputPass());

  // ---------- layout: the two coins in the deal up front, everyone else further back ----------
  let tall = null, FLOOR = -2;
  const holders = []; // where the swap's holders stand
  function layout(aspect) {
    const isTall = aspect < 1.15;
    if (isTall === tall) return;
    tall = isTall;
    W.base.set(...(tall ? [-0.85, 0.75, 0] : [-1.95, 0.3, 0]));
    T.base.set(...(tall ? [0.95, -0.95, 0.5] : [2.0, 0.05, 0.45]));
    others.forEach((c, k, rest) => {
      const u = (k + 0.5) / rest.length;
      if (tall) c.base.set(k % 2 ? -1.3 : 1.25, k % 2 ? -2.0 : 1.5, -3 - k * 0.4);
      else c.base.set(rest.length === 1 ? 0.15 : -3.4 + u * 7.4, -0.6 + 0.3 * Math.sin(k * 2.1), -3.4 - (k % 2) * 1.2);
    });
    FLOOR = Math.min(...coins.map((c) => c.base.y - radius(Math.max(c.before, c.cap)))) - 0.6;
    floor.position.y = FLOOR;
    const mid = V().addVectors(W.base, T.base).multiplyScalar(0.5);
    curve = new THREE.QuadraticBezierCurve3(W.base.clone(), mid.add(V(0, 1.4 + W.base.distanceTo(T.base) * 0.1, 0.9)), T.base.clone());
    for (const m of [pathCore, pathGlow, beam]) m.geometry?.dispose();
    pathCore.geometry = new THREE.TubeGeometry(curve, 140, 0.02, 8);
    pathGlow.geometry = new THREE.TubeGeometry(curve, 140, 0.07, 10);
    const from = W.base.clone().add(V(0, radius(W.before) + 0.5, 0));
    beam.geometry = new THREE.TubeGeometry(new THREE.LineCurve3(from, T.base.clone()), 40, 0.012, 6);
    // The holders who swap stand where the target was, one above another.
    const n = Math.min(beatOf("swap").count || 0, 4);
    holders.length = 0;
    for (let i = 0; i < n; i++) holders.push(T.base.clone().add(V(0.35, (i - (n - 1) / 2) * (tall ? 0.9 : 1.15), 0.2)));
    swaps.forEach((m) => { world.remove(m); m.geometry.dispose(); });
    swaps.length = 0;
    holders.forEach((h, i) => {
      for (const dir of [1, -1]) {
        const m = W.base.clone().lerp(h, 0.5).add(V(0, dir * (0.9 + 0.2 * i), 0.5));
        const path = lit(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(dir > 0 ? h.clone() : W.base.clone(), m, dir > 0 ? W.base.clone() : h.clone()), 80, 0.012, 6), keep(pathMaterial(0.9))));
        path.userData = { dir, curve: path.geometry.parameters.path };
        world.add(path); swaps.push(path);
      }
    });
    net.at = -1;
  }

  // ---------- theme: the arena always films in the dark, in the page's own colours ----------
  function setTheme(colors) {
    for (const k of Object.keys(C)) if (colors[k]) C[k].set(colors[k]);
    sky.material.uniforms.uBase.value.copy(C.bg).multiplyScalar(0.8);
    sky.material.uniforms.uGlow.value.copy(C.primary).lerp(C.muted, 0.7).multiplyScalar(0.05);
    scene.fog.color.copy(C.bg).multiplyScalar(0.75);
    rimL.color.copy(C.fg); rimR.color.copy(C.primary).lerp(C.fg, 0.7);
    motes.material.uniforms.uColor.value.copy(C.fg).lerp(C.primary, 0.15);
    shaft.material.uniforms.uColor.value.set(0xfff1e0);
    pool.material.color.copy(C.muted).multiplyScalar(0.12);
    for (const c of coins) c.dis.uEdge.value.copy(C.warn).lerp(new THREE.Color(1, 1, 1), 0.25);
    invalidate();
  }

  // ---------- the clock: the beat, the time into it, and how long ago any earlier beat began ----------
  const durs = B.map((b, n) => durationOf(b, n === last) / 1000);
  const starts = durs.map((_, n) => durs.slice(0, n).reduce((a, b) => a + b, 0));
  let k = Math.min(Math.max(start, 0), last), t = 0, time = 0, playing = !calm, fired = new Set();
  const since = (kind) => (I[kind] >= 0 && k >= I[kind] ? starts[k] + t - starts[I[kind]] : -1e9);
  const now = (kind) => k === I[kind];
  const once = (name, when, fn) => { if (!calm && t >= when && !fired.has(name)) { fired.add(name); fn(); } };
  const cam = { pos: V(0, 0.5, 14), look: V(), fromPos: V(0, 0.5, 14), fromLook: V(), focus: 10 };
  let shake = 0, bloomKick = 0;
  function enter(n) {
    k = n; t = calm ? durs[k] : 0; fired = new Set();
    cam.fromPos.copy(cam.pos); cam.fromLook.copy(cam.look);
    if (n === 0) { sparks.clear(); W.s = radius(W.before); W.sv = 0; }
    onBeat?.(k); invalidate();
  }

  // Effects that start at a moment in a beat (none with reduced motion).
  function moments() {
    const b = B[k], tp = T.group.position, wp = W.group.position;
    if (b.kind === "lock") once("in", 0.4, () => sparks.stream(tp, C.primary, 60, { spread: 1.0, radius: 3 }));
    if (b.kind === "late") once("in", 0.3, () => sparks.stream(tp, C.muted, 70, { from: buyer(), spread: 1.1, stop: T.s * 1.42, bend: 0.5, life: 0.8 }));
    if (b.kind === "passed") once("in", 0.5, () => sparks.burst(tp, [C.up], 60, 2.4));
    if (b.kind === "merge") {
      once("treasury", M.treasury, () => sparks.stream(wp, C.warn, 140, { from: tp, spread: 1.3, bend: 0.9, life: 1.1, sizeK: 1.3 }));
      once("hit", M.impact, () => { sparks.burst(W.base, [T.hue, C.up, C.warn, C.fg], 320, 5); shake = 1; bloomKick = 1; W.sv += 7; });
    }
    if (b.kind === "swap") {
      once("in", 1.0, () => holders.forEach((h) => sparks.stream(W.base, T.hue, 24, { from: h, spread: 1.2, bend: 0.7, life: 1.1 })));
      once("out", 1.9, () => holders.forEach((h) => sparks.stream(h, W.hue, 24, { from: W.base, spread: 1.2, bend: 0.7, life: 1.1 })));
    }
    if (b.kind === "vote") once("flow", 1.0, () => voters().forEach((p) => sparks.stream(gaugePoint(p), b.yesShare >= 0.5 ? C.up : C.down, 40, { from: p, spread: 1.6, bend: 0.3, life: 0.9 })));
  }
  // Where the late buyer comes from: off to the side of the target.
  const buyer = () => T.base.clone().add(tall ? V(1.4, 2.2, 1) : V(2.4, 1.7, 1.2));
  // The holders who voted, on an arc below and before the target; their tokens run to the gauge.
  const voters = () => {
    const n = Math.max(1, Math.min(beatOf("vote").voters || 1, 6));
    return Array.from({ length: n }, (_, i) => {
      const a = THREE.MathUtils.degToRad(n === 1 ? 225 : 200 + (50 * i) / (n - 1));
      return T.base.clone().add(V(Math.cos(a) * T.s * 2.5, Math.sin(a) * T.s * 2.0, 0.7));
    });
  };
  const gaugePoint = (p) => T.base.clone().add(p.clone().sub(T.base).setZ(0).normalize().multiplyScalar(T.s * 1.62));

  // ---------- camera: each beat frames its subjects, and every move eases out of wherever the last one left off ----------
  const insets = { top: 60, bottom: 150 };
  // A coin and the room round it, with its name underneath.
  const subject = (c, room = 1.25) => ({ p: c.group.position.clone().add(V(0, -0.22, 0)), r: Math.max(c.s, 0.45) * room + 0.22 });
  const brainSpot = (c) => ({ p: c.group.position.clone().add(V(0, c.s + 0.8, 0)), r: 0.6 });
  // Looks at the subjects from `yaw` and `pitch`, just far enough back that their extent, as seen from there,
  // fills the band between the top bar and the caption.
  const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  function fit(subjects, yaw, pitch, pad = 1.1) {
    yaw += user.yaw; pitch = Math.min(0.8, Math.max(-0.3, pitch + user.pitch));
    const back = V(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const right = V(0, 1, 0).cross(back).normalize(), up = back.clone().cross(right);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z = 0;
    for (const { p, r } of subjects) {
      const x = p.dot(right), y = p.dot(up);
      x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r);
      z += p.dot(back) / subjects.length;
    }
    const c = right.clone().multiplyScalar((x0 + x1) / 2).addScaledVector(up, (y0 + y1) / 2).addScaledVector(back, z);
    // Whatever stands nearer the camera than the middle looks bigger: step back by that much too.
    let near = 0;
    for (const { p, r } of subjects) near = Math.max(near, p.dot(back) - z + r * 0.5);
    const band = Math.max(0.3, (hostH - insets.top - insets.bottom) / Math.max(hostH, 1));
    const dist = Math.max(((x1 - x0) / 2) * pad / (TAN * camera.aspect), ((y1 - y0) / 2) * pad / (TAN * band)) + near;
    return { pos: c.clone().addScaledVector(back, Math.max(dist, 4)), look: c };
  }
  const mix = (a, b, x) => ({ pos: a.pos.clone().lerp(b.pos, x), look: a.look.clone().lerp(b.look, x) });
  function shot() {
    const kind = B[k].kind, u = clamp01(t / durs[k]);
    const two = [subject(W), subject(T)];
    // Beside the readout's spot, as much room as the readout takes (none on a phone, where it is pinned).
    const room = [];
    if (hud && !narrow) {
      const [at, side] = hudSpot(kind), ppu = hostH / (2 * TAN * Math.max(camera.position.distanceTo(cam.look), 1));
      if (side) room.push({ p: at.add(V(side * (hw + 24) / ppu, 0, 0)), r: 0.1 });
    }
    const frame = (subjects, ...a) => fit([...subjects, ...room], ...a);
    switch (kind) {
      case "lock": return [frame([subject(T, 1.65), { p: T.group.position.clone().add(V(0, T.s * 1.95 + 0.25, 0)), r: 0.3 }], lerp(0.3, 0.18, u), 0.14, 1.05), T];
      case "think": return [mix(frame([subject(W, 1.3), brainSpot(W)], lerp(0.3, 0.22, u), 0.12), frame([subject(W), brainSpot(W), subject(T), ...others.map((c) => subject(c, 1.1))], 0.08, 0.24, 1.0), span(t, 3.4, 5.4)), W];
      case "offer": return [frame([...two, brainSpot(W)], lerp(-0.08, 0.06, u), 0.13), t < 2.6 ? W : T];
      case "late": return [frame([...two, ...others.map((c) => subject(c, 1.1)), { p: buyer(), r: 0.3 }], lerp(0.16, 0.06, u), 0.3, 1.0), T];
      case "stance": return [frame([subject(T, 1.7), brainSpot(T), { p: curve.getPoint(0.9), r: 0.3 }], lerp(0.34, 0.2, u), 0.13), T];
      case "vote": return [frame([subject(T, 1.8), ...voters().map((p) => ({ p, r: 0.35 }))], lerp(0.12, 0.24, u), 0.26), T];
      case "passed": return [frame([...two, { p: T.group.position.clone().add(V(0, T.s + 0.9, 0)), r: 0.5 }], lerp(-0.1, 0.04, u), 0.04, 1.05), T];
      case "merge": {
        const wide = frame(two, 0.02, 0.1, 1.05), close = frame([subject(W, 1.9)], 0.14, 0.08, 1.0);
        return [mix(wide, close, span(t, M.burn[1] - 0.6, M.impact + 0.2) * (1 - 0.35 * span(t, M.impact + 1.2, durs[k]))), t < M.burn[0] + 0.6 ? T : W];
      }
      case "swap": return [frame([subject(W, 1.4), ...holders.map((p) => ({ p, r: 0.4 }))], lerp(0.1, -0.04, u), 0.16, 1.05), W];
      default: return [frame(two, 0, 0.12), W];
    }
  }

  // ---------- one frame ----------
  const user = { yaw: 0, pitch: 0, vyaw: 0, touched: -99 };
  let hovered = null, wantHover = false, dragging = null;
  const pointer = new THREE.Vector2(), ray = new THREE.Raycaster(), v = V();
  let bw = 0, bh = 0, hw = 0, hh = 0, hostW = 0, hostH = 0, capTop = 0, narrow = false, frames = [];

  function frame(dt) {
    // Paused, a beat still plays through once and then holds on its last frame.
    if (!calm) {
      t += dt;
      if (t >= durs[k]) { if (playing) enter(k === last ? 0 : k + 1); else t = durs[k]; }
    }
    host.style.setProperty("--beat", Math.min(t / durs[k], 1).toFixed(3));
    time += calm ? 0 : dt;
    const toward = (cur, to, rate) => (calm ? to : damp(cur, to, rate, dt));
    moments();
    const kind = B[k].kind;
    const sMerge = since("merge"), merging = now("merge");
    const burned = I.merge >= 0 && (k > I.merge || (merging && t >= M.burn[1]));
    const landed = I.merge >= 0 && (k > I.merge || (merging && t >= M.impact));

    // --- coins: size by market cap, a slow sway, and how lit each one is in this beat ---
    const lead = { lock: [T], think: [W], offer: [W, T], late: [W, T, ...others], stance: [T], vote: [T], passed: [W, T], merge: [W, T], swap: [W] }[kind] || coins;
    for (const c of coins) {
      let target = radius(c === W && landed ? c.cap : c.before);
      if (calm) c.s = target;
      else { c.sv += ((target - c.s) * 70 - c.sv * 11) * dt; c.s += c.sv * dt; }
      c.hover = toward(c.hover, hovered === c ? 1 : 0, 10);
      const s = Math.max(c.s, 0) * (1 + 0.05 * c.hover);
      c.spin.scale.setScalar(s);
      c.group.position.copy(c.base);
      if (!calm) c.group.position.y += Math.sin(time * 0.9 + c.phase) * 0.06;
      // Turning: a slow sway, faced toward each other once the vote has passed.
      const aligned = since("passed") > 0 && !landed ? span(since("passed"), 0.3, 1.4) : 0;
      let ry = calm ? -0.2 : Math.sin(time * 0.5 + c.phase) * 0.35;
      ry = lerp(ry, c === W ? 0.32 : c === T ? -0.32 : ry, aligned);
      c.spin.rotation.x = calm ? 0.05 : Math.sin(time * 0.37 + c.phase) * 0.1 * (1 - aligned);
      // The lock: the target comes in out of the dark, spinning, and stops as the field closes on it.
      if (c === T && now("lock")) { c.group.position.z -= (1 - ease(t / 1.8)) * 2.6; ry += (1 - ease(t / 2.2)) * 7; }
      // The merge: the winner draws back, leans in, and settles after the target lands in it.
      if (c === W && merging) c.group.position.lerp(T.base, 0.26 * span(t, M.lean[0], M.lean[1]) - 0.05 * span(t, 0.2, M.lean[0]) - 0.26 * span(t, M.impact, M.impact + 1.2));
      // The swap: the winner turns once as the holders swap.
      if (c === W && now("swap")) ry += ease((t - 1.1) / 2.4) * Math.PI * 2;
      c.spin.rotation.y = ry;
      const bright = lead.includes(c) ? 1 : kind === "think" && scanned(c) ? 0.85 : 0.42;
      c.presence = toward(c.presence, (c === T && now("lock") ? 0.15 + 0.85 * span(t, 0, 1.4) : bright) * (c === W && landed && merging ? 1 + 0.5 * (1 - span(t, M.impact, durs[k])) : 1), 3);
      c.mats.face.color.setScalar(c.presence);
      for (const m of Object.values(c.mats)) m.envMapIntensity = 0.25 + 0.75 * Math.min(c.presence, 1);
      c.mats.rim.color.copy(c.metal).multiplyScalar(c.presence);
      c.mats.edge.color.copy(c.metal).multiplyScalar(c.presence);
      const fire = (c === W && merging ? span(t, M.spark[1] - 0.2, M.spark[1]) * (1 - span(t, M.impact + 0.5, M.impact + 2)) : 0) + (c === T && merging ? span(t, M.lean[0], M.burn[0]) * (1 - span(t, M.burn[0], M.burn[1])) : 0);
      c.halo.material.color.copy(c.hue).lerp(C.warn, fire * 0.6);
      c.halo.material.opacity = 0.035 * c.presence + 0.28 * fire;
      c.halo.scale.setScalar(s * (2.6 + fire));
      c.group.visible = !(c === T && burned);
    }
    T.dis.uDissolve.value = merging ? 1.08 * span(t, M.burn[0], M.burn[1]) : burned ? 1.1 : 0;
    T.dis.uDir.value.copy(W.base).sub(T.base).setZ(0).normalize();
    const going = 1 - T.dis.uDissolve.value;

    // --- the lock: a field of light closes round the target, with a padlock that snaps shut ---
    const sLock = since(I.lock >= 0 ? "lock" : "offer");
    const fieldOn = sLock >= 0 && !burned;
    lockField.visible = fieldOn;
    if (fieldOn) {
      const a = I.lock >= 0 ? span(sLock, 0.5, 1.7) : 1;
      const late = now("late") ? span(t, 1.1, 1.3) * (1 - span(t, 1.8, 3.4)) : 0;
      lockField.scale.setScalar(T.s * (1.4 + (1 - a) * 0.6 + 0.04 * late));
      lockField.rotation.z = time * 0.06 + (1 - a) * 1.6;
      const u = lockField.material.uniforms;
      u.uDraw.value = a; u.uTime.value = time;
      u.uOpacity.value = (0.75 + 0.6 * late) * a * going;
      u.uColor.value.copy(C.primary).lerp(C.down, late);
    }
    const sPad = now("lock") ? t : I.lock >= 0 && k > I.lock ? 99 : -1;
    padlock.visible = sPad >= 0.5 && !burned;
    if (padlock.visible) {
      const closed = span(sPad, 1.25, 1.45), stow = span(sPad, 2.3, 3.2);
      padlock.scale.setScalar(T.s * lerp(0.5 * smooth((sPad - 0.5) / 0.4), 0.22, stow) * Math.max(going, 0.001));
      padlock.position.set(0, T.s * lerp(1.95, 1.47, stow), 0.12);
      padlock.rotation.y = calm ? 0 : Math.sin(time * 0.8) * 0.25 * (1 - stow);
      shackle.position.y = 0.12 * (1 - closed);
      steel.emissive.copy(C.primary).multiplyScalar(0.5 * (span(sPad, 1.4, 1.5) - span(sPad, 1.6, 2.3)));
    }

    // --- brains: the bidder's wakes for its look and its bid, the target's for its answer ---
    const sThink = since("think"), sStance = since("stance");
    const wOn = sThink >= 0 && (I.late < 0 || k <= I.late) && (k <= I.offer || now("late")) ? span(sThink, 1.0, 2.6) * (now("late") ? 1 - span(t, 0, 0.9) : 1) : 0;
    const tOn = now("stance") ? span(t, 0.4, 1.8) : now("vote") ? 1 - span(t, 0, 0.9) : 0;
    const decided = now("stance") && t >= DECIDE ? span(t, DECIDE, DECIDE + 0.5) : now("vote") ? 1 : 0;
    for (const [br, on, color] of [[brains.W, wOn, C.primary], [brains.T, tOn, T.hue.clone().lerp(C.fg, 0.35).lerp(B[I.stance]?.no ? C.down : C.up, decided)]]) {
      br.rig.visible = on > 0.001;
      if (!br.rig.visible) continue;
      const c = br.owner;
      br.rig.position.set(0, c.s + 0.8 + (calm ? 0 : Math.sin(time * 1.3) * 0.04), 0.1);
      br.rig.rotation.set(-0.15, calm ? -0.5 : -0.5 + Math.sin(time * 0.3) * 0.5, 0);
      const u = br.mat.uniforms;
      u.uColor.value.copy(color); u.uTime.value = time;
      u.uReveal.value = c === W ? span(sThink, 1.0, 2.6) : span(sStance, 0.4, 1.8);
      u.uOpacity.value = on; u.uThink.value = now("think") || now("stance") ? 1 : 0.35;
      const w = br.wires.material.uniforms;
      w.uColor.value.copy(color); w.uTime.value = time; w.uOpacity.value = on * 0.9;
      w.uDraw.value = c === W ? span(sThink, 1.6, 3.0) : span(sStance, 1.0, 2.2);
      br.nodeMat.color.copy(color); br.nodeMat.opacity = on * 0.8;
    }
    const thinker = wOn > 0.05 ? brains.W : tOn > 0.05 ? brains.T : null;
    brainLight.visible = !!thinker;
    if (thinker) { thinker.rig.getWorldPosition(brainLight.position); brainLight.color.copy(thinker.mat.uniforms.uColor.value); brainLight.intensity = 8 * thinker.mat.uniforms.uOpacity.value; }
    // The bidder's charge running into its coin.
    wiring.visible = wOn > 0.05 && k <= I.offer;
    if (wiring.visible) {
      const u = wiring.material.uniforms;
      u.uDraw.value = span(sThink, 2.0, 3.2); u.uTime.value = time; u.uColor.value.copy(C.primary);
      u.uOpacity.value = wOn * (now("offer") ? 1 - span(t, 0, 1.2) : 1);
    }

    // --- pulses: rings of light going out (the lock taking hold, the scan, the answer, the vote, the landing) ---
    let ri = 0;
    const ring = (at, flat, r0, r1, u, color, alpha = 0.8) => {
      if (u <= 0 || u >= 1 || ri >= rings.length) return;
      const m = rings[ri++], e = 1 - (1 - u) ** 2;
      m.visible = true; m.position.copy(at);
      m.rotation.set(flat ? -Math.PI / 2 : 0, 0, 0);
      m.scale.setScalar(lerp(r0, r1, e));
      const un = m.material.uniforms; un.uColor.value.copy(color); un.uOpacity.value = alpha * (1 - u); un.uDraw.value = 1;
    };
    const tPos = T.group.position, wPos = W.group.position, ground = (p) => V(p.x, FLOOR + 0.01, p.z);
    if (!calm) {
      if (I.lock >= 0) {
        ring(tPos, false, T.s * 1.4, T.s * 3, (sLock - 1.45) / 1.0, C.primary);
        ring(ground(T.base), true, 0.5, 11, (sLock - 1.5) / 3.2, C.primary, 0.5);
      }
      // The scan: rings go out across the floor from under the bidder and find its rivals.
      for (let j = 0; j < 4; j++) ring(ground(W.base), true, 0.4, 12, (sThink - 2.8 - j * 1.1) / 3.4, C.primary, 0.55);
      if (now("stance")) {
        for (const [name, at] of WEIGH) {
          if (name === "accept") ring(tPos, false, T.s * 1.2, T.s * 2.2, (t - at) / 0.7, C.up, 0.6);
        }
        ring(tPos, false, T.s * 1.3, T.s * 3.2, (t - DECIDE) / 1.1, B[k].no ? C.down : C.up, 0.9);
      }
      if (now("vote") && reach() !== null) {
        ring(tPos, false, T.s * 1.62, T.s * 3.6, (t - reach()) / 1.0, C.up, 0.9);
        ring(ground(T.base), true, 0.5, 8, (t - reach()) / 2.0, C.up, 0.5);
      }
      if (now("passed")) ring(tPos, false, T.s * 1.3, T.s * 4, (t - 0.4) / 1.2, C.up, 0.9);
      if (merging) {
        ring(wPos, false, W.s * 1.1, W.s * 4.4, (t - M.impact) / 1.0, C.up, 0.9);
        ring(ground(W.base), true, 0.5, 13, (t - M.impact) / 2.2, C.warn, 0.45);
      }
    }
    for (let j = ri; j < rings.length; j++) rings[j].visible = false;

    // --- the bid: a targeting beam, the reticle closing on the target, the path, and the bid riding it ---
    const sOffer = since("offer"), sPassed = since("passed");
    const live = sOffer >= 0 && !burned;
    const beamOn = now("offer") ? span(t, 0.2, 0.6) * (1 - span(t, 1.3, 1.9)) : 0;
    beam.visible = beamOn > 0.01;
    if (beam.visible) { const u = beam.material.uniforms; u.uDraw.value = span(t, 0.2, 0.7); u.uOpacity.value = beamOn; u.uColor.value.copy(C.primary); u.uTime.value = time; }
    reticle.visible = live && (I.passed < 0 || sPassed < 1.6);
    if (reticle.visible) {
      const a = span(sOffer, 0.4, 1.3), gone = span(sPassed, 0.3, 1.5);
      reticle.scale.setScalar(T.s * (lerp(2.5, 1.62, ease(a)) + gone * 0.8));
      reticle.rotation.z = (1 - a) * -1.3 + time * 0.03;
      const u = reticle.material.uniforms;
      u.uOpacity.value = a * (now("offer") ? 1 : 0.6) * (1 - gone) * going;
      u.uColor.value.copy(C.primary).lerp(C.up, span(sPassed, 0, 0.5)); u.uTime.value = time;
    }
    const pathOn = live ? (merging ? 1 - span(t, M.impact - 0.2, M.impact + 0.6) : 1) : 0;
    pathCore.visible = pathGlow.visible = pathOn > 0.01;
    for (const [m, a] of [[pathCore, 1], [pathGlow, 0.22 + (merging ? 0.5 * span(t, M.lean[0], M.burn[0]) : 0)]]) {
      const u = m.material.uniforms;
      u.uDraw.value = now("offer") ? span(t, 0.9, 2.0) : 1; u.uOpacity.value = a * pathOn; u.uTime.value = time;
      u.uColor.value.copy(C.primary).lerp(C.up, span(sPassed, 0, 0.8)); u.uDir.value = merging ? -1 : 1;
    }
    // The bid itself rides the path once it is drawn, then waits at the target until the merge.
    const ride = now("offer") ? ease((t - 2.0) / 1.3) : 1;
    const waiting = live && (!merging || t < M.spark[0]) && (k > I.offer || t > 2.0);
    packet.visible = packetGlow.visible = waiting;
    if (waiting) {
      curve.getPoint(0.05 + 0.85 * ride, packet.position);
      packet.position.y += calm ? 0 : Math.sin(time * 2) * 0.03;
      packet.rotation.y = time * 1.5;
      const blink = now("stance") && t > WEIGH[2][1] && t < WEIGH[2][1] + 0.7 ? 0.35 + 0.65 * Math.abs(Math.cos(t * 18)) : 1;
      packetGlow.position.copy(packet.position);
      packetGlow.scale.setScalar(0.75 + 0.1 * Math.sin(time * 4));
      packetGlow.material.color.copy(C.primary).lerp(C.up, span(sPassed, 0, 0.6));
      packetGlow.material.opacity = 0.9 * blink;
    }
    // The answer it could have given back: a counter-offer leaves the target toward the bidder, then thinks better of it.
    const cu = now("stance") ? (t - WEIGH[1][1]) / 0.7 : -1;
    counter.visible = cu > 0 && cu < 1;
    if (counter.visible) { curve.getPoint(0.9 - 0.32 * ease(cu), counter.position); counter.rotation.y = -time * 1.5; counter.scale.setScalar(0.13 * Math.sin(cu * Math.PI)); }

    // --- the vote: the holders' tokens run into a gauge round the target; it fills past the approval line ---
    const sVote = since("vote");
    const vb = beatOf("vote");
    const gaugeOn = sVote >= 0 && (I.passed < 0 || sPassed < 1.2) && !burned;
    gauge.visible = gaugeTicks.visible = notch.visible = gaugeOn;
    if (gaugeOn) {
      const a = span(sVote, 0.1, 0.9), shrink = span(sPassed, 0.2, 1.0);
      const sc = T.s * 1.62 * (1 - 0.5 * shrink);
      gauge.scale.setScalar(sc); gaugeTicks.scale.setScalar(sc);
      const g = gauge.material.uniforms, gt = gaugeTicks.material.uniforms;
      g.uDraw.value = a; g.uFill.value = (vb.yesShare ?? 1) * span(sVote, 1.2, 3.0);
      g.uColor.value.copy(C.muted); g.uFillColor.value.copy(C.up); g.uTime.value = time; g.uSpin.value = 0;
      g.uOpacity.value = (1 - shrink) * (0.9 + (now("passed") ? 0.8 * (1 - span(sPassed, 0, 0.6)) : 0));
      gt.uDraw.value = a; gt.uColor.value.copy(C.muted); gt.uOpacity.value = 0.6 * (1 - shrink); gt.uSpin.value = 0;
      // The approval line, where the gauge has to reach.
      const ang = Math.PI / 2 - Math.PI * 2 * (vb.approval ?? 0.5);
      notch.position.set(Math.cos(ang) * sc * 1.04, Math.sin(ang) * sc * 1.04, 0.01);
      notch.rotation.z = ang - Math.PI / 2;
      notch.scale.setScalar(sc * 0.86);
      notch.material.color.copy(C.fg); notch.material.opacity = a * (1 - shrink);
    }
    // The network: each holder who voted is a node with a line to the gauge, and the late buyer stands apart, unwired.
    const netOn = now("vote") ? span(t, 0.4, 1.0) : now("passed") ? 1 - span(t, 0, 0.8) : 0;
    if (netOn > 0 && net.at !== I.vote) {
      net.lines?.removeFromParent();
      const segs = voters().map((p) => [p, gaugePoint(p), Math.random() * 0.5]);
      net.lines = lit(pulseLines(segs)); keep(net.lines.geometry); keep(net.lines.material);
      world.add(net.lines); net.at = I.vote;
    }
    if (net.lines) {
      net.lines.visible = netOn > 0;
      const u = net.lines.material.uniforms;
      u.uOpacity.value = netOn; u.uDraw.value = 1; u.uTime.value = time; u.uColor.value.copy(C.up).lerp(C.fg, 0.3);
    }

    // --- the approval mark: it turns in over the target, then runs down the bid into the winner ---
    const markOn = sPassed >= 0 && !(merging && t > M.spark[0] + 0.3) && !landed;
    approval.visible = markOn && sPassed > 0.4;
    if (approval.visible) {
      const a = span(sPassed, 0.5, 1.2), go = merging ? span(t, 0, M.spark[0] + 0.3) : 0;
      approval.scale.setScalar(0.42 * ease(a) * (1 + 0.12 * Math.sin(a * Math.PI)) * (1 - go));
      approval.position.set(0, T.s + 0.95, 0.15);
      approval.rotation.y = (1 - ease(a)) * Math.PI + (calm ? 0 : Math.sin(time * 0.9) * 0.2);
      const u = approvalRing.material.uniforms;
      u.uColor.value.copy(C.up); u.uOpacity.value = a; u.uDraw.value = 1; u.uTime.value = time;
      tickMat.emissive.copy(C.up); tickMat.color.copy(C.up).lerp(C.fg, 0.5);
    }

    // --- dots: the late buyer, the voters, the swap's holders, the approval running down to the winner ---
    let di = 0;
    const dot = (at, color, size, alpha) => {
      if (alpha <= 0.01 || di >= dots.length) return;
      const s = dots[di++];
      s.visible = true; s.position.copy(at); s.scale.setScalar(size); s.material.color.copy(color); s.material.opacity = alpha;
    };
    const vs = netOn > 0 ? voters() : [];
    if (netOn > 0) {
      const flashAt = reach();
      vs.forEach((p) => dot(p, C.up, 0.4 + (flashAt !== null && now("vote") ? 0.5 * (1 - clamp01(Math.abs(t - flashAt - 0.1) / 0.4)) : 0), netOn * 0.7));
    }
    voterCoins.forEach((m, i) => {
      m.visible = i < vs.length;
      if (m.visible) { m.position.copy(vs[i]); m.scale.setScalar(0.12 * netOn); m.rotation.y = time * 0.8 + i; }
    });
    // The late buyer's tokens fly at the target; the field turns them away, and they wait outside it, unwired.
    const sLate = since("late");
    lateCoin.visible = I.late >= 0 && sLate > 0.1 && k <= (I.passed >= 0 ? I.passed : last) && !burned;
    if (lateCoin.visible) {
      const from = buyer(), dir = from.clone().sub(T.base).normalize();
      const hit = T.base.clone().addScaledVector(dir, T.s * 1.45), rest = T.base.clone().addScaledVector(dir, T.s * 1.45 + 0.45);
      if (sLate < 1.15) lateCoin.position.copy(from).lerp(hit, ease((sLate - 0.3) / 0.85));
      else lateCoin.position.copy(hit).lerp(rest, ease((sLate - 1.15) / 0.6));
      lateCoin.scale.setScalar(0.14 * span(sLate, 0.1, 0.4) * (now("passed") ? 1 - span(t, 0, 0.8) : 1));
      lateCoin.rotation.y = time * 1.5;
    }
    if (merging) {
      const u = span(t, M.spark[0], M.spark[1]);
      if (u > 0 && u < 1) dot(curve.getPoint(1 - ease(u)), C.up, 0.9, 1);
    }
    if (now("swap")) holders.forEach((h) => dot(h, C.fg, 0.5, 0.6 * span(t, 0.2, 0.8) * (1 - span(t, durs[k] - 1.2, durs[k] - 0.3))));
    for (let j = di; j < dots.length; j++) dots[j].visible = false;

    // --- the swap's two paths per holder: their tokens in to the winner, the winner's out to them ---
    swaps.forEach((m) => {
      const on = now("swap") ? span(t, 0.4, 1.1) * (1 - span(t, durs[k] - 1.4, durs[k] - 0.4)) : 0;
      m.visible = on > 0.01;
      if (!m.visible) return;
      const u = m.material.uniforms;
      u.uDraw.value = span(t, 0.4, 1.2); u.uOpacity.value = on * 0.8; u.uTime.value = time;
      u.uColor.value.copy(m.userData.dir > 0 ? T.hue : W.hue); u.uDir.value = 1;
    });

    // Each holder hands in its coin of the target, and a coin of the winner comes back to it.
    minis.forEach((m, i) => {
      m.give.visible = m.get.visible = false;
      if (!now("swap") || !holders[i]) return;
      const show = 0.15 * span(t, 0.3, 0.8) * (1 - span(t, durs[k] - 1.2, durs[k] - 0.4));
      const a = ease((t - 1.0 - i * 0.2) / 1.2), b = ease((t - 1.9 - i * 0.2) / 1.2);
      if (a < 1) { m.give.visible = true; swaps[i * 2].userData.curve.getPoint(a, m.give.position); m.give.scale.setScalar(show * (1 - 0.7 * span(a, 0.75, 1))); m.give.rotation.y = time * 2; }
      if (b > 0) { m.get.visible = true; swaps[i * 2 + 1].userData.curve.getPoint(b, m.get.position); m.get.scale.setScalar(show * (0.3 + 0.7 * span(b, 0, 0.25))); m.get.rotation.y = -time * 2; }
    });

    // --- the merge's dust: filled from the target's own face when the merge begins ---
    if (merging && dustFor !== k && !calm) fillDust();
    dust.points.visible = merging && !calm && t > M.burn[0] && t < M.impact + 2;
    if (dust.points.visible) {
      const u = dust.points.material.uniforms;
      u.uTime.value = t; u.uTo.value.copy(wPos); u.uMid.value.copy(curve.v1);
      T.spin.updateWorldMatrix(true, false); u.uFrom.value.copy(T.spin.matrixWorld);
    }
    flash.position.copy(wPos).add(V(0, 0, 1.2));
    flash.color.copy(C.warn).lerp(C.fg, 0.4);
    flash.intensity = merging && !calm ? 28 * Math.max(0, 1 - Math.abs(t - M.impact - 0.05) / 0.5) ** 2 : 0;

    // --- the room follows the beat's subject: the light from above, the pool on the floor, the focus ---
    const [pose, hero] = shot();
    const hp = hero.group.position;
    const shaftOn = { lock: 1, think: 0.8, merge: 1, passed: 0.8 }[kind] ?? 0.55;
    shaft.position.lerp(V(hp.x + 0.9, hp.y + 6.2, hp.z - 0.8), calm ? 1 : 1 - Math.exp(-2 * dt));
    shaft.lookAt(hp); shaft.rotateX(-Math.PI / 2);
    const su = shaft.material.uniforms; su.uTime.value = time; su.uOpacity.value = toward(su.uOpacity.value, 0.04 * shaftOn, 2);
    pool.position.lerp(V(hp.x, FLOOR + 0.02, hp.z), calm ? 1 : 1 - Math.exp(-2 * dt)); pool.scale.setScalar(9);
    motes.material.uniforms.uTime.value = time;
    sparks.update(calm ? 0 : dt);

    // --- the camera ---
    if (!dragging) {
      user.yaw += user.vyaw * dt; user.vyaw = damp(user.vyaw, 0, 3, dt);
      if (performance.now() - user.touched > 4000) { user.yaw = damp(user.yaw, 0, 0.8, dt); user.pitch = damp(user.pitch, 0, 0.8, dt); }
    }
    const blend = calm ? 1 : ease(t / 1.7);
    cam.pos.copy(cam.fromPos).lerp(pose.pos, blend);
    cam.look.copy(cam.fromLook).lerp(pose.look, blend);
    camera.position.copy(cam.pos);
    camera.lookAt(cam.look);
    shake = damp(shake, 0, 4, dt);
    if (shake > 0.01) camera.position.add(v.set(Math.random() - 0.5, Math.random() - 0.5, 0).multiplyScalar(shake * 0.14));
    if (bokeh) {
      cam.focus = toward(cam.focus, camera.position.distanceTo(hp), 3);
      bokeh.uniforms.focus.value = cam.focus;
    }
    bloomKick = damp(bloomKick, 0, 2.2, dt);
    bloom.strength = 0.42 + 0.35 * bloomKick;
    // The light from the key follows the action, so its shadows land under the coins.
    key.target.position.set(hp.x * 0.5, FLOOR, hp.z * 0.5);
    key.position.copy(key.target.position).add(V(4, 9, 6));
    fill.position.set(-6, 1.5, 4);
    rimL.position.set(-4, 3.5, -5); rimR.position.set(5, 2.5, -5);
    // Before the loop starts again, the picture dims and comes back up on the first beat.
    canvas.style.opacity = !calm && k === last && t > durs[k] - 0.7 ? "0.08" : "";

    if (wantHover) { wantHover = false; hover(); }
    composer.render(dt);
    place(lead, landed);
    if (!calm && frames.length < 150) adapt(dt);
  }

  // When the gauge crosses the approval line, in seconds into the vote.
  function reach() {
    const vb = beatOf("vote"), need = vb.approval ?? 0.5, yes = vb.yesShare ?? 1;
    return yes >= need ? 1.2 + 1.8 * invSmooth(need / Math.max(yes, 1e-6)) : null;
  }
  // Whether the bidder's scan has passed this rival yet.
  function scanned(c) {
    const d = Math.hypot(c.base.x - W.base.x, c.base.z - W.base.z);
    return since("think") - 2.8 > (d / 12) * 3.4 * 0.6;
  }
  // The dust: points over both faces in the colours of the target's own picture, and over its rim and edge in its metal.
  function fillDust() {
    dustFor = k;
    const g = T.faceCanvas.getContext("2d", { willReadFrequently: true });
    let px = null;
    try { px = g.getImageData(0, 0, 512, 512).data; } catch (_) { /* a picture without CORS: the coin's own colour instead */ }
    const col = new THREE.Color(), dir = T.dis.uDir.value;
    dust.fill((i) => {
      if (i % 10 < 7) {
        const a = Math.random() * Math.PI * 2, r = 0.8 * Math.sqrt(Math.random()), x = Math.cos(a) * r, y = Math.sin(a) * r;
        const side = i % 2 ? 1 : -1;
        if (px) {
          const ux = Math.round((0.5 + (side * x) / 1.6) * 511), uy = Math.round((0.5 - y / 1.6) * 511), o = (uy * 512 + ux) * 4;
          col.setRGB(px[o] / 255, px[o + 1] / 255, px[o + 2] / 255, THREE.SRGBColorSpace);
        } else col.copy(T.hue);
        return [[x, y, side * 0.061], col.clone()];
      }
      const a = Math.random() * Math.PI * 2, r = 0.8 + 0.2 * Math.random();
      return [[Math.cos(a) * r, Math.sin(a) * r, (Math.random() - 0.5) * 0.18], T.metal.clone().multiplyScalar(1.3)];
    }, (p) => M.burn[0] + (M.burn[1] - M.burn[0]) * invSmooth(clamp01(dissolveKey({ x: p[0], y: p[1] }, dir) / 1.08)));
    const u = dust.points.material.uniforms;
    u.uTravel.value = 1.25; u.uSize.value = LITE ? 0.85 : 0.6;
  }

  // Too slow for depth of field? Drop it (once), and the sharpest pixel ratio after it if that isn't enough.
  function adapt(dt) {
    frames.push(dt);
    if (frames.length < 150) return;
    const avg = frames.slice(30).reduce((a, b) => a + b, 0) / 120;
    if (avg > 0.022 && bokeh) { bokeh.enabled = false; bokeh = null; frames = []; }
    else if (avg > 0.026 && renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); resize(); }
  }

  // ---------- the page's words over the scene: labels under each coin, the bubble over whoever speaks, the readout ----------
  // Only the coins in the beat are named; the target's name sits below whatever ring is round it.
  function place(lead, landed) {
    const kind = B[k].kind;
    const ringT = Math.max(lockField.visible ? lockField.scale.x * 1.14 : 0, gauge.visible ? gauge.scale.x * 1.15 : 0, reticle.visible ? reticle.scale.x * 1.05 : 0);
    for (const c of coins) {
      const el = labels?.get(c.id);
      if (!el) continue;
      c.group.getWorldPosition(v);
      v.y -= Math.max(c.s, 0.3, c === T ? ringT : 0) + 0.2;
      v.project(camera);
      el.style.transform = `translate3d(${((v.x + 1) / 2) * hostW}px, ${((1 - v.y) / 2) * hostH}px, 0) translateX(-50%)`;
      const seen = kind === "think" ? c === W || scanned(c) : lead.includes(c);
      const leaving = c === T && ((now("merge") && t > M.burn[0]) || (I.merge >= 0 && k > I.merge));
      el.style.opacity = c.group.visible && c.s > 0.2 && seen && !leaving ? "1" : "0";
      el.classList.toggle("hot", hovered === c);
      el.classList.toggle("landed", c === W && landed);
    }
    const b = B[k];
    if (bubble && !narrow) {
      const c = byId.get(b.coin);
      if (b.quote && c) {
        c.group.getWorldPosition(v);
        v.y += c.s + (b.kind === "think" || b.kind === "offer" || b.kind === "stance" ? 1.5 : 0.25);
        v.project(camera);
        const x = ((v.x + 1) / 2) * hostW, y = ((1 - v.y) / 2) * hostH;
        const left = Math.min(Math.max(x - bw / 2, 12), hostW - bw - 12);
        const top = Math.max(y - bh - 14, 56);
        bubble.style.transform = `translate3d(${left}px, ${top}px, 0)`;
        bubble.style.setProperty("--tail", `${Math.min(Math.max(x - left, 22), bw - 22)}px`);
      }
    } else if (bubble) bubble.style.transform = "";
    if (hud) placeHud();
  }

  // The readout sits beside the beat's subject, and shows once there is something to read.
  // Where the readout goes in each beat: a point beside the subject, which side of it, and from when.
  function hudSpot(kind) {
    const tp = T.group.position, wp = W.group.position;
    switch (kind) {
      case "lock": return [tp.clone().add(V(T.s * 1.75, T.s * 0.3, 0)), 1, 1.6];
      case "think": return [wp.clone().add(V(-W.s * 1.45, -0.15, 0)), -1, 1.2];
      case "offer": return [tp.clone().add(V(T.s * 1.75, -T.s * 0.2, 0)), 1, 3.0];
      case "late": return [tp.clone().add(V(T.s * 1.6, -T.s * 0.6, 0)), 1, 0.6];
      case "stance": return [tp.clone().add(V(-T.s * 1.85, 0, 0)), -1, 1.0];
      case "vote": return [tp.clone().add(V(T.s * 1.95, 0.1, 0)), 1, 0.8];
      case "passed": return [tp.clone().add(V(T.s * 1.3 + 0.45, T.s + 0.95, 0)), 1, 0.9];
      case "merge": return [wp.clone().add(V(W.s * 1.5, -W.s * 0.4, 0)), 1, M.impact + 0.3];
      case "swap": return [wp.clone().add(V(-W.s * 1.55, 0, 0)), -1, 1.4];
      default: return [wp.clone(), 1, 0];
    }
  }
  function placeHud() {
    const kind = B[k].kind;
    const [at, side, from] = hudSpot(kind);
    hud.style.opacity = calm || t >= from ? "1" : "0";
    hud.dataset.stage = stage();
    if (kind === "vote") hud.style.setProperty("--fill", span(t, 1.2, 3.0).toFixed(3));
    if (narrow) { hud.style.transform = `translate3d(12px, ${capTop - hh - 10}px, 0)`; return; }
    at.project(camera);
    const x = ((at.x + 1) / 2) * hostW, y = ((1 - at.y) / 2) * hostH;
    let left = side > 0 ? x + 10 : side < 0 ? x - hw - 10 : x - hw / 2;
    left = Math.min(Math.max(left, 12), hostW - hw - 12);
    const top = Math.min(Math.max(y - hh / 2, insets.top), hostH - insets.bottom - hh);
    hud.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }
  // Which of the rival brain's answers is lit.
  function stage() {
    if (!now("stance")) return "";
    if (t >= DECIDE) return B[k].no ? "reject chosen" : "accept chosen";
    const lit = WEIGH.filter(([, at]) => t >= at - 0.1).pop();
    return lit ? lit[0] : "";
  }

  function hover() {
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(meshes.filter((m) => m.parent.parent.visible), false)[0];
    hovered = hit ? byId.get(hit.object.userData.id) : null;
    canvas.style.cursor = hovered ? "pointer" : "grab";
  }

  // ---------- input: drag to look round (it eases back), click a coin to open it ----------
  const toNdc = (e) => { const r = canvas.getBoundingClientRect(); pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  const down = (e) => { dragging = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY }; user.vyaw = 0; canvas.setPointerCapture?.(e.pointerId); canvas.style.cursor = "grabbing"; };
  const move = (e) => {
    toNdc(e);
    if (!dragging) { wantHover = true; if (calm) invalidate(); return; }
    const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
    dragging.x = e.clientX; dragging.y = e.clientY;
    user.yaw -= dx * 0.005; user.pitch = Math.min(0.5, Math.max(-0.3, user.pitch + dy * 0.004));
    user.vyaw = -dx * 0.005 * 60;
    user.touched = performance.now();
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
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(hostW, hostH);
    camera.aspect = hostW / hostH;
    layout(camera.aspect);
    measure();
    // A size-1 particle is about 5 CSS pixels across at the coins' distance.
    const px = 50 * renderer.getPixelRatio() * (hostH / 560);
    for (const m of [sparks.points.material, dust.points.material, motes.material]) m.uniforms.uScale.value = px;
    invalidate();
  }
  // The band the coins are framed in: under the top bar and any words being said, above the caption (and, on a
  // phone, the readout).
  function measure() {
    const cap = host.querySelector(".ar-cap"), first = cap?.querySelector(".ar-n");
    capTop = cap && first ? cap.offsetTop + first.offsetTop : hostH - 170;
    // Whoever speaks has its words above it, so the shot starts under them.
    insets.top = bubble?.classList.contains("on") ? 64 + bh : 58;
    // On a phone the readout sits over the caption, so the coins are framed above it too.
    insets.bottom = hostH - capTop + 8 + (narrow && hh ? hh + 10 : 0);
    camera.setViewOffset(hostW, hostH, 0, -(insets.top - insets.bottom) / 2, hostW, hostH);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  const sizes = new ResizeObserver(() => { bw = bubble?.offsetWidth || 0; bh = bubble?.offsetHeight || 0; hw = hud?.offsetWidth || 0; hh = hud?.offsetHeight || 0; measure(); invalidate(); });
  for (const el of [bubble, hud, host.querySelector(".ar-cap")]) if (el) sizes.observe(el);

  let raf = 0, pending = 0, visible = false, then = 0;
  const loop = (ms) => { raf = requestAnimationFrame(loop); const dt = Math.min(0.05, (ms - then) / 1000); then = ms; frame(dt); };
  // With reduced motion nothing runs on its own: a frame is drawn only when something changes.
  function invalidate() { if (calm || !raf) { if (!pending) pending = requestAnimationFrame(() => { pending = 0; frame(0); }); } }
  function run() {
    const on = visible && !document.hidden && !calm;
    if (on && !raf) { then = performance.now(); raf = requestAnimationFrame(loop); }
    else if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  document.addEventListener("visibilitychange", run);

  setTheme(theme.colors);
  resize();
  enter(k);
  // The first frame cuts straight to its shot.
  { const [pose] = shot(); cam.pos.copy(pose.pos); cam.look.copy(pose.look); cam.fromPos.copy(pose.pos); cam.fromLook.copy(pose.look); }

  return {
    setVisible(on) { visible = on; run(); },
    setBeat(n) { sparks.clear(); enter(n); },
    setPlaying(on) { playing = on && !calm; },
    setTheme({ colors }) { setTheme(colors); },
    loadIcons() { coins.forEach((c) => c.paint()); },
    dispose() {
      cancelAnimationFrame(raf); cancelAnimationFrame(pending);
      ro.disconnect(); sizes.disconnect();
      document.removeEventListener("visibilitychange", run);
      for (const [ev, f] of [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", cancel], ["pointerleave", leave]]) canvas.removeEventListener(ev, f);
      for (const m of [pathCore, pathGlow, beam, ...swaps]) m.geometry?.dispose();
      sparks.dispose(); dust.dispose(); target.dispose(); composer.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}
