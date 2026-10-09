/**
 * RealSkyline.js — the city beyond the city, so the realistic look doesn't end in a black void:
 *   • a distant skyline band with lit windows on both sides of the route and behind the dock, tallest behind the
 *     downtown core (zone 2) and thinning out where the desert begins;
 *   • street lights on the far ground between those blocks;
 *   • a warm light-pollution glow over the horizon on the city side (none over the desert).
 * Cheap on purpose: one merged mesh, one point cloud and one glow band. Visual only, with its own random stream.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { walls, roof } from './RealCity.js';

const TILE_W = 8; // distant facade tile: 8 window columns of 1 unit …
const TILE_H = 12; // … by 16 storeys of 0.75 units
const GLOW_CENTRE = new THREE.Vector3(60, 0, -20);

function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Distant facades: dark walls with small windows, a third of them lit, whole floors dark or lit at times. */
function distantFacade(rng) {
  const cols = 8;
  const rows = 16;
  const S = 256;
  const cw = S / cols;
  const ch = S / rows;
  const lit = [];
  for (let r = 0; r < rows; r++) {
    const mode = rng.next();
    let on = rng.next() < 0.5;
    for (let k = 0; k < cols; k++) {
      if (mode > 0.55 && rng.next() < 0.35) on = !on;
      const isLit = mode < 0.35 ? rng.next() < 0.05 : mode < 0.55 ? rng.next() > 0.1 : on;
      lit.push(isLit ? { warm: rng.next() < 0.7, a: 0.55 + 0.45 * rng.next() } : null);
    }
  }
  const cell = (g, paint) => {
    for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) paint(g, k * cw + 4, r * ch + 3, cw - 8, ch - 6, lit[r * cols + k]);
  };
  const map = canvasTexture(S, S, (g) => {
    g.fillStyle = '#1a1d23';
    g.fillRect(0, 0, S, S);
    cell(g, (gg, x, y, w, h, l) => {
      gg.fillStyle = l ? (l.warm ? '#7a5e3e' : '#5d6678') : '#0c0f13';
      gg.fillRect(x, y, w, h);
    });
  });
  const emissiveMap = canvasTexture(S, S, (g) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    cell(g, (gg, x, y, w, h, l) => {
      if (!l) return;
      gg.fillStyle = l.warm ? `rgba(255,196,128,${l.a})` : `rgba(206,222,255,${l.a})`;
      gg.fillRect(x, y, w, h);
    });
  });
  return { map, emissiveMap };
}

function dotTexture() {
  return canvasTexture(64, 64, (g, w) => {
    const grad = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, w);
  });
}

const smooth = (e0, e1, x) => THREE.MathUtils.smoothstep(x, e0, e1);

/**
 * @param {{rng: object, roadZ: (x:number)=>number, cityEndX: number}} opts
 */
