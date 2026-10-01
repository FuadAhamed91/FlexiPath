/**
 * VehicleManager.js — FlexiPath vehicle (A) and the Legacy ghost vehicle (B).
 *
 * Models come from public/models/{flexipath,legacy}_vehicle.glb when present,
 * otherwise an identical low-poly cyber-vehicle is built from primitives.
 * Each vehicle exposes an `AntennaAnchor` (roof antenna tip) where beams start.
 *
 * Visual state (all driven by the simulation snapshot):
 *   FlexiPath  — cyan halo; label shows PREDICT / WARM PROBE / BURST TX / SWITCHED with the
 *                radio power; purple pulsing halo while critical traffic is replicated
 *   Legacy     — crimson ghost; on an interruption it flashes red, shakes (stutters),
 *                brakes (fail-safe) and shows "SIMULATED INTERRUPTION · 3.8 s" with a countdown
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadGLB, collectEmissives } from './NetworkNodeManager.js';
import { METERS_PER_UNIT } from '../simulation/MobilityModel.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';
import { RELAY_PARAMS } from '../simulation/RelayTunnelModel.js';

const W = POWER_PARAMS.tierWatts;

const PALETTE = {
  flexipath: { body: '#0b0f16', accent: '#00F0FF', cabin: '#00F0FF', trim: '#1f2937' },
  legacy: { body: '#3b0a16', accent: '#E11D48', cabin: '#FB7185', trim: '#4c0519' },
};
const WHEEL_RADIUS = 0.36;
const VEHICLE_SCALE = 1.3; // stylised: vehicles read clearly against 1.2 km of route
const STALL_RED = new THREE.Color('#EF4444');
const REPL_PURPLE = new THREE.Color('#a855f7');

export function buildVehicle(kind = 'flexipath') {
  const c = PALETTE[kind];
  const root = new THREE.Group();
  const carbon = new THREE.MeshStandardMaterial({ color: c.body, metalness: 0.75, roughness: 0.32 });
  const trim = new THREE.MeshStandardMaterial({ color: c.trim, metalness: 0.6, roughness: 0.45 });
  const glass = new THREE.MeshStandardMaterial({
    color: '#02060d',
    metalness: 0.3,
    roughness: 0.15,
    emissive: new THREE.Color(c.cabin),
    emissiveIntensity: 1.1,
  });
  const accent = new THREE.MeshStandardMaterial({ color: '#05080f', emissive: new THREE.Color(c.accent), emissiveIntensity: 2.6 });
  const tail = new THREE.MeshStandardMaterial({ color: '#05080f', emissive: new THREE.Color('#ff2848'), emissiveIntensity: 2.2 });
  tail.name = 'TailLight';

  const extrude = (pts, width, mat) => {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: width - 0.12,
      bevelEnabled: true,
      bevelThickness: 0.06,
      bevelSize: 0.05,
      bevelSegments: 2,
    });
    geo.translate(0, 0, -(width - 0.12) / 2);
    return new THREE.Mesh(geo, mat);
  };

  // Wedge chassis (side profile, forward = +X).
  root.add(
    extrude(
      [
        [-1.8, 0.3],
        [1.72, 0.3],
        [1.88, 0.5],
        [1.7, 0.7],
        [0.72, 0.86],
        [-1.25, 0.9],
        [-1.78, 0.8],
        [-1.88, 0.5],
      ],
      1.64,
      carbon,
    ),
  );
  // Glowing cabin canopy.
  root.add(
    extrude(
      [
        [0.8, 0.84],
        [0.18, 1.3],
        [-0.92, 1.34],
        [-1.36, 0.9],
      ],
      1.3,
      glass,
    ),
  );
  // Side skirts, light bars.
  for (const side of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 0.04), accent);
    skirt.position.set(0, 0.42, side * 0.84);
    root.add(skirt);
  }
  const front = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 1.34), accent);
  front.position.set(1.86, 0.6, 0);
  root.add(front);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 1.4), tail);
  rear.position.set(-1.88, 0.62, 0);
  root.add(rear);

  // Wheels (axis along Z so rotation.z spins them).
  const tyre = new THREE.MeshStandardMaterial({ color: '#05070b', roughness: 0.9, metalness: 0.1 });
  const rimGlow = new THREE.MeshStandardMaterial({ color: '#05080f', emissive: new THREE.Color(c.accent), emissiveIntensity: 2.2 });
  for (const [name, x, z] of [
    ['Wheel_FL', 1.12, 0.83],
    ['Wheel_FR', 1.12, -0.83],
    ['Wheel_RL', -1.14, 0.83],
    ['Wheel_RR', -1.14, -0.83],
  ]) {
    const wheel = new THREE.Group();
    wheel.name = name;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.28, 24), tyre);
    t.rotation.x = Math.PI / 2;
    wheel.add(t);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.03, 8, 24), rimGlow);
    rim.position.z = Math.sign(z) * 0.145;
    wheel.add(rim);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.02), trim);
    spoke.position.z = Math.sign(z) * 0.145;
    wheel.add(spoke);
    wheel.position.set(x, WHEEL_RADIUS, z);
    root.add(wheel);
  }

  // Roof-mounted multi-link antenna + AntennaAnchor.
  const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.08, 20), trim);
  puck.position.set(-0.5, 1.38, 0);
  root.add(puck);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.62, 8), trim);
  mast.position.set(-0.5, 1.72, 0);
  root.add(mast);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10), accent);
  tip.position.set(-0.5, 2.04, 0);
  root.add(tip);
  const anchorObj = new THREE.Object3D();
  anchorObj.name = 'AntennaAnchor';
  anchorObj.position.set(-0.5, 2.06, 0);
  root.add(anchorObj);
  return root;
}

function makeLabel(kind) {
  const el = document.createElement('div');
  el.className = `veh-label ${kind === 'legacy' ? 'lg' : 'fp'}`;
  el.innerHTML = `<div class="name">${kind === 'legacy' ? 'LEGACY OS' : 'FLEXIPATH'}</div><div class="state"></div><div class="sub"></div><div class="bar"><span></span></div>`;
  const obj = new CSS2DObject(el);
  obj.position.set(0, 3.3, 0);
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

export class VehicleManager {
  constructor(sceneManager, world) {
    this.sm = sceneManager;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'Vehicles';
    this.sm.scene.add(this.group);
    this.vehicles = {};
    this.usedGLB = {};
  }

  async load() {
    const [fpGLB, lgGLB] = await Promise.all([loadGLB('flexipath_vehicle.glb'), loadGLB('legacy_vehicle.glb')]);
    this._register('flexipath', fpGLB);
    this._register('legacy', lgGLB);
    return this;
  }

  _register(id, glb) {
    this.usedGLB[id] = !!glb;
    const model = glb ?? buildVehicle(id);
    const holder = new THREE.Group();
    const body = new THREE.Group(); // shaken / pitched independently of the holder
    body.add(model);
    holder.add(body);
    const { halo, glow } = makeHalo();
    holder.add(halo, glow);
    const label = makeLabel(id);
    holder.add(label.obj);
    holder.scale.setScalar(VEHICLE_SCALE);
    this.group.add(holder);

    // Outermost Wheel_* nodes only (a nested match would double-spin).
    const wheels = [];
    model.traverse((o) => {
      if (!/^Wheel_/i.test(o.name)) return;
      let p = o.parent;
      while (p && !/^Wheel_/i.test(p.name)) p = p.parent;
      if (!p) wheels.push(o);
    });
    let anchorObj = model.getObjectByName('AntennaAnchor');
    if (!anchorObj) model.traverse((o) => (anchorObj ??= o.name.startsWith('AntennaAnchor') ? o : undefined));
    if (!anchorObj) {
      anchorObj = new THREE.Object3D();
      anchorObj.name = 'AntennaAnchor';
      anchorObj.position.set(-0.5, 2.06, 0);
      model.add(anchorObj);
    }
    const emissives = collectEmissives(model, 1.0, 0.3); // no boost: body detail must stay readable under bloom
    const tailLights = emissives.filter((m) => m.name === 'TailLight' || /tail|brake/i.test(m.name));

    if (id === 'legacy') {
      // Ghost treatment: slightly translucent so the FlexiPath car reads as the hero.
      model.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.transparent = true;
          m.opacity = 0.86;
        }
      });
    }

    this.vehicles[id] = {
      id,
      holder,
      body,
      model,
      wheels,
      anchor: anchorObj,
      emissives,
      tailLights,
      halo,
      glow,
      label,
      wheelAngle: 0,
      visible: true,
      baseHalo: new THREE.Color(id === 'legacy' ? '#E11D48' : '#00F0FF'),
    };
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

  getPosition(id, target) {
    return target.copy(this.vehicles[id].holder.position);
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

      // Wheels roll with speed.
      const unitsPerSec = kmh / 3.6 / METERS_PER_UNIT;
      v.wheelAngle -= (unitsPerSec / (WHEEL_RADIUS * VEHICLE_SCALE)) * dt;
      for (const w of v.wheels) w.rotation.z = v.wheelAngle;

      const stalled = !!d?.stalled;
      const repl = !!d?.replicationActive;
      const braking = agent.vehicle.failSafe;

      // Body motion: gentle suspension, stutter while stalled, nose-dive when braking.
      const bob = Math.sin(time * 9 + (id === 'legacy' ? 1.3 : 0)) * 0.012 * Math.min(1, kmh / 40);
      if (stalled) {
        v.body.position.set((Math.random() - 0.5) * 0.09, bob + Math.random() * 0.03, (Math.random() - 0.5) * 0.05);
        v.body.rotation.set((Math.random() - 0.5) * 0.02, 0, (Math.random() - 0.5) * 0.03);
      } else {
        v.body.position.set(0, bob, 0);
        v.body.rotation.set(0, 0, braking ? -0.035 : 0);
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
      for (const m of v.tailLights) if (braking && !flashOn) m.emissiveIntensity = m.userData.baseEmissive * 2.6;

      // Halo ring under the vehicle.
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

      // Floating label.
      const speed = `${Math.round(kmh)} km/h`;
      if (id === 'legacy') {
        if (stalled && d.stall) {
          const s = d.stall;
          const sub = s.waiting ? 'no carrier — waiting' : `stalled · ${s.phaseLabel} · ${s.remaining.toFixed(1)} s left`;
          this._setLabel(v, 'is-stalled', `SIMULATED INTERRUPTION · ${s.total.toFixed(1)} s`, sub, s.elapsed / s.total);
        } else {
          const st = agent.trace?.stage;
          const sub = braking
            ? 'fail-safe braking'
            : st === 'FAILED'
              ? 'link failed · still attached'
              : st === 'DEGRADING'
                ? 'link degrading · no prediction'
                : 'break-before-make';
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
