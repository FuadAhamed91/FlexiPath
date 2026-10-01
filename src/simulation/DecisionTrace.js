/**
 * DecisionTrace.js — turns controller state into the visible decision loop.
 *
 *   FlexiPath  DETECT → PREDICT → PREPARE → REPLICATE → SWITCH → CONTINUE
 *   Legacy     CONNECTED → DEGRADING → FAILED → INTERRUPTED → STOPPING → RECOVERED
 *
 * One "episode" per transition. Stage times come from real controller state and events; nothing is
 * scripted. The *failure* of the path being left is taken from the true link state — an EWMA of the true
 * loss above the 15 % switch level, or the link going down — computed identically for both engines, so
 * "acted before / after the failure" is measured the same way for both.
 */
import { INTERFACE_IDS, INTERFACE_SPECS, SWITCH_LOSS } from './LinkModel.js';
import { POWER_PARAMS } from './PowerModel.js';
import { EWMA } from '../utils/Metrics.js';

export const LOOP_STAGES = ['DETECT', 'PREDICT', 'PREPARE', 'REPLICATE', 'SWITCH', 'CONTINUE'];
export const LEGACY_STAGES = ['CONNECTED', 'DEGRADING', 'FAILED', 'INTERRUPTED', 'STOPPING', 'RECOVERED'];

export const TRACE_PARAMS = {
  switchHoldS: 1.0, // SWITCH stays the active stage for 1 s after the switch tick
  continueHoldS: 4.0, // an episode closes 4 s after its switch (or recovery)
  degradeLoss: 0.05, // "degrading" marker: EWMA of true loss above 5 %
  failLoss: SWITCH_LOSS, // "failed": EWMA of true loss above 15 % (or link down)
  lossAlpha: 0.3,
  failureWatchS: 12, // keep watching a path FlexiPath left early, so its later failure is still measured
};

/** EWMA of the *true* per-link loss (ground truth the controllers never see). */
class TrueLinkState {
  constructor() {
    this.ewma = Object.fromEntries(INTERFACE_IDS.map((id) => [id, new EWMA(TRACE_PARAMS.lossAlpha)]));
    this.up = {};
  }

  update(links) {
    for (const id of INTERFACE_IDS) {
      const L = links[id];
      if (!L?.up) {
        this.ewma[id].reset(null);
        this.up[id] = false;
      } else {
        this.ewma[id].update(L.lossRate);
        this.up[id] = true;
      }
    }
  }

  loss(id) {
    return this.up[id] ? (this.ewma[id].value ?? 0) : 1;
  }

  failed(id) {
    return !!id && (!this.up[id] || this.loss(id) > TRACE_PARAMS.failLoss);
  }

  degrading(id) {
    return !!id && (!this.up[id] || this.loss(id) > TRACE_PARAMS.degradeLoss);
  }
}

const byCode = (events) => {
  const out = {};
  for (const e of events) out[e.code] ??= e;
  return out;
};

const nm = (id) => (id ? INTERFACE_SPECS[id]?.name ?? id : '—');
const secs = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1));

const copyEpisode = (ep) => (ep ? { ...ep, stages: { ...ep.stages }, notes: { ...ep.notes }, skipped: { ...ep.skipped } } : null);

// ── FlexiPath ──────────────────────────────────────────────────────────────
export class FlexiPathTrace {
  constructor() {
    this.truth = new TrueLinkState();
    this.episode = null;
    this.last = null;
    this.history = [];
    this.pending = [];
    this.count = 0;
  }

  _open(t, kind, from, marks) {
    this.count++;
    this.episode = {
      id: this.count,
      kind, // predicted | dock | upgrade | abrupt
      from,
      to: null,
      start: t,
      stages: { DETECT: t, PREDICT: null, PREPARE: null, REPLICATE: null, SWITCH: null, CONTINUE: null },
      notes: {},
      skipped: {},
      failureT: null,
      switchKind: null,
      actionT: null,
      blackoutMs: 0,
      windows: 0,
      status: 'active',
      lostCritical: 0,
      lostRealtime: 0,
      replicatedBytes: 0,
      interruptionS: 0,
      marks,
    };
    return this.episode;
  }

  _close(status, t) {
    const ep = this.episode;
    ep.status = status;
    ep.end = t;
    this.last = ep;
    this.history.push(ep);
    if (this.history.length > 60) this.history.shift();
    // FlexiPath often switches seconds before the old path fails: keep watching it for a while.
    if (ep.failureT === null && ep.kind !== 'upgrade' && ep.stages.SWITCH !== null) this.pending.push(ep);
    this.episode = null;
  }

