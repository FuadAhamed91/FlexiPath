/**
 * VehicleManager.js — FlexiPath drone (A) and the Legacy ghost drone (B).
 *
 * Models come from public/models/{flexipath,legacy}_drone.glb when present,
 * otherwise an identical low-poly quadcopter is built from primitives.
 * Each drone exposes an `AntennaAnchor` (multi-link antenna tip) where beams start
 * and four `Rotor_*` pivots that spin about the vertical axis.
 *
 * The drones fly a low-altitude corridor above the route: they sit on their dock pads,
 * climb out on departure and hold the corridor height. Altitude is visual only (the radio
 * model is evaluated on the route centre-line at ground level).
 *
 * Visual state (all driven by the simulation snapshot):
 *   FlexiPath  — cyan halo; label shows PREDICT / WARM PROBE / BURST TX / SWITCHED with the
 *                radio power; purple pulsing halo while critical traffic is replicated
 *   Legacy     — crimson ghost; on an interruption it flashes red, wobbles (stutters),
 *                stops and hovers (fail-safe) and shows "SIMULATED INTERRUPTION · 3.8 s" with a countdown
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadGLB, collectEmissives } from './NetworkNodeManager.js';
import { METERS_PER_UNIT, MOBILITY_DEFAULTS } from '../simulation/MobilityModel.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';
import { RELAY_PARAMS } from '../simulation/RelayTunnelModel.js';

const W = POWER_PARAMS.tierWatts;

const PALETTE = {
  flexipath: { body: '#0b0f16', accent: '#00F0FF', canopy: '#00F0FF', trim: '#1f2937' },
  legacy: { body: '#3b0a16', accent: '#E11D48', canopy: '#FB7185', trim: '#4c0519' },
};

/** Realistic look: an enterprise-drone paint job instead of neon. FlexiPath white with cyan, Legacy graphite with red. */
const PAINT = {
  flexipath: { body: '#f1f4f7', guard: '#d6dbe1', trim: '#2a2e34', accent: '#13c4d6', canopy: '#123038', led: '#00F0FF' },
  legacy: { body: '#3b4047', guard: '#4b5058', trim: '#1c1f23', accent: '#d8283f', canopy: '#2b1419', led: '#ff3b55' },
};
const DISC_REAL = '#cfd6de'; // spinning props read as a faint pale disc
/** Part name (Blender object / procedural mesh) → paint slot; anything else is trim. Order matters. */
const PAINT_PARTS = [
  [/^Hull/, 'body'],
  [/^Canopy/, 'canopy'],
  [/^LightStrips/, 'stripe'],
  [/^Headlight/, 'head'],
  [/^GimbalLens/, 'head'],
  [/^TailLight/, 'tail'],
  [/^PropGuards/, 'guard'],
  [/^AntennaTip/, 'led'],
  [/^BladeTips/, 'tip'],
  [/^Blades/, 'blade'],
];

function paintedMaterials(kind) {
  const p = PAINT[kind];
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const tail = std({ color: '#05080f', emissive: '#ff2848', emissiveIntensity: 2.2 });
  tail.name = 'TailLight';
  return {
    body: std({ color: p.body, roughness: 0.55, metalness: 0.08 }),
    guard: std({ color: p.guard, roughness: 0.6, metalness: 0.05 }),
    trim: std({ color: p.trim, roughness: 0.5, metalness: 0.35 }),
    canopy: std({ color: p.canopy, roughness: 0.18, metalness: 0.4, emissive: p.led, emissiveIntensity: 0.12 }),
    stripe: std({ color: p.accent, roughness: 0.45, emissive: p.led, emissiveIntensity: 0.6 }),
    tip: std({ color: p.accent, roughness: 0.5 }),
    blade: std({ color: '#16191d', roughness: 0.6, metalness: 0.2 }),
    led: std({ color: '#05080f', emissive: p.led, emissiveIntensity: 2.2 }),
    head: std({ color: '#05080f', emissive: '#E0FDFF', emissiveIntensity: 3 }),
    tail,
  };
}
const VEHICLE_SCALE = 1.45; // stylised: drones read clearly against 1.2 km of route
const CRUISE_ALT = 5; // world units (≈ 25 m) above the route; visual only
const CLIMB_S = 9; // route units over which a drone climbs away from its dock pad
const ROTOR_IDLE = 9; // rad/s while waiting on the pad
const ROTOR_FLIGHT = 34; // rad/s once moving or airborne
const STALL_RED = new THREE.Color('#EF4444');
const REPL_PURPLE = new THREE.Color('#a855f7');

