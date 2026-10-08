/**
 * SceneManager.js — renderer, camera rig, bloom post-processing and label layer.
 *
 * Exponential depth fog, ACES tone mapping and an UnrealBloom pass so emissive beams and packets glow.
 * `setLook()` switches the lighting, fog and bloom between the moonlit `real` look and the dark neon `twin`.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export const BACKGROUND = 0x030712;

/** Direction towards the moon in the realistic look (RealWorld places the moon disc on it). */
export const MOON_DIRECTION = new THREE.Vector3(0.62, 0.42, -0.66).normalize();

/**
 * Scene-wide settings per look: `real` is a moonlit night over a real city and desert, `twin` the
 * original neon digital twin. The network layer (beams, packets, coverage, drones, labels) is the same in both.
 */
const LOOKS = {
  twin: {
    background: BACKGROUND,
    fog: BACKGROUND,
    fogDensity: 0.0058,
    hemi: { sky: 0x5b8cff, ground: 0x020617, intensity: 0.9 },
    moon: { color: 0xc7d9ff, intensity: 1.6, position: new THREE.Vector3(-80, 140, 90) },
    rim: 0.55,
    ambient: { color: 0x1e293b, intensity: 0.6 },
    bloom: 0.9,
    exposure: 1.05,
  },
  real: {
    background: 0x05070c,
    fog: 0x0a0e16,
    fogDensity: 0.005,
    hemi: { sky: 0x5d6f99, ground: 0x1c1e24, intensity: 0.65 },
    moon: { color: 0xd6defa, intensity: 1.6, position: MOON_DIRECTION.clone().multiplyScalar(400) },
    rim: 0.12,
    ambient: { color: 0x161c27, intensity: 0.45 },
    bloom: 0.72,
    exposure: 1.0,
  },
};

const CHASE_OFFSET = new THREE.Vector3(-15, 9.5, 20);
const OVERVIEW_POSE = { position: new THREE.Vector3(118, 150, 205), target: new THREE.Vector3(118, 0, -12) };