  update({ t, decision: d, events, links, totals, stats, before }) {
    this.truth.update(links);
    const ev = byCode(events);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const pe = this.pending[i];
      if (this.truth.failed(pe.from)) {
        pe.failureT = t;
        this.pending.splice(i, 1);
      } else if (t - pe.stages.SWITCH > TRACE_PARAMS.failureWatchS) this.pending.splice(i, 1);
    }
    const marks = before ?? {
      critical: totals.criticalLost,
      realtime: totals.realtimeLost,
      dup: totals.duplicateBytes,
      stall: stats.stallTime,
    };

    let ep = this.episode;
    // A new degradation (or failover / upgrade) during the CONTINUE hold starts a new episode.
    if (ep && ep.stages.SWITCH !== null) {
      const fresh = ev.PREDICT || ev.REPL_ON || ev.DRAIN || ev.UPGRADE || ev.FAILOVER || (d.watching && d.watchSince > ep.stages.SWITCH);
      if (fresh) {
        this._close('complete', t);
        ep = null;
      }
    }
    if (!ep) {
      if (ev.FAILOVER) {
        ep = this._open(t, 'abrupt', ev.FAILOVER.from, marks);
        ep.skipped.PREDICT = 'Abrupt failure: no degradation trend preceded it';
        ep.skipped.PREPARE = 'No warning, so nothing could be prepared';
        ep.skipped.REPLICATE = 'Nothing to replicate onto in time';
      } else if (ev.UPGRADE) {
        ep = this._open(t, 'upgrade', d.primary, marks);
        ep.skipped.PREDICT = 'No degradation: a better path became available';
      } else if (d.watching || ev.REPL_ON || ev.DRAIN || ev.PREDICT) {
        ep = this._open(d.watchSince ?? t, d.primary === 'eth0' ? 'dock' : 'predicted', d.primary, marks);
      }
    }
    if (!ep) return;

    const S = ep.stages;
    const pred = d.prediction;
    if ((ep.kind === 'predicted' || ep.kind === 'dock') && S.PREDICT === null) {
      S.PREDICT = d.watchSince ?? t;
      if (pred) {
        const proj = Number.isFinite(pred.projectedTtf) ? pred.projectedTtf : pred.ttf;
        if (pred.triggers?.context) ep.notes.PREDICT = `${nm(ep.from)} ends at dock release`;
        else if (pred.triggers?.rapidFade) ep.notes.PREDICT = `${nm(ep.from)} collapsing ${pred.signalSlope.toFixed(0)} dB/s`;
        else ep.notes.PREDICT = Number.isFinite(proj) ? `${nm(ep.from)} failure in ≈ ${secs(proj)} s` : `${nm(ep.from)} degrading`;
      }
    }
    if (S.PREPARE === null && ep.kind !== 'abrupt' && d.prepared) {
      S.PREPARE = Math.max(S.PREDICT ?? ep.start, d.preparedSince ?? t);
      ep.to = d.prepared;
      ep.emergency = !!d.emergency;
      const sc = d.scores?.[d.prepared]?.norm.critical;
      ep.notes.PREPARE = d.emergency
        ? `${nm(d.prepared)} woken · used before full validation (failure imminent)`
        : `${nm(d.prepared)} warm-validated${Number.isFinite(sc) ? ` · score ${sc.toFixed(0)}` : ''}`;
    }
    if (ev.REPL_ON) {
      ep.windows++;
      S.REPLICATE = t;
      ep.actionT ??= t;
      ep.to = d.replica;
      ep.stoodDown = null;
    }
    if (ev.DRAIN) {
      ep.windows++;
      ep.actionT ??= t;
      ep.to = d.replica;
      ep.skipped.REPLICATE = 'No critical or real-time flows: nothing to replicate. Bulk moved to the prepared path with delay-compensated pacing instead';
      ep.notes.REPLICATE = `bulk paced ⇢ ${nm(d.replica)}`;
    }
    if (d.replicationActive) {
      const cls = d.replicate?.REALTIME ? 'critical + real-time' : 'critical';
      ep.notes.REPLICATE = `${cls} ⇉ ${nm(d.replica)} · ${Math.round((d.burstWindowS ?? POWER_PARAMS.burstWindowS) * 1000)} ms burst`;
      ep.to = d.replica;
    }
    if (ev.REPL_ABORT) {
      ep.stoodDown = t;
      ep.notes.REPLICATE = `stood down after ${(t - (S.REPLICATE ?? ep.actionT ?? t)).toFixed(1)} s · primary recovered`;
    }
    const sw = ev.HOT_SWAP ?? ev.FAILOVER;
    if (sw && S.SWITCH === null) {
      S.SWITCH = t;
      ep.actionT ??= t;
      ep.from = sw.from ?? ep.from;
      ep.to = sw.to ?? d.primary;
      ep.switchKind = ev.HOT_SWAP ? 'seamless' : 'failover';
      ep.blackoutMs = d.blackoutTotalMs || d.blackoutMs || 0; // the whole gap (detection + any DRX wake)
      ep.notes.SWITCH = `${nm(ep.from)} → ${nm(ep.to)}${ep.switchKind === 'failover' ? ` · ${ep.blackoutMs} ms gap` : ' · 0 ms gap'}`;
    }
    if (S.SWITCH !== null && S.CONTINUE === null && t > S.SWITCH + 1e-9) S.CONTINUE = t;

