/**
 * FlexiPathController.js — DETECT → PREDICT → PREPARE → REPLICATE → SWITCH → CONTINUE,
 * planned around the radio power budget.
 *
 * Link utility (brief §4A):
 *
 *        W_i = Throughput_i^a / ( RTT_i^b · (1 + α · LossRate_i²) ),   α = 12
 *
 *   GENERAL  a = 1.0, b = 1.0   (UI utility gauge)
 *   CRITICAL a = 0.4, b = 1.2   (telemetry / voice: latency and loss first)
 *   BULK     a = 1.5, b = 0.5   (file streams: raw capacity first)
 *
 * The loop, as implemented here (radio tiers from PowerModel.js):
 *
 *   DETECT     the primary carries all traffic and is measured at 10 Hz. Every other modem sleeps in
 *              3GPP DRX (1.2 W system draw): it only reports signal once per DRX cycle, so the
 *              controller knows its signal but not its RTT or loss.
 *   PREDICT    early warning on the primary: a 3 s signal regression projects the 15 %-loss level
 *              within 8 s (within 20 dB of it), or a loss / RTT trigger is true. A secondary is woken
 *              when degradation is predicted, the primary's loss rises > 2 % in 1 s, or its health
 *              score (critical utility as % of its nominal) drops to ≤ 75.
 *   PREPARE    the woken modem enters WARM PROBE (1.8 W): 64-byte heartbeats every 100 ms. After
 *              0.3 s of probes its measured RTT / loss / score make it a validated next path.
 *   REPLICATE  when, on EWMA-smoothed probes, ΔLoss > 0.03 ∨ Loss > 0.05 ∨ RTT drift ∨ time-to-failure
 *              (1 s trend, within 10 dB) < 3 s ∨ rapid fade ∨ dock release — and the validated path
 *              beats the primary's predicted score or failure is imminent — both radios transmit for
 *              the ~400 ms handoff window (BURST TX, 3.4 W). Traffic-aware: CRITICAL replicated,
 *              REAL-TIME only above a 2 % loss budget or < 1 s to failure, BULK never (it is moved with
 *              delay-compensated pacing instead).
 *   SWITCH     at the end of the burst window the validated path becomes primary; the old radio goes
 *              back to DRX.
 *   CONTINUE   sessions ride the anchor relay (198.51.100.24): a path change never resets a socket.
 *
 * Every important decision also produces a structured record (current path, status, alternate,
 * traffic, action, reason, radio power) built from the values the controller had at that tick.
 */
import { TrendMonitor, clamp } from '../utils/Metrics.js';
import { INTERFACE_IDS, INTERFACE_SPECS, failureSignalLevel, estimateLinkFromSignal, nominalLinkMetrics } from './LinkModel.js';
import { POWER_PARAMS } from './PowerModel.js';

