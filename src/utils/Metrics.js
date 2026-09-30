/**
 * Metrics.js — statistical smoothing primitives shared by the simulation.
 *
 * Everything here is renderer-agnostic and allocation-free in the hot path.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const logistic = (x) => 1 / (1 + Math.exp(-x));
export const round = (v, digits = 2) => {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Exponentially weighted moving average: s_t = a·x_t + (1 − a)·s_{t−1}. */
export class EWMA {
  constructor(alpha = 0.3, initial = null) {
    this.alpha = alpha;
    this.initial = initial;
    this.value = initial;
  }

  update(x) {
    if (!Number.isFinite(x)) return this.value;
    this.value = this.value === null ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }

  reset(value = this.initial) {
    this.value = value;
  }
}

/** Fixed-capacity circular buffer of numbers. */
export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
    this.start = 0;
    this.length = 0;
  }

  push(x) {
    if (this.length < this.capacity) {
      this.data[(this.start + this.length) % this.capacity] = x;
      this.length++;
    } else {
      this.data[this.start] = x;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** i = 0 is the oldest sample. */
  get(i) {
    return this.data[(this.start + i) % this.capacity];
  }

  latest() {
    return this.length ? this.get(this.length - 1) : NaN;
  }

  /** Sample `n` pushes ago (0 = latest). Clamps to the oldest available. */
  ago(n) {
    if (!this.length) return NaN;
    return this.get(Math.max(0, this.length - 1 - n));
  }

  clear() {
    this.start = 0;
    this.length = 0;
  }

  toArray() {
    const out = new Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.get(i);
    return out;
  }
}

/** Least-squares slope of evenly spaced samples (units per second). */
export function linearSlope(buffer, dt) {
  const n = buffer.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  let meanY = 0;
  for (let i = 0; i < n; i++) meanY += buffer.get(i);
  meanY /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * (buffer.get(i) - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den / dt;
}

/**
 * TrendMonitor — EWMA smoothing plus a sliding window of the smoothed value.
 *
 *   delta  = EWMA_latest − EWMA_{t−window}   (the brief's ΔLoss definition)
 *   slope  = least-squares slope of the window (per second)
 *   predict(h) = EWMA_latest + slope·h       (linear extrapolation)
 */
export class TrendMonitor {
  constructor({ alpha = 0.3, window = 10, dt = 0.1, initial = null } = {}) {
    this.dt = dt;
    this.window = window;
    this.ewma = new EWMA(alpha, initial);
    this.history = new RingBuffer(window + 1);
    this.delta = 0;
    this.slope = 0;
  }

  update(x) {
    const v = this.ewma.update(x);
    if (v === null) return this;
    this.history.push(v);
    this.delta = this.history.length > 1 ? v - this.history.ago(this.window) : 0;
    this.slope = linearSlope(this.history, this.dt);
    return this;
  }

  get value() {
    return this.ewma.value;
  }

  predict(horizonSeconds) {
    return (this.ewma.value ?? 0) + this.slope * horizonSeconds;
  }

  reset() {
    this.ewma.reset(null);
    this.history.clear();
    this.delta = 0;
    this.slope = 0;
  }
}

/** Welford running statistics (mean / std / min / max). */
export class RunningStats {
  constructor() {
    this.reset();
  }

  push(x) {
    if (!Number.isFinite(x)) return;
    this.count++;
    const d = x - this.mean;
    this.mean += d / this.count;
    this.m2 += d * (x - this.mean);
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }

  get variance() {
    return this.count > 1 ? this.m2 / (this.count - 1) : 0;
  }

  get std() {
    return Math.sqrt(this.variance);
  }

  reset() {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  toJSON() {
    return {
      count: this.count,
      mean: round(this.mean, 4),
      std: round(this.std, 4),
      min: this.count ? round(this.min, 4) : null,
      max: this.count ? round(this.max, 4) : null,
    };
  }
}

/** Percentile (0..100) of an array using linear interpolation. */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp((p / 100) * (sorted.length - 1), 0, sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lerp(sorted[lo], sorted[hi], idx - lo);
}

export function mean(values) {
  if (!values.length) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Sliding-window ratio counter, e.g. packet loss over the last 1 s. */
export class WindowRatio {
  constructor(size = 10) {
    this.num = new RingBuffer(size);
    this.den = new RingBuffer(size);
  }

  push(numerator, denominator) {
    this.num.push(numerator);
    this.den.push(denominator);
  }

  get value() {
    let n = 0;
    let d = 0;
    for (let i = 0; i < this.num.length; i++) {
      n += this.num.get(i);
      d += this.den.get(i);
    }
    return d > 0 ? n / d : 0;
  }

  clear() {
    this.num.clear();
    this.den.clear();
  }
}