// Airframe, in the Blender script's frame (X forward, Y left, Z up). Keep in step with build_drone().
const HULL_OUTLINE = [[0.62, 0], [0.4, 0.34], [-0.42, 0.36], [-0.62, 0.18], [-0.62, -0.18], [-0.42, -0.36], [0.4, -0.34]];
const CANOPY_OUTLINE = [[0.44, 0], [0.27, 0.2], [-0.3, 0.2], [-0.4, 0], [-0.3, -0.2], [0.27, -0.2]];
const ARM_REACH = 1.12;
const ROTOR_Z = 0.82;
const GUARD_R = 0.7;
const BLADE_LEN = 1.24;
const MOTORS = [['FL', 1, 1], ['FR', 1, -1], ['RL', -1, 1], ['RR', -1, -1]];

/** Blender (x, y, z) → three.js (x, z, −y), the glTF exporter's axis conversion. */
const B = (x, y, z) => new THREE.Vector3(x, z, -y);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function buildDrone(kind = 'flexipath') {
  const c = PALETTE[kind];
  const root = new THREE.Group();
  const carbon = new THREE.MeshStandardMaterial({ color: c.body, metalness: 0.75, roughness: 0.32 });
  const trim = new THREE.MeshStandardMaterial({ color: c.trim, metalness: 0.6, roughness: 0.45 });
  const glass = new THREE.MeshStandardMaterial({
    color: '#02060d',
    metalness: 0.3,
    roughness: 0.15,
    emissive: new THREE.Color(c.canopy),
    emissiveIntensity: 1.1,
  });
  const accent = new THREE.MeshStandardMaterial({ color: '#05080f', emissive: new THREE.Color(c.accent), emissiveIntensity: 2.6 });
  const head = new THREE.MeshStandardMaterial({ color: '#05080f', emissive: new THREE.Color('#E0FDFF'), emissiveIntensity: 4 });
  const tail = new THREE.MeshStandardMaterial({ color: '#05080f', emissive: new THREE.Color('#ff2848'), emissiveIntensity: 2.2 });
  tail.name = 'TailLight';
  const blade = new THREE.MeshStandardMaterial({ color: '#05070b', metalness: 0.2, roughness: 0.6 });

  // Part names match the Blender objects, so both models can be repainted part by part (VehicleManager.setLook).
  const add = (parent, geo, mat, pos, name = '') => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    if (pos) m.position.copy(pos);
    parent.add(m);
    return m;
  };
  // Top-view outline extruded upwards from z0 to z1 (rotateX maps the shape's Y to −Z, depth to +Y).
  const slab = (outline, z0, z1, mat, name) => {
    const bevel = 0.02;
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0 - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, z0 + bevel, 0);
    return add(root, geo, mat, null, name);
  };
  const strut = (p0, p1, r, mat, name) => {
    const dir = new THREE.Vector3().subVectors(p1, p0);
    const m = add(root, new THREE.CylinderGeometry(r, r, dir.length(), 8), mat, p0.clone().lerp(p1, 0.5), name);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return m;
  };

  slab(HULL_OUTLINE, 0.41, 0.71, carbon, 'Hull');
  slab(CANOPY_OUTLINE, 0.71, 0.81, glass, 'Canopy');
  for (const side of [-1, 1]) add(root, new THREE.BoxGeometry(0.8, 0.05, 0.04), accent, B(0, side * 0.355, 0.5), 'LightStrips');
  add(root, new THREE.BoxGeometry(0.04, 0.06, 0.3), head, B(0.63, 0, 0.56), 'Headlight');
  add(root, new THREE.BoxGeometry(0.04, 0.06, 0.3), tail, B(-0.63, 0, 0.56), 'TailLight');

  // Arms, motor cans, prop guards and their struts.
  for (const [, sx, sy] of MOTORS) {
    const mx = sx * ARM_REACH;
    const my = sy * ARM_REACH;
    strut(B(sx * 0.34, sy * 0.26, 0.6), B(mx, my, 0.64), 0.065, trim, 'Arms');
    add(root, new THREE.CylinderGeometry(0.13, 0.13, 0.2, 16), trim, B(mx, my, 0.66), 'Arms');
    for (let k = 0; k < 3; k++) {
      const a = Math.atan2(sy, sx) + ((k - 1) * Math.PI * 2) / 3;
      strut(B(mx + 0.12 * Math.cos(a), my + 0.12 * Math.sin(a), 0.74), B(mx + GUARD_R * Math.cos(a), my + GUARD_R * Math.sin(a), ROTOR_Z - 0.02), 0.02, trim, 'Arms');
    }
    const guard = add(root, new THREE.TorusGeometry(GUARD_R, 0.035, 8, 40), accent, B(mx, my, ROTOR_Z - 0.02), 'PropGuards');
    guard.rotation.x = Math.PI / 2;
  }

  // Landing skids.
  for (const side of [-1, 1]) {
    const rail = add(root, new THREE.CylinderGeometry(0.04, 0.04, 1.3, 10), trim, B(0, side * 0.42, 0.05), 'Skids');
    rail.rotation.z = Math.PI / 2;
    for (const x of [-0.32, 0.32]) strut(B(x, side * 0.42, 0.05), B(x * 0.8, side * 0.3, 0.42), 0.03, trim, 'Skids');
  }

  // ISR camera gimbal under the nose.
  add(root, new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10), trim, B(0.42, 0, 0.36), 'Gimbal');
  add(root, new THREE.SphereGeometry(0.16, 16, 10), trim, B(0.42, 0, 0.27), 'Gimbal');
  const lens = add(root, new THREE.CylinderGeometry(0.07, 0.07, 0.04, 16), head, B(0.575, 0, 0.27), 'GimbalLens');
  lens.rotation.z = Math.PI / 2;

  // Multi-link antenna (Wi-Fi · 5G · LEO) + AntennaAnchor.
  add(root, new THREE.CylinderGeometry(0.12, 0.14, 0.06, 20), trim, B(-0.2, 0, 0.84), 'Antenna');
  add(root, new THREE.CylinderGeometry(0.016, 0.022, 0.5, 8), trim, B(-0.2, 0, 1.1), 'Antenna');
  add(root, new THREE.SphereGeometry(0.06, 14, 10), accent, B(-0.2, 0, 1.36), 'AntennaTip');
  const anchorObj = new THREE.Object3D();
  anchorObj.name = 'AntennaAnchor';
  anchorObj.position.copy(B(-0.2, 0, 1.38));
  root.add(anchorObj);

  // Rotor pivots (spin about +Y), blades with glowing tips.
  for (const [name, sx, sy] of MOTORS) {
    const pivot = new THREE.Group();
    pivot.name = `Rotor_${name}`;
    pivot.position.copy(B(sx * ARM_REACH, sy * ARM_REACH, ROTOR_Z));
    root.add(pivot);
    const alongX = sx * sy > 0;
    add(pivot, alongX ? new THREE.BoxGeometry(BLADE_LEN, 0.022, 0.1) : new THREE.BoxGeometry(0.1, 0.022, BLADE_LEN), blade, null, `Blades_${name}`);
    for (const s of [-1, 1]) {
      const d = s * (BLADE_LEN / 2 - 0.05);
      add(pivot, new THREE.BoxGeometry(0.1, 0.024, 0.1), accent, alongX ? new THREE.Vector3(d, 0, 0) : new THREE.Vector3(0, 0, d), `BladeTips_${name}`);
    }
    add(pivot, new THREE.CylinderGeometry(0.03, 0.06, 0.06, 12), trim, new THREE.Vector3(0, 0.03, 0), `Spinner_${name}`);
  }
  return root;
}

