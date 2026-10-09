/**
 * RealWorld.js — the realistic night look of the twin (the default; `L` switches to the neon twin).
 *
 *   • a moon over the night sky (the moonlight, fog and sky colours are set per look elsewhere)
 *   • ground that turns from city concrete to desert sand in zone 4, with dunes and the ridge that shadows 5G
 *   • tarmac road with lane markings, pavements and street lights through the city (zones 1–3)
 *   • the city blocks (RealCity.js) on the twin city's plots and its own infill; date palms and rocks in the desert
 *   • the city beyond the city (RealSkyline.js): a distant skyline, far street lights and a horizon glow
 *   • road-sign gantries at the zone borders and a concrete dock apron with painted landing pads
 *
 * Visual only: built once from the route and the city plots, it never reads the simulation state.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Random } from '../utils/Random.js';
import { MOON_DIRECTION } from './SceneManager.js';
import { buildRealCity } from './RealCity.js';
import { buildSkyline } from './RealSkyline.js';

const SAND_FROM_X = 150; // the ground turns from city to desert sand between these route X
const SAND_TO_X = 185;
const CITY_END_X = 158; // pavements, street lights and buildings stop here (end of zone 3)
const GANTRY_Y = 8.35; // sign height: the drones' corridor (≈ 5 units + airframe) passes under it

const smooth = (e0, e1, x) => THREE.MathUtils.smoothstep(x, e0, e1);
const CITY_GROUND = new THREE.Color('#2b2e33');
const SAND = new THREE.Color('#b0a088');
const SAND_CREST = new THREE.Color('#d6c4a2');

function canvasTexture(width, height, draw, srgb = true) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Fine grey grain, multiplied over a material colour (tarmac, concrete, sand). */
function grainTexture(rng, spread = 70) {
  return canvasTexture(256, 256, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 220 + (rng.next() - 0.5) * spread;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}

/** White centre fading to transparent: light pools and the moon's halo. */
function radialTexture() {
  return canvasTexture(128, 128, (g, w) => {
    const grad = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, w);
  });
}

/** Route centre-line Z as a function of X (X increases strictly along the route). */
function roadZLookup(path) {
  const pts = path.polyline(1);
  return (x) => {
    if (x <= pts[0].x) return pts[0].z;
    if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].z;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].x <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - pts[lo].x) / (pts[hi].x - pts[lo].x);
    return pts[lo].z + (pts[hi].z - pts[lo].z) * t;
  };
}

/** Desert surface height: flat on the road corridor, dunes beyond it, and the ridge behind zone 4. */
function duneHeight(roadZ) {
  return (x, z) => {
    const start = smooth(SAND_FROM_X + 5, SAND_TO_X + 10, x);
    if (start <= 0) return 0;
    const rz = roadZ(x);
    const corridor = smooth(13, 34, Math.abs(z - rz));
    const camSide = z > rz ? 0.3 : 1; // the camera rig sits on +Z: keep that side low
    const a = 0.5 + 0.5 * Math.sin(0.11 * x + 0.07 * z + 1.3 * Math.sin(0.031 * z));
    const b = 0.5 + 0.5 * Math.sin(0.23 * x - 0.13 * z + 0.8);
    const dunes = (4.2 * a * a + 1.6 * b * b * b) * camSide;
    const ridge = 19 * Math.exp(-(((z + 52) / 17) ** 2)) * (0.7 + 0.3 * Math.sin(x * 0.045 + 0.6)) * smooth(165, 205, x);
    return (dunes + ridge) * start * corridor;
  };
}

/** Ground colour at route X: city concrete, then sand, lighter on dune crests. */
function groundColor(x, h, jitter, out) {
  out.copy(CITY_GROUND).lerp(SAND, smooth(SAND_FROM_X, SAND_TO_X, x));
  if (h > 0) out.lerp(SAND_CREST, Math.min(1, h / 12));
  return out.multiplyScalar(0.9 + 0.2 * jitter);
}

