/**
 * RealCity.js — the realistic look's city: glass towers, office slabs, residential blocks and shopfronts.
 *
 * Built on the twin city's plots (EnvironmentManager.cityBoxes), with seeded variety:
 *   • towers in blue, bronze, teal or silver glass (reflecting a night-sky + city-glow environment map) or stone, on a
 *     stone podium: round towers, twin towers, stepped and classic shafts, with LED crowns, spires or pyramid caps
 *   • office slabs in concrete, granite or limestone with glass ribbon windows, lit floor by floor
 *   • residential blocks in sand, white or terracotta render, framed windows, balconies, warm lights; L-shaped,
 *     terraced, or two neighbours of different heights on one plot
 *   • lit shopfronts with signs along the street, parapets and rooftop plant on every roof
 *   • red aviation lights on the tall towers and a few lit rooftop helipads
 * Each facade style is one canvas-painted tile (colour, emissive, roughness/metalness) mapped at a fixed world scale,
 * so storeys line up across a building; each material is one merged mesh (one draw call). Every building also gets its
 * own wall tint (vertex colour) and window light level and colour (`aGlow`), so no two read the same.
 *
 * Besides the twin's plots, the realistic look fills in its own plots (`infillPlots`): rows behind the street rising
 * to a downtown skyline in zone 2, low-rise rows on the camera side and a city edge behind the dock. They come from
 * their own random stream, so the buildings on the twin's plots look exactly as before.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const FLOOR_H = 0.75; // one storey (≈ 3.75 m)
const ROWS = 16; // storeys per texture tile
const TILE_H = FLOOR_H * ROWS;
const SHOP_H = 0.95; // shopfront band
const SHOP_W = 1.6; // one shop
/** Tile layout per facade type: window columns, cell width (world units) and canvas pixels per column. */
const LAYOUT = {
  curtain: { cols: 8, cellW: 0.75, px: 128 },
  ribbon: { cols: 4, cellW: 1.5, px: 256 },
  punched: { cols: 6, cellW: 0.9, px: 128 },
};
/**
 * Facade styles: `type` picks the painter and tile layout, the palette the look. Each style is one texture set and one
 * merged mesh; every building also gets its own wall tint and window light level (vertex attributes), so two
 * buildings in the same style still differ.
 */
const STYLES = {
  // Curtain walls: pane = glass height per storey, fin = mullion width (px), dark / full = share of dark / fully lit floors.
  glassBlue: { type: 'curtain', mullion: '#353c46', glass: [30, 44, 62], mid: '#0c141e', low: '#070b11', spandrel: '#141b25', env: 1.8 },
  glassBronze: { type: 'curtain', mullion: '#3d362e', glass: [62, 46, 30], mid: '#1c140d', low: '#0e0a07', spandrel: '#231b14', env: 1.6, pane: 0.84, fin: 6, dark: 0.38, full: 0.2 },
  glassTeal: { type: 'curtain', mullion: '#2c3b3c', glass: [22, 58, 60], mid: '#09191a', low: '#050e0e', spandrel: '#0f1e1e', env: 1.8, pane: 0.7, fin: 14, dark: 0.22, full: 0.4 },
  glassSilver: { type: 'curtain', mullion: '#70757e', glass: [78, 86, 98], mid: '#262c34', low: '#151a20', spandrel: '#3d424a', env: 2.1, pane: 0.56, fin: 3, dark: 0.3, full: 0.3 },
  // Ribbon offices: bandH = window band height per storey.
  concrete: { type: 'ribbon', wall: '#7a8087', sill: '#6f757c', band: ['#1f2b38', '#080d13'], mullion: '#353c45' },
  granite: { type: 'ribbon', wall: '#4d5057', sill: '#404349', band: ['#1d2530', '#070a0f'], mullion: '#2a2d33', bandH: 0.42, dark: 0.2, full: 0.42 },
  limestone: { type: 'ribbon', wall: '#a59c8a', sill: '#8f8676', band: ['#22303b', '#0a1016'], mullion: '#5b554b', bandH: 0.68, dark: 0.34, full: 0.22 },
  // Punched render: win = window width per cell, lit = share of lit windows.
  sand: { type: 'punched', wall: '#9b8b76', frame: '#5a5046', balcony: '#7b6f60' },
  white: { type: 'punched', wall: '#c2bdb3', frame: '#6c6a66', balcony: '#a39f97', win: 0.34, lit: 0.3 },
  terracotta: { type: 'punched', wall: '#93583e', frame: '#4b3026', balcony: '#7a4c3c', win: 0.56, lit: 0.48 },
};
const GLASS = ['glassBlue', 'glassBlue', 'glassBronze', 'glassTeal', 'glassSilver'];
const STONE = ['concrete', 'granite', 'limestone'];
const RENDER = ['sand', 'sand', 'white', 'terracotta'];
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

