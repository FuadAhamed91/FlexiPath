/**
 * FlexiPathController.js — DETECT → PREDICT → PREPARE & REPLICATE → SWITCH & CONTINUE.
 *
 * Link utility (brief §4A):
 *
 *        W_i = Throughput_i^a / ( RTT_i^b · (1 + α · LossRate_i²) ),   α = 12
 *
 *   GENERAL  a = 1.0, b = 1.0   (UI utility gauge)
 *   CRITICAL a = 0.4, b = 1.2   (telemetry / voice: latency and loss first)
 *   BULK     a = 1.5, b = 0.5   (file streams: raw capacity first)
 *
 * Predictive replication trigger (brief §4B), evaluated on EWMA-smoothed probes:
 *
 *   ΔLoss = Loss_latest − Loss_{t−10}  (1.0 s window)
 *   degrading  ⇐ ΔLoss > 0.03 ∨ Loss > 0.05 ∨ RTT drift ∨ time-to-failure < 3 s ∨ dock release
 *   replicate  ⇐ degrading ∧ ∃ candidate whose score beats the primary's
 *                *predicted* score (2 s horizon) or failure is imminent
 *   switch     ⇐ primary loss > 15 % ∨ W_candidate > 1.5 · W_primary  (confirmed 2 ticks)
 *
 * Sessions ride a persistent anchor IP (198.51.100.24), so a path swap never
 * resets a socket — only packets can be lost, and replication covers those.
 */
import { TrendMonitor, clamp } from '../utils/Metrics.js';
import { INTERFACE_IDS, INTERFACE_SPECS, failureSignalLevel } from './LinkModel.js';

export const FLEXIPATH_PARAMS = {
  alpha: 12.0,
  windowTicks: 10,
  deltaLossTrigger: 0.03,
  lossTrigger: 0.05,
  switchLoss: 0.15,
  switchScoreRatio: 1.5,
  switchConfirmTicks: 2,
  minReplicationS: 0.2,
  upgradeMinReplicationS: 0.5,
  predictionHorizonS: 2.0,
  ttfTriggerS: 3.0,
  minSignalSlope: 0.8, // dB/s — slower drifts are treated as probe noise
  rttDriftFactor: 0.25, // RTT slope > 25 % of baseline per second …
  rttDriftLevel: 1.6, // … while RTT > 1.6 × baseline
  holdDownS: 3.0,
  upgradeRatio: 1.5,
  upgradeDwellS: 1.5,
  abortDwellS: 1.0,
  retargetRatio: 1.3,
  candidateMaxLoss: 0.12,
  candidateMinUpS: 0.3,
  failoverDetectMs: 60, // 3 missed probes × 20 ms
  bulkMinShare: 0.04,
  bulkMaxLoss: 0.2,
  drainS: 1.0,
};

export const SCORE_PROFILES = {
  GENERAL: { a: 1.0, b: 1.0 },
  CRITICAL: { a: 0.4, b: 1.2 },
  BULK: { a: 1.5, b: 0.5 },
};

/** W = T^a / (RTT^b · (1 + α·L²)) */
export function linkScore(m, profile = SCORE_PROFILES.GENERAL, alpha = FLEXIPATH_PARAMS.alpha) {
  const T = m.throughputMbps;
  const RTT = m.rttMs;
  const L = m.lossRate;
  if (!(T > 0) || !Number.isFinite(RTT) || RTT <= 0) return 0;
  return T ** profile.a / (RTT ** profile.b * (1 + alpha * L * L));
}