    // Running outcome of the episode (measured).
    ep.lostCritical = totals.criticalLost - ep.marks.critical;
    ep.lostRealtime = totals.realtimeLost - ep.marks.realtime;
    ep.replicatedBytes = totals.duplicateBytes - ep.marks.dup;
    ep.interruptionS = stats.stallTime - ep.marks.stall;
    if (S.CONTINUE !== null) {
      ep.notes.CONTINUE = `${ep.interruptionS.toFixed(2)} s interruption · ${ep.lostCritical + ep.lostRealtime} pkts lost`;
    }
    if (ep.failureT === null && ep.kind !== 'upgrade' && this.truth.failed(ep.from)) ep.failureT = t;

    if (ev.NO_PATH) this._close('no-path', t);
    else if (ev.TREND_OFF && S.SWITCH === null) this._close(ep.windows ? 'stood-down' : 'trend-reversed', t);
    else if (S.SWITCH !== null && t - S.SWITCH >= TRACE_PARAMS.continueHoldS - 1e-9) this._close('complete', t);
  }

  /** Active loop stage, derived from the controller state and the open episode. */
  stage(t, d) {
    const ep = this.episode;
    if (!ep) return 'DETECT';
    const S = ep.stages;
    if (S.SWITCH !== null) return t - S.SWITCH < TRACE_PARAMS.switchHoldS ? 'SWITCH' : 'CONTINUE';
    if (d?.replicationActive) return 'REPLICATE';
    if (d?.prepared) return 'PREPARE';
    if (S.PREDICT !== null) return 'PREDICT';
    return 'DETECT';
  }

  view(t, d) {
    return {
      stage: this.stage(t, d),
      episode: copyEpisode(this.episode),
      last: copyEpisode(this.last),
      count: this.count,
      counts: this.counts(),
    };
  }

  /** Measured action time relative to the true failure of the path being left (negative = before). */
  actionVsFailure() {
    const out = [];
    for (const ep of [...this.history, ...(this.episode ? [this.episode] : [])]) {
      if (ep.failureT === null) continue;
      const action = ep.actionT ?? ep.stages.REPLICATE ?? ep.stages.SWITCH;
      if (action === null || action === undefined) continue;
      out.push(action - ep.failureT);
    }
    return out;
  }

  counts() {
    const all = [...this.history, ...(this.episode ? [this.episode] : [])];
    return {
      episodes: all.length,
      pathFailures: all.filter((e) => e.failureT !== null).length,
      predictedFailures: all.filter((e) => e.kind !== 'abrupt' && e.failureT !== null && (e.actionT ?? Infinity) < e.failureT).length,
      abruptFailures: all.filter((e) => e.kind === 'abrupt').length,
      falseAlarms: all.filter((e) => e.status === 'stood-down' && e.failureT === null).length,
    };
  }
}

// ── Legacy ─────────────────────────────────────────────────────────────────
export class LegacyTrace {
  constructor() {
    this.truth = new TrueLinkState();
    this.episode = null;
    this.last = null;
    this.history = [];
    this.count = 0;
    this.serving = null;
    this.degradingT = null;
    this.failedT = null;
  }