export function buildSkyline({ rng, roadZ, cityEndX }) {
  const g = new THREE.Group();
  g.name = 'RealSkyline';
  const facades = [];
  const roofs = [];
  const blocks = [];
  // 1 through the city, 0 past the desert edge; the downtown core (zone 2) gets the tallest towers.
  const cityFade = (x) => 1 - smooth(cityEndX - 15, cityEndX + 20, x);
  const core = (x) => Math.exp(-(((x - 65) / 75) ** 2));
  const place = (x, z, w, d, h) => {
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    const v = Math.floor(rng.next() * 16) / 16;
    facades.push(walls(x0, x1, z0, z1, 0, h, TILE_W, TILE_H, { u: Math.floor(rng.next() * 8) / 8, v }));
    roofs.push(roof(x0, x1, z0, z1, h));
    blocks.push({ x0, x1, z0, z1 });
  };

  // Far side (−Z), 92 → 250 units from the road, and the camera side (+Z), 115 → 250, lower.
  for (const side of [-1, 1]) {
    const near = side < 0 ? 92 : 115;
    for (let off = near; off < 250; off += rng.range(9, 14)) {
      const depth = (off - near) / (250 - near); // 0 near → 1 far
      for (let x = -200; x < cityEndX + 25; x += rng.range(7, 12)) {
        const fade = cityFade(x);
        if (rng.next() > 0.78 * fade) continue;
        const tall = side < 0 ? 22 + 40 * core(x) : 12 + 14 * core(x);
        const h = rng.range(7, tall) * (1 - 0.3 * depth) * (0.55 + 0.45 * fade);
        place(x + rng.range(-2, 2), roadZ(x) + side * (off + rng.range(-3, 3)), rng.range(5, 11), rng.range(5, 11), h);
      }
    }
  }
  // Behind the dock (−X), where the road begins.
  for (let x = -110; x > -255; x -= rng.range(9, 13)) {
    for (let z = -160; z < 160; z += rng.range(8, 13)) {
      if (rng.next() > 0.72) continue;
      place(x + rng.range(-2, 2), z, rng.range(5, 10), rng.range(5, 10), rng.range(6, 24));
    }
  }

  const tex = distantFacade(rng);
  const facadeMat = new THREE.MeshStandardMaterial({ map: tex.map, emissiveMap: tex.emissiveMap, emissive: '#ffffff', emissiveIntensity: 1.5, roughness: 1, metalness: 0 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#202328', roughness: 1, metalness: 0 });
  g.add(new THREE.Mesh(mergeGeometries(facades), facadeMat), new THREE.Mesh(mergeGeometries(roofs), roofMat));

  // Street lights on the far ground: a loose grid of lit streets between the blocks.
  const pts = [];
  const cols = [];
  const warm = new THREE.Color('#ffb05c');
  const cool = new THREE.Color('#d9e4ff');
  const inBlock = (x, z) => blocks.some((b) => x > b.x0 - 0.3 && x < b.x1 + 0.3 && z > b.z0 - 0.3 && z < b.z1 + 0.3);
  const street = (x, z) => {
    if (cityFade(x) < 0.2 || inBlock(x, z)) return;
    pts.push(x, 0.35, z);
    const c = rng.next() < 0.82 ? warm : cool;
    const k = 0.6 + 0.4 * rng.next();
    cols.push(c.r * k, c.g * k, c.b * k);
  };
  for (const side of [-1, 1]) {
    const near = side < 0 ? 86 : 108;
    for (let off = near; off < 255; off += rng.range(12, 17)) for (let x = -205; x < cityEndX + 25; x += 2.6) street(x, roadZ(x) + side * off);
    for (let x = -200; x < cityEndX + 25; x += rng.range(16, 24)) for (let off = near; off < 255; off += 2.6) street(x, roadZ(x) + side * off);
  }
  for (let x = -100; x > -260; x -= rng.range(14, 18)) for (let z = -165; z < 165; z += 2.6) street(x, z);
  for (let z = -160; z < 160; z += rng.range(14, 18)) for (let x = -100; x > -260; x -= 2.6) street(x, z);
  const dotsGeo = new THREE.BufferGeometry();
  dotsGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  dotsGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const dots = new THREE.Points(
    dotsGeo,
    new THREE.PointsMaterial({ size: 1.5, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }),
  );
  g.add(dots);

  // Light-pollution glow over the horizon: an open band around the scene, warm at the bottom, none over the desert.
  const R = 380;
  const H = 70;
  const glowGeo = new THREE.CylinderGeometry(R, R, H, 128, 8, true);
  glowGeo.translate(GLOW_CENTRE.x, H / 2 - 4, GLOW_CENTRE.z);
  const pos = glowGeo.attributes.position;
  const glowCols = new Float32Array(pos.count * 3);
  const amber = new THREE.Color('#ff9a52');
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - GLOW_CENTRE.x;
    const dz = pos.getZ(i) - GLOW_CENTRE.z;
    const angle = Math.abs(Math.atan2(dz, dx)); // 0 = towards the desert (+X)
    const v = THREE.MathUtils.clamp((pos.getY(i) + 4) / H, 0, 1);
    const k = 0.3 * smooth(0.45, 1.25, angle) * (1 - v) ** 2.4;
    glowCols.set([amber.r * k, amber.g * k, amber.b * k], i * 3);
  }
  glowGeo.setAttribute('color', new THREE.BufferAttribute(glowCols, 3));
  const glow = new THREE.Mesh(
    glowGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide, fog: false, toneMapped: false }),
  );
  glow.renderOrder = -1;
  g.add(glow);
  return g;
}