function makeLabel(kind) {
  const el = document.createElement('div');
  el.className = `veh-label ${kind === 'legacy' ? 'lg' : 'fp'}`;
  el.innerHTML = `<div class="name">${kind === 'legacy' ? 'LEGACY OS' : 'FLEXIPATH'}</div><div class="state"></div><div class="sub"></div><div class="bar"><span></span></div>`;
  const obj = new CSS2DObject(el);
  obj.position.set(0, 2.4, 0);
  return { obj, el, state: el.querySelector('.state'), sub: el.querySelector('.sub'), bar: el.querySelector('.bar span'), last: '' };
}

function makeHalo() {
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#00F0FF'),
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const halo = new THREE.Mesh(new THREE.RingGeometry(2.25, 2.42, 72), mat);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.05;
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(2.2, 48),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#00F0FF'), transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.04;
  return { halo, glow };
}

/** Faint vertical line from the ground halo up to the drone, so its height reads at a glance. */
function makeAltitudeLine() {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: new THREE.Color('#00F0FF'), transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }));
  line.position.y = 0.06;
  return line;
}

export class VehicleManager {
  constructor(sceneManager, world) {
    this.sm = sceneManager;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'Vehicles';
    this.sm.scene.add(this.group);
    this.vehicles = {};
    this.usedGLB = {};
    this.sDock = world.path.sAtX(MOBILITY_DEFAULTS.startX); // route position of the dock pads
  }

