/**
 * BeamManager.js — dynamic CatmullRom energy beams between each vehicle's
 * AntennaAnchor and every network node.
 *
 *   eth0  Slate #64748B · wlan0 Neon Cyan #00F0FF · wwan0 Emerald #10B981
 *   sat0  Warm Gold #F59E0B · replication window: dual purple pulse #A855F7
 *   prepared next path: dashed beam · legacy interruption: beam turns red #EF4444, flickers and dies
 *
 * Tubes are rebuilt in place every frame (pre-allocated buffers, parallel-
 * transport frames) so beams stay attached to moving vehicles and satellites.
 */
import * as THREE from 'three';
import { INTERFACE_IDS, INTERFACE_SPECS } from '../simulation/LinkModel.js';

const BEAM_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;

const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uPulseColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uFlow;
  uniform float uPulse;
  uniform float uDash;
  uniform float uFlicker;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    float along = vUv.x;
    float wave = fract(along * 7.0 - uTime * uFlow);
    float streak = smoothstep(0.0, 0.22, wave) * smoothstep(1.0, 0.5, wave);
    float ends = smoothstep(0.0, 0.1, along) * smoothstep(1.0, 0.97, along); // soft start at the vehicle antenna
    float dash = mix(1.0, step(0.45, fract(along * 26.0 - uTime * 0.6)), uDash);
    float pulseWave = 0.5 + 0.5 * sin(uTime * 8.0 - along * 16.0);
    vec3 col = mix(uColor, uPulseColor, uPulse * (0.55 + 0.45 * pulseWave));
    float core = pow(vFacing, 1.5);
    float a = uIntensity * ends * dash * uFlicker * (0.28 + 0.72 * streak + uPulse * 0.45 * pulseWave) * (0.35 + 0.65 * core);
    gl_FragColor = vec4(col * (1.4 + 2.2 * streak + uPulse * 1.2), a);
  }
