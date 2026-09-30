/**
 * Random.js — seeded pseudo-random number generation for reproducible experiments.
 *
 * Core generator: Mulberry32 (32-bit state, period 2^32, excellent statistical
 * quality for simulation work, ~1 ns/sample). Independent sub-streams are derived
 * with `fork(label)` so that adding a draw in one subsystem (e.g. the Legacy
 * controller's channel) never perturbs another subsystem (e.g. FlexiPath's).
 */

/** xmur3-style 32-bit string hash — used to turn labels / text seeds into integers. */
export function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** Accepts numbers, numeric strings or arbitrary text and returns a uint32 seed. */
export function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(Math.abs(seed)) >>> 0;
  const s = String(seed ?? '').trim();
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10) >>> 0;
  return hashString(s || 'flexipath');
}

export class Random {
  constructor(seed = 1) {
    this.seed = normalizeSeed(seed);
    this.state = this.seed;
    this._spareGaussian = null;
  }

  /** Uniform float in [0, 1). */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + (max - min) * this.next();
  }

  int(min, maxInclusive) {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  chance(p) {
    return this.next() < p;
  }

  pick(items) {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Normal deviate via Box–Muller (caches the spare value). */
  gaussian(mean = 0, std = 1) {
    if (this._spareGaussian !== null) {
      const v = this._spareGaussian;
      this._spareGaussian = null;
      return mean + std * v;
    }
    let u = 0;
    let v = 0;
    while (u <= Number.EPSILON) u = this.next();
    v = this.next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this._spareGaussian = mag * Math.sin(2 * Math.PI * v);
    return mean + std * mag * Math.cos(2 * Math.PI * v);
  }

  /** Binomial(n, p): exact Bernoulli sum for small n, normal approximation otherwise. */
  binomial(n, p) {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    if (n <= 64) {
      let k = 0;
      for (let i = 0; i < n; i++) if (this.next() < p) k++;
      return k;
    }
    const k = Math.round(this.gaussian(n * p, Math.sqrt(n * p * (1 - p))));
    return Math.min(n, Math.max(0, k));
  }

  /** Poisson(lambda): Knuth for small lambda, normal approximation for large. */
  poisson(lambda) {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let prod = this.next();
      while (prod > limit) {
        k++;
        prod *= this.next();
      }
      return k;
    }
    return Math.max(0, Math.round(this.gaussian(lambda, Math.sqrt(lambda))));
  }

  /** Derive an independent, reproducible sub-stream. */
  fork(label) {
    return new Random(hashString(`${this.seed}:${label}`));
  }
}

/**
 * Smooth 1-D value noise with a fixed lattice — a spatially correlated random
 * field (used for log-normal shadow fading, so both vehicles see the same
 * obstruction pattern at the same point on the road).
 */
export class ValueNoise1D {
  constructor(rng, { spacing = 6, size = 256 } = {}) {
    this.spacing = spacing;
    this.values = new Float32Array(size);
    for (let i = 0; i < size; i++) this.values[i] = rng.gaussian(0, 1);
  }

  /** Returns an approximately N(0, 1) value that varies smoothly with x. */
  sample(x) {
    const u = x / this.spacing;
    const i0 = Math.floor(u);
    const f = u - i0;
    const n = this.values.length;
    const a = this.values[((i0 % n) + n) % n];
    const b = this.values[(((i0 + 1) % n) + n) % n];
    const s = f * f * (3 - 2 * f); // smoothstep interpolation
    // Linear blending of two N(0,1) values shrinks variance; renormalise.
    const w0 = 1 - s;
    const w1 = s;
    return (a * w0 + b * w1) / Math.sqrt(w0 * w0 + w1 * w1);
  }
}
