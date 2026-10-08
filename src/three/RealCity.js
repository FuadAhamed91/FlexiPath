/**
 * RealCity.js — the realistic look's city: glass towers, office slabs, residential blocks and shopfronts.
 *
 * Built on the twin city's plots (EnvironmentManager.cityBoxes), with seeded variety:
 *   • glass towers: reflective curtain walls (a night-sky + city-glow environment map), a podium,
 *     setbacks, LED crown lines and the odd spire
 *   • office slabs: concrete spandrels and glass ribbon windows, lit floor by floor
 *   • residential blocks: sand-coloured concrete, framed windows, balconies, warm lights
 *   • lit shopfronts with signs along the street, parapets and rooftop plant on every roof
 * Each facade type is one canvas-painted tile (colour, emissive, roughness/metalness) mapped at a fixed world
 * scale, so storeys line up across a building; each material is one merged mesh (one draw call).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const FLOOR_H = 0.75; // one storey (≈ 3.75 m)
const ROWS = 16; // storeys per texture tile
const TILE_H = FLOOR_H * ROWS;
const SHOP_H = 0.95; // shopfront band
const SHOP_W = 1.6; // one shop
const FACADES = {
  curtain: { cols: 8, cellW: 0.75, px: 128 },
  ribbon: { cols: 4, cellW: 1.5, px: 256 },
  punched: { cols: 6, cellW: 0.9, px: 128 },
};
const SIGN_COLOURS = ['#ff5a5a', '#3fd2c7', '#ffb547', '#f4f6f8', '#7aa2ff', '#ff7ac8', '#9be15d'];

// ── Canvas painting ─────────────────────────────────────────────────────────
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function texture(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

/** Add fine noise to what is already painted (concrete, render). */
function grain(g, w, h, rng, amount) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/** Which windows of one storey are lit: dark floors, whole lit floors, or runs of lit offices. */
function floorPlan(rng, n, dark = 0.28, full = 0.27) {
  const roll = rng.next();
  const mode = roll < dark ? 'dark' : roll < dark + full ? 'full' : 'part';
  const lit = [];
  let on = rng.next() < 0.5;
  for (let k = 0; k < n; k++) {
    if (mode === 'part' && rng.next() < 0.35) on = !on;
    lit.push(mode === 'full' ? rng.next() > 0.06 : mode === 'part' ? on : rng.next() < 0.04);
  }
  return { lit, warm: rng.next() < 0.42, k: 0.45 + 0.5 * rng.next() };
}

/** Corridor and night lighting behind an unlit window: just enough to show the window grid. */
function dimWindow(e, x, y, w, h, rng) {
  const warm = rng.next() < 0.55;
  const a = 0.08 + 0.14 * rng.next();
  e.fillStyle = warm ? `rgba(255,200,140,${a})` : `rgba(200,215,255,${a})`;
  e.fillRect(x, y, w, h);
}

/** A lit interior: ceiling light, brighter at the top, desks and partitions in silhouette. */
function litWindow(c, e, x, y, w, h, warm, k, rng) {
  const [r, g, b] = warm ? [255, 210, 150] : [228, 236, 255];
  const grad = e.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, `rgba(${r},${g},${b},${k})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},${k * 0.5})`);
  e.fillStyle = grad;
  e.fillRect(x, y, w, h);
  e.fillStyle = `rgba(255,255,255,${0.45 * k})`;
  e.fillRect(x, y + 1, w, Math.max(2, h * 0.05));
  e.fillStyle = 'rgba(0,0,0,0.5)';
  for (let i = 0; i < 2; i++) {
    const fw = w * (0.12 + 0.22 * rng.next());
    e.fillRect(x + rng.next() * (w - fw), y + h * 0.64, fw, h * 0.36);
  }
  c.fillStyle = `rgba(${r},${g},${b},0.32)`;
  c.fillRect(x, y, w, h);
}