`;

const RED = new THREE.Color('#EF4444');
const PURPLE = new THREE.Color('#A855F7');
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** Pre-allocated tube whose vertices are recomputed from a curve each frame. */
class DynamicTube {
  constructor(segments = 56, radial = 8) {
    this.segments = segments;
    this.radial = radial;
    const vCount = (segments + 1) * (radial + 1);
    this.positions = new Float32Array(vCount * 3);
    this.normals = new Float32Array(vCount * 3);
    const uvs = new Float32Array(vCount * 2);
    const idx = [];
    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= radial; j++) {
        const k = i * (radial + 1) + j;
        uvs[k * 2] = i / segments;
        uvs[k * 2 + 1] = j / radial;
        if (i < segments && j < radial) {
          const a = k;
          const b = k + radial + 1;
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(idx);
    this._p = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._o = new THREE.Vector3();
  }

  update(curve, radius) {
    const { segments, radial, positions, normals } = this;
    const P = this._p;
    const T = this._t;
    const N = this._n;
    const B = this._b;
    const O = this._o;
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      curve.getPoint(u, P);
      curve.getTangent(Math.min(0.999, Math.max(0.001, u)), T).normalize();
      if (i === 0) {
        N.crossVectors(T, Math.abs(T.y) > 0.9 ? X_AXIS : UP).normalize();
      } else {
        N.addScaledVector(T, -N.dot(T)); // parallel transport (Gram-Schmidt)
        if (N.lengthSq() < 1e-8) N.crossVectors(T, UP);
        N.normalize();
      }
      B.crossVectors(T, N).normalize();
      const r = radius * (0.55 + 0.45 * Math.sin(Math.PI * u) + (i === 0 || i === segments ? -0.2 : 0));
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        O.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
        const k = (i * (radial + 1) + j) * 3;
        positions[k] = P.x + O.x * r;
        positions[k + 1] = P.y + O.y * r;
        positions[k + 2] = P.z + O.z * r;
        normals[k] = O.x;
        normals[k + 1] = O.y;
        normals[k + 2] = O.z;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }
}

export class BeamManager {
  constructor(sceneManager, vehicles, nodes) {
    this.sm = sceneManager;
    this.vehicles = vehicles;
    this.nodes = nodes;
    this.group = new THREE.Group();
    this.group.name = 'Beams';
    this.sm.scene.add(this.group);
    this.beams = new Map();
    this._start = new THREE.Vector3();
    this._end = new THREE.Vector3();
    for (const vid of Object.keys(vehicles.vehicles)) {
      for (const lid of INTERFACE_IDS) this._create(vid, lid);
    }
  }

  static key(vehicleId, linkId) {
    return `${vehicleId}:${linkId}`;
  }

  _create(vehicleId, linkId) {
    const color = new THREE.Color(INTERFACE_SPECS[linkId].color);
    const uniforms = {
      uColor: { value: color.clone() },
      uPulseColor: { value: PURPLE.clone() },
      uIntensity: { value: 0 },
      uTime: { value: 0 },
      uFlow: { value: 1 },
      uPulse: { value: 0 },
      uDash: { value: 0 },
      uFlicker: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const tube = new DynamicTube(linkId === 'sat0' ? 64 : 48, 8);
    const mesh = new THREE.Mesh(tube.geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 5;
    this.group.add(mesh);
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], false, 'centripetal');
    this.beams.set(BeamManager.key(vehicleId, linkId), {
      vehicleId,
      linkId,
      mesh,
      tube,
      curve,
      uniforms,
      baseColor: color,
      intensity: 0,
      target: 0,
      role: 'off',
      rttMs: INTERFACE_SPECS[linkId].baseRtt,
      loss: 0,
      share: 0,
      ready: false,
      endSmoothed: new THREE.Vector3(),
    });
  }

  get(vehicleId, linkId) {
    return this.beams.get(BeamManager.key(vehicleId, linkId));
  }

  /** Decide role / target intensity for each beam from the latest decision. */
  _roles(vehicleId, agent) {
    const d = agent.decision;
    const links = agent.links;
    const out = {};
    for (const lid of INTERFACE_IDS) {
      const L = links[lid];
      const share = d?.bulkShares?.[lid] ?? 0;
      let role = 'off';
      let target = 0;
      if (vehicleId === 'legacy') {
        if (d?.stalled && d.stall) {
          if (lid === d.stall.from) {
            role = 'failing';
            target = d.stall.elapsed < 1.2 ? 0.9 : 0;
          } else if (lid === d.stall.to && L.up && d.stall.phase !== 'detect') {
            role = 'attaching';
            target = 0.22;
          }
        } else if (lid === d?.primary && L.up) {
          role = 'primary';
          target = 1;
        }
      } else if (L.up) {
        const radio = d?.radio?.[lid];
        const sc = d?.scores?.[lid];
        if (lid === d?.primary) {
          role = 'primary';
          target = 1;
        } else if (lid === d?.replica) {
          role = 'replica'; // BURST TX: both radios transmit during the handoff window
          target = d.replicationActive ? 0.95 : 0.6;
        } else if (lid === d?.prepared) {
          role = 'prepared'; // warm-validated next path: heartbeats, no traffic yet
          target = 0.45;
        } else if (share > 0.001) {
          role = 'share';
          target = 0.35 + 0.5 * share;
        } else if (radio === 'WARM') {
          role = 'prepared'; // warm probe, still being validated by its heartbeats
          target = 0.3;
        } else if (radio === 'WAKING') {
          role = 'waking';
          target = 0.18;
        } else if (radio === 'DRX') {
          // Asleep: no probes. A faint blink on the tick the modem wakes for its DRX signal sample.
          role = 'paging';
          target = sc?.estimated && sc.ageS < 0.05 ? 0.16 : 0;
        }
      }
      out[lid] = { role, target, share, rttMs: L.up ? L.rttMs : Infinity, loss: L.lossRate };
    }
    return out;
  }

  update(render, snapshot, dt, time, visibility = {}) {
    const k = 1 - Math.exp(-dt * 7);
    for (const vid of Object.keys(this.vehicles.vehicles)) {
      const agent = snapshot.agents[vid];
      const visible = visibility[vid] !== false;
      const roles = this._roles(vid, agent);
      const serving = agent.links.sat0?.info?.servingSat;
      const repl = !!agent.decision?.replicationActive;
      this.vehicles.getAnchorWorldPosition(vid, this._start);

      for (const lid of INTERFACE_IDS) {
        const beam = this.get(vid, lid);
        const r = roles[lid];
        beam.role = r.role;
        beam.share = r.share;
        beam.rttMs = r.rttMs;
        beam.loss = r.loss;
        beam.target = visible ? r.target : 0;
        beam.intensity += (beam.target - beam.intensity) * (beam.target < beam.intensity && r.role === 'off' ? Math.min(1, k * 2.5) : k);
        const show = beam.intensity > 0.01;
        beam.mesh.visible = show;
        if (!show) {
          beam.ready = false;
          continue;
        }

        this.nodes.getAnchorWorldPosition(lid, this._end, serving);
        if (!beam.ready) beam.endSmoothed.copy(this._end);
        else beam.endSmoothed.lerp(this._end, lid === 'sat0' ? Math.min(1, dt * 3) : 1);
        beam.ready = true;
        const end = beam.endSmoothed;

        const [p0, p1, p2] = beam.curve.points;
        p0.copy(this._start);
        p2.copy(end);
        const dist = p0.distanceTo(p2);
        p1.lerpVectors(p0, p2, 0.5);
        if (lid === 'sat0') p1.y += dist * 0.06;
        else p1.y += Math.min(14, dist * 0.2);
        const radius = r.role === 'primary' || r.role === 'failing' ? 0.13 : r.role === 'replica' ? 0.12 : r.role === 'prepared' ? 0.09 : 0.07;
        beam.tube.update(beam.curve, radius);

        const u = beam.uniforms;
        u.uTime.value = time;
        u.uIntensity.value = beam.intensity;
        u.uFlow.value = Math.min(2.4, Math.max(0.12, 9 / Math.max(3, beam.rttMs)));
        u.uDash.value = r.role === 'probe' || r.role === 'attaching' || r.role === 'prepared' || r.role === 'waking' || r.role === 'paging' ? 1 : 0;
        const pulse = repl && (r.role === 'primary' || r.role === 'replica') ? 1 : 0;
        u.uPulse.value += (pulse - u.uPulse.value) * k;
        if (r.role === 'failing' || r.role === 'attaching') {
          u.uColor.value.copy(RED);
          u.uFlicker.value = r.role === 'failing' ? (Math.random() > 0.35 ? 1 : 0.15) : 0.6 + 0.4 * Math.sin(time * 10);
        } else {
          u.uColor.value.copy(beam.baseColor);
          u.uFlicker.value = 1;
        }
      }
    }
  }
}