function buildGround(rng) {
  const geo = new THREE.PlaneGeometry(1600, 900, 160, 90);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    groundColor(pos.getX(i) + 120, 0, rng.next(), c);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const map = grainTexture(rng);
  map.repeat.set(220, 124);
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 1, metalness: 0 }));
  ground.position.set(120, -0.03, -60);
  return ground;
}

function buildDunes(rng, height) {
  const W = 230;
  const D = 260;
  const cx = 255;
  const cz = -45;
  const geo = new THREE.PlaneGeometry(W, D, 150, 170);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx;
    const z = pos.getZ(i) + cz;
    const border = Math.min(x - (cx - W / 2), cx + W / 2 - x, z - (cz - D / 2), cz + D / 2 - z);
    const h = height(x, z) * smooth(0, 18, border);
    pos.setY(i, h);
    groundColor(x, h, rng.next(), c);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.computeVertexNormals();
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const map = grainTexture(rng);
  map.repeat.set(W / 7.3, D / 7.3); // same grain density as the ground plane
  const dunes = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 1, metalness: 0 }));
  dunes.position.set(cx, -0.01, cz);
  return dunes;
}

function buildRoad(path, ribbon, rng) {
  const g = new THREE.Group();
  const tarmac = grainTexture(rng, 60);
  tarmac.repeat.set(0.5, 3);
  g.add(ribbon(path.polyline(1), 7.6, 0.012, new THREE.MeshStandardMaterial({ color: '#55585e', map: tarmac, roughness: 0.92, metalness: 0.05 })));

  const paving = grainTexture(rng, 50);
  paving.repeat.set(0.5, 1);
  const paveMat = new THREE.MeshStandardMaterial({ color: '#76797e', map: paving, roughness: 0.95 });
  for (const lateral of [-9.1, 9.1]) g.add(ribbon(path.polyline(1, lateral).filter((p) => p.x < CITY_END_X), 1.5, 0.03, paveMat));

  const paint = new THREE.MeshStandardMaterial({ color: '#d7dbe0', emissive: '#d7dbe0', emissiveIntensity: 0.1, roughness: 0.6 });
  for (const lateral of [-7.0, 7.0]) g.add(ribbon(path.polyline(1, lateral), 0.09, 0.02, paint));
  const dashes = [];
  for (let s = 2; s < path.length; s += 6) dashes.push(ribbon([path.frameAt(s), path.frameAt(Math.min(path.length, s + 3))], 0.1, 0.02, paint).geometry);
  g.add(new THREE.Mesh(mergeGeometries(dashes), paint));
  return g;
}

/** Street lights on both pavements through the city, each with a warm pool of light on the road. */
function buildStreetLights(path) {
  const spots = [];
  const sEnd = path.sAtX(CITY_END_X);
  for (let s = 4; s < sEnd; s += 14) {
    for (const side of [-1, 1]) {
      const f = path.frameAt(Math.min(sEnd, s + (side > 0 ? 7 : 0)), side * 9.4);
      spots.push({ x: f.x, z: f.z, yaw: Math.atan2(side * f.tx, side * f.tz) }); // local +X (the arm) points across the road
    }
  }
  const pole = new THREE.CylinderGeometry(0.07, 0.11, 4.8, 6);
  pole.translate(0, 2.4, 0);
  const arm = new THREE.BoxGeometry(2.3, 0.08, 0.08);
  arm.translate(1.15, 4.75, 0);
  const head = new THREE.BoxGeometry(0.9, 0.12, 0.36);
  head.translate(2.15, 4.68, 0);
  const pool = new THREE.CircleGeometry(3.8, 28);
  pool.rotateX(-Math.PI / 2);
  pool.translate(2.3, 0.045, 0);

  const steel = new THREE.MeshStandardMaterial({ color: '#5d636b', metalness: 0.6, roughness: 0.5 });
  const lamp = new THREE.MeshStandardMaterial({ color: '#222222', emissive: '#ffd8a0', emissiveIntensity: 3 });
  const glow = new THREE.MeshBasicMaterial({
    map: radialTexture(),
    color: '#ffb866',
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const g = new THREE.Group();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  for (const [geo, mat] of [[pole, steel], [arm, steel], [head, lamp], [pool, glow]]) {
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach((sp, i) => inst.setMatrixAt(i, m.compose(p.set(sp.x, 0, sp.z), q.setFromAxisAngle(up, sp.yaw), one)));
    g.add(inst);
  }
  return g;
}

function buildRocks(rng, height, roadZ) {
  const inst = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ color: '#56483a', roughness: 0.95, flatShading: true }),
    40,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  let k = 0;
  for (let tries = 0; k < 40 && tries < 600; tries++) {
    const x = rng.range(172, 330);
    const z = rng.range(-140, 60);
    if (Math.abs(z - roadZ(x)) < 18) continue;
    const r = rng.range(0.5, 1.8);
    p.set(x, height(x, z) + r * 0.2, z);
    q.setFromEuler(e.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)));
    s.set(r * rng.range(1, 1.8), r * rng.range(0.6, 1), r * rng.range(1, 1.6));
    inst.setMatrixAt(k++, m.compose(p, q, s));
  }
  inst.count = k;
  return inst;
}

