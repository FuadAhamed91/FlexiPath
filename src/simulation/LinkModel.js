/**
 * LinkModel.js — real-time link metrics for one interface of one drone.
 *
 * Maps the large-scale signal from NetworkEnvironment (+ per-drone fast
 * fading) to the metrics a transport proxy can observe every 100 ms:
 *
 *   loss      = base + (1 − base) · 1 / (1 + e^{(SNR − SNR₅₀)/k})   (link-edge logistic)
 *   capacity  = Tmax · min(1, log₂(1 + SNR) / log₂(1 + SNR_ref))    (Shannon-shaped MCS ladder)
 *   RTT       = RTT₀ + T_retx · L/(1 − L) [+ scheduling delay at low SINR]
 *   jitter    = J₀ + 12 · L
 *
 * Each sample carries both the *true* state (which decides packet fate in
 * TrafficManager) and a *measured* state with realistic probe noise (which is
 * all the controllers are allowed to see).
 */
import { clamp } from '../utils/Metrics.js';

export const INTERFACE_IDS = ['eth0', 'wlan0', 'wwan0', 'sat0'];

export const INTERFACE_SPECS = {
  eth0: {
    id: 'eth0',
    tech: 'wired',
    label: 'Gigabit Wired Dock',
    short: 'ETH · DOCK',
    name: 'Wired',
    color: '#64748B',
    maxThroughput: 500,
    baseRtt: 3,
    baseLoss: 0.001,
    baseJitter: 0.15,
    signalLabel: 'CARRIER',
    signalUnit: '',
    signalRange: [0, 1],
    fadeStd: 0,
    legacyMetric: 10,
  },
  wlan0: {
    id: 'wlan0',
    tech: 'wifi',
    label: 'Wi-Fi 6 Access Point',
    short: 'WI-FI 6',
    name: 'Wi-Fi',
    color: '#00F0FF',
    maxThroughput: 150,
    baseRtt: 5,
    baseLoss: 0.005,
    baseJitter: 0.8,
    signalLabel: 'RSSI',
    signalUnit: 'dBm',
    signalRange: [-95, -40],
    fadeStd: 1.3,
    noiseFloor: -95,
    edge: { mid: 9, k: 2.0 }, // 50 % PER at 9 dB SNR (≈ −86 dBm)
    snrRef: 35,
    retxRttMs: 55,
    legacyMetric: 25,
  },
  wwan0: {
    id: 'wwan0',
    tech: 'cellular',
    label: '5G Standalone',
    short: '5G SA',
    name: '5G',
    color: '#10B981',
    maxThroughput: 85,
    baseRtt: 22,
    baseLoss: 0.01,
    baseJitter: 2.5,
    signalLabel: 'RSRP',
    signalUnit: 'dBm',
    signalRange: [-128, -68],
    fadeStd: 1.6,
    sinrOffset: 122, // SINR ≈ RSRP + 122 dB (noise + interference per RE)
    edge: { mid: 1, k: 3.0 },
    snrRef: 25,
    retxRttMs: 40,
    legacyMetric: 50,
  },
  sat0: {
    id: 'sat0',
    tech: 'satellite',
    label: 'LEO Satellite',
    short: 'LEO SAT',
    name: 'LEO',
    color: '#F59E0B',
    maxThroughput: 35,
    baseRtt: 65,
    baseLoss: 0.02,
    baseJitter: 6,
    signalLabel: 'SNR',
    signalUnit: 'dB',
    signalRange: [0, 15],
    fadeStd: 0.35,
    edge: { mid: 3, k: 1.2 },
    snrRef: 12,
    retxRttMs: 30,
    legacyMetric: 100,
  },
};

export const SWITCH_LOSS = 0.15;

const edgeLoss = (snr, { mid, k }) => 1 / (1 + Math.exp((snr - mid) / k));
const log2 = Math.log2;

/** Signal level (dBm or dB) at which the link's PER reaches `loss` — used for time-to-failure. */
export function failureSignalLevel(spec, loss = SWITCH_LOSS) {
  if (!spec.edge) return -Infinity;
  const snr = spec.edge.mid + spec.edge.k * Math.log(1 / loss - 1);
  if (spec.tech === 'wifi') return snr + spec.noiseFloor;
  if (spec.tech === 'cellular') return snr - spec.sinrOffset;
  return snr;
}

/**
 * Expected link metrics from a signal reading alone, using the same PHY curves as `sample()` but
 * without fading or probe noise. This is all a controller knows about a modem sleeping in DRX: it
 * wakes once per cycle to measure signal (RSRP / RSSI / SNR) but carries no traffic and no probes.
 * @param {object} spec interface spec
 * @param {number} signal dBm (Wi-Fi, 5G) or dB SNR (satellite)
 * @param {{rttBase?: number}} [opts] base RTT override (e.g. satellite elevation)
 */
