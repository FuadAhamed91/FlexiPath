/**
 * main.js — FlexiPath entry point.
 *
 * Wires the renderer-agnostic SimulationEngine (10 Hz fixed step) to the
 * Three.js digital twin (60 fps, interpolated) and the HUD.
 *
 * URL parameters: ?scenario=mission|A…F&seed=2026&speed=60&mode=mission|advanced
 *                 &focus=flexipath|legacy&camera=chase|cinematic|overview&intro=0&paused=1&demo=1
 */
import * as THREE from 'three';
import { SimulationEngine } from './simulation/SimulationEngine.js';
import { SCENARIOS } from './simulation/Scenarios.js';
import { SceneManager } from './three/SceneManager.js';
import { EnvironmentManager } from './three/EnvironmentManager.js';
import { NetworkNodeManager } from './three/NetworkNodeManager.js';
import { VehicleManager } from './three/VehicleManager.js';
import { BeamManager } from './three/BeamManager.js';
import { PacketParticleManager } from './three/PacketParticleManager.js';
import { Dashboard } from './ui/Dashboard.js';
import { METERS_PER_UNIT } from './simulation/MobilityModel.js';

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const speed = Number(q.get('speed'));
  return {
    seed: q.get('seed') || 2026,
    speedKmh: q.has('speed') && Number.isFinite(speed) ? Math.max(0, Math.min(120, speed)) : 60,
    scenario: SCENARIOS[q.get('scenario')] ? q.get('scenario') : 'mission',
    mode: q.get('mode') === 'advanced' ? 'advanced' : 'mission',
    focus: q.get('focus') === 'legacy' ? 'legacy' : 'flexipath',
    camera: ['chase', 'cinematic', 'overview'].includes(q.get('camera')) ? q.get('camera') : 'chase',
    look: q.get('look') === 'twin' ? 'twin' : 'real',
    paused: q.get('paused') === '1',
    intro: q.get('intro') !== '0',
    demo: q.get('demo') === '1',
  };
}

const bootStatus = (text) => {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = text;
};

function hideSplash() {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.classList.add('is-hidden');
  setTimeout(() => splash.remove(), 700);
}

