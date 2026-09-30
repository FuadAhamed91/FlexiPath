/**
 * main.js — FlexiPath entry point.
 *
 * Wires the renderer-agnostic SimulationEngine (10 Hz fixed step) to the
 * Three.js digital twin (60 fps, interpolated) and the HUD.
 *
 * URL parameters: ?seed=2026&speed=60&focus=flexipath|legacy&camera=chase|cinematic|overview&paused=1
 */
import './styles.css';
import * as THREE from 'three';
import { SimulationEngine } from './simulation/SimulationEngine.js';
import { SceneManager } from './three/SceneManager.js';
import { EnvironmentManager } from './three/EnvironmentManager.js';
import { NetworkNodeManager } from './three/NetworkNodeManager.js';
import { VehicleManager } from './three/VehicleManager.js';
import { BeamManager } from './three/BeamManager.js';
import { PacketParticleManager } from './three/PacketParticleManager.js';
import { Dashboard } from './ui/Dashboard.js';

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const speed = Number(q.get('speed'));
  return {
    seed: q.get('seed') || 2026,
    speedKmh: q.has('speed') && Number.isFinite(speed) ? Math.max(0, Math.min(120, speed)) : 60,
    focus: q.get('focus') === 'legacy' ? 'legacy' : 'flexipath',
    camera: ['chase', 'cinematic', 'overview'].includes(q.get('camera')) ? q.get('camera') : 'chase',
    paused: q.get('paused') === '1',
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
  const engine = new SimulationEngine({ seed: params.seed, speedKmh: params.speedKmh });
  engine.setPaused(true); // hold the clock until the scene is ready

  const dashboard = new Dashboard(document.getElementById('app'), engine);
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
  dashboard.hooks.onBeforeReset = () => particles.clear();
  dashboard.setCamera(params.camera);

  const focusPos = new THREE.Vector3();
  const otherPos = new THREE.Vector3();
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
    environment.update(time, focusPos);
    sceneManager.updateCamera(dt, focusPos, showGhost ? vehicles.getPosition(other, otherPos) : null);
    sceneManager.render();
    dashboard.frame(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  hideSplash();
  dashboard.togglePause(params.paused);

  // Handy for demos and debugging from the browser console.
  window.flexipath = { engine, dashboard, sceneManager, vehicles, nodes, beams, particles };
}

boot().catch((err) => {
  console.error('[FlexiPath] startup failed', err);
  bootStatus(`Startup failed: ${err?.message ?? err}. WebGL 2 is required.`);
});