/** Facade tile → { map, emissiveMap, mrMap } (mrMap: green = roughness, blue = metalness). */
function paintFacade(kind, rng) {
  const { cols, px } = FACADES[kind];
  const ch = 64;
  const W = cols * px;
  const H = ROWS * ch;
  const [cc, c] = canvas(W, H);
  const [ec, e] = canvas(W, H);
  const [mc, m] = canvas(W, H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  const mr = (rough, metal) => `rgb(0,${rough},${metal})`;

  if (kind === 'curtain') {
    c.fillStyle = '#353c46'; // slim dark aluminium mullions
    c.fillRect(0, 0, W, H);
    m.fillStyle = mr(140, 220);
    m.fillRect(0, 0, W, H);
    for (let r = 0; r < ROWS; r++) {
      const plan = floorPlan(rng, cols);
      const y = r * ch;
      const ph = Math.round(ch * 0.76) - 2;
      for (let k = 0; k < cols; k++) {
        const x = k * px + 2;
        const pw = px - 4;
        // Blue-black glass, each pane a little different, with the city's lights faintly reflected in it.
        const lift = rng.next() * 0.08;
        const pane = c.createLinearGradient(x, y + 2, x + pw * 0.6, y + 2 + ph);
        pane.addColorStop(0, `rgb(${30 + 60 * lift},${44 + 70 * lift},${62 + 90 * lift})`);
        pane.addColorStop(0.55, '#0c141e');
        pane.addColorStop(1, '#070b11');
        c.fillStyle = pane;
        c.fillRect(x, y + 2, pw, ph);
        if (rng.next() < 0.35) {
          for (let i = 0; i < 3; i++) {
            c.fillStyle = rng.next() < 0.6 ? 'rgba(255,196,130,0.35)' : 'rgba(190,210,255,0.3)';
            c.fillRect(x + rng.next() * (pw - 4), y + 2 + ph * (0.35 + 0.6 * rng.next()), 2 + rng.next() * 3, 2);
          }
        }
        c.fillStyle = '#141b25'; // spandrel panel
        c.fillRect(x, y + 4 + ph, pw, ch - ph - 6);
        m.fillStyle = mr(18, 190);
        m.fillRect(x, y + 2, pw, ph);
        m.fillStyle = mr(110, 90);
        m.fillRect(x, y + 4 + ph, pw, ch - ph - 6);
        if (plan.lit[k]) litWindow(c, e, x, y + 2, pw, ph, plan.warm, plan.k * (0.85 + 0.15 * rng.next()), rng);
        else dimWindow(e, x, y + 2, pw, ph, rng);
      }
    }
  } else if (kind === 'ribbon') {
    c.fillStyle = '#7a8087'; // concrete
    c.fillRect(0, 0, W, H);
    grain(c, W, H, rng, 22);
    m.fillStyle = mr(215, 10);
    m.fillRect(0, 0, W, H);
    const half = px / 2;
    for (let r = 0; r < ROWS; r++) {
      const plan = floorPlan(rng, cols * 2, 0.28, 0.3);
      const y = r * ch + 6;
      const gh = Math.round(ch * 0.56);
      const band = c.createLinearGradient(0, y, 0, y + gh);
      band.addColorStop(0, '#1f2b38');
      band.addColorStop(1, '#080d13');
      c.fillStyle = band;
      c.fillRect(0, y, W, gh);
      m.fillStyle = mr(30, 160);
      m.fillRect(0, y, W, gh);
      for (let s = 0; s < cols * 2; s++) {
        if (plan.lit[s]) litWindow(c, e, s * half + 2, y, half - 4, gh, plan.warm, plan.k, rng);
        else dimWindow(e, s * half + 2, y, half - 4, gh, rng);
        c.fillStyle = '#353c45'; // mullion
        c.fillRect(s * half, y, 2, gh);
      }
      c.fillStyle = '#6f757c'; // sill shadow line
      c.fillRect(0, y + gh, W, 2);
    }
  } else {
    c.fillStyle = '#9b8b76'; // sand-coloured render
    c.fillRect(0, 0, W, H);
    grain(c, W, H, rng, 26);
    m.fillStyle = mr(235, 0);
    m.fillRect(0, 0, W, H);
    for (let r = 0; r < ROWS; r++) {
      const balconies = rng.next() < 0.55;
      for (let k = 0; k < cols; k++) {
        const x = k * px;
        const y = r * ch;
        const ww = Math.round(px * 0.46);
        const wh = Math.round(ch * 0.56);
        const wx = x + Math.round((px - ww) / 2);
        const wy = y + Math.round(ch * 0.14);
        c.fillStyle = '#5a5046'; // frame
        c.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
        const glass = c.createLinearGradient(0, wy, 0, wy + wh);
        glass.addColorStop(0, '#26303b');
        glass.addColorStop(1, '#10151c');
        c.fillStyle = glass;
        c.fillRect(wx, wy, ww, wh);
        m.fillStyle = mr(45, 110);
        m.fillRect(wx, wy, ww, wh);
        if (rng.next() >= 0.4) dimWindow(e, wx, wy, ww, wh, rng);
        else {
          const warm = rng.next() < 0.8;
          litWindow(c, e, wx, wy, ww, wh, warm, 0.55 + 0.4 * rng.next(), rng);
          if (rng.next() < 0.4) {
            e.fillStyle = 'rgba(0,0,0,0.65)'; // half-drawn curtain
            e.fillRect(wx, wy, ww * (0.3 + 0.3 * rng.next()), wh);
          }
        }
        if (balconies && k % 2 === 0) {
          c.fillStyle = '#7b6f60'; // balcony slab and railing
          c.fillRect(x + 8, wy + wh + 5, px - 16, 6);
          c.fillStyle = 'rgba(40,36,32,0.8)';
          for (let rx = x + 10; rx < x + px - 10; rx += 9) c.fillRect(rx, wy + wh - 9, 2, 14);
          c.fillRect(x + 8, wy + wh - 10, px - 16, 2);
        }
      }
    }
  }
  return { map: texture(cc, true), emissiveMap: texture(ec, true), mrMap: texture(mc, false) };
}

/** Shopfront band tile: four shops, each a lit sign over a glazed front with shelves and a door. */
function paintShops(rng) {
  const W = 1024;
  const H = 256;
  const [cc, c] = canvas(W, H);
  const [ec, e] = canvas(W, H);
  c.fillStyle = '#25282d';
  c.fillRect(0, 0, W, H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  for (let k = 0; k < 4; k++) {
    const x = k * 256;
    const sign = SIGN_COLOURS[Math.floor(rng.next() * SIGN_COLOURS.length)];
    c.fillStyle = '#16181c';
    c.fillRect(x + 10, 12, 236, 54);
    e.fillStyle = sign;
    e.globalAlpha = 0.85;
    e.fillRect(x + 14, 16, 228, 46);
    e.globalAlpha = 1;
    e.fillStyle = '#ffffff';
    let lx = x + 28;
    while (lx < x + 200) {
      const lw = 8 + rng.next() * 18; // lettering
      e.fillRect(lx, 28, lw, 22);
      lx += lw + 6;
    }
    const lit = rng.next() < 0.85;
    const warm = rng.next() < 0.6;
    if (lit) {
      const [r, g, b] = warm ? [255, 214, 160] : [235, 242, 255];
      const glow = e.createLinearGradient(0, 78, 0, 244);
      glow.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0.6)`);
      e.fillStyle = glow;
      e.fillRect(x + 12, 78, 232, 166);
      e.fillStyle = 'rgba(0,0,0,0.45)'; // shelves and displays
      for (let sy = 110; sy < 230; sy += 34) e.fillRect(x + 20, sy, 216, 5);
      c.fillStyle = `rgba(${r},${g},${b},0.4)`;
      c.fillRect(x + 12, 78, 232, 166);
    } else {
      c.fillStyle = '#0f1318';
      c.fillRect(x + 12, 78, 232, 166);
    }
    e.fillStyle = 'rgba(0,0,0,0.75)'; // door and mullions
    e.fillRect(x + 168, 130, 44, 114);
    c.fillStyle = '#25282d';
    for (const mx of [x + 92, x + 168]) {
      c.fillRect(mx, 78, 4, 166);
      e.fillRect(mx, 78, 4, 166);
    }
  }
  return { map: texture(cc, true), emissiveMap: texture(ec, true) };
}

/**
 * Light that isn't modelled as lamps: warm street-light spill and floodlighting that fades up a facade, plus a
 * faint sky fill, so walls read as walls at night instead of black voids. Added in the shader by world height.
 */
function withUplight(material, strength) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uUpWarm = { value: new THREE.Color('#ffc98f').multiplyScalar(0.4 * strength) };
    shader.uniforms.uSkyFill = { value: new THREE.Color('#9fb3d8').multiplyScalar(0.06 * strength) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uUpWarm;\nuniform vec3 uSkyFill;\nvarying float vWorldY;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += (diffuseColor.rgb + 0.1) * (uUpWarm * exp(-vWorldY / 2.8) + uSkyFill);',
      );
  };
  return material;
}

/** Night environment for reflections: dark sky, warm light-pollution glow and distant city lights. */
function nightEnvironment(renderer, rng) {
  const [cv, g] = canvas(1024, 512);
  const sky = g.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, '#04060c');
  sky.addColorStop(0.4, '#101828');
  sky.addColorStop(0.49, '#2a3142');
  sky.addColorStop(0.53, '#14161b');
  sky.addColorStop(1, '#070809');
  g.fillStyle = sky;
  g.fillRect(0, 0, 1024, 512);
  for (let i = 0; i < 1400; i++) {
    const warm = rng.next() < 0.65;
    g.fillStyle = warm ? `rgba(255,200,140,${0.3 + 0.7 * rng.next()})` : `rgba(210,225,255,${0.3 + 0.7 * rng.next()})`;
    g.fillRect(rng.next() * 1024, 244 + rng.next() * 26, 1 + rng.next() * 2, 1 + rng.next() * 1.5);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

// ── Geometry ────────────────────────────────────────────────────────────────
/**
 * The four walls of a block, outward-facing, with u running left → right as seen from outside (in cells of the
 * facade tile, from `u`) and v = `v` + absolute height / tile height, so storeys line up between tiers.
 */
function walls(x0, x1, z0, z1, y0, y1, tileW, tileH, { u: uOff = 0, v: vOff = 0, outset = 0 } = {}) {
  x0 -= outset;
  x1 += outset;
  z0 -= outset;
  z1 += outset;
  const faces = [
    [[x0, z1], [x1, z1], [0, 0, 1]],
    [[x1, z0], [x0, z0], [0, 0, -1]],
    [[x1, z1], [x1, z0], [1, 0, 0]],
    [[x0, z0], [x0, z1], [-1, 0, 0]],
  ];
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  faces.forEach(([[ax, az], [bx, bz], n], f) => {
    const len = Math.hypot(bx - ax, bz - az);
    pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
    for (let i = 0; i < 4; i++) nor.push(...n);
    const u0 = uOff;
    const u1 = uOff + len / tileW;
    const v0 = vOff + y0 / tileH;
    const v1 = vOff + y1 / tileH;
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    const o = f * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function roof(x0, x1, z0, z1, y) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
}

/** Roof slab, parapet, and plant (AC units, tanks, a lift overrun) on a block's roof. */
function roofTop(out, rng, x0, x1, z0, z1, y, plant = true) {
  const w = x1 - x0;
  const d = z1 - z0;
  out.roof.push(roof(x0, x1, z0, z1, y));
  const t = 0.12;
  const ph = 0.28;
  out.roof.push(
    box(w, ph, t, (x0 + x1) / 2, y, z0 + t / 2),
    box(w, ph, t, (x0 + x1) / 2, y, z1 - t / 2),
    box(t, ph, d - 2 * t, x0 + t / 2, y, (z0 + z1) / 2),
    box(t, ph, d - 2 * t, x1 - t / 2, y, (z0 + z1) / 2),
  );
  if (!plant) return;
  const n = 1 + Math.floor(rng.next() * 3);
  for (let i = 0; i < n; i++) {
    const uw = 0.5 + rng.next() * Math.min(1.6, w * 0.3);
    const ud = 0.5 + rng.next() * Math.min(1.6, d * 0.3);
    const ux = x0 + 0.4 + uw / 2 + rng.next() * Math.max(0, w - uw - 0.8);
    const uz = z0 + 0.4 + ud / 2 + rng.next() * Math.max(0, d - ud - 0.8);
    if (rng.next() < 0.3) {
      const tank = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 10);
      tank.translate(ux, y + 0.3, uz);
      out.roof.push(tank);
    } else out.roof.push(box(uw, 0.35 + rng.next() * 0.5, ud, ux, y, uz));
  }
}

/** Thin LED lines around the top of a tower (architectural lighting). */
function crown(out, x0, x1, z0, z1, y, warm) {
  const list = warm ? out.ledWarm : out.led;
  const w = x1 - x0;
  const d = z1 - z0;
  const s = 0.06;
  for (const yy of [y - 0.12, y - 0.42]) {
    list.push(
      box(w + 0.04, s, s, (x0 + x1) / 2, yy, z0 - 0.02),
      box(w + 0.04, s, s, (x0 + x1) / 2, yy, z1 + 0.02),
      box(s, s, d + 0.04, x0 - 0.02, yy, (z0 + z1) / 2),
      box(s, s, d + 0.04, x1 + 0.02, yy, (z0 + z1) / 2),
    );
  }
}

/** One plot → a building: tower (podium, shaft, setback, crown, spire) or a mid/low-rise block. */
function planBuilding(out, b, rng) {
  const x0 = b.x - b.w / 2;
  const x1 = b.x + b.w / 2;
  const z0 = b.z - b.d / 2;
  const z1 = b.z + b.d / 2;
  const street = b.street ?? (b.z < 0 && b.z > -26); // first row on the near side lines the street
  const vOff = Math.floor(rng.next() * ROWS) / ROWS; // whole storeys, so neighbours don't repeat each other's floors
  const add = (kind, ax0, ax1, az0, az1, y0, y1) => {
    const f = FACADES[kind];
    const u = Math.floor(rng.next() * f.cols) / f.cols;
    out[kind].push(walls(ax0, ax1, az0, az1, y0, y1, f.cellW * f.cols, TILE_H, { u, v: vOff }));
  };
  const shops = (ax0, ax1, az0, az1) => {
    out.shop.push(walls(ax0, ax1, az0, az1, 0, SHOP_H, SHOP_W * 4, SHOP_H, { u: Math.floor(rng.next() * 4) / 4, outset: 0.02 }));
  };

  if (b.h >= 15) {
    // Tower: podium with shops, inset shaft, optional setback, crown and spire.
    const glass = rng.next() < 0.68;
    const kind = glass ? 'curtain' : 'ribbon';
    const podium = Math.round((1.6 + rng.next()) / FLOOR_H) * FLOOR_H;
    add('ribbon', x0, x1, z0, z1, 0, podium);
    if (street) shops(x0, x1, z0, z1);
    const ix = b.w * (0.1 + 0.08 * rng.next());
    const iz = b.d * (0.1 + 0.08 * rng.next());
    const sx0 = x0 + ix;
    const sx1 = x1 - ix;
    const sz0 = z0 + iz;
    const sz1 = z1 - iz;
    roofTop(out, rng, x0, x1, z0, z1, podium, false);
    const setback = rng.next() < 0.45;
    const top = b.h;
    const mid = setback ? Math.round((top * (0.62 + 0.14 * rng.next())) / FLOOR_H) * FLOOR_H : top;
    add(kind, sx0, sx1, sz0, sz1, podium, mid);
    let [tx0, tx1, tz0, tz1] = [sx0, sx1, sz0, sz1];
    if (setback) {
      const jx = (sx1 - sx0) * 0.14;
      const jz = (sz1 - sz0) * 0.14;
      [tx0, tx1, tz0, tz1] = [sx0 + jx, sx1 - jx, sz0 + jz, sz1 - jz];
      roofTop(out, rng, sx0, sx1, sz0, sz1, mid, false);
      add(kind, tx0, tx1, tz0, tz1, mid, top);
    }
    roofTop(out, rng, tx0, tx1, tz0, tz1, top);
    const warmLeds = rng.next() < 0.3;
    if (glass && rng.next() < 0.7) crown(out, tx0, tx1, tz0, tz1, top, warmLeds);
    if (glass && rng.next() < 0.35) {
      // LED lines up the shaft's corners
      const list = warmLeds ? out.ledWarm : out.led;
      for (const [cx, cz] of [[sx0, sz0], [sx1, sz0], [sx0, sz1], [sx1, sz1]]) list.push(box(0.05, mid - podium, 0.05, cx, podium, cz));
    }
    if (top > 24 && rng.next() < 0.35) {
      const spire = new THREE.CylinderGeometry(0.05, 0.16, 3 + rng.next() * 4, 8);
      spire.translate((tx0 + tx1) / 2, top + spire.parameters.height / 2, (tz0 + tz1) / 2);
      out.roof.push(spire);
    }
  } else {
    // Mid / low-rise block, shops on the street side.
    const kind = rng.next() < (b.h >= 8 ? 0.45 : 0.25) ? 'ribbon' : 'punched';
    const h = Math.max(FLOOR_H * 3, Math.round(b.h / FLOOR_H) * FLOOR_H);
    add(kind, x0, x1, z0, z1, 0, h);
    if (street && rng.next() < 0.75) shops(x0, x1, z0, z1);
    roofTop(out, rng, x0, x1, z0, z1, h);
  }
}

/**
 * Low-rise shops and flats along the camera (+Z) side of the street, which the twin keeps open: 2–5 storeys,
 * so they never block the chase or cinematic camera's view of the drones.
 */
function streetSidePlots(roadZ, rng, maxX) {
  const plots = [];
  for (let x = 10; x < maxX - 4; ) {
    const w = rng.range(4, 7.5);
    if (rng.next() < 0.82) {
      const d = rng.range(4.5, 7.5);
      plots.push({ x: x + w / 2, z: roadZ(x + w / 2) + 15.5 + d / 2 + rng.range(0, 2), w, d, h: rng.range(1.6, 4.2), street: true });
    }
    x += w + rng.range(0.8, 2.2);
  }
  return plots;
}

/**
 * @param {{boxes: Array<{x:number,z:number,w:number,d:number,h:number}>, rng: object, renderer: THREE.WebGLRenderer,
 *          maxX: number, roadZ: (x:number) => number}} opts
 */
export function buildRealCity({ boxes, rng, renderer, maxX, roadZ }) {
  const env = nightEnvironment(renderer, rng);
  const out = { curtain: [], ribbon: [], punched: [], shop: [], roof: [], led: [], ledWarm: [] };
  for (const b of boxes) if (b.x <= maxX) planBuilding(out, b, rng);
  for (const b of streetSidePlots(roadZ, rng, maxX)) planBuilding(out, b, rng);

  const facadeMat = (tex, envMapIntensity, uplight) =>
    withUplight(
      new THREE.MeshStandardMaterial({
        map: tex.map,
        emissiveMap: tex.emissiveMap,
        emissive: '#ffffff',
        emissiveIntensity: 1.2,
        roughnessMap: tex.mrMap,
        metalnessMap: tex.mrMap,
        roughness: 1,
        metalness: 1,
        envMap: env,
        envMapIntensity,
      }),
      uplight,
    );
  const shopTex = paintShops(rng);
  const materials = {
    curtain: facadeMat(paintFacade('curtain', rng), 1.8, 0.7),
    ribbon: facadeMat(paintFacade('ribbon', rng), 1.2, 1),
    punched: facadeMat(paintFacade('punched', rng), 0.35, 1.2),
    shop: new THREE.MeshStandardMaterial({
      map: shopTex.map,
      emissiveMap: shopTex.emissiveMap,
      emissive: '#ffffff',
      emissiveIntensity: 1.05,
      roughness: 0.5,
      metalness: 0.3,
      envMap: env,
      envMapIntensity: 0.5,
    }),
    roof: new THREE.MeshStandardMaterial({ color: '#46494e', roughness: 0.9, metalness: 0.15, envMap: env, envMapIntensity: 0.2 }),
    led: new THREE.MeshStandardMaterial({ color: '#0b0d10', emissive: '#d9e6ff', emissiveIntensity: 2.4 }),
    ledWarm: new THREE.MeshStandardMaterial({ color: '#0b0d10', emissive: '#ffd6a0', emissiveIntensity: 2.2 }),
  };
  const city = new THREE.Group();
  city.name = 'RealCity';
  for (const [key, geos] of Object.entries(out)) {
    if (geos.length) city.add(new THREE.Mesh(mergeGeometries(geos), materials[key]));
  }
  return city;
}