export class SceneManager {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);
    this.scene.fog = new THREE.FogExp2(BACKGROUND, LOOKS.twin.fogDensity);
    this.fogDensity = LOOKS.twin.fogDensity;

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 2000);
    this.camera.position.set(7, 1, -1.5).add(CHASE_OFFSET);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label', 'FlexiPath 3D digital twin viewport');
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    Object.assign(this.labelRenderer.domElement.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
    });
    container.appendChild(this.labelRenderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 480;
    this.controls.target.set(7, 1, -1.5);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // High threshold: only hot sources (beams, packets, LEDs) bloom; cabins glow without smearing the bodywork.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.9, 0.5, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this._addLights();

    this.cameraMode = 'chase';
    this.cinematicAngle = -0.6;
    this._tween = null;
    this._desired = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._off = new THREE.Vector3();
    // Chase framing keeps both vehicles in view: it pulls back as the gap between them grows,
    // on top of whatever distance the user chose with the mouse wheel.
    this._autoZoom = 1;
    this._baseLen = CHASE_OFFSET.length();
    this._userDragging = false;
    this.controls.addEventListener('start', () => {
      this._userDragging = true;
    });
    this.controls.addEventListener('end', () => {
      this._userDragging = false;
      this._baseLen = this.camera.position.distanceTo(this.controls.target) / this._autoZoom;
    });

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this.resize();
  }

  _addLights() {
    const hemi = new THREE.HemisphereLight(0x5b8cff, 0x020617, 0.9);
    this.scene.add(hemi);
    const moon = new THREE.DirectionalLight(0xc7d9ff, 1.6);
    moon.position.set(-80, 140, 90);
    this.scene.add(moon);
    const rim = new THREE.DirectionalLight(0x00f0ff, 0.55);
    rim.position.set(120, 40, -160);
    this.scene.add(rim);
    const ambient = new THREE.AmbientLight(0x1e293b, 0.6);
    this.scene.add(ambient);
    this.lights = { hemi, moon, rim, ambient };
  }

  /** Switch the scene-wide lighting, fog and bloom between the `real` and `twin` looks. */
  setLook(look) {
    const L = LOOKS[look] ?? LOOKS.twin;
    const { hemi, moon, rim, ambient } = this.lights;
    this.scene.background.set(L.background);
    this.scene.fog.color.set(L.fog);
    this.fogDensity = L.fogDensity;
    hemi.color.set(L.hemi.sky);
    hemi.groundColor.set(L.hemi.ground);
    hemi.intensity = L.hemi.intensity;
    moon.color.set(L.moon.color);
    moon.intensity = L.moon.intensity;
    moon.position.copy(L.moon.position);
    rim.intensity = L.rim;
    ambient.color.set(L.ambient.color);
    ambient.intensity = L.ambient.intensity;
    this.bloom.strength = L.bloom;
    this.renderer.toneMappingExposure = L.exposure;
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setCameraMode(mode) {
    this.cameraMode = mode;
    if (mode === 'overview') {
      this._tween = { ...OVERVIEW_POSE, t: 0 };
    } else if (mode === 'chase') {
      this._tween = null;
      this._resetChaseOffset = true;
    } else {
      this._tween = null;
    }
  }

  /** Jump the chase camera to the focus vehicle (after a scenario reset moves it along the route). */
  snapTo(focus) {
    if (this.cameraMode !== 'chase') return;
    this._tween = null;
    this._autoZoom = 1;
    this._baseLen = CHASE_OFFSET.length();
    this.controls.target.copy(focus).add({ x: 7, y: 1, z: -1.5 });
    this.camera.position.copy(this.controls.target).add(CHASE_OFFSET);
  }

  /**
   * Camera rig update.
   * @param {number} dt seconds
   * @param {THREE.Vector3} focus focused vehicle position
   * @param {THREE.Vector3|null} companion other vehicle (if visible) — framed in chase mode
   */
  updateCamera(dt, focus, companion) {
    const k = 1 - Math.exp(-dt * 4.5);
    if (this.cameraMode === 'chase') {
      this._desired.copy(focus).add({ x: 7, y: 1, z: -1.5 });
      let wantZoom = 1;
      if (companion) {
        // Keep both vehicles in frame: aim between them and pull back until a sphere around
        // both fits inside the narrower half field of view.
        const sep = focus.distanceTo(companion);
        this._desired.lerp(companion, THREE.MathUtils.clamp((sep - 4) / 30, 0, 0.5));
        const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
        const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
        const need = (sep / 2 + 6) / Math.sin(Math.min(vHalf, hHalf));
        wantZoom = THREE.MathUtils.clamp(need / this._baseLen, 1, 4.5);
      }
      this._autoZoom += (wantZoom - this._autoZoom) * Math.min(1, k * 0.8);
      if (this._resetChaseOffset) {
        this._resetChaseOffset = false;
        this._baseLen = CHASE_OFFSET.length();
        this._tween = { position: this._desired.clone().add(CHASE_OFFSET), target: this._desired.clone(), t: 0, follow: true };
      }
      if (this._tween?.follow) {
        this._tween.target.copy(this._desired);
        this._tween.position.copy(this._desired).add(this._off.copy(CHASE_OFFSET).multiplyScalar(this._autoZoom));
      } else {
        this._delta.subVectors(this._desired, this.controls.target).multiplyScalar(k);
        this.controls.target.add(this._delta);
        this.camera.position.add(this._delta);
        if (!this._userDragging) {
          const off = this._off.subVectors(this.camera.position, this.controls.target);
          const len = off.length();
          const want = this._baseLen * this._autoZoom;
          if (len > 1e-3) {
            off.multiplyScalar((len + (want - len) * Math.min(1, k * 0.8)) / len);
            this.camera.position.copy(this.controls.target).add(off);
          }
        }
      }
    } else if (this.cameraMode === 'cinematic') {
      this.cinematicAngle += dt * 0.16;
      const a = this.cinematicAngle;
      const r = 24;
      this._desired.set(focus.x + Math.cos(a) * r, focus.y + 7 + Math.sin(a * 0.7) * 2.5, focus.z + Math.sin(a) * r + 4);
      this.camera.position.lerp(this._desired, k);
      this.controls.target.lerp(this._delta.copy(focus).add({ x: 3, y: 1.5, z: 0 }), k * 1.5);
    }

    if (this._tween) {
      const tw = this._tween;
      tw.t = Math.min(1, tw.t + dt * 1.1);
      const e = 1 - (1 - tw.t) ** 3;
      this.camera.position.lerp(tw.position, e * 0.35 + 0.02);
      this.controls.target.lerp(tw.target, e * 0.35 + 0.02);
      if (tw.t >= 1 && this.camera.position.distanceTo(tw.position) < 0.5) this._tween = null;
    }
  }

  render() {
    this.controls.update();
    // Depth fog tuned for the chase camera; thin it out as the camera pulls back so overviews stay legible.
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.scene.fog.density = this.fogDensity * Math.min(1, Math.max(0.3, 42 / dist));
    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
  }

  dispose() {
    this._resizeObserver.disconnect();
    this.renderer.dispose();
  }
}
