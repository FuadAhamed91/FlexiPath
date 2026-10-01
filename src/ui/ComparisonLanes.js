/**
 * ComparisonLanes.js — LEGACY vs FLEXIPATH: same route, same seed, same RF conditions.
 *
 * Two lanes built from the decision traces of both engines. Each step lights up when that engine
 * actually reached it; times are shown as T+ and, once the path's true failure instant is known,
 * relative to it (negative = before the path failed). Interruptions are labelled SIMULATED.
 */
import { fmtRel, fmtT, linkName, makeSetter } from './format.js';
import { METERS_PER_UNIT } from '../simulation/MobilityModel.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';

const BURST = `${Math.round(POWER_PARAMS.burstWindowS * 1000)} ms · ${POWER_PARAMS.tierWatts[2]} W`;

const C = {
  predict: '#facc15',
  prepare: '#60a5fa',
  repl: '#a855f7',
  fail: '#ef4444',
  switch: '#e2e8f0',
  ok: '#22c55e',
  degrade: '#facc15',
  neutral: '#94a3b8',
};

const at = (t, ref) => {
  if (t === null || t === undefined) return '';
  const rel = Number.isFinite(ref) ? ` <span class="rel">${fmtRel(t - ref)}</span>` : '';
  return `${fmtT(t)}${rel}`;
};