  update({ t, decision: d, events, links, stats, before }) {
    this.truth.update(links);
    const ev = byCode(events);

    // Pre-failure markers on the link the legacy stack is (stubbornly) using.
    const prev = { serving: this.serving, degradingT: this.degradingT, failedT: this.failedT };
    if (d.primary !== this.serving) {
      this.serving = d.primary;
      this.degradingT = null;
      this.failedT = null;
    }
    if (this.serving) {
      if (this.degradingT === null && this.truth.degrading(this.serving)) this.degradingT = t;
      if (this.failedT === null && this.truth.failed(this.serving)) this.failedT = t;
      // Hysteresis: the marker clears only once the true loss is back below half the degrading level.
      if (this.failedT === null && this.truth.loss(this.serving) < TRACE_PARAMS.degradeLoss / 2) this.degradingT = null;
    }

    if (ev.LINK_LOST) {
      if (this.episode) this._close('superseded', t);
      this.count++;
      const reselect = d.stall?.kind === 'reselect';
      const linkDown = !links[ev.LINK_LOST.from]?.up;
      const same = prev.serving === ev.LINK_LOST.from;
      const degradingT = same ? prev.degradingT : null;
      const failedT = same ? prev.failedT : null;
      this.episode = {
        id: this.count,
        kind: d.stall?.kind ?? 'wireless',
        from: ev.LINK_LOST.from,
        to: ev.LINK_LOST.to,
        start: t,
        stages: {
          CONNECTED: null,
          DEGRADING: reselect ? null : degradingT,
          FAILED: reselect ? null : (failedT ?? (linkDown ? t : null)),
          INTERRUPTED: t,
          STOPPING: null,
          RECOVERED: null,
        },
        notes: { INTERRUPTED: ev.LINK_LOST.message.replace(/ → break-before-make.*$/, '') },
        skipped: reselect ? { FAILED: 'Voluntary switch-back to a preferred interface (no failure)' } : {},
        stallTotal: d.stall?.total ?? null,
        interruptionS: 0,
        status: 'active',
        stallMark: before ? before.stall : stats.stallTime,
      };
    }

    const ep = this.episode;
    if (!ep) return;
    const S = ep.stages;
    if (ev.FAILSAFE) S.STOPPING = t;
    if (ev.RETRY && d.stall) ep.to = d.stall.to;
    if (S.FAILED === null && !ep.skipped.FAILED && this.truth.failed(ep.from)) S.FAILED = t;
    if (S.RECOVERED === null) ep.interruptionS = stats.stallTime - ep.stallMark;
    if (ev.RECONNECTED) {
      S.RECOVERED = t;
      ep.to = ev.RECONNECTED.to;
      ep.notes.RECOVERED = `on ${nm(ep.to)} after ${ep.interruptionS.toFixed(1)} s`;
    }
    if (S.RECOVERED !== null && t - S.RECOVERED >= TRACE_PARAMS.continueHoldS - 1e-9) this._close('complete', t);
  }

  _close(status, t) {
    const ep = this.episode;
    ep.status = status;
    ep.end = t;
    this.last = ep;
    this.history.push(ep);
    if (this.history.length > 60) this.history.shift();
    this.episode = null;
  }

  stage() {
    const ep = this.episode;
    if (ep) {
      if (ep.stages.RECOVERED !== null) return 'RECOVERED';
      if (ep.stages.STOPPING !== null) return 'STOPPING';
      return 'INTERRUPTED';
    }
    if (this.serving && this.failedT !== null) return 'FAILED';
    if (this.serving && this.degradingT !== null) return 'DEGRADING';
    return 'CONNECTED';
  }

  view() {
    return {
      stage: this.stage(),
      serving: this.serving,
      degradingT: this.degradingT,
      failedT: this.failedT,
      servingLoss: this.serving ? this.truth.loss(this.serving) : null,
      episode: copyEpisode(this.episode),
      last: copyEpisode(this.last),
      count: this.count,
      counts: this.counts(),
    };
  }

  /** Measured reaction time after the true failure of the path (positive = after). */
  actionVsFailure() {
    const out = [];
    for (const ep of [...this.history, ...(this.episode ? [this.episode] : [])]) {
      if (ep.stages.FAILED === null) continue;
      out.push(ep.stages.INTERRUPTED - ep.stages.FAILED);
    }
    return out;
  }

  counts() {
    const all = [...this.history, ...(this.episode ? [this.episode] : [])];
    return {
      episodes: all.length,
      pathFailures: all.filter((e) => e.stages.FAILED !== null).length,
      predictedFailures: 0,
      abruptFailures: 0,
      falseAlarms: 0,
    };
  }
}