const PALM_H = 4.4; // trunk height; the crown sits on top
const PALM_BEND = 0.32; // how far the trunk curves out by the top

/** Bark: leaf-scar rings over warm grey-brown, darker in the grooves, a little uneven. */
function barkTexture(rng) {
  const tex = canvasTexture(64, 128, (g, w, h) => {
    g.fillStyle = '#7a6550';
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 8) {
      const tilt = rng.range(-2, 2);
      g.strokeStyle = 'rgba(38,28,20,0.85)';
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(0, y + 6);
      g.lineTo(w, y + 6 + tilt);
      g.stroke();
      g.fillStyle = 'rgba(160,138,110,0.35)';
      g.fillRect(0, y + 1, w, 2);
    }
    const img = g.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rng.next() - 0.5) * 30;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  });
  tex.repeat.set(1, 4);
  return tex;
}

/** One pinnate frond (u across, v along): leaflets angled towards the tip either side of a pale rachis, cut out by alpha. */
function frondTexture(rng) {
  const tex = canvasTexture(128, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let y = h - 6; y > 6; y -= 7) {
      const t = 1 - y / h; // 0 at the base, 1 at the tip
      const green = [52 + 70 * t + rng.range(-8, 8), 92 + 46 * t + rng.range(-8, 8), 40 + 16 * t];
      g.strokeStyle = `rgb(${green.map(Math.round).join(',')})`;
      g.lineWidth = 3.2;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(w / 2, y);
        g.quadraticCurveTo(w / 2 + side * w * 0.25, y - 10, w / 2 + side * (w / 2 - 3), y - 30 - rng.range(0, 6));
        g.stroke();
      }
    }
    g.strokeStyle = '#a49a62';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(w / 2, h);
    g.lineTo(w / 2, 0);
    g.stroke();
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * One frond as a folded ribbon along an arc: it leaves the crown at `rise` radians above horizontal and bends down by
 * `droop` radians by the tip; it is widest past the middle and folded into a shallow V along the rachis.
 */