async function boot() {
  const params = readParams();
  const engine = new SimulationEngine({ seed: params.seed, speedKmh: params.speedKmh, scenario: params.scenario });
  engine.setPaused(true); // hold the clock until the scene is ready

  const dashboard = new Dashboard(document.getElementById('app'), engine, { mode: params.mode });
  dashboard.view.focus = params.focus;
  dashboard.controls.setEngine(params.focus);

  bootStatus('Building 3D digital twin…');
  const sceneManager = new SceneManager(dashboard.viewportEl);
  const world = engine.world;
  const environment = new EnvironmentManager(sceneManager, world);
  const nodes = new NetworkNodeManager(sceneManager, world);
  const vehicles = new VehicleManager(sceneManager, world);

  bootStatus('Loading models (Blender GLB → procedural fallback)…');
  await Promise.all([nodes.load(), vehicles.load()]);
  const beams = new BeamManager(sceneManager, vehicles, nodes);
  const particles = new PacketParticleManager(sceneManager, beams);

  dashboard.setAssetSource({ vehicles: vehicles.usedGLB, nodes: nodes.usedGLB });
  dashboard.hooks.onCamera = (mode) => sceneManager.setCameraMode(mode);
  dashboard.hooks.onLook = (look) => {
    sceneManager.setLook(look);
    environment.setLook(look);
    nodes.setLook(look);
    vehicles.setLook(look);
  };
  dashboard.setLook(params.look, { quiet: true });
  dashboard.hooks.onBeforeReset = () => particles.clear();
  dashboard.setCamera(params.camera);

  // A scenario may start anywhere on the route: snap the chase camera to the drones on reset.
  let snapCamera = true;
  engine.on('reset', () => {
    snapCamera = true;
  });

  const focusPos = new THREE.Vector3();
  const otherPos = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const LEGACY_STATE = { INTERRUPTED: 'SIMULATED INTERRUPTION', STOPPING: 'SIMULATED INTERRUPTION · hovering', RECOVERED: 'recovering', FAILED: 'on a failed link', DEGRADING: 'link degrading' };

  /** Edge marker for the comparison drone when it is outside the camera frame. */
  const updateOffscreen = (snapshot, focus, other, showGhost) => {
    if (!showGhost || dashboard.view.camera === 'overview') return dashboard.updateOffscreen({ visible: false });
    vehicles.getPosition(other, ndc);
    ndc.y += 2.5;
    ndc.project(sceneManager.camera);
    const behind = ndc.z > 1;
    if (!behind && Math.abs(ndc.x) <= 0.92 && Math.abs(ndc.y) <= 0.9) return dashboard.updateOffscreen({ visible: false });
    let x = behind ? -ndc.x : ndc.x;
    let y = behind ? -ndc.y : ndc.y;
    const m = Math.max(Math.abs(x), Math.abs(y), 1e-6);
    x /= m;
    y /= m;
    const host = dashboard.refs.viewport;
    const px = ((x * 0.94 + 1) / 2) * host.clientWidth;
    const py = ((1 - y * 0.9) / 2) * host.clientHeight;
    const A = snapshot.agents;
    const gapM = (A[focus].vehicle.s - A[other].vehicle.s) * METERS_PER_UNIT;
    const name = other === 'legacy' ? 'LEGACY OS' : 'FLEXIPATH';
    const where = Math.abs(gapM) < 2 ? 'alongside' : `${Math.abs(gapM).toFixed(0)} m ${gapM > 0 ? 'behind' : 'ahead'}`;
    const st = other === 'legacy' ? LEGACY_STATE[A.legacy.trace.stage] : null;
    dashboard.updateOffscreen({
      visible: true,
      x: px,
      y: py,
      angle: Math.atan2(-y, x),
      legacy: other === 'legacy',
      text: `${name} · ${where}${st ? ` · ${st}` : ''}`,
    });
  };
  const ghostState = { flexipath: true, legacy: true };
  let last = performance.now();

  const frame = (now) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    const time = now / 1000;

    engine.advance(dt);
    const render = engine.getRenderState();
    const snapshot = engine.snapshot;

    const { focus, showGhost } = dashboard.view;
    const other = focus === 'flexipath' ? 'legacy' : 'flexipath';
    const visibility = { [focus]: true, [other]: showGhost };
    for (const id of ['flexipath', 'legacy']) {
      if (ghostState[id] !== visibility[id]) {
        ghostState[id] = visibility[id];
        vehicles.setVisible(id, visibility[id]);
      }
    }

    vehicles.update(render, snapshot, dt, time);
    nodes.update(render, snapshot, focus, time);
    beams.update(render, snapshot, dt, time, visibility);
    particles.update(snapshot, dt, visibility);

    vehicles.getPosition(focus, focusPos);
    if (snapCamera) {
      sceneManager.snapTo(focusPos);
      snapCamera = false;
    }
    environment.update(time, focusPos);
    sceneManager.updateCamera(dt, focusPos, showGhost ? vehicles.getPosition(other, otherPos) : null);
    sceneManager.render();
    updateOffscreen(snapshot, focus, other, showGhost);
    dashboard.frame(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  hideSplash();
  if (params.demo) dashboard.startDemo();
  else if (params.intro) dashboard.showIntro();
  else dashboard.togglePause(params.paused);

  // Handy for demos and debugging from the browser console.
  window.flexipath = { engine, dashboard, sceneManager, vehicles, nodes, beams, particles };
}

boot().catch((err) => {
  console.error('[FlexiPath] startup failed', err);
  bootStatus(`Startup failed: ${err?.message ?? err}. WebGL 2 is required.`);
});
