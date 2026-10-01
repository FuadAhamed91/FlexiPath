/**
 * ReorderingBuffer.js — packet ordering at the receiver, and the head-of-line (HoL) cost of it.
 *
 * CRITICAL / REAL-TIME (datagrams). Every packet carries a 32-bit sequence number. The first copy
 * to arrive is delivered to the application immediately; a later copy of the same sequence number
 * (the replica that took the slower path) is silently discarded. Nothing ever waits for a missing
 * earlier packet, so the HoL stall is 0 ms by construction — and it is measured, not assumed. For
 * contrast the buffer also measures what strict in-order delivery of the same arrivals would add.
 *
 * BULK (TCP-like byte streams). In-order delivery means a missing segment blocks everything behind
 * it. Two causes are modelled:
 *   • loss recovery: per RTT round, a loss is repaired by fast retransmit (one RTT of blocking) when
 *     the congestion window can produce three duplicate ACKs (cwnd ≥ 4); otherwise by a
 *     retransmission timeout, RTO = max(200 ms, SRTT + 4·RTTVAR), with one possible back-off,
 *     capped at 500 ms. The window is the Mathis et al. (1997) estimate cwnd ≈ 1.22 / √p, capped by
 *     the bandwidth-delay product — so the timeout regime starts near 9 % loss.
 *   • multipath reordering: when one flow spans two paths, segments on the faster path wait ΔOWD
 *     (the one-way delay gap) for the slower path's earlier segments. Delay-compensated pacing sends
 *     on the slower path ΔOWD earlier (offsetting e.g. satellite transmissions by the latency gap),
 *     which leaves only jitter misalignment.
 */
import { clamp } from '../utils/Metrics.js';

export const HOL_PARAMS = {
  mssBytes: 1460,
  rtoMinMs: 200, // Linux TCP_RTO_MIN
  rtoMaxStallMs: 500, // one back-off at most within a stall (RACK/TLP-era recovery)
  dupAckThreshold: 3, // fast retransmit needs 3 duplicate ACKs → cwnd ≥ 4 segments
  mathisC: 1.22, // Mathis et al. (1997): cwnd ≈ C / √p
  maxRoundsPerTick: 40,
  seqWindow: 4096, // duplicate-detection window (sequence numbers)
};

/** RFC 1982 serial-number arithmetic on 32-bit sequence numbers. */
export const seqAdd = (a, n) => (a + n) >>> 0;
export const seqDiff = (a, b) => (a - b) | 0; // signed distance a − b, wraps correctly at 2^32

/** First-copy-wins receiver for sequenced datagrams (critical and real-time flows). */
export class SequenceReorderBuffer {
  constructor({ window = HOL_PARAMS.seqWindow } = {}) {
    this.window = window; // power of two
    this.mask = window - 1;
    this.reset();
  }

  reset() {
    this.highest = null;
    this.bits = new Uint8Array(this.window);
    this.delivered = 0;
    this.duplicates = 0;
    this.late = 0;
    this.reordered = 0;
    this.holMaxMs = 0; // actual wait of delivered packets (deliver-on-arrival ⇒ 0)
    this.inOrderLast = null; // latest arrival among delivered sequence numbers so far (in-order counterfactual)
    this.inOrderMaxMs = 0;
    this.inOrderSumMs = 0;
    this.inOrderCount = 0;
  }

  /**
   * One arriving copy, in arrival order.
   * @returns {'deliver'|'duplicate'|'late'}
   */
  arrive(seq) {
    if (this.highest === null) {
      this.highest = seq;
      this.bits[seq & this.mask] = 1;
      this.delivered++;
      return 'deliver';
    }
    const d = seqDiff(seq, this.highest);
    if (d > 0) {
      const steps = Math.min(d, this.window);
      for (let k = 1; k <= steps; k++) this.bits[seqAdd(this.highest, k) & this.mask] = 0;
      this.highest = seq;
      this.bits[seq & this.mask] = 1;
      this.delivered++;
      return 'deliver';
    }
    if (-d >= this.window) {
      this.late++;
      return 'late';
    }
    if (this.bits[seq & this.mask]) {
      this.duplicates++;
      return 'duplicate';
    }
    // An earlier sequence number arriving after a later one: delivered at once, nothing waits.
    this.bits[seq & this.mask] = 1;
    this.delivered++;
    this.reordered++;
    return 'deliver';
  }

  /**
   * Counterfactual: wait this packet would have had under strict in-order delivery. Call with the
   * first-arrival time of each delivered sequence number, in sequence order (lost ones skipped).
   */
  inOrderSample(arrivalS) {
    const wait = this.inOrderLast === null ? 0 : Math.max(0, this.inOrderLast - arrivalS) * 1000;
    this.inOrderLast = this.inOrderLast === null ? arrivalS : Math.max(this.inOrderLast, arrivalS);
    this.inOrderMaxMs = Math.max(this.inOrderMaxMs, wait);
    this.inOrderSumMs += wait;
    this.inOrderCount++;
    return wait;
  }

  get inOrderMeanMs() {
    return this.inOrderCount ? this.inOrderSumMs / this.inOrderCount : 0;
  }
}

