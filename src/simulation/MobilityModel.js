/**
 * MobilityModel.js — spline trajectory + longitudinal drone kinematics.
 *
 * Pure maths (no Three.js). The route is a uniform Catmull-Rom spline through
 * control points in the XZ plane, re-sampled to a constant arc-length table so
 * that `pointAt(s)` is O(1).
 *
 * World scale: 1 scene unit = 5 m (METERS_PER_UNIT). The route runs X: 0 → 240
 * (1.2 km) across the four coverage zones.
 */
import { clamp } from '../utils/Metrics.js';

export const METERS_PER_UNIT = 5;
export const ROUTE_END_X = 240;
export const ANTENNA_HEIGHT = 2.2; // antenna height used for RF geometry (units); the twin's flight altitude is visual only

/** Gentle S-curves; X is strictly increasing so X ↔ s is a bijection. */
export const DEFAULT_ROUTE = [
  [-24, 0],
  [-10, 0],
  [0, 0],
  [20, 0.4],
  [40, 1.6],
  [60, -0.8],
  [80, 1.4],
  [100, 0.2],
  [120, -1.8],
  [140, 0.4],
  [160, 2.2],
  [180, 1.0],
  [200, -1.4],
  [220, 0.2],
  [240, 1.2],
  [262, 0.6],
  [290, 0],
];

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export class RoutePath {
  constructor(controlPoints = DEFAULT_ROUTE, { step = 0.1, y = 0 } = {}) {
    this.controlPoints = controlPoints;
    this.step = step;
    this.y = y;

    // 1) Dense parametric sampling.
    const pts = controlPoints;
    const segs = pts.length - 1;
    const perSeg = 120;
    const dense = [];
    for (let i = 0; i < segs; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let k = 0; k < perSeg; k++) {
        const t = k / perSeg;
        dense.push([catmullRom(p0[0], p1[0], p2[0], p3[0], t), catmullRom(p0[1], p1[1], p2[1], p3[1], t)]);
      }
    }
    dense.push(pts[pts.length - 1]);

    // 2) Cumulative arc length.
    const cum = new Float64Array(dense.length);
    for (let i = 1; i < dense.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
    }
    this.length = cum[cum.length - 1];

    // 3) Uniform arc-length resampling.
    const n = Math.ceil(this.length / step) + 1;
    this.xs = new Float64Array(n);
    this.zs = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.min(i * step, this.length);
      while (j < cum.length - 2 && cum[j + 1] < s) j++;
      const seg = cum[j + 1] - cum[j] || 1;
      const f = (s - cum[j]) / seg;
      this.xs[i] = dense[j][0] + (dense[j + 1][0] - dense[j][0]) * f;
      this.zs[i] = dense[j][1] + (dense[j + 1][1] - dense[j][1]) * f;
    }
  }

  _index(s) {
    const u = clamp(s, 0, this.length) / this.step;
    const i = Math.min(Math.floor(u), this.xs.length - 2);
    return [i, u - i];
  }

  /** Centre-line point at arc length s (scene units). */
  pointAt(s, out = { x: 0, y: 0, z: 0 }) {
    const [i, f] = this._index(s);
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * f;
    out.y = this.y;
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * f;
    return out;
  }

  /** Unit tangent in XZ at arc length s. */
  tangentAt(s, out = { x: 1, y: 0, z: 0 }) {
    const [i] = this._index(s);
    const a = Math.max(0, i - 2);
    const b = Math.min(this.xs.length - 1, i + 3);
    const dx = this.xs[b] - this.xs[a];
    const dz = this.zs[b] - this.zs[a];
    const len = Math.hypot(dx, dz) || 1;
    out.x = dx / len;
    out.y = 0;
    out.z = dz / len;
    return out;
  }

  /**
   * Lane frame: centre-line point shifted by `lateral` along the right-hand
   * normal (forward × up = (−tz, 0, tx)). Heading is the yaw that maps a model's
   * local +X onto the tangent: θ = atan2(−tz, tx).
   */
  frameAt(s, lateral = 0, out = {}) {
    const p = this.pointAt(s);
    const t = this.tangentAt(s);
    out.x = p.x - t.z * lateral;
    out.y = p.y;
    out.z = p.z + t.x * lateral;
    out.cx = p.x;
    out.cz = p.z;
    out.tx = t.x;
    out.tz = t.z;
    out.heading = Math.atan2(-t.z, t.x);
    return out;
  }

  /** Inverse lookup (X is monotonic along the route). */
  sAtX(x) {
    let lo = 0;
    let hi = this.xs.length - 1;
    if (x <= this.xs[lo]) return 0;
    if (x >= this.xs[hi]) return this.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.xs[mid] < x) lo = mid;
      else hi = mid;
    }
    const f = (x - this.xs[lo]) / (this.xs[hi] - this.xs[lo] || 1);
    return (lo + f) * this.step;
  }

  /** Down-sampled polyline for rendering (route ribbon and markings). */
  polyline(spacing = 1, lateral = 0) {
    const out = [];
    for (let s = 0; s <= this.length; s += spacing) out.push(this.frameAt(s, lateral));
    return out;
  }
}