export function estimateLinkFromSignal(spec, signal, { rttBase } = {}) {
  if (spec.tech === 'wired') {
    return { throughputMbps: spec.maxThroughput * (1 - spec.baseLoss), rttMs: spec.baseRtt, lossRate: spec.baseLoss };
  }
  if (!Number.isFinite(signal)) return { throughputMbps: 0, rttMs: Infinity, lossRate: 1 };
  let snr;
  if (spec.tech === 'wifi') snr = signal - spec.noiseFloor;
  else if (spec.tech === 'cellular') snr = signal + spec.sinrOffset;
  else snr = signal;
  const loss = spec.baseLoss + (1 - spec.baseLoss) * edgeLoss(snr, spec.edge);
  const se = Math.log2(1 + 10 ** (snr / 10)) / Math.log2(1 + 10 ** (spec.snrRef / 10));
  const capacity = spec.maxThroughput * clamp(se, 0, 1);
  const lr = Math.min(loss, 0.97);
  let rtt = (rttBase ?? spec.baseRtt) + spec.retxRttMs * (lr / (1 - lr));
  if (spec.tech === 'cellular') rtt += Math.max(0, 12 - snr);
  return { throughputMbps: capacity * (1 - loss), rttMs: rtt, lossRate: loss };
}

/** Metrics of the link at its nominal operating point (used to express health as % of nominal). */
export function nominalLinkMetrics(spec) {
  return { throughputMbps: spec.maxThroughput * (1 - spec.baseLoss), rttMs: spec.baseRtt, lossRate: spec.baseLoss };
}

function downState(spec, signal = null) {
  return {
    id: spec.id,
    tech: spec.tech,
    up: false,
    signal,
    snr: null,
    quality: 0,
    capacityMbps: 0,
    throughputMbps: 0,
    rttMs: Infinity,
    jitterMs: 0,
    lossRate: 1,
    meas: { signal, lossRate: 1, rttMs: NaN, throughputMbps: 0, jitterMs: 0 },
    info: null,
  };
}

export class LinkModel {
  constructor(spec, rng) {
    this.spec = spec;
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.fade = 0;
    this.upSince = null;
    this.state = downState(this.spec);
  }

  /**
   * @param {{available:boolean, value:number, rtt?:number}} sig large-scale signal
   * @param {number} t simulation time (s)
   */
  sample(sig, t) {
    const s = this.spec;
    const r = this.rng;
    const rho = 0.75; // 100 ms autocorrelation of small-scale fading
    this.fade = rho * this.fade + Math.sqrt(1 - rho * rho) * r.gaussian(0, s.fadeStd || 0);

    if (!sig.available) {
      this.upSince = null;
      this.state = downState(s, s.tech === 'wired' ? 0 : sig.value);
      return this.state;
    }
    if (this.upSince === null) this.upSince = t;

    let signal;
    let snr;
    let loss;
    let capacity;
    let rtt;
    let jitter;

    switch (s.tech) {
      case 'wired': {
        signal = 1;
        snr = null;
        loss = s.baseLoss;
        capacity = s.maxThroughput * (0.985 + 0.015 * r.next());
        rtt = s.baseRtt + Math.abs(r.gaussian(0, 0.12));
        jitter = s.baseJitter;
        break;
      }
      case 'wifi':
      case 'cellular':
      case 'satellite': {
        signal = sig.value + this.fade;
        if (s.tech === 'wifi') snr = signal - s.noiseFloor;
        else if (s.tech === 'cellular') snr = signal + s.sinrOffset;
        else snr = signal;
        const per = edgeLoss(snr, s.edge);
        loss = s.baseLoss + (1 - s.baseLoss) * per;
        const se = log2(1 + 10 ** (snr / 10)) / log2(1 + 10 ** (s.snrRef / 10));
        capacity = s.maxThroughput * clamp(se, 0, 1);
        const lr = Math.min(loss, 0.97);
        const base = s.tech === 'satellite' ? sig.rtt : s.baseRtt;
        rtt = base + s.retxRttMs * (lr / (1 - lr));
        if (s.tech === 'cellular') rtt += Math.max(0, 12 - snr) * 1.0; // scheduler / HARQ delay at low SINR
        jitter = s.baseJitter + 12 * loss;
        break;
      }
      default:
        this.state = downState(s);
        return this.state;
    }

    const [lo, hi] = s.signalRange;
    const quality = s.tech === 'wired' ? 1 : clamp((signal - lo) / (hi - lo), 0, 1);
    const throughput = capacity * (1 - loss);

    // Probe-based measurements (what a real client can observe at 10 Hz).
    const meas = {
      signal: s.tech === 'wired' ? 1 : signal + r.gaussian(0, 0.6),
      lossRate: clamp(loss + r.gaussian(0, 0.1 * loss + 0.0015), 0, 1),
      rttMs: rtt + Math.abs(r.gaussian(0, jitter * 0.6)),
      throughputMbps: Math.max(0, throughput * (1 + r.gaussian(0, 0.025))),
      jitterMs: jitter,
    };

    this.state = {
      id: s.id,
      tech: s.tech,
      up: true,
      signal,
      snr,
      quality,
      capacityMbps: capacity,
      throughputMbps: throughput,
      rttMs: rtt,
      jitterMs: jitter,
      lossRate: loss,
      meas,
      upSince: this.upSince,
      info: s.tech === 'satellite' ? { servingSat: sig.servingSat, elevationDeg: sig.elevationDeg } : null,
    };
    return this.state;
  }
}