export class ComparisonLanes {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 pt-2.5 pb-2">
        <div class="flex min-w-0 items-baseline gap-2.5">
          <h2 class="hud-title text-slate-200!">Legacy vs FlexiPath</h2>
          <span class="truncate font-mono text-[9.5px] text-slate-500">same route · same seed · same RF conditions · times vs. the moment the path actually failed</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="kpi-cell flex items-baseline gap-3">
            <span class="sim-int">SIMULATED INTERRUPTION</span>
            <span class="text-[10px] font-bold tracking-[0.14em] text-fp">FP <b class="v" data-ref="fpInt">0.00</b> s</span>
            <span class="text-[10px] font-bold tracking-[0.14em] text-legacy">LG <b class="v" data-ref="lgInt">0.00</b> s</span>
          </div>
          <div class="kpi-cell flex items-baseline gap-3" title="Critical packets lost (all runs of this scenario so far)">
            <span class="hud-label">Critical pkts lost</span>
            <span class="num text-[12px] font-bold text-fp" data-ref="fpLost">0</span>
            <span class="num text-[12px] font-bold text-legacy" data-ref="lgLost">0</span>
          </div>
          <div class="kpi-cell flex items-baseline gap-3" title="Path failures the engine acted on before the path failed (measured against the true link state)">
            <span class="hud-label">Acted before failure</span>
            <span class="num text-[12px] font-bold text-fp" data-ref="fpPred">0/0</span>
            <span class="num text-[12px] font-bold text-legacy" data-ref="lgPred">0/0</span>
          </div>
          <div class="kpi-cell flex items-baseline gap-3" title="Mean radio power so far. Tier draws (1.2 / 1.8 / 3.4 W) are model parameters; the mean is measured from the run">
            <span class="hud-label">Radio W</span>
            <span class="num text-[12px] font-bold text-fp" data-ref="fpPw">—</span>
            <span class="num text-[12px] font-bold text-legacy" data-ref="lgPw">—</span>
          </div>
          <div class="kpi-cell flex items-baseline gap-2" title="Distance between the two vehicles along the route (lost to interruptions and fail-safe stops)">
            <span class="hud-label">Gap</span>
            <span class="num text-[12px] font-bold text-slate-200" data-ref="gap">level</span>
          </div>
        </div>
      </div>
      <div class="flex flex-col gap-2 px-3 pb-3">
        <div class="lane" style="--lc:#00F0FF">
          <div class="lane-head"><span class="who">FLEXIPATH</span><span class="what" data-ref="fpWhat">monitoring</span></div>
          <div class="lane-steps" data-ref="fpSteps"></div>
        </div>
        <div class="lane" style="--lc:#F43F5E">
          <div class="lane-head"><span class="who">LEGACY OS</span><span class="what" data-ref="lgWhat">connected</span></div>
          <div class="lane-steps" data-ref="lgSteps"></div>
        </div>
      </div>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.set = makeSetter();
  }

  _render(el, key, steps) {
    const html = steps
      .map(
        (s) =>
          `<div class="lane-step${s.alarm ? ' is-alarm' : ''}" data-state="${s.state}" style="--sc:${s.color}" title="${s.title ?? ''}"><div class="t1">${s.t1}</div><div class="t2">${s.t2 ?? ''}</div></div>`,
      )
      .join('');
    this.set.html(el, key, html);
  }

  _fpSteps(snapshot) {
    const tr = snapshot.agents.flexipath.trace;
    const ep = tr.episode ?? tr.last;
    const now = snapshot.t;
    if (!ep) {
      const prim = snapshot.agents.flexipath.decision?.primary;
      return {
        what: prim ? `on ${linkName(prim)} · monitoring` : 'no path',
        steps: ['Degradation predicted', 'Next path warm-validated', 'Burst replication', 'Path failed', 'Next path primary', 'Vehicle continues'].map((t1) => ({ t1, t2: 'waiting', state: '', color: C.neutral })),
      };
    }
    const S = ep.stages;
    const ref = ep.failureT;
    const live = ep === tr.episode;
    const from = linkName(ep.from);
    const to = ep.to ? linkName(ep.to) : 'next path';
    const steps = [];
    const push = (t1, t, color, extra = {}) => steps.push({ t1, t2: extra.t2 ?? at(t, ref), t, color, ...extra });

    if (ep.skipped.PREDICT) push('Not predictable', null, C.neutral, { skip: true, t2: ep.kind === 'abrupt' ? 'abrupt outage, no trend before it' : 'no degradation (better path)' });
    else push('Degradation predicted', S.PREDICT, C.predict);
    if (ep.skipped.PREPARE) push('No time to prepare', null, C.neutral, { skip: true, t2: 'unplanned failover' });
    else push(ep.emergency ? `${to} woken (emergency)` : `${to} warm-validated`, S.PREPARE, C.prepare, ep.emergency && S.PREPARE !== null ? { t2: `${at(S.PREPARE, ref)} · failure imminent` } : {});
    if (ep.skipped.REPLICATE && S.REPLICATE === null) {
      push(ep.kind === 'abrupt' ? 'Nothing replicated' : 'Bulk paced', ep.kind === 'abrupt' ? null : ep.actionT, C.prepare, {
        skip: ep.kind === 'abrupt',
        t2: ep.kind === 'abrupt' ? 'no warning' : at(ep.actionT, ref),
      });
    } else push('Burst replication', S.REPLICATE, C.repl, { t2: S.REPLICATE !== null ? `${at(S.REPLICATE, ref)} · ${BURST}` : '' });
    if (ep.kind === 'upgrade') push('No failure', null, C.neutral, { skip: true, t2: 'voluntary upgrade' });
    else push(`${from} failed`, ep.failureT, C.fail, { alarm: true, t2: ep.failureT !== null ? at(ep.failureT, ref) : live ? 'not yet' : 'did not fail' });
    push(`${to} primary`, S.SWITCH, C.switch, {
      t2: S.SWITCH !== null ? `${at(S.SWITCH, ref)}${ep.switchKind === 'failover' ? ` · ${ep.blackoutMs} ms gap` : ' · 0 ms gap'}` : '',
    });
    push('Vehicle continues', S.CONTINUE, C.ok, {
      t2: S.CONTINUE !== null ? `${ep.interruptionS.toFixed(2)} s interruption · ${ep.lostCritical + ep.lostRealtime} pkts lost` : '',
    });

    // Order by time for the "now" marker; pending / skipped steps keep their slot.
    let latest = -1;
    steps.forEach((s, i) => {
      if (s.skip) s.state = 'skip';
      else if (s.t !== null && s.t !== undefined && s.t <= now + 1e-6) {
        s.state = 'done';
        if (latest < 0 || s.t >= steps[latest].t) latest = i;
      } else s.state = '';
    });
    if (live && latest >= 0) steps[latest].state = 'now';
    const kind = { predicted: 'predicted degradation', dock: 'dock release', upgrade: 'better path', abrupt: 'abrupt failure' }[ep.kind] ?? ep.kind;
    return { what: `${from} → ${to} · ${kind}${live ? '' : ' · done'}`, steps };
  }

  _lgSteps(snapshot) {
    const lg = snapshot.agents.legacy;
    const tr = lg.trace;
    const now = snapshot.t;
    const ep = tr.episode;
    const pre = !ep && tr.serving && (tr.degradingT !== null || tr.failedT !== null);
    const src = ep ?? (pre ? null : tr.last);
    const steps = [];
    let ref;
    let what;
    let live = false;

    if (pre) {
      // Still attached to a degrading / failed link: the legacy stack has not reacted yet.
      live = true;
      ref = tr.failedT;
      const name = linkName(tr.serving);
      what = `${name} · still attached`;
      steps.push({ t1: `${name} degrading`, t2: `${at(tr.degradingT, ref)} · no prediction`, t: tr.degradingT, color: C.degrade });
      steps.push({ t1: `${name} failed`, t2: tr.failedT !== null ? `${at(tr.failedT, ref)} · still on it` : 'not yet', t: tr.failedT, color: C.fail, alarm: true });
      steps.push({ t1: 'CONNECTION INTERRUPTED', t2: `waits for the ${name} floor`, t: null, color: C.fail, alarm: true });
      steps.push({ t1: 'Vehicle stopping', t2: '', t: null, color: C.fail });
      steps.push({ t1: 'Recovered', t2: '', t: null, color: C.switch });
    } else if (src) {
      live = src === ep;
      const S = src.stages;
      ref = S.FAILED;
      const from = linkName(src.from);
      const to = src.to ? linkName(src.to) : 'fallback';
      what = `${from} → ${to} · ${src.kind === 'reselect' ? 'switch-back' : 'break-before-make'}${live ? '' : ' · done'}`;
      if (src.kind === 'reselect') {
        steps.push({ t1: `${to} preferred again`, t2: 'static route metric', skip: true, color: C.neutral });
        steps.push({ t1: 'No failure', t2: 'voluntary switch-back', skip: true, color: C.neutral });
      } else {
        steps.push({ t1: `${from} degrading`, t2: S.DEGRADING !== null ? `${at(S.DEGRADING, ref)} · no prediction` : src.kind === 'wired' ? 'carrier only' : '—', t: S.DEGRADING, color: C.degrade, skip: S.DEGRADING === null && src.kind === 'wired' });
        steps.push({ t1: `${from} failed`, t2: at(S.FAILED, ref), t: S.FAILED, color: C.fail, alarm: true });
      }
      const intS = src.stallTotal ?? null;
      steps.push({
        t1: 'CONNECTION INTERRUPTED',
        t2: `${at(S.INTERRUPTED, ref)} · SIMULATED${intS ? ` ${intS.toFixed(1)} s` : ''}`,
        t: S.INTERRUPTED,
        color: C.fail,
        alarm: true,
        title: src.notes?.INTERRUPTED ?? '',
      });
      steps.push({ t1: 'Vehicle stopping', t2: S.STOPPING !== null ? `${at(S.STOPPING, ref)} · fail-safe` : live ? '' : 'no fail-safe stop', t: S.STOPPING, color: C.fail });
      steps.push({
        t1: `Recovered on ${to}`,
        t2: S.RECOVERED !== null ? `${at(S.RECOVERED, ref)} · after ${src.interruptionS.toFixed(1)} s` : live ? `${src.interruptionS.toFixed(1)} s so far` : '',
        t: S.RECOVERED,
        color: C.switch,
      });
    } else {
      const name = linkName(lg.decision?.primary);
      what = `on ${name} · connected`;
      for (const t1 of ['Path degrading', 'Path failed', 'CONNECTION INTERRUPTED', 'Vehicle stopping', 'Recovered']) steps.push({ t1, t2: 'waiting', t: null, color: C.neutral });
    }

    let latest = -1;
    steps.forEach((s, i) => {
      if (s.skip) s.state = 'skip';
      else if (s.t !== null && s.t !== undefined && s.t <= now + 1e-6) {
        s.state = 'done';
        if (latest < 0 || s.t >= steps[latest].t) latest = i;
      } else s.state = '';
    });
    if (live && latest >= 0) steps[latest].state = 'now';
    return { what, steps };
  }

  update(snapshot) {
    const fp = this._fpSteps(snapshot);
    const lg = this._lgSteps(snapshot);
    this.set.text(this.refs.fpWhat, 'fpWhat', fp.what);
    this.set.text(this.refs.lgWhat, 'lgWhat', lg.what);
    this._render(this.refs.fpSteps, 'fpSteps', fp.steps);
    this._render(this.refs.lgSteps, 'lgSteps', lg.steps);

    const A = snapshot.agents;
    this.set.text(this.refs.fpInt, 'fpInt', A.flexipath.stats.stallTime.toFixed(2));
    this.set.text(this.refs.lgInt, 'lgInt', A.legacy.stats.stallTime.toFixed(2));
    this.set.text(this.refs.fpLost, 'fpLost', A.flexipath.stats.criticalLost.toLocaleString('en-US'));
    this.set.text(this.refs.lgLost, 'lgLost', A.legacy.stats.criticalLost.toLocaleString('en-US'));
    this.set.text(this.refs.fpPw, 'fpPw', A.flexipath.power ? A.flexipath.power.meanWatts.toFixed(2) : '—');
    this.set.text(this.refs.lgPw, 'lgPw', A.legacy.power ? A.legacy.power.meanWatts.toFixed(2) : '—');
    const gapM = (A.flexipath.vehicle.s - A.legacy.vehicle.s) * METERS_PER_UNIT;
    this.set.text(this.refs.gap, 'gap', Math.abs(gapM) < 2 ? 'level' : `Legacy ${Math.abs(gapM).toFixed(0)} m ${gapM > 0 ? 'behind' : 'ahead'}`);
    const c = (a) => a.trace.counts ?? null;
    const fpc = c(A.flexipath);
    const lgc = c(A.legacy);
    if (fpc) this.set.text(this.refs.fpPred, 'fpPred', `${fpc.predictedFailures}/${fpc.pathFailures}`);
    if (lgc) this.set.text(this.refs.lgPred, 'lgPred', `${lgc.predictedFailures}/${lgc.pathFailures}`);
  }
}
