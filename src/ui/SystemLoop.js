/**
 * SystemLoop.js — the central DETECT → PREDICT → PREPARE → REPLICATE → SWITCH → CONTINUE strip.
 *
 * Driven only by the simulation: the active stage and the stage times come from the FlexiPath
 * decision trace (DecisionTrace.js) in the snapshot — when the controller actually reached each
 * stage in the current episode. Skipped stages (e.g. an abrupt, unpredictable outage) say so.
 * Captions include the radio power state (DRX standby / warm probe / burst) the stage runs at.
 */
import { LOOP_STAGES } from '../simulation/DecisionTrace.js';
import { INTERFACE_IDS } from '../simulation/LinkModel.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';
import { esc, fmtRel, fmtT, linkName, makeSetter } from './format.js';

const W = POWER_PARAMS.tierWatts;
const BURST_MS = Math.round(POWER_PARAMS.burstWindowS * 1000);

export const STAGE_META = {
  DETECT: { color: '#0891B2', question: `Measure the primary at 10 Hz · other modems in DRX (${W[0]} W)` },
  PREDICT: { color: '#B45309', question: 'Is the current path degrading?' },
  PREPARE: { color: '#2563EB', question: `Wake and validate the next path (warm probe, ${W[1]} W)` },
  REPLICATE: { color: '#7C3AED', question: `Burst-protect critical traffic for ${BURST_MS} ms (${W[2]} W)` },
  SWITCH: { color: '#334155', question: 'Make the prepared path primary' },
  CONTINUE: { color: '#15803D', question: 'Sessions continue via the anchor relay' },
};

const KIND_LABEL = {
  predicted: 'predicted degradation',
  dock: 'dock release',
  upgrade: 'better path available',
  abrupt: 'abrupt failure · not predictable',
};

const LEGACY_LABEL = {
  CONNECTED: ['connected', '#64748b'],
  DEGRADING: ['link degrading · no prediction', '#b45309'],
  FAILED: ['link failed · still attached', '#dc2626'],
  INTERRUPTED: ['SIMULATED INTERRUPTION', '#dc2626'],
  STOPPING: ['SIMULATED INTERRUPTION · fail-safe hover', '#dc2626'],
  RECOVERED: ['recovered', '#334155'],
};

const secs = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1));

