/**
 * RealWorld.js — the realistic night look of the twin (the default; `L` switches to the neon twin).
 *
 *   • a moon over the night sky (the moonlight, fog and sky colours are set per look elsewhere)
 *   • ground that turns from city concrete to desert sand in zone 4, with dunes and the ridge that shadows 5G
 *   • tarmac road with lane markings, pavements and street lights through the city (zones 1–3)
 *   • the city blocks (RealCity.js) on the twin city's plots; date palms and rocks in the desert
 *   • road-sign gantries at the zone borders and a concrete dock apron with painted landing pads
 *
 * Visual only: built once from the route and the city plots, it never reads the simulation state.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Random } from '../utils/Random.js';
import { MOON_DIRECTION } from './SceneManager.js';
import { buildRealCity } from './RealCity.js';

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

/** Date palms as two instanced meshes (trunks, fronds) at spots {x, y, z, s, yaw, lean}. */
function palmGroup(spots) {
  const trunk = new THREE.CylinderGeometry(0.14, 0.24, 4.4, 6, 4);
  trunk.translate(0, 2.2, 0);
  const fronds = [];
  for (let i = 0; i < 9; i++) {
    const f = new THREE.ConeGeometry(0.34, 2.9, 4, 1);
    f.scale(1, 1, 0.22);
    f.translate(0, 1.45, 0);
    f.rotateZ(i % 2 ? -1.75 : -1.3); // arch out, alternate fronds droop
    f.rotateY((i / 9) * Math.PI * 2);
    f.translate(0, 4.35, 0);
    fronds.push(f);
  }
  const g = new THREE.Group();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (const [geo, color] of [[trunk, '#5b4838'], [mergeGeometries(fronds), '#3f7048']]) {
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9 }), spots.length);
    spots.forEach((o, i) => inst.setMatrixAt(i, m.compose(p.set(o.x, o.y, o.z), q.setFromEuler(e.set(o.lean, o.yaw, o.lean)), sc.setScalar(o.s))));
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
  return palmGroup(spots);
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
    buildRealCity({ boxes, rng: new Random('flexipath-real-city'), renderer, maxX: CITY_END_X, roadZ }),
    buildBoulevardPalms(path, rng),
    buildRocks(rng, height, roadZ),
    buildDesertPalms(rng, height, roadZ),
    buildGantries(path, gates),
    buildDock(pads, rng),
  );
  return g;
}