  async load() {
    const [fpGLB, lgGLB] = await Promise.all([loadGLB('flexipath_drone.glb'), loadGLB('legacy_drone.glb')]);
    this._register('flexipath', fpGLB);
    this._register('legacy', lgGLB);
    return this;
  }

  _register(id, glb) {
    this.usedGLB[id] = !!glb;
    const model = glb ?? buildDrone(id);
    const holder = new THREE.Group(); // ground point under the drone: halo and altitude line
    const air = new THREE.Group(); // flight altitude
    const body = new THREE.Group(); // attitude: pitch, bank, hover bob, stall wobble
    body.add(model);
    air.add(body);
    holder.add(air);
    const { halo, glow } = makeHalo();
    const altLine = makeAltitudeLine();
    holder.add(halo, glow, altLine);
    const label = makeLabel(id);
    air.add(label.obj);
    holder.scale.setScalar(VEHICLE_SCALE);
    this.group.add(holder);

    // Outermost Rotor_* nodes only (a nested match would double-spin); neighbours counter-rotate.
    const rotors = [];
    model.traverse((o) => {
      if (!/^Rotor_/i.test(o.name)) return;
      let p = o.parent;
      while (p && !/^Rotor_/i.test(p.name)) p = p.parent;
      if (!p) rotors.push({ obj: o, dir: /FL|RR/i.test(o.name) ? 1 : -1 });
    });
    let anchorObj = model.getObjectByName('AntennaAnchor');
    if (!anchorObj) model.traverse((o) => (anchorObj ??= o.name.startsWith('AntennaAnchor') ? o : undefined));
    if (!anchorObj) {
      anchorObj = new THREE.Object3D();
      anchorObj.name = 'AntennaAnchor';
      anchorObj.position.copy(B(-0.2, 0, 1.38));
      model.add(anchorObj);
    }
    const emissives = collectEmissives(model, 1.0, 0.3); // no boost: body detail must stay readable under bloom
    const tailLights = emissives.filter((m) => m.name === 'TailLight' || /tail|brake/i.test(m.name));

    // Realistic-look paint for every part (by part name), kept beside the neon materials for setLook().
    const paint = paintedMaterials(id);
    const parts = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      const key = PAINT_PARTS.find(([re]) => re.test(o.name))?.[1] ?? 'trim';
      parts.push({ mesh: o, twin: o.material, real: paint[key] });
    });
    // Navigation LEDs under the motors (realistic look only): they keep a painted drone easy to spot at night.
    const motorLeds = new THREE.Group();
    motorLeds.visible = false;
    for (const [, sx, sy] of MOTORS) {
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), paint.led);
      led.position.copy(B(sx * ARM_REACH, sy * ARM_REACH, 0.54));
      motorLeds.add(led);
    }
    model.add(motorLeds);
    const realEmissives = Object.values(paint).filter((m) => m.emissiveIntensity > 0 && m.emissive.getHex() !== 0);
    for (const m of realEmissives) {
      m.userData.baseEmissive = m.emissiveIntensity;
      m.userData.baseEmissiveColor = m.emissive.clone();
    }

    if (id === 'legacy') {
      // Ghost treatment: slightly translucent so the FlexiPath drone reads as the hero.
      for (const m of [...parts.map((p) => p.twin), ...Object.values(paint)]) {
        m.transparent = true;
        m.opacity = 0.86;
      }
    }

    // Motion-blur discs over the spinning blades (added after the ghost pass, which would make them opaque).
    const discMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE[id].accent),
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const discGeo = new THREE.CircleGeometry(GUARD_R - 0.06, 40);
    discGeo.rotateX(-Math.PI / 2);
    for (const r of rotors) r.obj.add(new THREE.Mesh(discGeo, discMat));

    this.vehicles[id] = {
      id,
      holder,
      air,
      body,
      model,
      rotors,
      discMat,
      altLine,
      anchor: anchorObj,
      emissives,
      tailLights,
      parts,
      motorLeds,
      twinEmissives: emissives,
      twinTailLights: tailLights,
      realEmissives,
      realTailLights: [paint.tail],
      discColor: new THREE.Color(PALETTE[id].accent),
      halo,
      glow,
      label,
      rotorAngle: 0,
      rotorSpeed: ROTOR_IDLE,
      pitch: 0,
      bank: 0,
      heading: null,
      visible: true,
      baseHalo: new THREE.Color(id === 'legacy' ? '#E11D48' : '#00F0FF'),
    };
  }

  /** `real`: painted airframes (white / graphite with cyan / red accents); `twin`: the neon drones. */
  setLook(look) {
    const real = look === 'real';
    for (const v of Object.values(this.vehicles)) {
      for (const p of v.parts) p.mesh.material = real ? p.real : p.twin;
      v.emissives = real ? v.realEmissives : v.twinEmissives;
      v.tailLights = real ? v.realTailLights : v.twinTailLights;
      v.discColor.set(real ? DISC_REAL : PALETTE[v.id].accent);
      v.discScale = real ? 0.6 : 1;
      v.motorLeds.visible = real;
    }
  }

  setVisible(id, visible) {
    const v = this.vehicles[id];
    if (!v) return;
    v.visible = visible;
    v.holder.visible = visible;
    v.label.obj.visible = visible;
    v.label.el.style.display = visible ? '' : 'none';
  }

  getAnchorWorldPosition(id, target) {
    return this.vehicles[id].anchor.getWorldPosition(target);
  }

  /** The drone itself (at flight altitude), which the cameras follow. */
  getPosition(id, target) {
    return this.vehicles[id].air.getWorldPosition(target);
  }

  /** " · 59 m behind" once the legacy drone has lost ground to interruptions and fail-safe stops. */
  _gapText(snapshot) {
    const fp = snapshot.agents.flexipath?.vehicle;
    const lg = snapshot.agents.legacy?.vehicle;
    if (!fp || !lg) return '';
    const m = (fp.s - lg.s) * METERS_PER_UNIT;
    return Math.abs(m) < 2 ? '' : ` · ${Math.abs(m).toFixed(0)} m ${m > 0 ? 'behind' : 'ahead'}`;
  }

  _setLabel(v, cls, state, sub, progress) {
    const key = `${cls}|${state}|${sub}`;
    if (key !== v.label.last) {
      v.label.last = key;
      v.label.el.className = `veh-label ${v.id === 'legacy' ? 'lg' : 'fp'} ${cls}`;
      v.label.state.textContent = state;
      v.label.sub.textContent = sub;
    }
    v.label.bar.style.width = `${Math.round((progress ?? 0) * 100)}%`;
  }

  update(render, snapshot, dt, time) {
    for (const id of Object.keys(this.vehicles)) {
      const v = this.vehicles[id];
      const r = render.vehicles[id];
      const agent = snapshot.agents[id];
      if (!r || !agent) continue;
      const d = agent.decision;
      const kmh = r.speedKmh;

      v.holder.position.set(r.x, 0, r.z);
      v.holder.rotation.y = r.heading;

      // Altitude: on the dock pad until departure, a climb-out over the first metres of route, then
      // the corridor height (a scenario that starts further along begins airborne).
      const alt = CRUISE_ALT * THREE.MathUtils.smoothstep(r.s - this.sDock, 0.2, CLIMB_S);
      v.air.position.y = alt / VEHICLE_SCALE;
      const airborne = alt > 0.05;

      // Rotors idle on the pad and spin up for flight.
      const spin = airborne || kmh > 0.5 ? ROTOR_FLIGHT : ROTOR_IDLE;
      v.rotorSpeed += (spin - v.rotorSpeed) * Math.min(1, dt * 2.5);
      v.rotorAngle += v.rotorSpeed * dt;
      for (const rt of v.rotors) rt.obj.rotation.y = rt.dir * v.rotorAngle;

      const stalled = !!d?.stalled;
      const repl = !!d?.replicationActive;
      const failSafe = agent.vehicle.failSafe; // lost-link policy: stop and hover

      // Attitude: nose down with forward speed, nose up while braking to the fail-safe hover,
      // banked into turns, a slow hover bob; the stalled legacy drone wobbles.
      const turn = v.heading === null || dt <= 0 ? 0 : wrapAngle(r.heading - v.heading) / dt;
      v.heading = r.heading;
      const k = Math.min(1, dt * 3);
      const bankTarget = airborne ? THREE.MathUtils.clamp(-turn * 0.5, -0.3, 0.3) : 0;
      const pitchTarget = !airborne ? 0 : failSafe && kmh > 1 ? 0.2 : -0.13 * Math.min(1, kmh / 90);
      v.bank += (bankTarget - v.bank) * k;
      v.pitch += (pitchTarget - v.pitch) * k;
      const bob = airborne ? Math.sin(time * 2.1 + (id === 'legacy' ? 1.3 : 0)) * 0.06 : 0;
      if (stalled) {
        v.body.position.set((Math.random() - 0.5) * 0.12, bob + (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08);
        v.body.rotation.set(v.bank + (Math.random() - 0.5) * 0.06, 0, v.pitch + (Math.random() - 0.5) * 0.05);
      } else {
        v.body.position.set(0, bob, 0);
        v.body.rotation.set(v.bank, 0, v.pitch);
      }

      // Emissive state: stall flash for legacy.
      const flashOn = stalled && Math.sin(time * Math.PI * 8) > 0;
      for (const m of v.emissives) {
        if (stalled) {
          m.emissive.copy(flashOn ? STALL_RED : m.userData.baseEmissiveColor);
          m.emissiveIntensity = m.userData.baseEmissive * (flashOn ? 1.6 : 0.5);
        } else {
          m.emissive.copy(m.userData.baseEmissiveColor);
          m.emissiveIntensity = m.userData.baseEmissive;
        }
      }
      // Fail-safe hover: the rear light strobes.
      for (const m of v.tailLights) if (failSafe && !flashOn) m.emissiveIntensity = m.userData.baseEmissive * (Math.sin(time * 10) > 0 ? 3 : 0.6);
      v.discMat.opacity = (0.02 + 0.07 * (v.rotorSpeed / ROTOR_FLIGHT)) * (v.discScale ?? 1);
      v.discMat.color.copy(stalled && flashOn ? STALL_RED : v.discColor);

      // Halo ring on the ground under the drone, joined to it by the altitude line.
      const hm = v.halo.material;
      const gm = v.glow.material;
      if (stalled) {
        hm.color.copy(STALL_RED);
        hm.opacity = 0.35 + 0.45 * (flashOn ? 1 : 0);
        gm.color.copy(STALL_RED);
        gm.opacity = 0.16;
        v.halo.scale.setScalar(1 + 0.08 * Math.sin(time * 12));
      } else if (repl) {
        hm.color.copy(REPL_PURPLE);
        hm.opacity = 0.32 + 0.22 * Math.sin(time * 7);
        gm.color.copy(REPL_PURPLE);
        gm.opacity = 0.07;
        v.halo.scale.setScalar(1 + 0.12 * ((time * 1.6) % 1));
      } else {
        hm.color.copy(v.baseHalo);
        hm.opacity = 0.1;
        gm.color.copy(v.baseHalo);
        gm.opacity = 0.02;
        v.halo.scale.setScalar(1);
      }
      v.altLine.visible = alt > 0.6;
      v.altLine.scale.y = Math.max(0.01, v.air.position.y - 0.06);
      v.altLine.material.color.copy(hm.color);

      // Floating label.
      const speed = `${Math.round(kmh)} km/h`;
      if (id === 'legacy') {
        if (stalled && d.stall) {
          const s = d.stall;
          const sub = s.waiting ? 'no carrier — waiting' : `stalled · ${s.phaseLabel} · ${s.remaining.toFixed(1)} s left`;
          this._setLabel(v, 'is-stalled', `SIMULATED INTERRUPTION · ${s.total.toFixed(1)} s`, sub, s.elapsed / s.total);
        } else {
          const st = agent.trace?.stage;
          const sub = failSafe
            ? 'fail-safe hover · C2 link lost'
            : st === 'FAILED'
              ? 'link failed · still attached'
              : st === 'DEGRADING'
                ? 'link degrading · no prediction'
                : `break-before-make${this._gapText(snapshot)}`;
          this._setLabel(v, '', `${d?.primary ?? '—'} · ${speed}`, sub, 0);
        }
      } else if (repl) {
        const cls = d.replicate?.REALTIME ? 'critical + real-time' : 'critical';
        const win = d.burstWindowS ?? POWER_PARAMS.burstWindowS;
        this._setLabel(v, 'is-repl', `⇉ ${d.primary} + ${d.replica}`, `BURST TX ${W[2]} W · ${cls} · ${Math.round(d.replicationElapsed * 1000)}/${Math.round(win * 1000)} ms`, Math.min(1, d.replicationElapsed / win));
      } else {
        const ls = d?.lastSwitch;
        const recent = ls && snapshot.t - ls.t < 2.5;
        if (recent) {
          this._setLabel(v, 'is-ok', `${d?.primary ?? '—'} · ${speed}`, ls.seamless ? `SWITCHED ✓ ${ls.from} → ${ls.to} · 0 ms gap` : `FAILOVER ${ls.from} → ${ls.to} · ${ls.blackoutMs} ms`, 0);
        } else if (d?.protecting) {
          this._setLabel(v, 'is-predict', `${d.primary} · ${speed}`, `PROTECTION WINDOW · bulk paced → ${d.replica}`, 0);
        } else if (d?.watching) {
          const p = d.prediction;
          const proj = Number.isFinite(p?.projectedTtf) ? p.projectedTtf : p?.ttf;
          const ttf = Number.isFinite(proj) ? ` · failure ≈ ${proj < 1 ? proj.toFixed(2) : proj.toFixed(1)} s` : '';
          const next = d.prepared ? ` · ${d.prepared} warm ✓` : d.warmTarget ? ` · waking ${d.warmTarget} (${W[1]} W)` : '';
          this._setLabel(v, 'is-predict', `${d.primary} · ${speed}`, `PREDICT${ttf}${next}`, 0);
        } else if (d?.warmTarget && (d.radio?.[d.warmTarget] === 'WARM' || d.radio?.[d.warmTarget] === 'WAKING')) {
          this._setLabel(v, '', `${d.primary ?? '—'} · ${speed}`, `WARM PROBE ${d.warmTarget} · ${W[1]} W`, 0);
        } else {
          this._setLabel(v, '', `${d?.primary ?? '—'} · ${speed}`, `DRX standby ${W[0]} W · relay ${RELAY_PARAMS.anchorIp}`, 0);
        }
      }
    }
  }
}
