/**
 * PacketParticleManager.js — animated data packets travelling down the beams.
 *
 * One InstancedMesh draws every packet (single draw call). Travel time scales
 * with link RTT, so Wi-Fi packets zip across while satellite packets move at a
 * measured, deliberate pace. Packet fate mirrors the simulation:
 *   • critical packets  — bright white-cyan cores
 *   • bulk packets      — tinted with the link colour
 *   • replicated pairs  — purple twins launched on both paths simultaneously
 *   • lost packets      — flash red and fizzle out mid-beam
 *   • legacy stall      — no packets at all; in-flight packets on the dead path die
 */
import * as THREE from 'three';
import { INTERFACE_IDS, INTERFACE_SPECS } from '../simulation/LinkModel.js';

const CRITICAL = new THREE.Color('#e0fdff');
const DUPLICATE = new THREE.Color('#d8b4fe');
const LOST = new THREE.Color('#ff2340');
const PROBE = new THREE.Color('#64748b');

export class PacketParticleManager {
  constructor(sceneManager, beams, { max = 1800 } = {}) {
    this.sm = sceneManager;
    this.beams = beams;
    this.max = max;
    const geo = new THREE.IcosahedronGeometry(0.15, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 6;
    this.sm.scene.add(this.mesh);

    this.pool = [];
    for (let i = 0; i < max; i++) this.pool.push({ alive: false, color: new THREE.Color() });
    this.spawnAcc = new Map();
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._c = new THREE.Color();
    this.linkColors = Object.fromEntries(INTERFACE_IDS.map((id) => [id, new THREE.Color(INTERFACE_SPECS[id].color)]));
  }

  _alloc() {
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[(this._cursor = ((this._cursor ?? 0) + 1) % this.pool.length)];
      if (!p.alive) return p;
    }
    return null;
  }

  _spawn(beam, { kind, dir, twin = false }) {
    const p = this._alloc();
    if (!p) return;
    const travel = Math.min(2.6, Math.max(0.24, 0.16 + beam.rttMs / 34)) * (beam.linkId === 'sat0' ? 1.25 : 1);
    p.alive = true;
    p.beam = beam;
    p.dir = dir;
    p.t = 0;
    p.speed = 1 / travel;
    p.kind = kind;
    p.fade = 1;
    p.dying = false;
    const lossP = kind === 'probe' ? 0 : Math.min(0.95, beam.loss ?? 0);
    p.lost = Math.random() < lossP;
    p.dieAt = 0.25 + Math.random() * 0.55;
    p.size = kind === 'critical' ? 1.15 : kind === 'dup' ? 1.05 : kind === 'probe' ? 0.55 : 0.8;
    if (kind === 'critical') p.color.copy(CRITICAL);
    else if (kind === 'dup') p.color.copy(DUPLICATE);
    else if (kind === 'probe') p.color.copy(PROBE);
    else p.color.copy(this.linkColors[beam.linkId]).multiplyScalar(1.3);
    p.twin = twin;
  }

  _rates(beam, repl) {
    // Visual packets per second (not 1:1 with simulated traffic — legible density).
    switch (beam.role) {
      case 'primary':
        return { critical: repl ? 0 : 7, bulk: 5 + 12 * Math.max(beam.share, 0.3), dup: repl ? 7 : 0, probe: 0 };
      case 'replica':
        return { critical: 0, bulk: 4 * beam.share, dup: 0, probe: 0 }; // twins spawned with primary
      case 'share':
        return { critical: 0, bulk: 3 + 14 * beam.share, dup: 0, probe: 0 };
      case 'probe':
        return { critical: 0, bulk: 0, dup: 0, probe: 1.1 };
      default:
        return { critical: 0, bulk: 0, dup: 0, probe: 0 };
    }
  }

  update(snapshot, dt, visibility = {}) {
    // ── Spawning ─────────────────────────────────────────────────────────
    for (const beam of this.beams.beams.values()) {
      if (visibility[beam.vehicleId] === false || beam.intensity < 0.12) continue;
      const agent = snapshot.agents[beam.vehicleId];
      const repl = !!agent.decision?.replicationActive;
      const rates = this._rates(beam, repl);
      const key = beam.mesh.id;
      const acc = this.spawnAcc.get(key) ?? { critical: 0, bulk: 0, dup: 0, probe: 0 };
      for (const kind of ['critical', 'bulk', 'dup', 'probe']) {
        acc[kind] += rates[kind] * dt;
        while (acc[kind] >= 1) {
          acc[kind] -= 1;
          const dir = kind === 'bulk' ? (Math.random() < 0.55 ? 1 : -1) : 1;
          if (kind === 'dup') {
            this._spawn(beam, { kind: 'dup', dir, twin: true });
            const replica = this.beams.get(beam.vehicleId, agent.decision.replica);
            if (replica && replica.intensity > 0.1) this._spawn(replica, { kind: 'dup', dir, twin: true });
          } else {
            this._spawn(beam, { kind, dir });
          }
        }
      }
      this.spawnAcc.set(key, acc);
    }

    // ── Integrate & draw ─────────────────────────────────────────────────
    let n = 0;
    const m = this._m;
    const pos = this._p;
    for (const p of this.pool) {
      if (!p.alive) continue;
      const beam = p.beam;
      const dead = beam.intensity < 0.05 || beam.role === 'off' || beam.role === 'failing';
      if (dead && !p.dying) {
        p.dying = true;
        p.color.copy(LOST);
      }
      p.t += p.speed * dt;
      if (p.lost && p.t >= p.dieAt && !p.dying) {
        p.dying = true;
        p.color.copy(LOST);
        p.speed *= 0.25;
      }
      if (p.dying) p.fade -= dt * 3.2;
      if (p.t >= 1 || p.fade <= 0) {
        p.alive = false;
        continue;
      }
      const u = p.dir > 0 ? p.t : 1 - p.t;
      beam.curve.getPoint(u, pos);
      const edge = Math.min(1, p.t * 8, (1 - p.t) * 8);
      const s = p.size * (0.5 + 0.5 * edge) * (p.dying ? 1 + (1 - p.fade) * 1.4 : 1);
      m.makeScale(s, s, s).setPosition(pos);
      this.mesh.setMatrixAt(n, m);
      this._c.copy(p.color).multiplyScalar(Math.max(0, p.fade) * (0.35 + 0.65 * edge) * Math.min(1, beam.intensity * 1.4));
      this.mesh.setColorAt(n, this._c);
      n++;
      if (n >= this.max) break;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (const p of this.pool) p.alive = false;
    this.spawnAcc.clear();
    this.mesh.count = 0;
  }
}