/** In-order (TCP-like) delivery of one bulk flow on one path: loss-recovery stalls. */
export class TcpHolModel {
  constructor(rng, params = HOL_PARAMS) {
    this.rng = rng;
    this.p = params;
    this.reset();
  }

  reset() {
    this.stallLeftMs = 0;
    this.stallLenMs = 0;
    this.srtt = null;
    this.rttvar = null;
    this.events = 0;
    this.rtoEvents = 0;
    this.fastRetx = 0;
    this.sumSqMs2 = 0;
    this.peakMs = 0;
    this.timeMs = 0;
  }

  _rtoMs() {
    return Math.max(this.p.rtoMinMs, this.srtt + 4 * this.rttvar);
  }

  _event(len) {
    this.events++;
    this.sumSqMs2 += len * len;
    this.peakMs = Math.max(this.peakMs, len);
  }

  /**
   * Advance one tick.
   * @param {number} dtMs tick length in ms
   * @param {{rttMs:number, jitterMs:number, lossRate:number, mbps:number}|null} path
   * @returns {{blockedMs:number, stallMs:number, rto:boolean}}
   */
  step(dtMs, path) {
    this.timeMs += dtMs;
    if (!path || !(path.mbps > 0) || !Number.isFinite(path.rttMs)) {
      // Nothing flowing is an interruption, not head-of-line blocking.
      this.stallLeftMs = 0;
      return { blockedMs: 0, stallMs: 0, rto: false };
    }
    const sample = path.rttMs + Math.abs(this.rng.gaussian(0, path.jitterMs || 0));
    if (this.srtt === null) {
      this.srtt = sample;
      this.rttvar = sample / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - sample);
      this.srtt = 0.875 * this.srtt + 0.125 * sample;
    }

    let t = 0;
    let blocked = 0;
    let stallMs = 0;
    let rto = false;
    if (this.stallLeftMs > 0) {
      const used = Math.min(dtMs, this.stallLeftMs);
      this.stallLeftMs -= used;
      blocked += used;
      t += used;
      stallMs = this.stallLenMs;
    }

    const p = clamp(path.lossRate, 0, 0.97);
    const rtt = Math.max(1, path.rttMs);
    const bdp = Math.max(1, ((path.mbps * 1e6) / 8) * (rtt / 1000) / this.p.mssBytes);
    const cwnd = Math.max(1, Math.min(bdp, p > 0 ? this.p.mathisC / Math.sqrt(p) : bdp));
    const pRound = 1 - (1 - p) ** cwnd;
    const fastRetransmit = cwnd >= this.p.dupAckThreshold + 1;
    let rounds = 0;
    while (t < dtMs - 1e-9 && rounds < this.p.maxRoundsPerTick) {
      rounds++;
      const span = Math.min(rtt, dtMs - t);
      if (this.rng.next() < pRound * (span / rtt)) {
        if (fastRetransmit) {
          this._event(rtt);
          this.fastRetx++;
          blocked += Math.min(rtt, dtMs - t);
          stallMs = Math.max(stallMs, rtt);
          t += rtt;
        } else {
          let len = this._rtoMs();
          if (this.rng.next() < p) len *= 2; // the retransmission was lost too → one back-off
          len = Math.min(this.p.rtoMaxStallMs, Math.max(this.p.rtoMinMs, len));
          this._event(len);
          this.rtoEvents++;
          rto = true;
          const used = Math.min(len, dtMs - t);
          blocked += used;
          this.stallLeftMs = len - used;
          this.stallLenMs = len;
          stallMs = Math.max(stallMs, len);
          break;
        }
      } else {
        t += span;
      }
    }
    return { blockedMs: Math.min(blocked, dtMs), stallMs, rto };
  }

  /** Mean extra in-order delivery delay of a byte (ms): Σ stall² / (2 · time). */
  get meanDelayMs() {
    return this.timeMs > 0 ? this.sumSqMs2 / (2 * this.timeMs) : 0;
  }
}

/**
 * Delay-compensated pacing for a flow striped over several paths this tick.
 * @param {Array<{id:string, rttMs:number, jitterMs:number, mbps:number}>} paths paths with traffic
 * @param {import('../utils/Random.js').Random} rng
 * @returns {null | {offsetMs:number, slowPath:string, fastPath:string, fastShare:number, pacedHolMs:number, unpacedHolMs:number}}
 */
export function delayCompensatedPacing(paths, rng) {
  const live = paths.filter((p) => p.mbps > 0 && Number.isFinite(p.rttMs));
  if (live.length < 2) return null;
  live.sort((a, b) => a.rttMs - b.rttMs);
  const fast = live[0];
  const slow = live[live.length - 1];
  const offsetMs = (slow.rttMs - fast.rttMs) / 2; // one-way delay gap
  const total = live.reduce((a, p) => a + p.mbps, 0) || 1;
  const fastShare = fast.mbps / total;
  const misalign = Math.abs(rng.gaussian(0, Math.hypot(fast.jitterMs || 0, slow.jitterMs || 0) / 2));
  return {
    offsetMs,
    slowPath: slow.id,
    fastPath: fast.id,
    fastShare,
    pacedHolMs: fastShare * Math.min(misalign, offsetMs + misalign),
    unpacedHolMs: fastShare * offsetMs,
  };
}
