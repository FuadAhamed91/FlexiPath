/**
 * QoEModel.js — real-time MOS estimation with the ITU-T G.107 E-model.
 *
 *   R      = R₀ − I_s − I_d − I_e,eff + A          (R₀ − I_s ≈ 93.2 by default)
 *   I_d    = 0.024·d + 0.11·(d − 177.3)·H(d − 177.3)   (d = mouth-to-ear delay, ms)
 *   I_e,eff= I_e + (95 − I_e) · Ppl / (Ppl / BurstR + B_pl)
 *   MOS    = 1 + 0.035R + 7·10⁻⁶ · R(R − 60)(100 − R),   clamped to [1.0, 4.5]
 *
 * Codec: G.711 with packet-loss concealment (I_e = 0, B_pl = 25.1), 20 ms frames.
 * A session that delivers nothing (socket stalled / TCP reset) scores MOS 1.0.
 */
import { EWMA, clamp } from '../utils/Metrics.js';

export const EMODEL_DEFAULTS = {
  r0MinusIs: 93.2,
  ie: 0,
  bpl: 25.1,
  burstR: 1,
  advantage: 0,
  codecDelayMs: 25, // 20 ms frame + 5 ms look-ahead
  minJitterBufferMs: 20,
};

export class QoEModel {
  constructor(params = {}) {
    this.p = { ...EMODEL_DEFAULTS, ...params };
    this.smoothed = new EWMA(0.25);
    this.reset();
  }

  reset() {
    this.smoothed.reset(null);
    this.r = 93.2;
    this.mos = QoEModel.rToMos(93.2);
  }

  /** Mouth-to-ear delay: network one-way + adaptive jitter buffer + codec. */
  mouthToEarDelay(oneWayMs, jitterMs) {
    const jb = Math.max(this.p.minJitterBufferMs, 2 * jitterMs);
    return oneWayMs + jb + this.p.codecDelayMs;
  }

  computeR({ oneWayMs, jitterMs = 0, lossPct }) {
    const d = this.mouthToEarDelay(oneWayMs, jitterMs);
    const id = 0.024 * d + (d > 177.3 ? 0.11 * (d - 177.3) : 0);
    const ppl = clamp(lossPct, 0, 100);
    const ieEff = this.p.ie + ((95 - this.p.ie) * ppl) / (ppl / this.p.burstR + this.p.bpl);
    return this.p.r0MinusIs - id - ieEff + this.p.advantage;
  }

  static rToMos(r) {
    if (r <= 0) return 1;
    if (r >= 100) return 4.5;
    return clamp(1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r), 1, 4.5);
  }

  /**
   * @param {{delivered:number, sent:number, windowLossPct:number, oneWayMs:number, jitterMs:number}} voice
   */
  update(voice) {
    let r;
    if (voice.sent > 0 && voice.delivered === 0) {
      r = 0; // session interrupted — no speech path at all
    } else {
      r = this.computeR({ oneWayMs: voice.oneWayMs, jitterMs: voice.jitterMs, lossPct: voice.windowLossPct });
    }
    this.r = r;
    const instant = QoEModel.rToMos(r);
    this.mos = this.smoothed.update(instant);
    return { r, mosInstant: instant, mos: this.mos };
  }
}
