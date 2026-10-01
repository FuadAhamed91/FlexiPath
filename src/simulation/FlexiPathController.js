/**
 * FlexiPathController.js — DETECT → PREDICT → PREPARE → REPLICATE → SWITCH → CONTINUE.
 *
 * Link utility (brief §4A):
 *
 *        W_i = Throughput_i^a / ( RTT_i^b · (1 + α · LossRate_i²) ),   α = 12
 *
 *   GENERAL  a = 1.0, b = 1.0   (UI utility gauge)
 *   CRITICAL a = 0.4, b = 1.2   (telemetry / voice: latency and loss first)
 *   BULK     a = 1.5, b = 0.5   (file streams: raw capacity first)
 *
 * The loop, as implemented here:
 *
 *   DETECT     every link is measured at 10 Hz (EWMA loss, RTT, throughput, signal).
 *   PREDICT    early warning: a 3 s regression of the primary's signal projects the 15 %-loss level
 *              within 8 s (only within 20 dB of it), or a loss / RTT trigger is already true.
 *   PREPARE    while a degradation is watched, the best alternate (critical score, loss ≤ 12 %,
 *              up ≥ 0.3 s) is kept selected and validated every tick.
 *   REPLICATE  act (brief §4B) when, on EWMA-smoothed probes,
 *                ΔLoss = Loss_latest − Loss_{t−10} > 0.03 ∨ Loss > 0.05 ∨ RTT drift
 *                ∨ time-to-failure (1 s trend, within 10 dB) < 3 s ∨ rapid fade ∨ dock release
 *              and the prepared path beats the primary's *predicted* score (2 s horizon) or failure
 *              is imminent. Replication is traffic-aware: CRITICAL for the whole window, REAL-TIME
 *              only once measured loss exceeds its 2 % budget or failure is < 1 s away, BULK never.
 *   SWITCH     primary loss > 15 % ∨ W_prepared > 1.5 · W_primary (confirmed 2 ticks).
 *   CONTINUE   sessions ride a persistent anchor IP (198.51.100.24): a path swap never resets a
 *              socket, only packets can be lost — and replication covers those.
 *
 * Every important decision also produces a structured record (current path, status, alternate,
 * traffic, action, reason) built from the measured values the controller acted on.
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
  ttfMarginDb: 10, // only extrapolate time-to-failure within 10 dB of the failure level
  ttfConfirmTicks: 2, // TTF must persist for 200 ms
  abortMarginDb: 13, // stand down only once the margin has recovered past this (3 dB hysteresis)
  rapidFadeSlope: 12, // dB/s — a collapse this steep is never mobility or shadowing
  minSignalSlope: 0.8, // dB/s — slower drifts are treated as probe noise
  rttDriftFactor: 0.25, // RTT slope > 25 % of baseline per second …
  rttDriftLevel: 1.6, // … while RTT > 1.6 × baseline
  watchWindowTicks: 30, // early-warning trend: 3 s regression of the smoothed signal
  watchMarginDb: 20, // … tracked only within 20 dB of the failure level
  watchHorizonS: 8.0, // … PREDICT stage when it projects the failure level within 8 s
  watchReleaseS: 1.0, // … released after 1 s without a projection inside the horizon
  realtimeLossBudget: 0.02, // REAL-TIME joins replication above 2 % measured loss (G.711 + PLC: < 0.2 MOS) …
  realtimeTtfS: 1.0, // … or when failure is less than 1 s away
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
const secs = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1));
const name = (id) => (id ? INTERFACE_SPECS[id].name : '—');
const fmtSig = (id, v) => {
  const s = INTERFACE_SPECS[id];
  if (!s || s.tech === 'wired' || !Number.isFinite(v)) return null;
  return `${v.toFixed(1)} ${s.signalUnit}`;
};

export class FlexiPathController {
  /**
   * @param {{params?: object, dt?: number, classes?: {CRITICAL:boolean, REALTIME:boolean, BULK:boolean}}} opts
   *   `classes` — which traffic classes are present, so protection is planned for the traffic that exists.
   */
  constructor({ params = {}, dt = 0.1, classes = { CRITICAL: true, REALTIME: true, BULK: true } } = {}) {
    this.p = { ...FLEXIPATH_PARAMS, ...params };
    this.dt = dt;
    this.classes = { CRITICAL: !!classes.CRITICAL, REALTIME: !!classes.REALTIME, BULK: !!classes.BULK };
    this.reset();
  }

  /** True when at least one replication-eligible class (critical / real-time) is carried. */
  get _eligible() {
    return this.classes.CRITICAL || this.classes.REALTIME;
  }

  /** Human-readable list of the classes being replicated right now. */
  _replicatedText() {
    const out = [];
    if (this.classes.CRITICAL) out.push('critical');
    if (this.classes.REALTIME && this.rtLatched) out.push('real-time');
    return out.join(' + ');
  }

  reset() {
    this.monitors = {};
    for (const id of INTERFACE_IDS) this.monitors[id] = this._newMonitor();
    this.primary = null;
    this.replica = null;
    this.state = 'INIT';
    this.replStart = 0;
    this.replReason = null;
    this.rtLatched = false;
    this.switchPending = 0;
    this.recoverTicks = 0;
    this.upgradeTicks = 0;
    this.holdUntil = 0;
    this.lastSwitch = null;
    this.handovers = 0;
    this.unplannedFailovers = 0;
    this.watching = false;
    this.watchSince = null;
    this.watchLastSeen = 0;
    this.prepared = null;
    this.preparedSince = null;
    this.records = [];
    this.lastRecord = null;
    this.lastDecision = null;
  }

  _newMonitor() {
    const base = { window: this.p.windowTicks, dt: this.dt };
    return {
      loss: new TrendMonitor({ ...base, alpha: 0.35 }),
      rtt: new TrendMonitor({ ...base, alpha: 0.3 }),
      thr: new TrendMonitor({ ...base, alpha: 0.3 }),
      sig: new TrendMonitor({ ...base, alpha: 0.3 }),
      sigLong: new TrendMonitor({ window: this.p.watchWindowTicks, dt: this.dt, alpha: 0.3 }),
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
      m.sigLong.update(L.meas.signal);
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

    // Time-to-failure: linear extrapolation of the smoothed signal towards the
    // level where PER reaches the 15 % switch threshold. Gated to the last
    // `ttfMarginDb` so shadow-fading ripples far from the edge cannot trigger it.
    // The early-warning projection uses a slower 3 s trend over a wider margin.
    let ttf = Infinity;
    let projectedTtf = Infinity;
    let margin = Infinity;
    let failLevel = null;
    if (spec.tech === 'wired') {
      if (ctx.dockRelease) ttf = projectedTtf = ctx.dockTtf ?? 0;
    } else {
      failLevel = failureSignalLevel(spec, p.switchLoss);
      margin = m.sig.value - failLevel;
      if (m.sig.slope < -p.minSignalSlope && margin < p.ttfMarginDb) ttf = Math.max(0, margin / -m.sig.slope);
      if (m.sigLong.slope < -p.minSignalSlope && margin < p.watchMarginDb) {
        projectedTtf = Math.max(0, margin / -m.sigLong.slope);
      }
    }

    m.ttfHits = ttf < p.ttfTriggerS ? (m.ttfHits ?? 0) + 1 : 0;

    const loss = m.loss.value ?? 0;
    const rtt = m.rtt.value ?? spec.baseRtt;
    const triggers = {
      deltaLoss: m.loss.delta > p.deltaLossTrigger,
      lossRate: loss > p.lossTrigger,
      rttDrift: m.rtt.slope > p.rttDriftFactor * spec.baseRtt && rtt > p.rttDriftLevel * spec.baseRtt,
      ttf: spec.tech === 'wired' ? ttf < p.ttfTriggerS : m.ttfHits >= p.ttfConfirmTicks,
      rapidFade: spec.tech !== 'wired' && m.sig.slope < -p.rapidFadeSlope,
      context: spec.tech === 'wired' && !!ctx.dockRelease,
    };
    const degrading = Object.values(triggers).some(Boolean);
    const failureImminent =
      predicted.lossRate > p.switchLoss || triggers.ttf || triggers.rapidFade || triggers.context;
    const watch = degrading || m.ttfHits > 0 || projectedTtf < p.watchHorizonS;
    return {
      link: id,
      dockDistM: spec.tech === 'wired' ? ctx.dockDistM ?? null : null,
      loss,
      dLoss: m.loss.delta,
      rtt,
      rttSlope: m.rtt.slope,
      signal: m.sig.value,
      signalSlope: m.sig.slope,
      signalSlopeLong: m.sigLong.slope,
      failLevel,
      marginDb: margin,
      predictedLoss: predicted.lossRate,
      predictedRtt: predicted.rttMs,
      predictedCritical,
      ttf,
      projectedTtf,
      triggers,
      degrading,
      failureImminent,
      watch,
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

  // ── Explanations ───────────────────────────────────────────────────────
  _triggerReasons(pred) {
    const p = this.p;
    const out = [];
    if (!pred) return out;
    const tr = pred.triggers;
    if (tr.context) {
      out.push(`dock release: vehicle departing, wired carrier ends ${Number.isFinite(pred.dockDistM) ? `${pred.dockDistM.toFixed(0)} m ahead` : 'imminently'}`);
    }
    if (tr.rapidFade) out.push(`signal collapsing ${pred.signalSlope.toFixed(0)} dB/s (steeper than −${p.rapidFadeSlope} dB/s)`);
    if (tr.ttf && !tr.context && Number.isFinite(pred.ttf)) {
      out.push(`predicted time-to-failure ${secs(pred.ttf)} s < ${p.ttfTriggerS.toFixed(1)} s trigger`);
    }
    if (tr.deltaLoss) out.push(`loss rose ${pct(pred.dLoss)} in 1 s (> ${pct(p.deltaLossTrigger)})`);
    if (tr.lossRate) out.push(`loss ${pct(pred.loss)} > ${pct(p.lossTrigger)}`);
    if (tr.rttDrift) out.push(`RTT drifting +${pred.rttSlope.toFixed(1)} ms/s`);
    return out;
  }

  _linkView(id, links, pred, statusOverride) {
    if (!id) return null;
    const L = links[id];
    const m = this.monitors[id];
    const isPrimaryPred = pred && pred.link === id;
    let status = 'Healthy';
    let level = 'ok';
    if (!L.up) {
      status = 'Lost';
      level = 'crit';
    } else if (isPrimaryPred && pred.failureImminent) {
      status = 'Failure imminent';
      level = 'crit';
    } else if (isPrimaryPred && (pred.watch || pred.degrading)) {
      status = 'Degrading';
      level = 'warn';
    }
    if (statusOverride) [status, level] = statusOverride;
    return {
      link: id,
      name: name(id),
      status,
      level,
      signal: L.up ? m.sig.value : null,
      signalText: L.up ? fmtSig(id, m.sig.value) : null,
      slope: isPrimaryPred ? pred.signalSlopeLong : null,
      marginDb: isPrimaryPred ? pred.marginDb : null,
      ttf: isPrimaryPred ? pred.ttf : null,
      projectedTtf: isPrimaryPred ? pred.projectedTtf : null,
      loss: L.up ? m.loss.value : 1,
      rttMs: L.up ? m.rtt.value : null,
    };
  }

  _altView(id, scores, links, t, label) {
    if (!id) return null;
    const m = this.monitors[id];
    return {
      link: id,
      name: name(id),
      label,
      score: scores[id]?.norm.critical ?? 0,
      loss: m.loss.value,
      rttMs: m.rtt.value,
      throughputMbps: m.thr.value,
      upS: links[id].upSince !== undefined && links[id].upSince !== null ? t - links[id].upSince : null,
    };
  }

  _trafficView() {
    const c = this.classes;
    const protecting = this.state === 'REPLICATING';
    const replicated = protecting
      ? [...(c.CRITICAL ? ['CRITICAL'] : []), ...(c.REALTIME && this.rtLatched ? ['REALTIME'] : [])]
      : [];
    const standby = protecting && c.REALTIME && !this.rtLatched ? ['REALTIME'] : [];
    const notReplicated = c.BULK ? ['BULK'] : [];
    const parts = [];
    if (replicated.includes('CRITICAL')) parts.push('critical replicated');
    if (replicated.includes('REALTIME')) parts.push('real-time replicated');
    if (standby.includes('REALTIME')) parts.push('real-time on standby (within its loss budget)');
    if (c.BULK) parts.push(protecting ? 'bulk not replicated, drained to the prepared path' : 'bulk not replicated');
    return {
      replicated,
      standby,
      notReplicated,
      text: protecting ? parts.join(' · ') : 'Single path · no replication needed',
    };
  }

  _record(t, kind, data) {
    const rec = { t, kind, ...data };
    this.records.push(rec);
    if (this.records.length > 60) this.records.shift();
    this.lastRecord = rec;
    this._tickRecords.push(rec);
    return rec;
  }

  // ── PREPARE & REPLICATE ────────────────────────────────────────────────
  _startReplication(candidate, t, reason, pred, scores, links, events) {
    const p = this.p;
    this.state = 'REPLICATING';
    if (this.prepared !== candidate) this.preparedSince = t;
    this.prepared = candidate;
    this.replica = candidate;
    this.replStart = t;
    this.replReason = reason;
    this.switchPending = 0;
    this.recoverTicks = 0;
    this.upgradeTicks = 0;
    this.rtLatched = this.classes.REALTIME && reason !== 'UPGRADE' && this._realtimeNeedsCover(pred);
    const why = this._triggerReasons(pred);
    const classes = this._replicatedText();
    if (reason === 'UPGRADE') {
      const ratio = scores[candidate].critical / Math.max(1e-9, scores[this.primary].critical);
      events.push({
        level: 'repl',
        code: 'UPGRADE',
        message: `Better path ${candidate} (${ratio.toFixed(1)}× critical score) → make-before-break upgrade`,
      });
      this._record(t, 'UPGRADE', {
        headline: `Better path available: ${name(candidate)}`,
        current: this._linkView(this.primary, links, pred, ['Healthy', 'ok']),
        alternate: this._altView(candidate, scores, links, t, 'Better path'),
        traffic: this._trafficView(),
        action: `Make-before-break upgrade to ${name(candidate)} (critical traffic replicated during the move)`,
        reason: `${name(candidate)} scores ${ratio.toFixed(1)}× the current path for ${p.upgradeDwellS.toFixed(1)} s (upgrade ratio ${p.upgradeRatio}×)`,
      });
    } else {
      if (!this.watching) {
        events.push({
          level: 'warn',
          code: 'PREDICT',
          message: `PREDICT ${this.primary} failure [${why.join(' · ') || 'score trend'}] → ${candidate} selected`,
        });
      }
      const wiredPrimary = INTERFACE_SPECS[this.primary].tech === 'wired';
      this._record(t, 'PROTECT', {
        headline: `${wiredPrimary ? 'Dock release detected' : `${name(this.primary)} degradation predicted`} · ${name(candidate)} prepared · ${
          this._eligible ? `${this.classes.CRITICAL ? 'critical' : 'real-time'} flow protection enabled` : 'bulk drained to it (nothing to replicate)'
        }`,
        current: this._linkView(this.primary, links, pred),
        alternate: this._altView(candidate, scores, links, t, 'Prepared path'),
        traffic: this._trafficView(),
        action: this._eligible
          ? `Prepare ${name(candidate)} + replicate ${classes || 'no'} traffic`
          : `Prepare ${name(candidate)} + drain bulk traffic onto it (no critical or real-time flows to replicate)`,
        reason: why.length ? `Predicted degradation exceeds threshold: ${why.join('; ')}` : 'Predicted score of the primary falls below the prepared path',
        preparedLeadS: this.preparedSince !== null && this.prepared === candidate ? t - this.preparedSince : 0,
      });
    }
    if (this._eligible) {
      events.push({
        level: 'repl',
        code: 'REPL_ON',
        message: `PREDICTIVE REPLICATION ON · ${classes || 'no'} traffic mirrored ${this.primary} ⇉ ${candidate}${this.classes.BULK ? ' · bulk not replicated' : ''}`,
      });
    } else {
      events.push({
        level: 'info',
        code: 'DRAIN',
        message: `PROTECTION WINDOW · no critical / real-time traffic to replicate · bulk drained ${this.primary} → ${candidate}`,
      });
    }
  }

  _realtimeNeedsCover(pred) {
    if (!pred) return false;
    const p = this.p;
    return (
      pred.loss > p.realtimeLossBudget ||
      (Number.isFinite(pred.ttf) && pred.ttf < p.realtimeTtfS) ||
      pred.triggers.rapidFade ||
      pred.triggers.context
    );
  }

  // ── SWITCH & CONTINUE ──────────────────────────────────────────────────
  _switchTo(next, t, reason, events, { seamless = true, from = this.primary, blackoutMs = 0, record = null } = {}) {
    const replicationS = this.state === 'REPLICATING' ? t - this.replStart : 0;
    const preparedLeadS = this.prepared === next && this.preparedSince !== null ? t - this.preparedSince : null;
    this.monitors[next].ttfHits = 0;
    this.primary = next;
    this.replica = null;
    this.state = 'STEADY';
    this.replReason = null;
    this.rtLatched = false;
    this.holdUntil = t + this.p.holdDownS;
    this.switchPending = 0;
    this.recoverTicks = 0;
    this.upgradeTicks = 0;
    this.handovers++;
    this.watching = false;
    this.watchSince = null;
    this.prepared = null;
    this.preparedSince = null;
    this.lastSwitch = { t, from, to: next, seamless, reason, replicationS, blackoutMs, preparedLeadS };
    if (record) this._record(t, seamless ? 'SWITCH' : 'FAILOVER', { ...record, preparedLeadS });
    if (seamless) {
      events.push({
        level: 'ok',
        code: 'HOT_SWAP',
        message: `HOT-SWAP ${from} → ${next} · ${reason}${replicationS ? ` · ${this._eligible ? 'replication' : 'protection window'} ${replicationS.toFixed(1)} s` : ''}`,
        from,
        to: next,
      });
      if (replicationS && this._eligible) {
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

  /** PREDICT / PREPARE bookkeeping while the primary is being watched. */
  _watch(t, pred, best, scores, links, events) {
    const p = this.p;
    if (!this.primary || !pred) {
      this.watching = false;
      this.watchSince = null;
      return;
    }
    if (pred.watch) {
      this.watchLastSeen = t;
      if (!this.watching) {
        this.watching = true;
        this.watchSince = t;
        const wired = INTERFACE_SPECS[this.primary].tech === 'wired';
        const why = this._triggerReasons(pred);
        let projText;
        if (wired) projText = why.join(' · ') || 'dock release';
        else if (Number.isFinite(pred.projectedTtf)) projText = `failure level in ≈ ${secs(pred.projectedTtf)} s (3 s trend ${pred.signalSlopeLong.toFixed(1)} dB/s)`;
        else if (Number.isFinite(pred.ttf)) projText = `failure level in ≈ ${secs(pred.ttf)} s (1 s trend ${pred.signalSlope.toFixed(1)} dB/s)`;
        else projText = why.join(' · ') || 'degradation trend';
        events.push({ level: 'warn', code: 'PREDICT', message: `PREDICT ${this.primary} degradation · ${projText}` });
        const sig = INTERFACE_SPECS[this.primary];
        this._record(t, 'PREDICT', {
          headline: wired ? 'Dock release detected: the wired link is about to end' : `${name(this.primary)} degradation predicted`,
          current: this._linkView(this.primary, links, pred),
          alternate: best ? this._altView(best, scores, links, t, 'Alternate') : null,
          traffic: this._trafficView(),
          action: best
            ? `Prepare ${name(best)}; protect critical traffic if time-to-failure < ${p.ttfTriggerS.toFixed(1)} s`
            : 'Search for an alternate path',
          reason:
            pred.failLevel !== null && Number.isFinite(pred.projectedTtf)
              ? `3 s signal trend ${pred.signalSlopeLong.toFixed(1)} dB/s, ${pred.marginDb.toFixed(1)} dB above the 15 %-loss level (${pred.failLevel.toFixed(1)} ${sig.signalUnit}) → projected failure in ${secs(pred.projectedTtf)} s (< ${p.watchHorizonS.toFixed(0)} s horizon)`
              : pred.failLevel !== null && Number.isFinite(pred.ttf)
                ? `1 s signal trend ${pred.signalSlope.toFixed(1)} dB/s, ${pred.marginDb.toFixed(1)} dB above the 15 %-loss level → time-to-failure ${secs(pred.ttf)} s`
                : why.length
                  ? why.join('; ')
                  : 'Degradation trend on the primary',
        });
      }
    } else if (this.watching && t - this.watchLastSeen >= p.watchReleaseS - 1e-9 && this.state !== 'REPLICATING') {
      this.watching = false;
      this.watchSince = null;
      events.push({ level: 'info', code: 'TREND_OFF', message: `${this.primary} trend recovered — prediction released, no action needed` });
    }

    // PREPARE: keep the next path selected and validated while a degradation is watched.
    const want = this.state === 'REPLICATING' ? this.replica : this.watching ? best : null;
    if (want !== this.prepared) {
      const changed = this.prepared && want;
      this.prepared = want;
      this.preparedSince = want ? t : null;
      if (want && this.state !== 'REPLICATING') {
        const m = this.monitors[want];
        events.push({
          level: 'info',
          code: 'PREPARE',
          message: `${changed ? 'Next path changed →' : 'Next path prepared:'} ${want} · score ${scores[want].norm.critical.toFixed(0)} · loss ${pct(m.loss.value ?? 0)} · RTT ${(m.rtt.value ?? 0).toFixed(0)} ms`,
        });
        if (this.watchSince !== t) {
          this._record(t, 'PREPARE', {
            headline: `${name(want)} prepared as the next path`,
            current: this._linkView(this.primary, links, pred),
            alternate: this._altView(want, scores, links, t, 'Prepared path'),
            traffic: this._trafficView(),
            action: `Keep ${name(want)} validated; protect critical traffic if time-to-failure < ${p.ttfTriggerS.toFixed(1)} s`,
            reason: `Highest critical score among links with loss ≤ ${pct(p.candidateMaxLoss)} and up ≥ ${p.candidateMinUpS} s`,
          });
        }
      }
    }
  }

  /**
   * One 100 ms control cycle.
   * @param {{t:number, links:Record<string,object>, ctx:object}} input
   */
  update({ t, links, ctx = {} }) {
    const p = this.p;
    const events = [];
    this._tickRecords = [];
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
        this._record(t, 'ATTACH', {
          headline: `${name(first)} selected as primary path`,
          current: this._linkView(first, links, null),
          alternate: null,
          traffic: this._trafficView(),
          action: `Carry all flows on ${name(first)}; keep monitoring every link`,
          reason: `Highest critical score (${scores[first].norm.critical.toFixed(0)}) of the available links`,
        });
      }
    }

    // Abrupt loss of the primary (e.g. cell outage): promote replica or fail over.
    if (this.primary && !links[this.primary].up) {
      const lost = this.primary;
      const wasWatched = this.watching;
      if (this.replica && links[this.replica].up) {
        const next = this.replica;
        this._switchTo(next, t, `${lost} dropped · replica promoted, 0 ms gap`, events, {
          from: lost,
          record: {
            headline: `Switched to ${name(next)} — 0 ms gap`,
            current: this._linkView(lost, links, null, ['Failure detected (link lost)', 'crit']),
            alternate: this._altView(next, scores, links, t, 'New primary'),
            traffic: { replicated: [], standby: [], notReplicated: ['BULK'], text: 'All flows continue on the new primary' },
            action: `Promote ${name(next)} to primary path`,
            reason: `${name(lost)} dropped while ${name(next)} was already carrying replicated critical traffic — alternate was prepared before failure`,
          },
        });
      } else {
        const fb = this._bestCandidate(scores, links, t, lost, { strict: false });
        if (fb) {
          blackoutMs = p.failoverDetectMs;
          this._switchTo(fb, t, 'abrupt link loss', events, {
            seamless: false,
            from: lost,
            blackoutMs,
            record: {
              headline: `Unplanned failover to ${name(fb)}`,
              current: this._linkView(lost, links, null, ['Failure detected (abrupt)', 'crit']),
              alternate: this._altView(fb, scores, links, t, 'New primary'),
              traffic: { replicated: [], standby: [], notReplicated: ['BULK'], text: `In-flight packets of every class lost for ${blackoutMs} ms` },
              action: `Fail over to ${name(fb)} after ${blackoutMs} ms detection`,
              reason: wasWatched
                ? `${name(lost)} dropped before protection was armed`
                : `${name(lost)} was lost abruptly with no degradation trend before it — not predictable. Detected by 3 missed probes; sessions stay on the anchor IP`,
            },
          });
        } else {
          this.primary = null;
          this.replica = null;
          this.state = 'INIT';
          this.watching = false;
          this.prepared = null;
          events.push({ level: 'crit', code: 'NO_PATH', message: 'No usable interface — buffering at anchor' });
          this._record(t, 'NO_PATH', {
            headline: 'No usable path',
            current: this._linkView(lost, links, null, ['Lost', 'crit']),
            alternate: null,
            traffic: { replicated: [], standby: [], notReplicated: [], text: 'All flows buffered at the anchor' },
            action: 'Buffer at the anchor and attach as soon as any link returns',
            reason: 'Every interface is down',
          });
        }
      }
    }

    const pred = this.primary ? this._predict(this.primary, ctx) : null;
    const best = this.primary ? this._bestCandidate(scores, links, t, this.primary) : null;
    this._watch(t, pred, best, scores, links, events);

    if (this.state === 'STEADY' && this.primary) {
      const beatsPrediction = best && scores[best].critical > pred.predictedCritical;
      if (pred.degrading && best && (beatsPrediction || pred.failureImminent)) {
        this._startReplication(best, t, 'PREDICTED_DEGRADATION', pred, scores, links, events);
      } else if (
        best &&
        t >= this.holdUntil &&
        !pred.degrading &&
        scores[best].critical > p.upgradeRatio * scores[this.primary].critical
      ) {
        this.upgradeTicks++;
        if (this.upgradeTicks * this.dt >= p.upgradeDwellS - 1e-9) {
          this._startReplication(best, t, 'UPGRADE', pred, scores, links, events);
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
          this._record(t, 'RETARGET', {
            headline: `Prepared path lost — ${name(alt)} takes over`,
            current: this._linkView(this.primary, links, pred),
            alternate: this._altView(alt, scores, links, t, 'Prepared path'),
            traffic: this._trafficView(),
            action: `Replicate onto ${name(alt)} instead`,
            reason: `${name(this.replica)} went down during the protection window`,
          });
          this.replica = alt;
        } else {
          events.push({ level: 'warn', code: 'REPL_OFF', message: `Replica ${this.replica} lost — no alternative, replication off` });
          this.replica = null;
          this.state = 'STEADY';
          this.rtLatched = false;
        }
      } else if (best && best !== this.replica && scores[best].critical > p.retargetRatio * scores[this.replica].critical) {
        events.push({ level: 'info', code: 'RETARGET', message: `Replica retargeted ${this.replica} → ${best} (higher score)` });
        this._record(t, 'RETARGET', {
          headline: `Better alternate: ${name(best)}`,
          current: this._linkView(this.primary, links, pred),
          alternate: this._altView(best, scores, links, t, 'Prepared path'),
          traffic: this._trafficView(),
          action: `Move the replica from ${name(this.replica)} to ${name(best)}`,
          reason: `${name(best)} scores more than ${p.retargetRatio}× the current replica`,
        });
        this.replica = best;
      }

      if (this.state === 'REPLICATING') {
        if (this.prepared !== this.replica) {
          this.prepared = this.replica;
          this.preparedSince = t;
        }
        const elapsed = t - this.replStart;
        const primLoss = this.monitors[this.primary].loss.value ?? 0;
        const ratio = scores[this.replica].critical / Math.max(1e-9, scores[this.primary].critical);
        const lossCond = primLoss > p.switchLoss;
        const scoreCond = ratio > p.switchScoreRatio;
        this.switchPending = lossCond || scoreCond ? this.switchPending + 1 : 0;
        const minRepl = this.replReason === 'UPGRADE' ? p.upgradeMinReplicationS : p.minReplicationS;

        // Traffic-aware: real-time traffic joins only once it actually needs cover.
        if (this.classes.REALTIME && !this.rtLatched && this.replReason !== 'UPGRADE' && this._realtimeNeedsCover(pred)) {
          this.rtLatched = true;
          const why =
            pred.loss > p.realtimeLossBudget
              ? `loss ${(pred.loss * 100).toFixed(2)}% > ${pct(p.realtimeLossBudget)} real-time budget`
              : Number.isFinite(pred.ttf)
                ? `failure in ${secs(pred.ttf)} s < ${p.realtimeTtfS.toFixed(1)} s`
                : 'path collapsing';
          events.push({ level: 'repl', code: 'REPL_RT', message: `Real-time traffic added to replication — ${why}` });
          this._record(t, 'PROTECT_RT', {
            headline: 'Real-time traffic added to the protection',
            current: this._linkView(this.primary, links, pred),
            alternate: this._altView(this.replica, scores, links, t, 'Prepared path'),
            traffic: this._trafficView(),
            action: `Replicate real-time traffic on ${name(this.primary)} + ${name(this.replica)} as well`,
            reason: `${why.charAt(0).toUpperCase()}${why.slice(1)}`,
          });
        }

        if (this.switchPending >= p.switchConfirmTicks && elapsed >= minRepl - 1e-9) {
          const from = this.primary;
          const to = this.replica;
          const reason = lossCond ? `primary loss ${pct(primLoss)} > 15%` : `candidate score ${ratio.toFixed(1)}× primary`;
          const leadText = this.preparedSince !== null ? ` — ${name(to)} was prepared ${(t - this.preparedSince).toFixed(1)} s before` : '';
          this._switchTo(to, t, reason, events, {
            record: {
              headline: `Switched primary path to ${name(to)}`,
              current: this._linkView(from, links, pred, lossCond ? ['Failure detected', 'crit'] : ['Degraded', 'warn']),
              alternate: this._altView(to, scores, links, t, 'Prepared path → new primary'),
              traffic: { replicated: [], standby: [], notReplicated: ['BULK'], text: 'Replication ends · all flows continue on the new primary' },
              action: `Switch primary path to ${name(to)}`,
              reason: lossCond
                ? `${name(from)} loss ${pct(primLoss)} exceeds the ${pct(p.switchLoss)} switch threshold${leadText}`
                : `${name(to)} scores ${ratio.toFixed(1)}× ${name(from)} (> ${p.switchScoreRatio}×)${leadText}`,
            },
          });
        } else if (this.replReason === 'UPGRADE') {
          if (ratio < p.upgradeRatio) {
            this.recoverTicks++;
            if (this.recoverTicks * this.dt >= p.abortDwellS - 1e-9) this._abort(t, 'upgrade no longer beneficial', events, links, pred, scores);
          } else this.recoverTicks = 0;
        } else if (
          !pred.degrading &&
          pred.loss < 0.02 &&
          pred.dLoss <= 0.005 &&
          (pred.marginDb > p.abortMarginDb || pred.signalSlope > p.minSignalSlope)
        ) {
          this.recoverTicks++;
          if (this.recoverTicks * this.dt >= p.abortDwellS - 1e-9) this._abort(t, `${this.primary} recovered`, events, links, pred, scores);
        } else {
          this.recoverTicks = 0;
        }
      }
    }

    const bulkShares = this._bulkShares(scores, links, t);
    const criticalPaths = this.primary ? (this.replica ? [this.primary, this.replica] : [this.primary]) : [];
    const protecting = this.state === 'REPLICATING';
    const replicate = {
      CRITICAL: protecting && this.classes.CRITICAL,
      REALTIME: protecting && this.classes.REALTIME && this.rtLatched,
      BULK: false,
    };
    const replicating = replicate.CRITICAL || replicate.REALTIME;
    const backup = this.replica ?? this.prepared ?? best ?? null;

    this.lastDecision = {
      engine: 'flexipath',
      state: this.state,
      primary: this.primary,
      replica: this.replica,
      protecting,
      replicationActive: replicating,
      replicationReason: this.replReason,
      replicationElapsed: protecting ? t - this.replStart : 0,
      replicate,
      classes: this.classes,
      criticalPaths,
      bulkShares,
      backup,
      watching: this.watching,
      watchSince: this.watchSince,
      prepared: this.prepared,
      preparedSince: this.preparedSince,
      blackoutMs,
      stalled: !this.primary,
      stall: null,
      scores,
      prediction: pred,
      lastSwitch: this.lastSwitch,
      records: this._tickRecords,
      lastRecord: this.lastRecord,
      events,
    };
    return this.lastDecision;
  }

  _abort(t, why, events, links, pred, scores) {
    const d = t - this.replStart;
    events.push({ level: 'info', code: 'REPL_ABORT', message: `Replication stood down after ${d.toFixed(1)} s — ${why}` });
    this._record(t, 'STAND_DOWN', {
      headline: 'Protection stood down',
      current: this._linkView(this.primary, links, pred, ['Recovered', 'ok']),
      alternate: this._altView(this.replica, scores, links, t, 'Prepared path (kept on standby)'),
      traffic: { replicated: [], standby: [], notReplicated: ['BULK'], text: 'Replication stopped · single path again' },
      action: `Stop replicating after ${d.toFixed(1)} s`,
      reason: `${why.charAt(0).toUpperCase()}${why.slice(1)} — keeping duplicates would only add overhead`,
    });
    this.state = 'STEADY';
    this.replica = null;
    this.replReason = null;
    this.rtLatched = false;
    this.recoverTicks = 0;
    this.switchPending = 0;
  }
}