export class SystemLoop {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="loop-head flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pb-2">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h2 class="hud-title text-slate-700!">FlexiPath decision loop</h2>
          <span class="min-w-0 font-mono text-[10px] text-slate-500" data-ref="ep">Monitoring</span>
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-[10px]">
          <span class="text-slate-500">LEGACY OS</span><span class="min-w-0" data-ref="legacy">—</span>
        </div>
      </div>
      <ol class="loop-stages" aria-label="Decision loop stages">
        ${LOOP_STAGES.map(
          (s, i) => `
          <li class="loop-stage" data-stage="${s}" data-state="idle" style="--sc:${STAGE_META[s].color}">
            <span class="idx">${String(i + 1).padStart(2, '0')}</span>
            <div class="body"><div class="name">${s}</div><div class="cap" data-cap>${esc(STAGE_META[s].question)}</div></div>
            <span class="time" data-time></span>
          </li>`,
        ).join('')}
      </ol>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.cells = {};
    for (const li of root.querySelectorAll('[data-stage]')) {
      this.cells[li.dataset.stage] = { el: li, cap: li.querySelector('[data-cap]'), time: li.querySelector('[data-time]'), cache: {} };
    }
    this.set = makeSetter();
  }

  _liveCaption(stage, fp, ep) {
    const d = fp.decision;
    const pred = d?.prediction;
    switch (stage) {
      case 'DETECT': {
        if (!d?.primary) return 'No usable link';
        const radio = d.radio ?? {};
        const drx = INTERFACE_IDS.filter((id) => radio[id] === 'DRX').length;
        const warm = d.warmTarget && (radio[d.warmTarget] === 'WARM' || radio[d.warmTarget] === 'WAKING') ? d.warmTarget : null;
        if (warm) return `${linkName(d.primary)} at 10 Hz · ${linkName(warm)} ${radio[warm] === 'WAKING' ? 'waking' : 'warm probe'} (${d.warmReason ?? 'dwell'})`;
        const standby = !d.protecting && fp.power?.tier === 0 ? ` · ${W[0]} W` : '';
        if (!drx) return `${linkName(d.primary)} measured at 10 Hz · no other link in coverage${standby}`;
        return `${linkName(d.primary)} measured at 10 Hz · ${drx} modem${drx === 1 ? '' : 's'} asleep in DRX${standby}`;
      }
      case 'PREDICT': {
        if (!pred) return ep?.notes.PREDICT ?? '';
        const proj = Number.isFinite(pred.projectedTtf) ? pred.projectedTtf : pred.ttf;
        if (pred.triggers?.context) return `${linkName(d.primary)} ends at dock release`;
        return Number.isFinite(proj) ? `${linkName(d.primary)} failure in ≈ ${secs(proj)} s` : `${linkName(d.primary)} degrading`;
      }
      case 'PREPARE': {
        const id = d?.prepared;
        if (!id) {
          const w = d?.warmTarget;
          const st = w ? d.radio?.[w] : null;
          if (st === 'WAKING') return `waking ${linkName(w)} from DRX…`;
          if (st === 'WARM') return `${linkName(w)} warm probe · validating · ${W[1]} W`;
          return 'no alternate ready yet';
        }
        const sc = d.scores?.[id]?.norm.critical;
        return `${linkName(id)} warm-validated${Number.isFinite(sc) ? ` · score ${sc.toFixed(0)}` : ''} · ${W[1]} W`;
      }
      case 'REPLICATE': {
        if (!d?.protecting) return ep?.notes.REPLICATE ?? '';
        const ms = `${Math.round(d.replicationElapsed * 1000)}/${Math.round((d.burstWindowS ?? POWER_PARAMS.burstWindowS) * 1000)} ms`;
        if (!d.replicationActive) return `bulk paced ⇢ ${linkName(d.replica)} · ${ms}`;
        const cls = d.replicate.REALTIME ? 'critical + real-time' : 'critical';
        return `BURST ${ms} · ${cls} ⇉ ${linkName(d.replica)} · ${W[2]} W`;
      }
      default:
        return ep?.notes[stage] ?? '';
    }
  }

  update(snapshot) {
    const fp = snapshot.agents.flexipath;
    const tr = fp.trace;
    const ep = tr.episode;
    const active = tr.stage;
    const activeIdx = LOOP_STAGES.indexOf(active);

    for (const [i, stage] of LOOP_STAGES.entries()) {
      const cell = this.cells[stage];
      let state = 'idle';
      let cap = STAGE_META[stage].question;
      let time = '';
      if (ep) {
        const t = ep.stages[stage];
        if (ep.skipped[stage] && t === null) {
          state = 'skipped';
          cap = ep.skipped[stage];
        } else if (stage === active) {
          state = 'active';
          cap = this._liveCaption(stage, fp, ep) || cap;
          if (t !== null) time = fmtT(t);
        } else if (t !== null && i < activeIdx) {
          state = 'reached';
          cap = ep.notes[stage] ?? this._liveCaption(stage, fp, ep) ?? cap;
          time = fmtT(t);
        }
      } else if (stage === 'DETECT') {
        state = 'active';
        cap = this._liveCaption(stage, fp, null);
      }
      const c = cell.cache;
      if (c.state !== state) {
        c.state = state;
        cell.el.dataset.state = state;
      }
      if (c.cap !== cap) {
        c.cap = cap;
        cell.cap.textContent = cap;
        cell.el.title = `${stage}: ${cap}`;
      }
      if (c.time !== time) {
        c.time = time;
        cell.time.textContent = time;
      }
    }

    // Episode summary (current or last).
    let epText;
    if (ep) {
      const to = ep.to ? linkName(ep.to) : '…';
      epText = `Episode ${ep.id} · ${linkName(ep.from)} → ${to} · ${KIND_LABEL[ep.kind] ?? ep.kind}`;
    } else if (tr.last) {
      const L = tr.last;
      const parts = [`Last: ${linkName(L.from)} → ${L.to ? linkName(L.to) : '—'}`];
      if (L.status === 'trend-reversed') parts.push('trend reversed, no action needed');
      else if (L.status === 'stood-down') parts.push('protection stood down, path recovered');
      else {
        const action = L.actionT;
        if (L.failureT !== null && action !== null && action !== undefined) parts.push(`acted ${fmtRel(action - L.failureT)} vs failure`);
        parts.push(`${L.interruptionS.toFixed(2)} s interruption`);
      }
      epText = parts.join(' · ');
    } else {
      epText = 'Monitoring · no degradation predicted yet';
    }
    this.set.text(this.refs.ep, 'ep', epText);

    // Legacy, at the same moment (no loop: it reacts after failure).
    const lg = snapshot.agents.legacy;
    const [label, color] = LEGACY_LABEL[lg.trace.stage] ?? ['—', '#64748b'];
    const serving = lg.decision?.primary ?? lg.decision?.stall?.from;
    const text = `${serving ? `${linkName(serving)} · ` : ''}${label}`;
    if (this.set.cache.lgText !== text) {
      this.set.text(this.refs.legacy, 'lgText', text);
      this.refs.legacy.style.color = color;
    }
  }
}