function frondGeometry(length, rise, droop) {
  const N = 14;
  const pos = [];
  const uv = [];
  const idx = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const width = 0.05 + 1.05 * Math.sin(Math.PI * Math.min(1, t ** 0.8)) * (1 - 0.3 * t);
    const fold = 0.22 * width;
    for (const [side, u] of [
      [-1, 0],
      [0, 0.5],
      [1, 1],
    ]) {
      pos.push(x, y + (side ? fold : 0), (side * width) / 2);
      uv.push(u, t);
    }
    if (i < N) {
      const a = rise - (rise + droop) * ((i + 0.5) / N) ** 1.5;
      x += (length / N) * Math.cos(a);
      y += (length / N) * Math.sin(a);
      const o = i * 3;
      idx.push(o, o + 3, o + 1, o + 1, o + 3, o + 4, o + 1, o + 4, o + 2, o + 2, o + 4, o + 5);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A crown of 18 fronds in three tiers: young ones up, mature ones arching out, old ones hanging down. */
function crownGeometry(rng) {
  const tiers = [
    { n: 5, rise: [0.95, 1.25], droop: [0.2, 0.5], len: [2.2, 2.7] },
    { n: 7, rise: [0.45, 0.7], droop: [1.0, 1.4], len: [3.0, 3.5] },
    { n: 6, rise: [0.05, 0.25], droop: [1.5, 2.0], len: [2.9, 3.3] },
  ];
  const fronds = [];
  let k = 0;
  for (const tier of tiers) {
    for (let i = 0; i < tier.n; i++, k++) {
      const f = frondGeometry(rng.range(...tier.len), rng.range(...tier.rise), rng.range(...tier.droop));
      f.rotateX(rng.range(-0.25, 0.25)); // a little twist about the rachis
      f.rotateY(k * 2.39996 + rng.range(-0.15, 0.15)); // golden-angle spiral, so fronds never stack
      f.translate(PALM_BEND * 1.08, PALM_H + 0.25, 0); // on the curved trunk's top
      fronds.push(f);
    }
  }
  return mergeGeometries(fronds);
}

/** A gently curved, tapering trunk with a darker boot of old frond bases under the crown. */
function trunkGeometry() {
  const trunk = new THREE.CylinderGeometry(0.13, 0.21, PALM_H, 10, 8);
  trunk.translate(0, PALM_H / 2, 0);
  const boot = new THREE.CylinderGeometry(0.17, 0.26, 0.6, 10, 1);
  boot.translate(0, PALM_H + 0.05, 0);
  const g = mergeGeometries([trunk, boot]);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) + PALM_BEND * (pos.getY(i) / PALM_H) ** 2);
  g.computeVertexNormals();
  return g;
}

