/**
 * SceneManager.js — renderer, camera rig, bloom post-processing and label layer.
 *
 * Dark high-contrast digital twin: #030712 background, exponential depth fog,
 * ACES tone mapping and an UnrealBloom pass so emissive beams and packets glow.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export const BACKGROUND = 0x030712;
const FOG_DENSITY = 0.0058;

const CHASE_OFFSET = new THREE.Vector3(-15, 9.5, 20);
const OVERVIEW_POSE = { position: new THREE.Vector3(118, 150, 205), target: new THREE.Vector3(118, 0, -12) };

export class SceneManager {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);
    this.scene.fog = new THREE.FogExp2(BACKGROUND, FOG_DENSITY);

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
    this.scene.add(new THREE.AmbientLight(0x1e293b, 0.6));
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
      if (companion) {
        const sep = focus.distanceTo(companion);
        if (sep > 14) this._desired.lerp(companion, Math.min(0.45, (sep - 14) / 90));
      }
      if (this._resetChaseOffset) {
        this._resetChaseOffset = false;
        this._tween = { position: this._desired.clone().add(CHASE_OFFSET), target: this._desired.clone(), t: 0, follow: true };
      }
      if (this._tween?.follow) {
        this._tween.target.copy(this._desired);
        this._tween.position.copy(this._desired).add(CHASE_OFFSET);
      } else {
        this._delta.subVectors(this._desired, this.controls.target).multiplyScalar(k);
        this.controls.target.add(this._delta);
        this.camera.position.add(this._delta);
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
    this.scene.fog.density = FOG_DENSITY * Math.min(1, Math.max(0.3, 42 / dist));
    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
  }

  dispose() {
    this._resizeObserver.disconnect();
    this.renderer.dispose();
  }
}