/** Facade tile for one style → { map, emissiveMap, mrMap } (mrMap: green = roughness, blue = metalness). */
function paintFacade(id, rng) {
  const st = STYLES[id];
  const { cols, px } = LAYOUT[st.type];
  const ch = 64;
  const W = cols * px;
  const H = ROWS * ch;
  const [cc, c] = canvas(W, H);
  const [ec, e] = canvas(W, H);
  const [mc, m] = canvas(W, H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  const mr = (rough, metal) => `rgb(0,${rough},${metal})`;

  if (st.type === 'curtain') {
    c.fillStyle = st.mullion; // slim aluminium mullions
    c.fillRect(0, 0, W, H);
    m.fillStyle = mr(140, 220);
    m.fillRect(0, 0, W, H);
    for (let r = 0; r < ROWS; r++) {
      const plan = floorPlan(rng, cols, st.dark ?? 0.28, st.full ?? 0.27);
      const y = r * ch;
      const ph = Math.round(ch * (st.pane ?? 0.76)) - 2;
      const fin = st.fin ?? 4;
      for (let k = 0; k < cols; k++) {
        const x = k * px + fin / 2;
        const pw = px - fin;
        // Tinted glass, each pane a little different, with the city's lights faintly reflected in it.
        const lift = 1 + rng.next() * 0.25;
        const [gr, gg, gb] = st.glass;
        const pane = c.createLinearGradient(x, y + 2, x + pw * 0.6, y + 2 + ph);
        pane.addColorStop(0, `rgb(${Math.round(gr * lift)},${Math.round(gg * lift)},${Math.round(gb * lift)})`);
        pane.addColorStop(0.55, st.mid);
        pane.addColorStop(1, st.low);
        c.fillStyle = pane;
        c.fillRect(x, y + 2, pw, ph);
        if (rng.next() < 0.35) {
          for (let i = 0; i < 3; i++) {
            c.fillStyle = rng.next() < 0.6 ? 'rgba(255,196,130,0.35)' : 'rgba(190,210,255,0.3)';
            c.fillRect(x + rng.next() * (pw - 4), y + 2 + ph * (0.35 + 0.6 * rng.next()), 2 + rng.next() * 3, 2);
          }
        }
        c.fillStyle = st.spandrel; // spandrel panel
        c.fillRect(x, y + 4 + ph, pw, ch - ph - 6);
        m.fillStyle = mr(18, 190);
        m.fillRect(x, y + 2, pw, ph);
        m.fillStyle = mr(110, 90);
        m.fillRect(x, y + 4 + ph, pw, ch - ph - 6);
        if (plan.lit[k]) litWindow(c, e, x, y + 2, pw, ph, plan.warm, plan.k * (0.85 + 0.15 * rng.next()), rng);
        else dimWindow(e, x, y + 2, pw, ph, rng);
      }
    }
  } else if (st.type === 'ribbon') {
    c.fillStyle = st.wall; // concrete or stone
    c.fillRect(0, 0, W, H);
    grain(c, W, H, rng, 22);
    m.fillStyle = mr(215, 10);
    m.fillRect(0, 0, W, H);
    const half = px / 2;
    for (let r = 0; r < ROWS; r++) {
      const plan = floorPlan(rng, cols * 2, st.dark ?? 0.28, st.full ?? 0.3);
      const y = r * ch + 6;
      const gh = Math.round(ch * (st.bandH ?? 0.56));
      const band = c.createLinearGradient(0, y, 0, y + gh);
      band.addColorStop(0, st.band[0]);
      band.addColorStop(1, st.band[1]);
      c.fillStyle = band;
      c.fillRect(0, y, W, gh);
      m.fillStyle = mr(30, 160);
      m.fillRect(0, y, W, gh);
      for (let s = 0; s < cols * 2; s++) {
        if (plan.lit[s]) litWindow(c, e, s * half + 2, y, half - 4, gh, plan.warm, plan.k, rng);
        else dimWindow(e, s * half + 2, y, half - 4, gh, rng);
        c.fillStyle = st.mullion; // mullion
        c.fillRect(s * half, y, 2, gh);
      }
      c.fillStyle = st.sill; // sill shadow line
      c.fillRect(0, y + gh, W, 2);
    }
  } else {
    c.fillStyle = st.wall; // render
    c.fillRect(0, 0, W, H);
    grain(c, W, H, rng, 26);
    m.fillStyle = mr(235, 0);
    m.fillRect(0, 0, W, H);
    for (let r = 0; r < ROWS; r++) {
      const balconies = rng.next() < 0.55;
      for (let k = 0; k < cols; k++) {
        const x = k * px;
        const y = r * ch;
        const ww = Math.round(px * (st.win ?? 0.46));
        const wh = Math.round(ch * 0.56);
        const wx = x + Math.round((px - ww) / 2);
        const wy = y + Math.round(ch * 0.14);
        c.fillStyle = st.frame; // frame
        c.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
        const glass = c.createLinearGradient(0, wy, 0, wy + wh);
        glass.addColorStop(0, '#26303b');
        glass.addColorStop(1, '#10151c');
        c.fillStyle = glass;
        c.fillRect(wx, wy, ww, wh);
        m.fillStyle = mr(45, 110);
        m.fillRect(wx, wy, ww, wh);
        if (rng.next() >= (st.lit ?? 0.4)) dimWindow(e, wx, wy, ww, wh, rng);
        else {
          const warm = rng.next() < 0.8;
          litWindow(c, e, wx, wy, ww, wh, warm, 0.55 + 0.4 * rng.next(), rng);
          if (rng.next() < 0.4) {
            e.fillStyle = 'rgba(0,0,0,0.65)'; // half-drawn curtain
            e.fillRect(wx, wy, ww * (0.3 + 0.3 * rng.next()), wh);
          }
        }
        if (balconies && k % 2 === 0) {
          c.fillStyle = st.balcony; // balcony slab and railing
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
 * The windows' light is scaled per building by the `aGlow` attribute (level and colour), the walls by vertex colour,
 * and `aAccent` (colour, start height) washes the top of some towers in static architectural light.
 */
function withUplight(material, strength) {
  material.vertexColors = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uUpWarm = { value: new THREE.Color('#ffc98f').multiplyScalar(0.4 * strength) };
    shader.uniforms.uSkyFill = { value: new THREE.Color('#9fb3d8').multiplyScalar(0.06 * strength) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;\nattribute vec3 aGlow;\nvarying vec3 vGlow;\nattribute vec4 aAccent;\nvarying vec4 vAccent;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;\nvGlow = aGlow;\nvAccent = aAccent;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uUpWarm;\nuniform vec3 uSkyFill;\nvarying float vWorldY;\nvarying vec3 vGlow;\nvarying vec4 vAccent;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow;\ntotalEmissiveRadiance += vAccent.rgb * smoothstep(vAccent.w, vAccent.w + 4.0, vWorldY);\ntotalEmissiveRadiance += (diffuseColor.rgb + 0.1) * (uUpWarm * exp(-vWorldY / 2.8) + uSkyFill);',
      );
  };
  return material;
}

const pick = (rng, list) => list[Math.floor(rng.next() * list.length)];

/** Static architectural light for tower tops (a Gulf skyline at night): cool white, teal, blue, violet, amber, magenta. */
const ACCENTS = ['#a9d6ff', '#a9d6ff', '#4fd1c5', '#5f86ff', '#a98bff', '#ffb46b', '#ff8fd0'];
const NO_ACCENT = [0, 0, 0, 1e4];

/** A wash that fades in over the top 15–30 % of a tower, in one accent colour, for about a third of the towers. */
function accentFor(rng, base, top) {
  if (rng.next() > 0.34) return NO_ACCENT;
  const c = new THREE.Color(pick(rng, ACCENTS)).multiplyScalar(rng.range(0.16, 0.36));
  return [c.r, c.g, c.b, top - (top - base) * rng.range(0.15, 0.3)];
}

/**
 * One building's look: a wall tint (brightness and a slight warm/cool shift) and a window light level and colour.
 * Some buildings are bright offices, most are partly lit, some are nearly dark; homes lean warm, offices cool.
 */
function buildingLook(rng, residential) {
  const b = rng.range(0.78, 1.15);
  const shift = rng.range(-1, 1);
  const tint = [b * (1 + 0.06 * shift), b, b * (1 - 0.06 * shift)];
  const roll = rng.next();
  const level = roll < 0.2 ? rng.range(0.08, 0.25) : roll < 0.4 ? rng.range(0.4, 0.7) : roll < 0.72 ? rng.range(0.8, 1.1) : rng.range(1.25, 1.75);
  const warm = residential ? rng.range(0.2, 1) : rng.range(-1, 0.6);
  return { tint, glow: [level * (1 + 0.12 * warm), level * (1 + 0.02 * warm), level * (1 - 0.2 * warm)] };
}

/** Give every vertex of a facade geometry its building's tint (`color`), window light (`aGlow`) and crown wash (`aAccent`). */
function stamp(geo, look, accent = NO_ACCENT) {
  const n = geo.attributes.position.count;
  const color = new Float32Array(n * 3);
  const glow = new Float32Array(n * 3);
  const acc = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    color.set(look.tint, i * 3);
    glow.set(look.glow, i * 3);
    acc.set(accent, i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glow, 3));
  geo.setAttribute('aAccent', new THREE.BufferAttribute(acc, 4));
  return geo;
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
export function walls(x0, x1, z0, z1, y0, y1, tileW, tileH, { u: uOff = 0, v: vOff = 0, outset = 0 } = {}) {
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

export function roof(x0, x1, z0, z1, y) {
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

/** A round tower's wall, with the facade tile wrapped at the same world scale as the flat walls. */
function roundWalls(cx, cz, r, y0, y1, tileW, tileH, { u: uOff = 0, v: vOff = 0 } = {}) {
  const g = new THREE.CylinderGeometry(r, r, y1 - y0, 32, 1, true);
  g.translate(cx, (y0 + y1) / 2, cz);
  const uv = g.attributes.uv;
  const pos = g.attributes.position;
  const around = (2 * Math.PI * r) / tileW;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uOff + uv.getX(i) * around, vOff + pos.getY(i) / tileH);
  return g;
}

function disc(cx, cz, r, y) {
  const g = new THREE.CircleGeometry(r, 32);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, y, cz);
  return g;
}

/** An open ring (a round parapet or LED band) of height `h` from `y`. */
function ring(cx, cz, r, y, h) {
  const g = new THREE.CylinderGeometry(r, r, h, 32, 1, true);
  g.translate(cx, y + h / 2, cz);
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

/**
 * One plot → a building. Towers (h ≥ 15): a stone podium with shops on the street, then a round tower, twin towers,
 * a stepped tower or a classic shaft, topped by an LED crown, a spire or a pyramid cap. Mid-rises: plain, L-shaped or
 * terraced. Low-rises: one block or two joined ones of different heights. Every building gets its own style, wall
 * tint and window light level.
 */
function planBuilding(out, b, rng) {
  const x0 = b.x - b.w / 2;
  const x1 = b.x + b.w / 2;
  const z0 = b.z - b.d / 2;
  const z1 = b.z + b.d / 2;
  const street = b.street ?? (b.z < 0 && b.z > -26); // first row on the near side lines the street
  const vOff = Math.floor(rng.next() * ROWS) / ROWS; // whole storeys, so neighbours don't repeat each other's floors
  const snap = (h) => Math.max(FLOOR_H * 3, Math.round(h / FLOOR_H) * FLOOR_H);
  const block = (style, look, ax0, ax1, az0, az1, y0, y1, accent) => {
    const L = LAYOUT[STYLES[style].type];
    const u = Math.floor(rng.next() * L.cols) / L.cols;
    out[style].push(stamp(walls(ax0, ax1, az0, az1, y0, y1, L.cellW * L.cols, TILE_H, { u, v: vOff }), look, accent));
  };
  const shops = (ax0, ax1, az0, az1) => {
    out.shop.push(walls(ax0, ax1, az0, az1, 0, SHOP_H, SHOP_W * 4, SHOP_H, { u: Math.floor(rng.next() * 4) / 4, outset: 0.02 }));
  };

  /** A tower shaft from y0 to top, with 0–2 setbacks, its roof, lights and cap; records the top for the extras. */
  const shaft = (style, look, ax0, ax1, az0, az1, y0, top, steps, allowCap) => {
    let [a0, a1, c0, c1] = [ax0, ax1, az0, az1];
    let yb = y0;
    const accent = accentFor(rng, y0, top);
    const cuts = steps === 2 ? [rng.range(0.5, 0.62), rng.range(0.76, 0.86)] : steps === 1 ? [rng.range(0.62, 0.76)] : [];
    for (const f of cuts) {
      const y = snap(top * f);
      block(style, look, a0, a1, c0, c1, yb, y, accent);
      roofTop(out, rng, a0, a1, c0, c1, y, false);
      const jx = (a1 - a0) * 0.13;
      const jz = (c1 - c0) * 0.13;
      [a0, a1, c0, c1] = [a0 + jx, a1 - jx, c0 + jz, c1 - jz];
      yb = y;
    }
    block(style, look, a0, a1, c0, c1, yb, top, accent);
    roofTop(out, rng, a0, a1, c0, c1, top);
    const glass = STYLES[style].type === 'curtain';
    const warm = rng.next() < 0.3;
    if (glass && rng.next() < 0.6) crown(out, a0, a1, c0, c1, top, warm);
    const cx = (a0 + a1) / 2;
    const cz = (c0 + c1) / 2;
    let tipY = null;
    const capRoll = rng.next();
    if (top > 24 && capRoll < 0.3) {
      const spire = new THREE.CylinderGeometry(0.05, 0.16, 3 + rng.next() * 4, 8);
      spire.translate(cx, top + spire.parameters.height / 2, cz);
      out.roof.push(spire);
      tipY = top + spire.parameters.height;
    } else if (allowCap && capRoll < 0.52) {
      // Pyramid cap in brushed metal, sitting inside the parapet
      const h = rng.range(1.2, 2.8);
      const cap = new THREE.ConeGeometry(Math.min(a1 - a0, c1 - c0) * 0.62, h, 4, 1);
      cap.rotateY(Math.PI / 4);
      cap.translate(cx, top + 0.05 + h / 2, cz);
      out.cap.push(cap);
      tipY = top + 0.05 + h;
    }
    // Recorded without drawing from rng: the aviation lights and helipads are decided from these afterwards.
    out.tops.push({ x0: a0, x1: a1, z0: c0, z1: c1, y: top, tipY, round: false });
  };

  if (b.h >= 15) {
    const glass = rng.next() < 0.7;
    const style = glass ? pick(rng, GLASS) : pick(rng, STONE);
    const look = buildingLook(rng, false);
    const podium = snap(1.6 + rng.next());
    block(pick(rng, STONE), buildingLook(rng, false), x0, x1, z0, z1, 0, podium);
    if (street) shops(x0, x1, z0, z1);
    roofTop(out, rng, x0, x1, z0, z1, podium, false);
    const ix = b.w * (0.1 + 0.08 * rng.next());
    const iz = b.d * (0.1 + 0.08 * rng.next());
    const [sx0, sx1, sz0, sz1] = [x0 + ix, x1 - ix, z0 + iz, z1 - iz];
    const top = b.h;
    const form = rng.next();
    if (form < 0.16 && Math.min(sx1 - sx0, sz1 - sz0) >= 3) {
      // Round glass tower with an LED band and a round parapet
      const r = Math.min(sx1 - sx0, sz1 - sz0) / 2;
      const cx = (sx0 + sx1) / 2;
      const cz = (sz0 + sz1) / 2;
      const roundStyle = glass ? style : pick(rng, GLASS);
      const L = LAYOUT.curtain;
      out[roundStyle].push(stamp(roundWalls(cx, cz, r, podium, top, L.cellW * L.cols, TILE_H, { u: rng.next(), v: vOff }), look, accentFor(rng, podium, top)));
      out.roof.push(disc(cx, cz, r, top), ring(cx, cz, r - 0.06, top, 0.28));
      (rng.next() < 0.35 ? out.ledWarm : out.led).push(ring(cx, cz, r + 0.03, top - 0.2, 0.07), ring(cx, cz, r + 0.03, top - 0.5, 0.07));
      out.tops.push({ x0: cx - r, x1: cx + r, z0: cz - r, z1: cz + r, y: top, tipY: null, round: true });
    } else if (form < 0.36 && Math.max(sx1 - sx0, sz1 - sz0) >= 5) {
      // Twin towers on one podium, split along the longer side, one shorter than the other
      const gap = 0.7;
      const alongX = sx1 - sx0 >= sz1 - sz0;
      const mx = (sx0 + sx1) / 2;
      const mz = (sz0 + sz1) / 2;
      const parts = alongX
        ? [
            [sx0, mx - gap / 2, sz0, sz1],
            [mx + gap / 2, sx1, sz0, sz1],
          ]
        : [
            [sx0, sx1, sz0, mz - gap / 2],
            [sx0, sx1, mz + gap / 2, sz1],
          ];
      const shorter = snap(top * rng.range(0.72, 0.9));
      const tops = rng.next() < 0.5 ? [top, shorter] : [shorter, top];
      parts.forEach(([a0, a1, c0, c1], i) => shaft(style, look, a0, a1, c0, c1, podium, tops[i], rng.next() < 0.3 ? 1 : 0, true));
    } else {
      // Stepped (two setbacks) or classic (one or none)
      const steps = form < 0.6 ? 2 : rng.next() < 0.45 ? 1 : 0;
      shaft(style, look, sx0, sx1, sz0, sz1, podium, top, steps, true);
    }
  } else if (b.h >= 7.5) {
    const residential = rng.next() < 0.55;
    const style = residential ? pick(rng, RENDER) : pick(rng, STONE);
    const look = buildingLook(rng, residential);
    const h = snap(b.h);
    const form = rng.next();
    if (!street && form < 0.3 && b.w >= 4.5) {
      // L-shape: a full-height block and a lower wing
      const split = x0 + b.w * rng.range(0.55, 0.68);
      const h2 = snap(h * rng.range(0.55, 0.8));
      const [wz0, wz1] = rng.next() < 0.5 ? [z0, z0 + b.d * 0.55] : [z1 - b.d * 0.55, z1];
      block(style, look, x0, split, z0, z1, 0, h);
      roofTop(out, rng, x0, split, z0, z1, h);
      block(style, look, split, x1, wz0, wz1, 0, h2);
      roofTop(out, rng, split, x1, wz0, wz1, h2);
    } else if (form < 0.55) {
      // Terraced: a broad base, then an upper block set back
      const h1 = snap(h * rng.range(0.55, 0.7));
      const ix = b.w * rng.range(0.12, 0.2);
      const iz = b.d * rng.range(0.15, 0.25);
      block(style, look, x0, x1, z0, z1, 0, h1);
      roofTop(out, rng, x0, x1, z0, z1, h1, false);
      block(style, look, x0 + ix, x1 - ix, z0 + iz, z1 - iz, h1, h);
      roofTop(out, rng, x0 + ix, x1 - ix, z0 + iz, z1 - iz, h);
    } else {
      block(style, look, x0, x1, z0, z1, 0, h);
      roofTop(out, rng, x0, x1, z0, z1, h);
    }
    if (street && rng.next() < 0.75) shops(x0, x1, z0, z1);
  } else {
    const residential = rng.next() < 0.75;
    const style = residential ? pick(rng, RENDER) : pick(rng, STONE);
    const h = snap(b.h);
    if (!street && b.w >= 4.6 && rng.next() < 0.35) {
      // Two neighbours sharing the plot, each in its own style and height (never taller on the camera side)
      const split = x0 + b.w * rng.range(0.4, 0.6);
      const h2 = snap(h * rng.range(0.6, b.z > 0 ? 1 : 1.35));
      const style2 = rng.next() < 0.75 ? pick(rng, RENDER) : pick(rng, STONE);
      block(style, buildingLook(rng, residential), x0, split, z0, z1, 0, h);
      roofTop(out, rng, x0, split, z0, z1, h);
      block(style2, buildingLook(rng, true), split, x1, z0, z1, 0, h2);
      roofTop(out, rng, split, x1, z0, z1, h2);
    } else {
      block(style, buildingLook(rng, residential), x0, x1, z0, z1, 0, h);
      roofTop(out, rng, x0, x1, z0, z1, h);
    }
    if (street && rng.next() < 0.75) shops(x0, x1, z0, z1);
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

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => THREE.MathUtils.smoothstep(x, e0, e1);

/**
 * Extra plots for the realistic look only (the neon twin keeps its own). Three groups, each clear of the twin's plots,
 * the network masts and the dock:
 *   • the far (−Z) side, rows 1–6 behind the street, rising to a downtown skyline behind zone 2;
 *   • the camera (+Z) side, low-rise rows behind the shops (≤ 4.8 units, under the chase and cinematic cameras);
 *   • a city edge behind the dock, where the road begins.
 * Row 0 on the far side is left as the twin placed it, so nothing new stands near the cameras' orbit.
 */
function infillPlots(taken, rng, maxX, roadZ) {
  const plots = [];
  const keepOut = [
    { x: 22, z: -14, r: 9 }, // Wi-Fi pole
    { x: 125, z: -22, r: 14 }, // 5G mast
    { x: -3, z: 0, r: 12 }, // dock apron
  ];
  const fits = (p) =>
    !keepOut.some((k) => Math.hypot(k.x - p.x, k.z - p.z) < k.r + Math.max(p.w, p.d) / 2) &&
    !taken.some((b) => Math.abs(b.x - p.x) < (b.w + p.w) / 2 + 1.1 && Math.abs(b.z - p.z) < (b.d + p.d) / 2 + 1.1) &&
    !plots.some((b) => Math.abs(b.x - p.x) < (b.w + p.w) / 2 + 1.1 && Math.abs(b.z - p.z) < (b.d + p.d) / 2 + 1.1);
  const add = (p) => {
    if (fits(p)) plots.push(p);
  };
  // 0 → 1 → 0 across zone 2, the downtown core; 1 → 0 where the city ends at the desert.
  const downtown = (x) => smooth(28, 48, x) * (1 - smooth(88, 110, x));
  const cityFade = (x) => 1 - smooth(maxX - 24, maxX, x);

  for (let row = 1; row <= 6; row++) {
    const back = row >= 3;
    for (let x = -88; x < maxX - 2; x += rng.range(5, 7.5)) {
      const dt = downtown(x);
      if (rng.next() > (0.6 + 0.28 * dt) * (0.55 + 0.45 * cityFade(x))) continue;
      const [b0, b1] = back ? [6, 17] : [5, 13];
      const [d0, d1] = back ? [16, 44] : [12, 30];
      const h = rng.range(lerp(b0, d0, dt), lerp(b1, d1, dt)) * (row >= 5 ? 1.1 : 1) * (0.5 + 0.5 * cityFade(x));
      add({ x, z: roadZ(x) - (16 + row * 11 + rng.range(0, 4)), w: rng.range(3.6, 7), d: rng.range(4, 7.5), h });
    }
  }
  for (let row = 0; row < 3; row++) {
    for (let x = -88; x < maxX - 2; x += rng.range(5, 8)) {
      if (rng.next() > 0.7 * cityFade(x)) continue;
      add({ x, z: roadZ(x) + 29 + row * 10 + rng.range(0, 3), w: rng.range(3.8, 7), d: rng.range(4, 7), h: rng.range(1.8, 4.8) });
    }
  }
  for (let x = -92; x < -34; x += rng.range(6, 8)) {
    for (let z = -12; z <= 12; z += rng.range(8.5, 11)) {
      if (rng.next() > 0.75) continue;
      add({ x, z: z + rng.range(-1.5, 1.5), w: rng.range(4, 7), d: rng.range(4, 7), h: rng.range(4, 12) });
    }
  }
  return plots;
}

/** A rooftop helipad decal: dark deck, a yellow touchdown ring, a white H and an amber edge stripe. */
function paintHelipad() {
  const S = 256;
  const [cc, c] = canvas(S, S);
  const [ec, e] = canvas(S, S);
  c.fillStyle = '#26292e';
  c.fillRect(0, 0, S, S);
  e.fillStyle = '#000';
  e.fillRect(0, 0, S, S);
  for (const [g, glow] of [
    [c, 1],
    [e, 0.55],
  ]) {
    g.lineWidth = 12;
    g.strokeStyle = `rgba(242,196,64,${glow})`;
    g.beginPath();
    g.arc(S / 2, S / 2, S * 0.38, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = `rgba(240,244,248,${glow})`;
    g.fillRect(S * 0.36, S * 0.3, S * 0.07, S * 0.4); // H
    g.fillRect(S * 0.57, S * 0.3, S * 0.07, S * 0.4);
    g.fillRect(S * 0.36, S * 0.47, S * 0.28, S * 0.06);
  }
  c.strokeStyle = '#c98a2c';
  c.lineWidth = 6;
  c.strokeRect(3, 3, S - 6, S - 6);
  const map = texture(cc, true);
  const emissiveMap = texture(ec, true);
  for (const t of [map, emissiveMap]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return { map, emissiveMap };
}

/**
 * Rooftop extras, decided from the recorded tower tops without any random draws: red aviation lights on every
 * tower above 22 units (on the roof's corners, or around a round roof, and on any spire or cap tip), and helipads on
 * four of the tallest flat square roofs, spread along the road.
 */
function rooftopExtras(out) {
  for (const t of out.tops) {
    if (t.y < 22) continue;
    const s = 0.16;
    const cx = (t.x0 + t.x1) / 2;
    const cz = (t.z0 + t.z1) / 2;
    const r = (t.x1 - t.x0) / 2 - 0.15;
    const corners = t.round
      ? [0, 1, 2, 3].map((k) => [cx + r * Math.cos(Math.PI / 4 + (k * Math.PI) / 2), cz + r * Math.sin(Math.PI / 4 + (k * Math.PI) / 2)])
      : [
          [t.x0 + 0.18, t.z0 + 0.18],
          [t.x1 - 0.18, t.z0 + 0.18],
          [t.x0 + 0.18, t.z1 - 0.18],
          [t.x1 - 0.18, t.z1 - 0.18],
        ];
    for (const [x, z] of corners) out.aviation.push(box(s, s, s, x, t.y + 0.3, z));
    if (t.tipY) out.aviation.push(box(s * 1.3, s * 1.3, s * 1.3, cx, t.tipY - 0.05, cz));
  }
  const pads = [];
  const candidates = out.tops
    .filter((t) => !t.tipY && !t.round && t.y >= 16 && t.x1 - t.x0 >= 3 && t.z1 - t.z0 >= 3 && (t.z0 + t.z1) / 2 > -75)
    .sort((a, b) => b.y - a.y);
  for (const t of candidates) {
    const cx = (t.x0 + t.x1) / 2;
    if (pads.length >= 4) break;
    if (pads.some((p) => Math.abs(p.cx - cx) < 18)) continue;
    pads.push({ ...t, cx });
  }
  for (const t of pads) {
    const cz = (t.z0 + t.z1) / 2;
    const size = Math.min(t.x1 - t.x0, t.z1 - t.z0) - 0.5;
    const deckY = t.y + 0.9; // a raised deck clears the rooftop plant
    out.roof.push(box(size + 0.3, 0.12, size + 0.3, t.cx, deckY - 0.12, cz));
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      out.roof.push(box(0.12, 0.8, 0.12, t.cx + (dx * size) / 2.4, t.y, cz + (dz * size) / 2.4));
    }
    const pad = new THREE.PlaneGeometry(size, size);
    pad.rotateX(-Math.PI / 2);
    pad.translate(t.cx, deckY + 0.02, cz);
    out.helipad.push(pad);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      out.padLight.push(box(0.12, 0.08, 0.12, t.cx + Math.cos(a) * size * 0.47, deckY, cz + Math.sin(a) * size * 0.47));
    }
  }
}

/**
 * @param {{boxes: Array<{x:number,z:number,w:number,d:number,h:number}>, rng: object, renderer: THREE.WebGLRenderer,
 *          maxX: number, roadZ: (x:number) => number}} opts
 */
export function buildRealCity({ boxes, rng, infillRng, renderer, maxX, roadZ }) {
  const env = nightEnvironment(renderer, rng);
  const out = { shop: [], roof: [], cap: [], led: [], ledWarm: [], aviation: [], helipad: [], padLight: [], tops: [] };
  for (const id of Object.keys(STYLES)) out[id] = [];
  const twinPlots = boxes.filter((b) => b.x <= maxX);
  for (const b of twinPlots) planBuilding(out, b, rng);
  const streetPlots = streetSidePlots(roadZ, rng, maxX);
  for (const b of streetPlots) planBuilding(out, b, rng);
  // The realistic look's own plots, on their own stream: the twin's buildings above keep their exact look.
  for (const b of infillPlots([...twinPlots, ...streetPlots], infillRng, maxX, roadZ)) planBuilding(out, b, infillRng);
  rooftopExtras(out);
  delete out.tops;

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
  // Reflections and uplight per facade type: glass mirrors the night sky, render barely does.
  const typeLook = { curtain: { uplight: 0.7 }, ribbon: { env: 1.2, uplight: 1 }, punched: { env: 0.35, uplight: 1.2 } };
  const materials = {
    ...Object.fromEntries(
      Object.entries(STYLES).map(([id, st]) => [id, facadeMat(paintFacade(id, rng), st.env ?? typeLook[st.type].env, typeLook[st.type].uplight)]),
    ),
    cap: new THREE.MeshStandardMaterial({ color: '#5d636c', metalness: 0.75, roughness: 0.32, envMap: env, envMapIntensity: 1.3 }),
    shop: new THREE.MeshStandardMaterial({
      map: shopTex.map,
      emissiveMap: shopTex.emissiveMap,
      emissive: '#ffffff',
      emissiveIntensity: 1.05,
      roughness: 0.5,
      metalness: 0.3,
      envMap: env,
      envMapIntensity: 0.5,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    roof: new THREE.MeshStandardMaterial({ color: '#46494e', roughness: 0.9, metalness: 0.15, envMap: env, envMapIntensity: 0.2 }),
    led: new THREE.MeshStandardMaterial({ color: '#0b0d10', emissive: '#d9e6ff', emissiveIntensity: 2.4 }),
    ledWarm: new THREE.MeshStandardMaterial({ color: '#0b0d10', emissive: '#ffd6a0', emissiveIntensity: 2.2 }),
    aviation: new THREE.MeshStandardMaterial({ color: '#2a0505', emissive: '#ff2b2b', emissiveIntensity: 3.2 }),
    helipad: new THREE.MeshStandardMaterial({ ...paintHelipad(), emissive: '#ffffff', emissiveIntensity: 0.9, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    padLight: new THREE.MeshStandardMaterial({ color: '#06200f', emissive: '#4dff8a', emissiveIntensity: 2.6 }),
  };
  const city = new THREE.Group();
  city.name = 'RealCity';
  for (const [key, geos] of Object.entries(out)) {
    if (geos.length) city.add(new THREE.Mesh(mergeGeometries(geos), materials[key]));
  }
  return city;
}