export const MOBILITY_DEFAULTS = {
  startX: 1.5, // docked at the drone dock
  departureDelay: 2.0, // s of dwell on the wired dock before departure
  accel: 2.6, // m/s² comfortable acceleration
  brake: 3.5, // m/s² normal deceleration (speed-slider decrease)
  failSafeDecel: 7.0, // m/s² minimal-risk manoeuvre (stop and hover) when C2 telemetry is lost
  endBrake: 6.0, // m/s² stop after the route end
};

export class MobilityModel {
  constructor({ path, laneOffset = 0, endX = ROUTE_END_X, ...opts } = {}) {
    this.path = path;
    this.laneOffset = laneOffset;
    this.endX = endX;
    this.opts = { ...MOBILITY_DEFAULTS, ...opts };
    this.targetMps = 60 / 3.6;
    this.reset();
  }

  reset() {
    this.s = this.path.sAtX(this.opts.startX);
    this.startS = this.s;
    this.speed = 0; // m/s
    this.distanceM = 0;
    this.failSafe = false;
    this.finished = false;
    this.finishTime = null;
    this.departed = false;
    this._frame = this.path.frameAt(this.s, this.laneOffset);
  }

  setTargetSpeedKmh(kmh) {
    this.targetMps = clamp(kmh, 0, 120) / 3.6;
  }

  setFailSafe(active) {
    this.failSafe = !!active;
  }

  /** Advance kinematics by dt seconds at simulation time t. */
  update(dt, t) {
    const o = this.opts;
    let target = this.targetMps;
    if (t < o.departureDelay) target = 0;
    if (this.failSafe) target = 0;
    if (this.finished) target = 0;

    if (this.speed < target) {
      this.speed = Math.min(target, this.speed + o.accel * dt);
    } else if (this.speed > target) {
      const decel = this.finished ? o.endBrake : this.failSafe ? o.failSafeDecel : o.brake;
      this.speed = Math.max(target, this.speed - decel * dt);
    }

    const ds = (this.speed * dt) / METERS_PER_UNIT;
    this.s = Math.min(this.path.length - 0.5, this.s + ds);
    this.distanceM += this.speed * dt;
    if (this.speed > 0.05) this.departed = true;

    this._frame = this.path.frameAt(this.s, this.laneOffset);
    if (!this.finished && this._frame.cx >= this.endX) {
      this.finished = true;
      this.finishTime = t + dt;
    }
    return this.state;
  }

  get state() {
    const f = this._frame;
    return {
      s: this.s,
      x: f.x, // lane position (rendering)
      z: f.z,
      cx: f.cx, // centre-line position (RF geometry — identical for both engines)
      cz: f.cz,
      heading: f.heading,
      speedMps: this.speed,
      speedKmh: this.speed * 3.6,
      distanceM: this.distanceM,
      failSafe: this.failSafe,
      finished: this.finished,
      finishTime: this.finishTime,
      departed: this.departed,
    };
  }
}
