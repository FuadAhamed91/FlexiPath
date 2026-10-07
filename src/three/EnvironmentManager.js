/**
 * EnvironmentManager.js — static world dressing, in two looks (`setLook`).
 *
 * Shared: horizon sky dome (colours per look), star field, zone and dock labels.
 * `real` (default): the night city and desert built by RealWorld.js.
 * `twin` (the neon digital twin):
 *   • glowing cyan perspective grid floor (anti-aliased shader, focus glow + scan ring)
 *   • road ribbon with lane markings built from the simulation's route spline
 *   • zone gates, drone dock with a landing pad per drone
 *   • stylised wireframe buildings (urban zones 1–3) and the rural ridge (zone 4)
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Random } from '../utils/Random.js';
import { MOBILITY_DEFAULTS } from '../simulation/MobilityModel.js';
import { ENGINES } from '../simulation/SimulationEngine.js';
import { buildRealWorld } from './RealWorld.js';

/** Sky dome colours per look (the realistic night has a warm light-pollution glow on the horizon). */
const SKY = {
  twin: { top: '#010309', horizon: '#071329', glow: '#0e7490', stars: 0.85 },
  real: { top: '#02040a', horizon: '#121a2b', glow: '#4a3a28', stars: 0.75 },
};

const GRID_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const GRID_FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform vec3 uBase;
  uniform vec3 uLine;
  uniform vec3 uFocus;
  uniform float uTime;
  varying vec3 vWorld;

  float gridLine(vec2 p, float size, float width) {
    vec2 coord = p / size;
    vec2 g = abs(fract(coord - 0.5) - 0.5) / (fwidth(coord) * width);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    vec2 p = vWorld.xz;
    float minor = gridLine(p, 4.0, 1.0);
    float major = gridLine(p, 20.0, 1.4);
    float d = length(p - uFocus.xz);
    float glow = exp(-d * 0.03);
    float period = 110.0;
    float r = mod(uTime * 22.0, period);
    float ring = smoothstep(2.2, 0.0, abs(d - r)) * (1.0 - r / period);
    vec3 col = uBase;
    col += uLine * minor * (0.07 + 0.30 * glow);
    col += uLine * major * (0.18 + 0.55 * glow);
    col += uLine * ring * 0.35;
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  void main() {
    float h = clamp(vDir.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(h, 0.45));
    col += uGlow * exp(-h * 14.0) * 0.55;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class EnvironmentManager {
  constructor(sceneManager, world) {
    this.sm = sceneManager;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'Environment';
    this.sm.scene.add(this.group);
    this.rng = new Random('flexipath-city');
    this.twin = new THREE.Group(); // neon digital-twin world (the `twin` look)
    this.twin.name = 'TwinWorld';
    this.group.add(this.twin);

    // Shared by both looks: sky dome, stars and the zone labels; everything else is per look.
    this._buildSky();
    this._buildStars();
    this._buildGround();
    this._buildRoad();
    this._buildDepot();
    this._buildZoneGates();
    this._buildCity();
    this._buildRidge();

    const zones = this.world.zones;
    this.real = buildRealWorld({
      world: this.world,
      boxes: this.cityBoxes,
      pads: this.padFrames,
      gates: [
        ...zones.slice(1).map((z) => ({ x: z.x0, title: `ZONE ${z.id}`, sub: z.name.toUpperCase(), color: z.color })),
        { x: this.world.routeEndX, title: 'ROUTE END', sub: '1.2 KM · X = 240', color: '#f8fafc' },
      ],
      ribbon: (...args) => this._ribbon(...args),
      renderer: this.sm.renderer,
    });
    this.group.add(this.real);
    this.setLook('real');
  }

  /** `real`: the night city and desert (RealWorld.js); `twin`: the original neon digital twin. */
  setLook(look) {
    const real = look === 'real';
    this.twin.visible = !real;
    this.real.visible = real;
    const sky = real ? SKY.real : SKY.twin;
    this.skyUniforms.uTop.value.set(sky.top);
    this.skyUniforms.uHorizon.value.set(sky.horizon);
    this.skyUniforms.uGlow.value.set(sky.glow);
    this.stars.material.opacity = sky.stars;
  }

  _buildSky() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(SKY.twin.top) },
        uHorizon: { value: new THREE.Color(SKY.twin.horizon) },
        uGlow: { value: new THREE.Color(SKY.twin.glow) },
      },
    });
    this.skyUniforms = mat.uniforms;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), mat);
    sky.position.set(120, 0, 0);
    sky.renderOrder = -10;
    this.group.add(sky);
  }

  _buildStars() {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const theta = this.rng.range(0, Math.PI * 2);
      const phi = Math.acos(this.rng.range(0.08, 1));
      const r = 1100;
      pos[i * 3] = 120 + r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      c.setHSL(this.rng.range(0.52, 0.66), 0.6, this.rng.range(0.55, 0.95));
      col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, fog: false, transparent: true, opacity: 0.85 }),
    );
    this.stars = stars;
    this.group.add(stars);
  }

  _buildGround() {
    this.gridUniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uBase: { value: new THREE.Color('#040a17') },
        uLine: { value: new THREE.Color('#00d8ff') },
        uFocus: { value: new THREE.Vector3() },
        uTime: { value: 0 },
      },
    ]);
    const mat = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      uniforms: this.gridUniforms,
      fog: true,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 900), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(120, -0.02, -60);
    this.twin.add(ground);
  }

  _ribbon(points, halfWidth, y, material) {
    const n = points.length;
    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    const idx = [];
    let along = 0;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const nx = -p.tz;
      const nz = p.tx;
      pos.set([p.x - nx * halfWidth, y, p.z - nz * halfWidth, p.x + nx * halfWidth, y, p.z + nz * halfWidth], i * 6);
      if (i > 0) along += Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z);
      uv.set([along, 0, along, 1], i * 4);
      if (i < n - 1) {
        const a = i * 2; // a = left edge, a+1 = right edge; CCW seen from +Y
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, material);
  }

  _buildRoad() {
    const path = this.world.path;
    const line = path.polyline(1);
    const asphalt = new THREE.MeshStandardMaterial({ color: '#070d1a', roughness: 0.85, metalness: 0.2 });
    const road = this._ribbon(line, 7.6, 0.01, asphalt);
    this.twin.add(road);

    // Edge lines (emissive cyan) and centre dashes.
    const edgeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#22d3ee').multiplyScalar(1.1), toneMapped: false });
    for (const lateral of [-7.2, 7.2]) {
      const pts = path.polyline(1, lateral);
      this.twin.add(this._ribbon(pts, 0.09, 0.03, edgeMat));
    }
    const dashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#94a3b8').multiplyScalar(0.9), toneMapped: false });
    const dashGeo = [];
    for (let s = 2; s < path.length; s += 6) {
      const seg = [path.frameAt(s), path.frameAt(Math.min(path.length, s + 3))];
      dashGeo.push(this._ribbon(seg, 0.1, 0.03, dashMat).geometry);
    }
    this.twin.add(new THREE.Mesh(mergeGeometries(dashGeo), dashMat));
  }

  _buildDepot() {
    // Dock apron with a landing pad per drone, where it sits plugged into the wired dock before take-off.
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 16),
      new THREE.MeshBasicMaterial({ color: '#1d4ed8', transparent: true, opacity: 0.1, depthWrite: false, toneMapped: false }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(-1, 0.035, 0);
    this.twin.add(pad);
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(14, 16)),
      new THREE.LineBasicMaterial({ color: new THREE.Color('#3b82f6').multiplyScalar(1.8), toneMapped: false }),
    );
    frame.rotation.x = -Math.PI / 2;
    frame.position.set(-1, 0.04, 0);
    this.twin.add(frame);

    const path = this.world.path;
    const sDock = path.sAtX(MOBILITY_DEFAULTS.startX);
    const padMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#3b82f6').multiplyScalar(1.6),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const flat = (geo) => {
      geo.rotateX(-Math.PI / 2);
      return new THREE.Mesh(geo, padMat);
    };
    this.padFrames = ['flexipath', 'legacy'].map((id) => path.frameAt(sDock, ENGINES[id].laneOffset));
    for (const f of this.padFrames) {
      const pad = new THREE.Group();
      pad.position.set(f.x, 0.045, f.z);
      pad.rotation.y = f.heading;
      pad.add(flat(new THREE.RingGeometry(2.05, 2.2, 56)));
      for (const [w, d, x, z] of [
        [1.5, 0.16, 0, -0.5],
        [1.5, 0.16, 0, 0.5],
        [0.16, 1.0, 0, 0],
      ]) {
        const bar = flat(new THREE.PlaneGeometry(w, d));
        bar.position.set(x, 0, z);
        pad.add(bar);
      }
      this.twin.add(pad);
    }
    this._label('DRONE DOCK · ETH', 'Zone 1 start', '#3b82f6', new THREE.Vector3(-1, 0.2, 9.5));
  }

  _label(title, sub, color, position) {
    const el = document.createElement('div');
    el.className = 'zone-label';
    el.style.setProperty('--c', color);
    el.innerHTML = `${title}${sub ? `<small>${sub}</small>` : ''}`;
    const obj = new CSS2DObject(el);
    obj.position.copy(position);
    this.group.add(obj);
    return obj;
  }

  _buildZoneGates() {
    const path = this.world.path;
    const gates = [...this.world.zones.slice(1).map((z) => ({ x: z.x0, zone: z })), { x: this.world.routeEndX, zone: null }];
    for (const g of gates) {
      const s = path.sAtX(g.x);
      const f = path.frameAt(s);
      const color = new THREE.Color(g.zone ? g.zone.color : '#f8fafc');
      const mat = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2.2), toneMapped: false });
      const gate = new THREE.Group();
      const postGeo = new THREE.BoxGeometry(0.35, 7, 0.35);
      for (const side of [-8.4, 8.4]) {
        const post = new THREE.Mesh(postGeo, mat);
        post.position.set(0, 3.5, side);
        gate.add(post);
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 17), mat);
      bar.position.y = 7;
      gate.add(bar);
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(0.6, 16.8),
        new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.4), transparent: true, opacity: 0.8, toneMapped: false }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = 0.05;
      gate.add(floor);
      gate.position.set(f.x, 0, f.z);
      gate.rotation.y = f.heading;
      this.twin.add(gate);
      if (g.zone) {
        this._label(`ZONE ${g.zone.id}`, g.zone.name.toUpperCase(), g.zone.color, new THREE.Vector3(f.x, 9.2, f.z));
      } else {
        this._label('ROUTE END', '1.2 KM · X = 240', '#f8fafc', new THREE.Vector3(f.x, 9.2, f.z));
      }
    }
  }

  _buildCity() {
    const boxes = [];
    const keepOut = [
      { x: 22, z: -14, r: 9 }, // Wi-Fi pole
      { x: 125, z: -22, r: 12 }, // 5G tower
      { x: -3, z: 0, r: 10 }, // depot
    ];
    const zoneDensity = (x) => (x < 40 ? 0.75 : x < 90 ? 1.0 : x < 160 ? 0.55 : 0.08);
    const zoneHeight = (x) => (x < 40 ? [4, 14] : x < 90 ? [10, 30] : x < 160 ? [4, 12] : [2, 5]);
    for (let x = -30; x < 262; x += 7) {
      for (const side of [-1, 1]) {
        for (let row = 0; row < 3; row++) {
          if (this.rng.next() > zoneDensity(x) * (row === 0 ? 0.9 : 0.7)) continue;
          const w = this.rng.range(3.5, 6.5);
          const d = this.rng.range(3.5, 7);
          const [h0, h1] = zoneHeight(x);
          // The camera rig sits on the +Z side: keep that side far away and low so it never blocks the road.
          const near = side < 0;
          const h = this.rng.range(h0, h1) * (row === 2 ? 1.25 : 1) * (near ? 1 : 0.45);
          const cz = near ? -(16 + row * 11 + this.rng.range(0, 4)) : 62 + row * 12 + this.rng.range(0, 6);
          const cx = x + this.rng.range(-1.5, 1.5);
          if (keepOut.some((k) => Math.hypot(k.x - cx, k.z - cz) < k.r + w)) continue;
          boxes.push({ x: cx, z: cz, w, d, h });
        }
      }
    }

    this.cityBoxes = boxes; // the realistic look builds solid buildings on the same plots
    const count = boxes.length;
    const fillMat = new THREE.MeshStandardMaterial({
      color: '#0a1428',
      roughness: 0.6,
      metalness: 0.3,
      transparent: true,
      opacity: 0.82,
      emissive: new THREE.Color('#06142b'),
    });
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), fillMat, count);
    const m = new THREE.Matrix4();
    const edges = [];
    const edgeTemplate = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)).attributes.position.array;
    boxes.forEach((b, i) => {
      m.makeScale(b.w, b.h, b.d).setPosition(b.x, b.h / 2, b.z);
      inst.setMatrixAt(i, m);
      for (let k = 0; k < edgeTemplate.length; k += 3) {
        edges.push(b.x + edgeTemplate[k] * b.w, b.h / 2 + edgeTemplate[k + 1] * b.h, b.z + edgeTemplate[k + 2] * b.d);
      }
    });
    this.twin.add(inst);

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
    const edgeMat = new THREE.LineBasicMaterial({
      color: new THREE.Color('#0ea5e9').multiplyScalar(0.9),
      transparent: true,
      opacity: 0.55,
    });
    this.twin.add(new THREE.LineSegments(edgeGeo, edgeMat));

    // Rooftop aviation beacons on the tallest towers.
    const tall = boxes.filter((b) => b.h > 18);
    const beaconPos = new Float32Array(tall.length * 3);
    tall.forEach((b, i) => beaconPos.set([b.x, b.h + 0.4, b.z], i * 3));
    const beaconGeo = new THREE.BufferGeometry();
    beaconGeo.setAttribute('position', new THREE.BufferAttribute(beaconPos, 3));
    this.beacons = new THREE.Points(
      beaconGeo,
      new THREE.PointsMaterial({ color: new THREE.Color('#ff2d55').multiplyScalar(2), size: 0.9, toneMapped: false }),
    );
    this.twin.add(this.beacons);
  }

  _buildRidge() {
    // Wireframe hills behind zone 4 — the terrain that diffracts the 5G signal away.
    const geo = new THREE.PlaneGeometry(190, 70, 48, 18);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const u = (x + 95) / 190;
      const ridge = Math.sin(u * Math.PI) * (16 + 9 * Math.sin(u * 11.0) + 5 * Math.cos(u * 23.0));
      const falloff = Math.exp(-(((y - 5) / 26) ** 2));
      pos.setZ(i, Math.max(0, ridge * falloff));
    }
    geo.computeVertexNormals();
    const ridge = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#f59e0b').multiplyScalar(0.55),
        wireframe: true,
        transparent: true,
        opacity: 0.32,
      }),
    );
    ridge.rotation.x = -Math.PI / 2;
    ridge.position.set(215, 0, -44);
    this.twin.add(ridge);
    this._label('RIDGE SHADOW', '5G DIFFRACTION LOSS', '#f59e0b', new THREE.Vector3(200, 26, -52));
  }

  update(time, focus) {
    this.gridUniforms.uTime.value = time;
    if (focus) this.gridUniforms.uFocus.value.copy(focus);
    if (this.beacons) this.beacons.material.opacity = 0.35 + 0.65 * (Math.sin(time * 3) > 0.6 ? 1 : 0.2);
  }
}

/** Minimal indexed-geometry merge (position + uv) to keep the draw-call count low. */
function mergeGeometries(geos) {
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index.count;
  }
  const pos = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