/** Warm landscape uplight: light that fades up from the ground (`reach` units), added in the shader. */
function withPalmUplight(material, strength, reach) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uUp = { value: new THREE.Color('#ffb36b').multiplyScalar(strength) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLocalY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalY = transformed.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uUp;\nvarying float vLocalY;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += uUp * diffuseColor.rgb * exp(-vLocalY / ${reach.toFixed(2)});`);
  };
  return material;
}

/**
 * Date palms at spots {x, y, z, s, yaw, lean} as instanced trunks and crowns. Boulevard palms (`uplit`) stand in a
 * warm pool from a ground uplight that also lights the trunk and the underside of the crown.
 */
function palmGroup(spots, { uplit = false } = {}) {
  // Their own stream: the palms' shape and textures never shift anything else in the realistic world.
  const rng = new Random('flexipath-real-palms');
  const bark = barkTexture(rng);
  const frond = frondTexture(rng);
  const trunkMat = new THREE.MeshStandardMaterial({ map: bark, roughness: 0.95 });
  const crownMat = new THREE.MeshStandardMaterial({ map: frond, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75, emissive: '#10200c' });
  if (uplit) {
    withPalmUplight(trunkMat, 0.9, 1.6);
    withPalmUplight(crownMat, 0.55, 3.2);
  }
  const g = new THREE.Group();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const parts = [
    [trunkGeometry(), trunkMat],
    [crownGeometry(rng), crownMat],
  ];
  for (const [geo, mat] of parts) {
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach((o, i) => inst.setMatrixAt(i, m.compose(p.set(o.x, o.y, o.z), q.setFromEuler(e.set(o.lean, o.yaw, o.lean)), sc.setScalar(o.s))));
    g.add(inst);
  }
  if (uplit) {
    const pool = new THREE.CircleGeometry(1.7, 24);
    pool.rotateX(-Math.PI / 2);
    pool.translate(0, 0.05, 0);
    const glow = new THREE.MeshBasicMaterial({ map: radialTexture(), color: '#ffab5e', transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const inst = new THREE.InstancedMesh(pool, glow, spots.length);
    spots.forEach((o, i) => inst.setMatrixAt(i, m.compose(p.set(o.x, o.y, o.z), q.identity(), sc.setScalar(1))));
    g.add(inst);
  }
  return g;
}

/** A small date-palm grove where the desert begins. */
function buildDesertPalms(rng, height, roadZ) {
  const spots = [];
  for (let tries = 0; spots.length < 14 && tries < 200; tries++) {
    const x = rng.range(166, 200);
    const side = rng.next() < 0.5 ? -1 : 1;
    const z = roadZ(x) + side * rng.range(16, 34);
    if (spots.some((o) => Math.hypot(o.x - x, o.z - z) < 3.5)) continue;
    spots.push({ x, y: height(x, z), z, s: rng.range(0.8, 1.15), yaw: rng.range(0, Math.PI * 2), lean: rng.range(-0.08, 0.08) });
  }
  return palmGroup(spots);
}

/** Palms lining both pavements through the city, clear of the network masts and the dock. */
function buildBoulevardPalms(path, rng) {
  const keepOut = [
    { x: 22, z: -14, r: 3.5 }, // Wi-Fi pole
    { x: 125, z: -22, r: 5 }, // 5G mast
    { x: -1, z: 0, r: 11 }, // dock apron
  ];
  const spots = [];
  const sEnd = path.sAtX(CITY_END_X - 4);
  for (let s = 8; s < sEnd; s += 12) {
    for (const side of [-1, 1]) {
      const f = path.frameAt(Math.min(sEnd, s + (side > 0 ? 6 : 0)), side * 12.4);
      if (keepOut.some((k) => Math.hypot(k.x - f.x, k.z - f.z) < k.r)) continue;
      spots.push({ x: f.x, y: 0, z: f.z, s: rng.range(0.85, 1.05), yaw: rng.range(0, Math.PI * 2), lean: rng.range(-0.05, 0.05) });
    }
  }
  return palmGroup(spots, { uplit: true });
}

function signTexture(title, sub, color) {
  return canvasTexture(512, 120, (g, w, h) => {
    g.fillStyle = '#0d2a1f';
    g.fillRect(0, 0, w, h);
    g.fillStyle = color;
    g.fillRect(0, 0, 18, h);
    g.strokeStyle = '#e8edf2';
    g.lineWidth = 5;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = '#f1f5f9';
    g.font = 'bold 50px "Segoe UI", Arial, sans-serif';
    g.fillText(title, 40, 58);
    g.font = '600 26px "Segoe UI", Arial, sans-serif';
    g.fillText(sub, 40, 96);
  });
}

/** Cantilever road-sign gantries where the twin has its neon zone gates. */
function buildGantries(path, gates) {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: '#7a8087', metalness: 0.65, roughness: 0.45 });
  const back = new THREE.MeshStandardMaterial({ color: '#30353b', metalness: 0.4, roughness: 0.6 });
  const box = (w, h, d, mat, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    return mesh;
  };
  for (const gate of gates) {
    const f = path.frameAt(path.sAtX(gate.x));
    // Cantilever: one post on the far (−Z) side and an arm over the lanes, so nothing stands between the
    // chase camera (+Z side) and the drones.
    const gantry = new THREE.Group();
    const post = -9.0;
    const tip = 3.4;
    const mid = (post + tip) / 2;
    gantry.add(box(0.45, GANTRY_Y + 0.5, 0.45, steel, 0, (GANTRY_Y + 0.5) / 2, post));
    for (const y of [GANTRY_Y - 0.35, GANTRY_Y + 0.35]) gantry.add(box(0.22, 0.22, tip - post + 0.2, steel, 0, y, mid));
    for (let k = 0; k < 6; k++) {
      const strut = box(0.08, 0.95, 0.08, steel, 0, GANTRY_Y, post + 1.1 + k * 2.1);
      strut.rotation.x = k % 2 ? 0.75 : -0.75;
      gantry.add(strut);
    }
    const tex = signTexture(gate.title, gate.sub, gate.color);
    const face = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.5, roughness: 0.6 });
    // BoxGeometry material slots: +x, −x, +y, −y, +z, −z. The face looks back along the route, towards the drones.
    gantry.add(box(0.12, 1.5, 6.4, [back, face, back, back, back, back], -0.25, GANTRY_Y, mid));
    gantry.position.set(f.x, 0, f.z);
    gantry.rotation.y = f.heading;
    g.add(gantry);
  }
  return g;
}

/** Concrete dock apron with a painted landing pad under each drone. */
function buildDock(pads, rng) {
  const g = new THREE.Group();
  const concrete = grainTexture(rng, 50);
  concrete.repeat.set(4, 4);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(14, 16), new THREE.MeshStandardMaterial({ color: '#86888c', map: concrete, roughness: 0.95 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(-1, 0.035, 0);
  g.add(apron);
  const yellow = new THREE.MeshStandardMaterial({ color: '#e0b43a', emissive: '#e0b43a', emissiveIntensity: 0.12, roughness: 0.7 });
  const white = new THREE.MeshStandardMaterial({ color: '#e6e8eb', emissive: '#e6e8eb', emissiveIntensity: 0.1, roughness: 0.7 });
  const flat = (geo, mat) => {
    geo.rotateX(-Math.PI / 2);
    return new THREE.Mesh(geo, mat);
  };
  for (const f of pads) {
    const pad = new THREE.Group();
    pad.position.set(f.x, 0.045, f.z);
    pad.rotation.y = f.heading;
    pad.add(flat(new THREE.RingGeometry(2.0, 2.2, 56), yellow));
    for (const [w, d, z] of [
      [1.5, 0.18, -0.5],
      [1.5, 0.18, 0.5],
      [0.18, 1.0, 0],
    ]) {
      const bar = flat(new THREE.PlaneGeometry(w, d), white);
      bar.position.z = z;
      pad.add(bar);
    }
    g.add(pad);
  }
  return g;
}

function buildMoon() {
  const g = new THREE.Group();
  const centre = new THREE.Vector3(120, 0, 0).addScaledVector(MOON_DIRECTION, 1000);
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(170, 170),
    new THREE.MeshBasicMaterial({ map: radialTexture(), color: '#8ea6ff', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }),
  );
  const disc = new THREE.Mesh(new THREE.CircleGeometry(15, 48), new THREE.MeshBasicMaterial({ color: '#eef2ff', fog: false, toneMapped: false }));
  for (const mesh of [halo, disc]) {
    mesh.position.copy(centre);
    mesh.lookAt(120, 0, 0);
    g.add(mesh);
  }
  return g;
}

/**
 * @param {{world: object, boxes: Array<{x:number,z:number,w:number,d:number,h:number}>, pads: Array<object>,
 *          gates: Array<{x:number,title:string,sub:string,color:string}>, ribbon: Function,
 *          renderer: THREE.WebGLRenderer}} opts
 */
export function buildRealWorld({ world, boxes, pads, gates, ribbon, renderer }) {
  const rng = new Random('flexipath-real');
  const path = world.path;
  const roadZ = roadZLookup(path);
  const height = duneHeight(roadZ);
  const g = new THREE.Group();
  g.name = 'RealWorld';
  g.add(
    buildMoon(),
    buildGround(rng),
    buildDunes(rng, height),
    buildRoad(path, ribbon, rng),
    buildStreetLights(path),
    buildRealCity({ boxes, rng: new Random('flexipath-real-city'), infillRng: new Random('flexipath-real-city-infill'), renderer, maxX: CITY_END_X, roadZ }),
    buildSkyline({ rng: new Random('flexipath-real-skyline'), roadZ, cityEndX: CITY_END_X }),
    buildBoulevardPalms(path, rng),
    buildRocks(rng, height, roadZ),
    buildDesertPalms(rng, height, roadZ),
    buildGantries(path, gates),
    buildDock(pads, rng),
  );
  return g;
}