// Log-scale 0–100 gauge between a "barely usable" and an "ideal" reference link.
const REF_BEST = { throughputMbps: 500, rttMs: 2, lossRate: 0 };
const REF_WORST = { throughputMbps: 1, rttMs: 300, lossRate: 0.3 };
const NORM_CACHE = new Map();
export function normalizeScore(w, profile = SCORE_PROFILES.GENERAL, alpha = FLEXIPATH_PARAMS.alpha) {
  if (!(w > 0)) return 0;
  let range = NORM_CACHE.get(profile);
  if (!range) {
    range = [Math.log10(linkScore(REF_WORST, profile, alpha)), Math.log10(linkScore(REF_BEST, profile, alpha))];
    NORM_CACHE.set(profile, range);
  }
  return clamp(((Math.log10(w) - range[0]) / (range[1] - range[0])) * 100, 0, 100);
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

export class FlexiPathController {
  constructor({ params = {}, dt = 0.1 } = {}) {
    this.p = { ...FLEXIPATH_PARAMS, ...params };
    this.dt = dt;
    this.reset();
  }

  reset() {
    this.monitors = {};
    for (const id of INTERFACE_IDS) this.monitors[id] = this._newMonitor();
    this.primary = null;
    this.replica = null;
    this.state = 'INIT';
    this.replStart = 0;
    this.replReason = null;
    this.switchPending = 0;
    this.recoverTicks = 0;
    this.upgradeTicks = 0;
    this.holdUntil = 0;
    this.lastSwitch = null;
    this.handovers = 0;
    this.unplannedFailovers = 0;
    this.lastDecision = null;
  }

  _newMonitor() {
    const base = { window: this.p.windowTicks, dt: this.dt };
    return {
      loss: new TrendMonitor({ ...base, alpha: 0.35 }),
      rtt: new TrendMonitor({ ...base, alpha: 0.3 }),
      thr: new TrendMonitor({ ...base, alpha: 0.3 }),
      sig: new TrendMonitor({ ...base, alpha: 0.3 }),
      wasUp: false,
    };
  }

  // ── DETECT ─────────────────────────────────────────────────────────────
  _measure(links) {
    for (const id of INTERFACE_IDS) {
      const L = links[id];
      if (!L.up) {
        if (this.monitors[id].wasUp) this.monitors[id] = this._newMonitor();
        continue;
      }
      const m = this.monitors[id];
      m.wasUp = true;
      m.loss.update(L.meas.lossRate);
      m.rtt.update(L.meas.rttMs);
      m.thr.update(L.meas.throughputMbps);
      m.sig.update(L.meas.signal);
    }
  }

  _score(id, L) {
    if (!L.up) {
      return { up: false, general: 0, critical: 0, bulk: 0, norm: { general: 0, critical: 0, bulk: 0 } };
    }
    const m = this.monitors[id];
    const metrics = { throughputMbps: m.thr.value, rttMs: m.rtt.value, lossRate: m.loss.value };
    const a = this.p.alpha;
    const general = linkScore(metrics, SCORE_PROFILES.GENERAL, a);
    const critical = linkScore(metrics, SCORE_PROFILES.CRITICAL, a);
    const bulk = linkScore(metrics, SCORE_PROFILES.BULK, a);
    return {
      up: true,
      metrics,
      general,
      critical,
      bulk,
      norm: {
        general: normalizeScore(general, SCORE_PROFILES.GENERAL, a),
        critical: normalizeScore(critical, SCORE_PROFILES.CRITICAL, a),
        bulk: normalizeScore(bulk, SCORE_PROFILES.BULK, a),
      },
    };
  }

  // ── PREDICT ────────────────────────────────────────────────────────────
  _predict(id, ctx) {
    const p = this.p;
    const m = this.monitors[id];
    const spec = INTERFACE_SPECS[id];
    const H = p.predictionHorizonS;
    const predicted = {
      throughputMbps: Math.max(0, m.thr.predict(H)),
      rttMs: Math.max(spec.baseRtt, m.rtt.predict(H)),
      lossRate: clamp(m.loss.predict(H), 0, 1),
    };
    const predictedCritical = linkScore(predicted, SCORE_PROFILES.CRITICAL, p.alpha);

    let ttf = Infinity;
    if (spec.tech === 'wired') {
      if (ctx.dockRelease) ttf = ctx.dockTtf ?? 0;
    } else if (m.sig.slope < -p.minSignalSlope) {
      ttf = Math.max(0, (m.sig.value - failureSignalLevel(spec, p.switchLoss)) / -m.sig.slope);
    }

    const loss = m.loss.value ?? 0;
    const rtt = m.rtt.value ?? spec.baseRtt;
    const triggers = {
      deltaLoss: m.loss.delta > p.deltaLossTrigger,
      lossRate: loss > p.lossTrigger,
      rttDrift: m.rtt.slope > p.rttDriftFactor * spec.baseRtt && rtt > p.rttDriftLevel * spec.baseRtt,
      ttf: ttf < p.ttfTriggerS,
      context: spec.tech === 'wired' && !!ctx.dockRelease,
    };
    const degrading = Object.values(triggers).some(Boolean);
    const failureImminent = predicted.lossRate > p.switchLoss || ttf < p.ttfTriggerS || triggers.context;
    return {
      link: id,
      loss,
      dLoss: m.loss.delta,
      rtt,
      rttSlope: m.rtt.slope,
      signal: m.sig.value,
      signalSlope: m.sig.slope,
      predictedLoss: predicted.lossRate,
      predictedRtt: predicted.rttMs,
      predictedCritical,
      ttf,
      triggers,
      degrading,
      failureImminent,
    };
  }

  _bestCandidate(scores, links, t, exclude, { strict = true } = {}) {
    let best = null;
    for (const id of INTERFACE_IDS) {
      if (id === exclude || !links[id].up) continue;
      if (strict) {
        if ((this.monitors[id].loss.value ?? 1) > this.p.candidateMaxLoss) continue;
        if (links[id].upSince !== undefined && t - links[id].upSince < this.p.candidateMinUpS) continue;
      }
      if (!best || scores[id].critical > scores[best].critical) best = id;
    }
    return best;
  }

  // ── PREPARE & REPLICATE ────────────────────────────────────────────────
  _startReplication(candidate, t, reason, pred, scores, events) {
    this.state = 'REPLICATING';
    this.replica = candidate;
    this.replStart = t;
    this.replReason = reason;
    this.switchPending = 0;
    this.recoverTicks = 0;
    this.upgradeTicks = 0;
    const why = [];
    if (pred?.triggers.context) why.push('dock release');
    if (pred?.triggers.deltaLoss) why.push(`ΔLoss +${pct(pred.dLoss)}/s`);
    if (pred?.triggers.lossRate) why.push(`loss ${pct(pred.loss)}`);
    if (pred?.triggers.rttDrift) why.push(`RTT drift +${pred.rttSlope.toFixed(1)} ms/s`);
    if (pred && Number.isFinite(pred.ttf) && pred.triggers.ttf) why.push(`TTF ${pred.ttf.toFixed(1)} s`);
    if (reason === 'UPGRADE') {
      const ratio = scores[candidate].critical / Math.max(1e-9, scores[this.primary].critical);
      events.push({
        level: 'repl',
        code: 'UPGRADE',
        message: `Better path ${candidate} (${ratio.toFixed(1)}× critical score) → make-before-break upgrade`,
      });
    } else {
      events.push({
        level: 'warn',
        code: 'PREDICT',
        message: `PREDICT ${this.primary} failure [${why.join(' · ') || 'score trend'}] → priming ${candidate} (score ${scores[candidate].norm.critical.toFixed(0)})`,
      });
    }
    events.push({
      level: 'repl',
      code: 'REPL_ON',
      message: `PREDICTIVE REPLICATION ON · critical flows mirrored ${this.primary} ⇉ ${candidate}`,
    });
  }

  // ── SWITCH & CONTINUE ──────────────────────────────────────────────────
  _switchTo(next, t, reason, events, { seamless = true, from = this.primary, blackoutMs = 0 } = {}) {
    const replicationS = this.state === 'REPLICATING' ? t - this.replStart : 0;
    this.primary = next;
    this.replica = null;
    this.state = 'STEADY';
    this.replReason = null;
    this.holdUntil = t + this.p.holdDownS;
    this.switchPending = 0;
    this.recoverTicks = 0;
    this.upgradeTicks = 0;
    this.handovers++;
    this.lastSwitch = { t, from, to: next, seamless, reason, replicationS, blackoutMs };
    if (seamless) {
      events.push({
        level: 'ok',
        code: 'HOT_SWAP',
        message: `HOT-SWAP ${from} → ${next} · ${reason}${replicationS ? ` · replication ${replicationS.toFixed(1)} s` : ''}`,
        from,
        to: next,
      });
      if (replicationS) {
        events.push({ level: 'info', code: 'REPL_OFF', message: `Replication disengaged — ${next} carrying all flows` });
      }
    } else {
      this.unplannedFailovers++;
      events.push({
        level: 'warn',
        code: 'FAILOVER',
        message: `UNPLANNED FAILOVER ${from} → ${next} · detected in ${blackoutMs} ms (3 missed probes) · sessions kept on anchor IP`,
        from,
        to: next,
      });
    }
  }

  _bulkShares(scores, links, t) {
    const p = this.p;
    const terrestrial = ['eth0', 'wlan0', 'wwan0'].some(
      (id) => links[id].up && (this.monitors[id].loss.value ?? 1) < p.bulkMaxLoss,
    );
    const w = {};
    for (const id of INTERFACE_IDS) {
      if (!links[id].up) continue;
      // LEO capacity is metered: used for bulk only when it is the primary or no terrestrial link remains.
      if (id === 'sat0' && terrestrial && this.primary !== 'sat0') continue;
      if ((this.monitors[id].loss.value ?? 1) > p.bulkMaxLoss && id !== this.primary) continue;
      let weight = scores[id].bulk;
      if (this.state === 'REPLICATING' && id === this.primary && this.replReason !== 'UPGRADE') {
        weight *= 1 - 0.85 * clamp((t - this.replStart) / p.drainS, 0, 1); // drain the failing link
      }
      if (weight > 0) w[id] = weight;
    }
    let sum = Object.values(w).reduce((a, b) => a + b, 0);
    if (sum <= 0) return this.primary ? { [this.primary]: 1 } : {};
    for (const id of Object.keys(w)) {
      if (w[id] / sum < p.bulkMinShare && id !== this.primary) delete w[id];
    }
    sum = Object.values(w).reduce((a, b) => a + b, 0);
    for (const id of Object.keys(w)) w[id] /= sum;
    return w;
  }

  /**
   * One 100 ms control cycle.
   * @param {{t:number, links:Record<string,object>, ctx:object}} input
   */
  update({ t, links, ctx = {} }) {
    const p = this.p;
    const events = [];
    let blackoutMs = 0;

    this._measure(links);
    const scores = {};
    for (const id of INTERFACE_IDS) scores[id] = this._score(id, links[id]);

    // Initial attach.
    if (!this.primary) {
      const first = this._bestCandidate(scores, links, t, null, { strict: false });
      if (first) {
        this.primary = first;
        this.state = 'STEADY';
        events.push({ level: 'info', code: 'ATTACH', message: `Primary path ${first} (critical score ${scores[first].norm.critical.toFixed(0)})` });
      }
    }

    // Abrupt loss of the primary (e.g. cell outage): promote replica or fail over.
    if (this.primary && !links[this.primary].up) {
      const lost = this.primary;
      if (this.replica && links[this.replica].up) {
        this._switchTo(this.replica, t, `${lost} dropped · replica promoted, 0 ms gap`, events, { from: lost });
      } else {
        const fb = this._bestCandidate(scores, links, t, lost, { strict: false });
        if (fb) {
          blackoutMs = p.failoverDetectMs;
          this._switchTo(fb, t, 'abrupt link loss', events, { seamless: false, from: lost, blackoutMs });
        } else {
          this.primary = null;
          this.replica = null;
          this.state = 'INIT';
          events.push({ level: 'crit', code: 'NO_PATH', message: 'No usable interface — buffering at anchor' });
        }
      }
    }

    const pred = this.primary ? this._predict(this.primary, ctx) : null;
    const best = this.primary ? this._bestCandidate(scores, links, t, this.primary) : null;

    if (this.state === 'STEADY' && this.primary) {
      const beatsPrediction = best && scores[best].critical > pred.predictedCritical;
      if (pred.degrading && best && (beatsPrediction || pred.failureImminent)) {
        this._startReplication(best, t, 'PREDICTED_DEGRADATION', pred, scores, events);
      } else if (
        best &&
        t >= this.holdUntil &&
        !pred.degrading &&
        scores[best].critical > p.upgradeRatio * scores[this.primary].critical
      ) {
        this.upgradeTicks++;
        if (this.upgradeTicks * this.dt >= p.upgradeDwellS - 1e-9) {
          this._startReplication(best, t, 'UPGRADE', pred, scores, events);
        }
      } else {
        this.upgradeTicks = 0;
      }
    } else if (this.state === 'REPLICATING') {
      // Keep the replica on the best available candidate.
      if (!links[this.replica].up) {
        const alt = best;
        if (alt) {
          events.push({ level: 'warn', code: 'RETARGET', message: `Replica ${this.replica} lost → re-priming ${alt}` });
          this.replica = alt;
        } else {
          events.push({ level: 'warn', code: 'REPL_OFF', message: `Replica ${this.replica} lost — no alternative, replication off` });
          this.replica = null;
          this.state = 'STEADY';
        }
      } else if (best && best !== this.replica && scores[best].critical > p.retargetRatio * scores[this.replica].critical) {
        events.push({ level: 'info', code: 'RETARGET', message: `Replica retargeted ${this.replica} → ${best} (higher score)` });
        this.replica = best;
      }

      if (this.state === 'REPLICATING') {
        const elapsed = t - this.replStart;
        const primLoss = this.monitors[this.primary].loss.value ?? 0;
        const ratio = scores[this.replica].critical / Math.max(1e-9, scores[this.primary].critical);
        const lossCond = primLoss > p.switchLoss;
        const scoreCond = ratio > p.switchScoreRatio;
        this.switchPending = lossCond || scoreCond ? this.switchPending + 1 : 0;
        const minRepl = this.replReason === 'UPGRADE' ? p.upgradeMinReplicationS : p.minReplicationS;

        if (this.switchPending >= p.switchConfirmTicks && elapsed >= minRepl - 1e-9) {
          const reason = lossCond ? `primary loss ${pct(primLoss)} > 15%` : `candidate score ${ratio.toFixed(1)}× primary`;
          this._switchTo(this.replica, t, reason, events);
        } else if (this.replReason === 'UPGRADE') {
          if (ratio < p.upgradeRatio) {
            this.recoverTicks++;
            if (this.recoverTicks * this.dt >= p.abortDwellS - 1e-9) this._abort(t, 'upgrade no longer beneficial', events);
          } else this.recoverTicks = 0;
        } else if (!pred.degrading && pred.loss < 0.02 && pred.dLoss <= 0.005 && pred.ttf > 2 * p.predictionHorizonS) {
          this.recoverTicks++;
          if (this.recoverTicks * this.dt >= p.abortDwellS - 1e-9) this._abort(t, `${this.primary} recovered`, events);
        } else {
          this.recoverTicks = 0;
        }
      }
    }

    const bulkShares = this._bulkShares(scores, links, t);
    const criticalPaths = this.primary ? (this.replica ? [this.primary, this.replica] : [this.primary]) : [];

    this.lastDecision = {
      engine: 'flexipath',
      state: this.state,
      primary: this.primary,
      replica: this.replica,
      replicationActive: this.state === 'REPLICATING',
      replicationReason: this.replReason,
      replicationElapsed: this.state === 'REPLICATING' ? t - this.replStart : 0,
      criticalPaths,
      bulkShares,
      blackoutMs,
      stalled: !this.primary,
      stall: null,
      scores,
      prediction: pred,
      lastSwitch: this.lastSwitch,
      events,
    };
    return this.lastDecision;
  }

  _abort(t, why, events) {
    const d = t - this.replStart;
    events.push({ level: 'info', code: 'REPL_ABORT', message: `Replication stood down after ${d.toFixed(1)} s — ${why}` });
    this.state = 'STEADY';
    this.replica = null;
    this.replReason = null;
    this.recoverTicks = 0;
    this.switchPending = 0;
  }
}