export const FLEXIPATH_PARAMS = {
  alpha: 12.0,
  windowTicks: 10,
  deltaLossTrigger: 0.03,
  lossTrigger: 0.05,
  switchLoss: 0.15, // failure level used by the predictor (loss where a path counts as failed)
  predictionHorizonS: 2.0,
  ttfTriggerS: 3.0,
  ttfMarginDb: 10, // only extrapolate time-to-failure within 10 dB of the failure level
  ttfConfirmTicks: 2, // TTF must persist for 200 ms
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
  burstWindowS: POWER_PARAMS.burstWindowS, // dual-radio TX window of a handoff
  holdDownS: 3.0,
  upgradeRatio: 1.5,
  upgradeDwellS: 1.5,
  upgradeMinMarginDb: 20, // only upgrade to a path well inside its coverage (no ping-pong at the edge)
  candidateMaxLoss: 0.12,
  candidateMinUpS: 0.3,
  failoverDetectMs: 60, // 3 missed probes × 20 ms
  bulkMinShare: 0.04,
  bulkMaxLoss: 0.2,
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
const W = POWER_PARAMS.tierWatts;
const AWAKE = new Set(['ACTIVE', 'BURST', 'WARM']);
const fmtSig = (id, v) => {
  const s = INTERFACE_SPECS[id];
  if (!s || s.tech === 'wired' || !Number.isFinite(v)) return null;
  return `${v.toFixed(1)} ${s.signalUnit}`;
};
const POWER_HINT = {
  DRX: { tier: 0, watts: W[0], label: 'DRX STANDBY' },
  WARM: { tier: 1, watts: W[1], label: 'WARM PROBE' },
  BURST: { tier: 2, watts: W[2], label: 'BURST TX' },
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
    this.nominal = Object.fromEntries(
      INTERFACE_IDS.map((id) => [id, linkScore(nominalLinkMetrics(INTERFACE_SPECS[id]), SCORE_PROFILES.CRITICAL, this.p.alpha)]),
    );
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
    this.radio = Object.fromEntries(INTERFACE_IDS.map((id) => [id, { state: 'OFF', readyAt: null, drx: null }]));
    this.primary = null;
    this.replica = null;
    this.state = 'INIT';
    this.replStart = 0;
    this.replReason = null;
    this.rtLatched = false;
    this.emergency = false;
    this.upgradeTicks = 0;
    this.upgradeProbe = null;
    this.holdUntil = 0;
    this.lastSwitch = null;
    this.handovers = 0;
    this.unplannedFailovers = 0;
    this.watching = false;
    this.watchSince = null;
    this.watchLastSeen = 0;
    this.prepared = null;
    this.preparedSince = null;
    this.warmTarget = null;
    this.warmReason = null;
    this.warmLastReasonT = -Infinity;
    this.blackoutUntil = 0;
    this.blackoutTotalMs = 0;
    this.blackoutStartT = null;
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

  _awake(id) {
    return INTERFACE_SPECS[id].tech === 'wired' || AWAKE.has(this.radio[id].state);
  }

  // ── DETECT ─────────────────────────────────────────────────────────────
  _measure(links, t) {
    const P = POWER_PARAMS;
    for (const id of INTERFACE_IDS) {
      const L = links[id];
      const R = this.radio[id];
      if (!L.up) {
        if (this.monitors[id].wasUp) this.monitors[id] = this._newMonitor();
        R.drx = null;
        continue;
      }
      if (this._awake(id)) {
        const m = this.monitors[id];
        m.wasUp = true;
        m.loss.update(L.meas.lossRate);
        m.rtt.update(L.meas.rttMs);
        m.thr.update(L.meas.throughputMbps);
        m.sig.update(L.meas.signal);
        m.sigLong.update(L.meas.signal);
        R.drx = { signal: L.meas.signal, t };
      } else if (!R.drx || t - R.drx.t >= P.drxCycleS - 1e-9) {
        // DRX: the modem wakes once per cycle to measure signal — no traffic, no RTT / loss.
        R.drx = { signal: L.meas.signal, t };
      }
    }
  }

  _score(id, L, t) {
    const zero = { up: !!L.up, general: 0, critical: 0, bulk: 0, norm: { general: 0, critical: 0, bulk: 0 }, health: 0, estimated: false, marginDb: null };
    if (!L.up) return zero;
    const spec = INTERFACE_SPECS[id];
    const m = this.monitors[id];
    const R = this.radio[id];
    let metrics;
    let estimated = false;
    let ageS = 0;
    let signal = null;
    if (this._awake(id) && m.loss.value !== null) {
      metrics = { throughputMbps: m.thr.value, rttMs: m.rtt.value, lossRate: m.loss.value };
      signal = m.sig.value;
    } else if (R.drx) {
      metrics = estimateLinkFromSignal(spec, R.drx.signal);
      estimated = true;
      ageS = t - R.drx.t;
      signal = R.drx.signal;
    } else return zero;
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
      estimated,
      ageS,
      health: clamp((critical / Math.max(1e-12, this.nominal[id])) * 100, 0, 100),
      marginDb: spec.tech === 'wired' || !Number.isFinite(signal) ? null : signal - failureSignalLevel(spec, this.p.switchLoss),
      norm: {
        general: normalizeScore(general, SCORE_PROFILES.GENERAL, a),
        critical: normalizeScore(critical, SCORE_PROFILES.CRITICAL, a),
        bulk: normalizeScore(bulk, SCORE_PROFILES.BULK, a),
      },
    };
  }

  // ── PREDICT ────────────────────────────────────────────────────────────
  /** @param {{peek?: boolean}} [opts] peek = evaluate without advancing the TTF confirmation counter */
  _predict(id, ctx, { peek = false } = {}) {
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
    // level where PER reaches the 15 % failure level. Gated to the last
    // `ttfMarginDb` so shadow-fading ripples far from the edge cannot trigger it.
    // The early-warning projection uses a slower 3 s trend over a wider margin.
    let ttf = Infinity;
    let projectedTtf = Infinity;
    let margin = Infinity;
    let failLevel = null;
    if (spec.tech === 'wired') {
      if (ctx.dockRelease) ttf = projectedTtf = ctx.dockTtf ?? 0;
    } else if (m.sig.value !== null) {
      failLevel = failureSignalLevel(spec, p.switchLoss);
      margin = m.sig.value - failLevel;
      if (m.sig.slope < -p.minSignalSlope && margin < p.ttfMarginDb) ttf = Math.max(0, margin / -m.sig.slope);
      if (m.sigLong.slope < -p.minSignalSlope && margin < p.watchMarginDb) {
        projectedTtf = Math.max(0, margin / -m.sigLong.slope);
      }
    }

    const ttfHits = ttf < p.ttfTriggerS ? (m.ttfHits ?? 0) + 1 : 0;
    if (!peek) m.ttfHits = ttfHits;

    const loss = m.loss.value ?? 0;
    const rtt = m.rtt.value ?? spec.baseRtt;
    const triggers = {
      deltaLoss: m.loss.delta > p.deltaLossTrigger,
      lossRate: loss > p.lossTrigger,
      rttDrift: m.rtt.slope > p.rttDriftFactor * spec.baseRtt && rtt > p.rttDriftLevel * spec.baseRtt,
      ttf: spec.tech === 'wired' ? ttf < p.ttfTriggerS : ttfHits >= p.ttfConfirmTicks,
      rapidFade: spec.tech !== 'wired' && m.sig.slope < -p.rapidFadeSlope,
      context: spec.tech === 'wired' && !!ctx.dockRelease,
    };
    const degrading = Object.values(triggers).some(Boolean);
    const failureImminent =
      predicted.lossRate > p.switchLoss || triggers.ttf || triggers.rapidFade || triggers.context;
    const watch = degrading || ttfHits > 0 || projectedTtf < p.watchHorizonS;
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

  /** A path that may carry the handoff: awake, probed long enough, measured loss acceptable. */
  _validated(id, links, t) {
    const L = links[id];
    if (!L?.up) return false;
    if (INTERFACE_SPECS[id].tech === 'wired') return L.upSince === undefined || t - L.upSince >= this.p.candidateMinUpS;
    const R = this.radio[id];
    if (R.state !== 'WARM' || R.readyAt === null || t - R.readyAt < POWER_PARAMS.warmValidateS - 1e-9) return false;
    if ((this.monitors[id].loss.value ?? 1) > this.p.candidateMaxLoss) return false;
    return L.upSince === undefined || t - L.upSince >= this.p.candidateMinUpS;
  }

  /** strict: validated (probed) paths only. Otherwise any up path, ranked on measured or DRX-estimated score. */
  _bestCandidate(scores, links, t, exclude, { strict = true } = {}) {
    let best = null;
    for (const id of INTERFACE_IDS) {
      if (id === exclude || !links[id].up) continue;
      if (strict && !this._validated(id, links, t)) continue;
      if (!strict && !(scores[id].critical > 0)) continue;
      if (!best || scores[id].critical > scores[best].critical) best = id;
    }
    return best;
  }

  /** Which sleeping modem to wake: best estimated score, keeping the current target unless clearly beaten. */
  _wakeCandidate(scores, links, t) {
    const best = this._bestCandidate(scores, links, t, this.primary, { strict: false });
    const cur = this.warmTarget;
    if (cur && cur !== this.primary && links[cur]?.up && scores[cur].critical > 0.8 * (scores[best]?.critical ?? 0)) return cur;
    return best;
  }

  // ── Explanations ───────────────────────────────────────────────────────
  _triggerReasons(pred) {
    const p = this.p;
    const out = [];
    if (!pred) return out;
    const tr = pred.triggers;
    if (tr.context) {
      out.push(`dock release: drone departing, wired carrier ends ${Number.isFinite(pred.dockDistM) ? `${pred.dockDistM.toFixed(0)} m ahead` : 'imminently'}`);
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
    const s = scores[id];
    const met = s?.metrics ?? {};
    return {
      link: id,
      name: name(id),
      label,
      score: s?.norm.critical ?? 0,
      loss: met.lossRate,
      rttMs: met.rttMs,
      throughputMbps: met.throughputMbps,
      estimated: !!s?.estimated,
      radio: this.radio[id]?.state ?? null,
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
    if (c.BULK) parts.push(protecting ? 'bulk not replicated, moved with delay-compensated pacing' : 'bulk not replicated');
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

  _probeText(id, scores, t) {
    const R = this.radio[id];
    const met = scores[id]?.metrics;
    if (!met || scores[id].estimated || R.readyAt === null) return '';
    return ` ${name(id)} warm-probed for ${(t - R.readyAt).toFixed(1)} s (RTT ${met.rttMs.toFixed(0)} ms, loss ${pct(met.lossRate)})`;
  }

  // ── Radio power plan ───────────────────────────────────────────────────
  /** Decide which secondary (if any) is awake: DRX ↔ WAKING → WARM. */
  _radioPlan(t, links, pred, scores, events) {
    const P = POWER_PARAMS;
    const reasons = [];
    if (this.primary) {
      if (this.state === 'REPLICATING') reasons.push('handoff burst');
      if (this.watching) reasons.push('degradation predicted');
      if (pred && pred.dLoss > P.lossDeltaWake) reasons.push(`primary loss rose ${pct(pred.dLoss)} in 1 s (> ${pct(P.lossDeltaWake)})`);
      const h = scores[this.primary]?.health;
      if (INTERFACE_SPECS[this.primary].tech !== 'wired' && !scores[this.primary]?.estimated && h <= P.healthWakeScore) {
        reasons.push(`primary health ${h.toFixed(0)} ≤ ${P.healthWakeScore}`);
      }
      if (this.upgradeProbe) reasons.push(`${name(this.upgradeProbe)} estimated much better (DRX signal)`);
    }

    let target = null;
    if (reasons.length) {
      this.warmLastReasonT = t;
      target = this.state === 'REPLICATING' ? this.replica : (this.upgradeProbe ?? this._wakeCandidate(scores, links, t));
    } else if (this.warmTarget && t - this.warmLastReasonT < P.warmReleaseS) {
      target = this.warmTarget; // dwell before going back to sleep
    }
    if (target === this.primary) target = null;

    if (target !== this.warmTarget) {
      const old = this.warmTarget;
      if (old && old !== this.primary && links[old]?.up && INTERFACE_SPECS[old].tech !== 'wired') {
        const was = this.radio[old].state;
        this.radio[old].state = 'DRX';
        this.radio[old].readyAt = null;
        if (was === 'WARM' || was === 'WAKING') {
          events.push({ level: 'info', code: 'SLEEP', message: `${old} modem back to DRX sleep — ${target ? `${target} woken instead` : 'no wake reason for 2 s'} · system ${target ? W[1] : W[0]} W` });
        }
      }
      if (target && INTERFACE_SPECS[target].tech !== 'wired') {
        const R = this.radio[target];
        if (!AWAKE.has(R.state) && R.state !== 'WAKING') {
          R.state = 'WAKING';
          R.readyAt = t + P.wakeLatencyS;
          events.push({
            level: 'info',
            code: 'WAKE',
            message: `${target} modem woken from DRX → Warm Probe (${W[1]} W): 64-byte heartbeats every ${P.heartbeatIntervalS * 1000} ms · ${reasons[0] ?? 'dwell'}`,
          });
        }
      }
      this.warmTarget = target;
    }
    this.warmReason = reasons[0] ?? (this.warmTarget ? 'cooling down' : null);

    // WAKING → WARM once the modem has resumed: probes start, measurements are fresh.
    for (const id of INTERFACE_IDS) {
      const R = this.radio[id];
      if (R.state === 'WAKING' && t >= R.readyAt - 1e-9) {
        R.state = 'WARM';
        R.readyAt = t;
        this.monitors[id] = this._newMonitor();
      }
    }
  }

  /** Per-interface radio state for this tick (drives power, beams and the interface badges). */
  _radioStates(links) {
    const out = {};
    for (const id of INTERFACE_IDS) {
      const R = this.radio[id];
      const wired = INTERFACE_SPECS[id].tech === 'wired';
      let s;
      if (!links[id].up) s = 'OFF';
      else if (this.state === 'REPLICATING' && (id === this.primary || id === this.replica)) s = 'BURST';
      else if (id === this.primary) s = 'ACTIVE';
      else if (wired) s = 'IDLE';
      else if (id === this.warmTarget && (R.state === 'WAKING' || R.state === 'WARM')) s = R.state;
      else s = 'DRX';
      if (!wired) {
        if (s === 'OFF' || s === 'DRX') R.readyAt = null;
        R.state = s;
      }
      out[id] = s;
    }
    return out;
  }

  // ── REPLICATE: the handoff burst ───────────────────────────────────────
  _startBurst(candidate, t, reason, pred, scores, links, events, { emergency = false } = {}) {
    const p = this.p;
    this.state = 'REPLICATING';
    if (this.prepared !== candidate) this.preparedSince = t;
    this.prepared = candidate;
    this.replica = candidate;
    this.replStart = t;
    this.replReason = reason;
    this.emergency = emergency;
    this.upgradeTicks = 0;
    this.upgradeProbe = null;
    this.rtLatched = this.classes.REALTIME && reason !== 'UPGRADE' && this._realtimeNeedsCover(pred);
    const why = this._triggerReasons(pred);
    const classes = this._replicatedText();
    const windowMs = Math.round(p.burstWindowS * 1000);
    const probe = this._probeText(candidate, scores, t);
    const power = { ...POWER_HINT.BURST };
    if (reason === 'UPGRADE') {
      const ratio = scores[candidate].critical / Math.max(1e-9, scores[this.primary].critical);
      events.push({
        level: 'repl',
        code: 'UPGRADE',
        message: `Better path ${candidate} (${ratio.toFixed(1)}× critical score, warm-validated) → ${windowMs} ms make-before-break burst`,
      });
      this._record(t, 'UPGRADE', {
        headline: `Better path available: ${name(candidate)}`,
        current: this._linkView(this.primary, links, pred, ['Healthy', 'ok']),
        alternate: this._altView(candidate, scores, links, t, 'Better path'),
        traffic: this._trafficView(),
        action: `Burst-replicate critical traffic for ${windowMs} ms (${W[2]} W), then make ${name(candidate)} primary`,
        reason: `${name(candidate)} scores ${ratio.toFixed(1)}× the current path (upgrade ratio ${p.upgradeRatio}×) and sits ${scores[candidate].marginDb?.toFixed(0) ?? '—'} dB inside its coverage.${probe}`,
        power,
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
        headline: `${wiredPrimary ? 'Dock release detected' : `${name(this.primary)} degradation predicted`} · ${name(candidate)} ${emergency ? 'woken' : 'warm-validated'} · ${
          this._eligible ? `${this.classes.CRITICAL ? 'critical' : 'real-time'} flow protection enabled` : 'bulk moved to it (nothing to replicate)'
        }`,
        current: this._linkView(this.primary, links, pred),
        alternate: this._altView(candidate, scores, links, t, emergency ? 'Woken path (emergency)' : 'Prepared path'),
        traffic: this._trafficView(),
        action: this._eligible
          ? `Burst-replicate ${classes || 'no'} traffic on ${name(this.primary)} + ${name(candidate)} for the ${windowMs} ms handoff window (${W[2]} W), then make ${name(candidate)} primary`
          : `Move bulk traffic to ${name(candidate)} with delay-compensated pacing over ${windowMs} ms (no critical or real-time flows to replicate)`,
        reason: `${why.length ? `Predicted degradation exceeds threshold: ${why.join('; ')}` : 'Predicted score of the primary falls below the prepared path'}.${
          emergency ? ` Failure imminent: ${name(candidate)} used as soon as it woke (no time for full validation).` : probe
        }`,
        preparedLeadS: this.preparedSince !== null && this.prepared === candidate ? t - this.preparedSince : 0,
        power,
      });
    }
    if (this._eligible) {
      events.push({
        level: 'repl',
        code: 'REPL_ON',
        message: `BURST TX · dual-radio ${W[2]} W for ${windowMs} ms · ${classes || 'no'} traffic mirrored ${this.primary} ⇉ ${candidate}${this.classes.BULK ? ' · bulk paced, not replicated' : ''}`,
      });
    } else {
      events.push({
        level: 'info',
        code: 'DRAIN',
        message: `PROTECTION WINDOW · no critical / real-time traffic to replicate · bulk moved ${this.primary} → ${candidate} with delay-compensated pacing`,
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
    this.emergency = false;
    this.holdUntil = t + this.p.holdDownS;
    this.upgradeTicks = 0;
    this.upgradeProbe = null;
    this.handovers++;
    this.watching = false;
    this.watchSince = null;
    this.prepared = null;
    this.preparedSince = null;
    if (this.warmTarget === next) this.warmTarget = null;
    // The new primary carries traffic; the old radio sleeps unless a wake reason keeps a warm spare.
    if (INTERFACE_SPECS[next].tech !== 'wired') this.radio[next].state = 'ACTIVE';
    if (from && from !== next && INTERFACE_SPECS[from].tech !== 'wired' && this.radio[from].state !== 'OFF') {
      this.radio[from].state = 'DRX';
      this.radio[from].readyAt = null;
    }
    this.lastSwitch = { t, from, to: next, seamless, reason, replicationS, blackoutMs, preparedLeadS };
    if (record) this._record(t, seamless ? 'SWITCH' : 'FAILOVER', { ...record, preparedLeadS });
    if (seamless) {
      events.push({
        level: 'ok',
        code: 'HOT_SWAP',
        message: `HOT-SWAP ${from} → ${next} · ${reason}${replicationS ? ` · ${this._eligible ? 'burst' : 'protection window'} ${(replicationS * 1000).toFixed(0)} ms` : ''}`,
        from,
        to: next,
      });
      if (replicationS && this._eligible) {
        events.push({ level: 'info', code: 'REPL_OFF', message: `Burst over — ${next} carrying all flows · ${from} radio back to DRX sleep` });
      }
    } else {
      this.unplannedFailovers++;
      events.push({
        level: 'warn',
        code: 'FAILOVER',
        message: `UNPLANNED FAILOVER ${from} → ${next} · ${reason} · sessions kept on the anchor relay`,
        from,
        to: next,
      });
    }
  }

  /** Bulk goes only where a radio is transmitting anyway: the primary, plus the replica during a burst. */
  _bulkShares(scores, links, t) {
    const p = this.p;
    if (!this.primary) return {};
    if (this.state !== 'REPLICATING' || !this.replica || !links[this.replica]?.up) return { [this.primary]: 1 };
    // During the burst, bulk moves from the old primary to the replica within the window.
    const k = clamp((t - this.replStart + this.dt) / p.burstWindowS, 0, 1);
    const w = { [this.primary]: Math.max(0, 1 - k), [this.replica]: Math.max(1e-6, k) };
    if (w[this.primary] < p.bulkMinShare) return { [this.replica]: 1 };
    const sum = w[this.primary] + w[this.replica];
    return { [this.primary]: w[this.primary] / sum, [this.replica]: w[this.replica] / sum };
  }

  /** PREDICT / PREPARE bookkeeping while the primary is being watched. */
  _watch(t, pred, wakeCand, ready, scores, links, events) {
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
        const wakeName = wakeCand ? name(wakeCand) : null;
        this._record(t, 'PREDICT', {
          headline: wired ? 'Dock release detected: the wired link is about to end' : `${name(this.primary)} degradation predicted`,
          current: this._linkView(this.primary, links, pred),
          alternate: wakeCand ? this._altView(wakeCand, scores, links, t, 'Alternate (DRX estimate)') : null,
          traffic: this._trafficView(),
          action: wakeCand
            ? `${wakeName} modem primed to Warm Probe state (${W[1]} W): 64-byte heartbeats validate it; replicate critical traffic in a ${Math.round(p.burstWindowS * 1000)} ms burst if time-to-failure < ${p.ttfTriggerS.toFixed(1)} s`
            : 'Search for an alternate path',
          reason:
            pred.failLevel !== null && Number.isFinite(pred.projectedTtf)
              ? `3 s signal trend ${pred.signalSlopeLong.toFixed(1)} dB/s, ${pred.marginDb.toFixed(1)} dB above the 15 %-loss level (${pred.failLevel.toFixed(1)} ${sig.signalUnit}) → projected failure in ${secs(pred.projectedTtf)} s (< ${p.watchHorizonS.toFixed(0)} s horizon)`
              : pred.failLevel !== null && Number.isFinite(pred.ttf)
                ? `1 s signal trend ${pred.signalSlope.toFixed(1)} dB/s, ${pred.marginDb.toFixed(1)} dB above the 15 %-loss level → time-to-failure ${secs(pred.ttf)} s`
                : why.length
                  ? why.join('; ')
                  : 'Degradation trend on the primary',
          power: wakeCand ? { ...POWER_HINT.WARM } : { ...POWER_HINT.DRX },
        });
      }
    } else if (this.watching && t - this.watchLastSeen >= p.watchReleaseS - 1e-9 && this.state !== 'REPLICATING') {
      this.watching = false;
      this.watchSince = null;
      events.push({ level: 'info', code: 'TREND_OFF', message: `${this.primary} trend recovered — prediction released, no action needed` });
    }

    // PREPARE: the next path is the woken modem once its heartbeats have validated it.
    const want = this.state === 'REPLICATING' ? this.replica : this.watching ? ready : null;
    if (want !== this.prepared) {
      const changed = this.prepared && want;
      this.prepared = want;
      this.preparedSince = want ? t : null;
      if (want && this.state !== 'REPLICATING') {
        const met = scores[want].metrics;
        events.push({
          level: 'info',
          code: 'PREPARE',
          message: `${changed ? 'Next path changed →' : 'Next path validated:'} ${want} · WARM PROBE ${W[1]} W · RTT ${met.rttMs.toFixed(0)} ms · loss ${pct(met.lossRate)} · score ${scores[want].norm.critical.toFixed(0)}`,
        });
        this._record(t, 'PREPARE', {
          headline: `${name(want)} validated as the next path`,
          current: this._linkView(this.primary, links, pred),
          alternate: this._altView(want, scores, links, t, 'Prepared path (warm)'),
          traffic: this._trafficView(),
          action: `Keep ${name(want)} in Warm Probe (${W[1]} W); burst-replicate critical traffic if time-to-failure < ${p.ttfTriggerS.toFixed(1)} s`,
          reason: `${name(want)} answered ${Math.round(POWER_PARAMS.warmValidateS / POWER_PARAMS.heartbeatIntervalS)}+ heartbeats: RTT ${met.rttMs.toFixed(0)} ms, loss ${pct(met.lossRate)} ≤ ${pct(p.candidateMaxLoss)}, best critical score of the awake paths`,
          power: { ...POWER_HINT.WARM },
        });
      }
    }
  }

  /**
   * One 100 ms control cycle.
   * @param {{t:number, links:Record<string,object>, ctx:object}} input
   */
  update({ t, links, ctx = {} }) {
    const p = this.p;
    const P = POWER_PARAMS;
    const events = [];
    this._tickRecords = [];
    let blackoutEvent = false;

    this._measure(links, t);
    const scores = {};
    for (const id of INTERFACE_IDS) scores[id] = this._score(id, links[id], t);

    // Initial attach (boot scan: every radio measured once, then all but the primary go to DRX).
    if (!this.primary) {
      const first = this._bestCandidate(scores, links, t, null, { strict: false });
      if (first) {
        this.primary = first;
        this.state = 'STEADY';
        if (INTERFACE_SPECS[first].tech !== 'wired') this.radio[first].state = 'ACTIVE';
        events.push({ level: 'info', code: 'ATTACH', message: `Primary path ${first} (critical score ${scores[first].norm.critical.toFixed(0)}) · other modems to DRX · ${W[0]} W` });
        this._record(t, 'ATTACH', {
          headline: `${name(first)} selected as primary path`,
          current: this._linkView(first, links, null),
          alternate: null,
          traffic: this._trafficView(),
          action: `Carry all flows on ${name(first)}; every other modem sleeps in DRX (${W[0]} W) and reports signal once per ${P.drxCycleS} s`,
          reason: `Highest critical score (${scores[first].norm.critical.toFixed(0)}) of the available links at the boot scan`,
          power: { ...POWER_HINT.DRX },
        });
      }
    }

    // Abrupt loss of the primary (e.g. cell outage): promote the replica, or fail over.
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
            reason: `${name(lost)} dropped during the burst while ${name(next)} was already carrying replicated traffic — the next path was ready before the failure`,
            power: { ...POWER_HINT.DRX },
          },
        });
      } else {
        const fb = this._bestCandidate(scores, links, t, lost, { strict: false });
        if (fb) {
          const asleep = INTERFACE_SPECS[fb].tech !== 'wired' && this.radio[fb].state !== 'WARM';
          const wakeMs = asleep ? P.wakeLatencyS * 1000 : 0;
          const total = p.failoverDetectMs + wakeMs;
          this.blackoutStartT = t;
          this.blackoutUntil = t + total / 1000;
          this.blackoutTotalMs = total;
          blackoutEvent = true;
          const detail = `detected in ${p.failoverDetectMs} ms (3 missed probes)${asleep ? ` + ${wakeMs} ms waking ${fb} from DRX` : ` · ${fb} was already warm`}`;
          this._switchTo(fb, t, detail, events, {
            seamless: false,
            from: lost,
            blackoutMs: total,
            record: {
              headline: `Unplanned failover to ${name(fb)}`,
              current: this._linkView(lost, links, null, ['Failure detected (abrupt)', 'crit']),
              alternate: this._altView(fb, scores, links, t, 'New primary'),
              traffic: { replicated: [], standby: [], notReplicated: ['BULK'], text: `In-flight packets of every class lost for ${total} ms` },
              action: `Fail over to ${name(fb)}: ${detail}`,
              reason: wasWatched
                ? `${name(lost)} dropped before protection was armed`
                : `${name(lost)} was lost abruptly with no degradation trend before it — not predictable. ${asleep ? `${name(fb)} was sleeping in DRX to save power, so the gap includes its ${wakeMs} ms wake-up.` : ''} Sessions stay on the anchor relay`,
              power: { ...POWER_HINT.DRX },
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
            action: 'Buffer at the anchor relay and attach as soon as any link returns',
            reason: 'Every interface is down',
            power: { ...POWER_HINT.DRX },
          });
        }
      }
    }

    const pred = this.primary ? this._predict(this.primary, ctx) : null;
    const wakeCand = this.primary ? this._wakeCandidate(scores, links, t) : null;
    let ready = this.primary ? this._bestCandidate(scores, links, t, this.primary, { strict: true }) : null;
    this._watch(t, pred, wakeCand, ready, scores, links, events);
    this._radioPlan(t, links, pred, scores, events);
    ready = this.primary ? this._bestCandidate(scores, links, t, this.primary, { strict: true }) : null;

    if (this.state === 'STEADY' && this.primary) {
      if (pred.degrading) {
        const beatsPrediction = ready && scores[ready].critical > pred.predictedCritical;
        if (ready && (beatsPrediction || pred.failureImminent)) {
          this._startBurst(ready, t, 'PREDICTED_DEGRADATION', pred, scores, links, events);
        } else if (!ready && pred.failureImminent && this.warmTarget && this.radio[this.warmTarget].state === 'WARM' && links[this.warmTarget].up) {
          // Failure is imminent and the woken modem has just resumed: use it without full validation.
          this._startBurst(this.warmTarget, t, 'PREDICTED_DEGRADATION', pred, scores, links, events, { emergency: true });
        }
        this.upgradeTicks = 0;
        this.upgradeProbe = null;
      } else if (t >= this.holdUntil && !this.watching) {
        // Upgrade: a sleeping link estimated (from its DRX signal) to be much better and well inside coverage.
        const cand = this._bestCandidate(scores, links, t, this.primary, { strict: false });
        const margin = cand ? scores[cand].marginDb : null;
        const better = cand && scores[cand].critical > p.upgradeRatio * scores[this.primary].critical;
        const deep = cand && (margin === null || margin >= p.upgradeMinMarginDb);
        if (better && deep) {
          this.upgradeTicks++;
          if (this.upgradeTicks * this.dt >= p.upgradeDwellS - 1e-9) this.upgradeProbe = cand;
        } else {
          this.upgradeTicks = 0;
          this.upgradeProbe = null;
        }
        const probe = this.upgradeProbe;
        if (probe && this._validated(probe, links, t) && scores[probe].critical > p.upgradeRatio * scores[this.primary].critical) {
          this._startBurst(probe, t, 'UPGRADE', pred, scores, links, events);
        }
      }
    } else if (this.state === 'REPLICATING') {
      if (!links[this.replica].up) {
        events.push({ level: 'warn', code: 'REPL_OFF', message: `Replica ${this.replica} lost during the burst — staying on ${this.primary}` });
        this.replica = null;
        this.state = 'STEADY';
        this.rtLatched = false;
      } else {
        // Traffic-aware: real-time traffic joins only once it actually needs cover.
        if (this.classes.REALTIME && !this.rtLatched && this.replReason !== 'UPGRADE' && this._realtimeNeedsCover(pred)) {
          this.rtLatched = true;
          const why =
            pred.loss > p.realtimeLossBudget
              ? `loss ${(pred.loss * 100).toFixed(2)}% > ${pct(p.realtimeLossBudget)} real-time budget`
              : Number.isFinite(pred.ttf)
                ? `failure in ${secs(pred.ttf)} s < ${p.realtimeTtfS.toFixed(1)} s`
                : 'path collapsing';
          events.push({ level: 'repl', code: 'REPL_RT', message: `Real-time traffic added to the burst — ${why}` });
          this._record(t, 'PROTECT_RT', {
            headline: 'Real-time traffic added to the burst',
            current: this._linkView(this.primary, links, pred),
            alternate: this._altView(this.replica, scores, links, t, 'Prepared path'),
            traffic: this._trafficView(),
            action: `Replicate real-time traffic on ${name(this.primary)} + ${name(this.replica)} as well`,
            reason: `${why.charAt(0).toUpperCase()}${why.slice(1)}`,
            power: { ...POWER_HINT.BURST },
          });
        }

        if (t - this.replStart >= p.burstWindowS - 1e-9) {
          const from = this.primary;
          const to = this.replica;
          const windowMs = Math.round((t - this.replStart) * 1000);
          const leadText = this.preparedSince !== null ? `; ${name(to)} had been validated ${(t - this.preparedSince).toFixed(1)} s earlier` : '';
          const tf = pred && Number.isFinite(pred.ttf) ? ` ${name(from)} was ${secs(pred.ttf)} s from its predicted failure.` : '';
          this._switchTo(to, t, `handoff burst complete (${windowMs} ms)`, events, {
            record: {
              headline: `Switched primary path to ${name(to)}`,
              current: this._linkView(from, links, pred, pred?.failureImminent ? ['Failure imminent', 'crit'] : ['Degrading', 'warn']),
              alternate: this._altView(to, scores, links, t, 'Prepared path → new primary'),
              traffic: { replicated: [], standby: [], notReplicated: ['BULK'], text: 'Burst ends · all flows continue on the new primary' },
              action: `Make ${name(to)} primary; ${name(from)} radio back to DRX sleep (system ${W[0]} W unless a spare is kept warm)`,
              reason: `${windowMs} ms dual-radio burst complete before ${name(from)} failed${leadText}.${tf} Tunnel rebinds to ${name(to)}'s address; remote services keep seeing the anchor relay`,
              power: { ...POWER_HINT.DRX },
            },
          });
        }
      }
    }

    // Per-tick share of an ongoing failover gap.
    const blackoutMs = Math.max(0, Math.min(this.dt, this.blackoutUntil - t)) * 1000;
    const radio = this._radioStates(links);
    const bulkShares = this._bulkShares(scores, links, t);
    const criticalPaths = this.primary ? (this.replica ? [this.primary, this.replica] : [this.primary]) : [];
    const protecting = this.state === 'REPLICATING';
    const replicate = {
      CRITICAL: protecting && this.classes.CRITICAL,
      REALTIME: protecting && this.classes.REALTIME && this.rtLatched,
      BULK: false,
    };
    const replicating = replicate.CRITICAL || replicate.REALTIME;
    const backup = this.replica ?? this.prepared ?? this.warmTarget ?? wakeCand ?? null;

    this.lastDecision = {
      engine: 'flexipath',
      state: this.state,
      primary: this.primary,
      replica: this.replica,
      protecting,
      replicationActive: replicating,
      replicationReason: this.replReason,
      replicationElapsed: protecting ? t - this.replStart : 0,
      burstWindowS: p.burstWindowS,
      emergency: this.emergency,
      replicate,
      classes: this.classes,
      criticalPaths,
      bulkShares,
      backup,
      watching: this.watching,
      watchSince: this.watchSince,
      prepared: this.prepared,
      preparedSince: this.preparedSince,
      radio,
      pacing: true, // bulk spanning two paths during a burst is sent with delay-compensated pacing
      warmTarget: this.warmTarget,
      warmReason: this.warmReason,
      health: this.primary ? scores[this.primary]?.health ?? null : null,
      blackoutMs,
      blackoutEvent,
      blackoutTotalMs: blackoutEvent ? this.blackoutTotalMs : 0,
      stalled: !this.primary,
      stall: null,
      scores,
      // The prediction always describes the primary of this decision (re-evaluated after a switch this tick).
      prediction: pred && pred.link !== this.primary ? (this.primary ? this._predict(this.primary, ctx, { peek: true }) : null) : pred,
      lastSwitch: this.lastSwitch,
      records: this._tickRecords,
      lastRecord: this.lastRecord,
      events,
    };
    return this.lastDecision;
  }
}
