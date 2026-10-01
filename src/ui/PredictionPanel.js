/**
 * PredictionPanel.js — "PREDICTION · LIVE": current link, trend, prediction, next path, action.
 *
 * Every value is the controller's own measurement at this tick (EWMA-smoothed probes, 3 s trend,
 * extrapolated time-to-failure). The sparkline plots the measured signal of the current primary,
 * the 15 %-loss failure level and the trend extrapolated to where it crosses that level.
 */
import { INTERFACE_SPECS } from '../simulation/LinkModel.js';
import { FLEXIPATH_PARAMS } from '../simulation/FlexiPathController.js';
import { esc, fmtPct, fmtSignal, linkChip, linkName, makeSetter, tag } from './format.js';

const P = FLEXIPATH_PARAMS;
const HIST_S = 8;
const FUT_S = 8;
const secs = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1));

export class PredictionPanel {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 class="hud-title">Prediction · live</h2>
        ${tag('measured')}
      </div>
      <div class="px-3 pb-3">
        <dl class="kv">
          <dt>Current link</dt><dd data-ref="cur">—</dd>
          <dt>Trend</dt><dd data-ref="trend">—</dd>
          <dt>Prediction</dt><dd data-ref="pred">—</dd>
          <dt>Next path</dt><dd data-ref="next">—</dd>
        </dl>
        <canvas class="pred-canvas mt-2.5" data-ref="canvas" role="img" aria-label="Measured signal of the current link with failure level and trend extrapolation"></canvas>
        <div class="mt-2.5 flex items-center justify-between gap-2">
          <span class="hud-label">Action</span>
          <span class="flow-meta truncate" title="Model parameters">protect if TTF &lt; ${P.ttfTriggerS.toFixed(1)} s · switch at loss &gt; ${(P.switchLoss * 100).toFixed(0)} %</span>
        </div>
        <div class="action-box mt-1.5" data-ref="action">—</div>
      </div>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.set = makeSetter();
    this.samples = [];
    this.primary = null;
    this.lastT = -1;
  }

  reset() {
    this.samples = [];
    this.primary = null;
    this.lastT = -1;
  }

  /** Called every tick (cheap): keep the measured-signal history of the current primary. */
  sample(snapshot) {
    const d = snapshot.agents.flexipath.decision;
    const pred = d?.prediction;
    if (snapshot.t < this.lastT) this.reset();
    this.lastT = snapshot.t;
    if (d?.primary !== this.primary) {
      this.primary = d?.primary ?? null;
      this.samples = [];
    }
    if (pred && Number.isFinite(pred.signal) && INTERFACE_SPECS[this.primary]?.tech !== 'wired') {
      this.samples.push({ t: snapshot.t, v: pred.signal });
      while (this.samples.length && this.samples[0].t < snapshot.t - HIST_S - 0.2) this.samples.shift();
    }
  }

  update(snapshot) {
    const fp = snapshot.agents.flexipath;
    const d = fp.decision;
    const pred = d?.prediction;
    const stage = fp.trace.stage;
    const r = this.refs;
    const S = this.set;

    if (!d?.primary || !pred) {
      S.html(r.cur, 'cur', '<span class="lvl-crit">No usable path</span>');
      S.html(r.trend, 'trend', '—');
      S.html(r.pred, 'pred', '—');
      S.html(r.next, 'next', '—');
      this._action('No usable path: flows buffered at the anchor until a link returns', 'is-crit');
      this._draw(snapshot, null, null);
      return;
    }
    const id = d.primary;
    const spec = INTERFACE_SPECS[id];
    const wired = spec.tech === 'wired';

    S.html(
      r.cur,
      'cur',
      `${linkChip(id, spec.name)} <span class="num">${esc(fmtSignal(id, wired ? 1 : pred.signal))}</span> <span class="text-slate-500">·</span> <span class="num">loss ${fmtPct(pred.loss)}</span>`,
    );

    // Trend (3 s regression of the measured signal).
    let trend;
    if (wired) trend = pred.triggers.context ? '<span class="trend lvl-warn">↓ leaving the dock</span>' : '<span class="text-slate-400">wired carrier · no radio trend</span>';
    else {
      const s = pred.signalSlopeLong;
      if (!Number.isFinite(s)) trend = '<span class="text-slate-400">collecting samples…</span>';
      else if (s < -P.minSignalSlope) trend = `<span class="trend lvl-warn">↓ degrading</span> <span class="num">${s.toFixed(1)} dB/s</span>`;
      else if (s > P.minSignalSlope) trend = `<span class="trend lvl-ok">↑ improving</span> <span class="num">+${s.toFixed(1)} dB/s</span>`;
      else trend = `<span class="trend text-slate-300">→ stable</span> <span class="num text-slate-500">${s >= 0 ? '+' : ''}${s.toFixed(1)} dB/s</span>`;
    }
    S.html(r.trend, 'trend', trend);

    // Prediction.
    let predText;
    if (wired) {
      predText = pred.triggers.context
        ? `<span class="lvl-crit">Carrier ends at dock release</span>${Number.isFinite(pred.dockDistM) ? ` <span class="num text-slate-400">(${pred.dockDistM.toFixed(0)} m)</span>` : ''}`
        : '<span class="text-slate-300">No failure predicted while docked</span>';
    } else {
      const level = `${pred.failLevel.toFixed(1)} ${spec.signalUnit}`;
      if (pred.triggers.ttf && Number.isFinite(pred.ttf)) {
        predText = `<span class="lvl-crit">Failure level in ≈ ${secs(pred.ttf)} s</span> <span class="num text-slate-400">(${level})</span>`;
      } else if (pred.triggers.rapidFade) {
        predText = `<span class="lvl-crit">Signal collapsing ${pred.signalSlope.toFixed(0)} dB/s</span>`;
      } else if (Number.isFinite(pred.projectedTtf)) {
        predText = `<span class="lvl-warn">Failure level in ≈ ${secs(pred.projectedTtf)} s</span> <span class="num text-slate-400">(${level})</span>`;
      } else if (pred.degrading) {
        const why = [];
        if (pred.triggers.deltaLoss) why.push(`loss +${(pred.dLoss * 100).toFixed(1)}% in 1 s`);
        if (pred.triggers.lossRate) why.push(`loss ${(pred.loss * 100).toFixed(1)}%`);
        if (pred.triggers.rttDrift) why.push(`RTT +${pred.rttSlope.toFixed(1)} ms/s`);
        predText = `<span class="lvl-warn">Degrading: ${esc(why.join(' · '))}</span>`;
      } else {
        predText = `<span class="lvl-ok">No degradation predicted</span> <span class="num text-slate-500">· ${Number.isFinite(pred.marginDb) ? `${pred.marginDb.toFixed(0)} dB margin` : ''}</span>`;
      }
    }
    S.html(r.pred, 'pred', predText);

    // Next path.
    const next = d.prepared ?? d.backup;
    let nextText = '<span class="text-slate-500">No alternate available</span>';
    if (next) {
      const sc = d.scores?.[next];
      const m = sc?.metrics;
      const detail = m
        ? `score ${sc.norm.critical.toFixed(0)} · loss ${fmtPct(m.lossRate)} · RTT ${Number.isFinite(m.rttMs) ? m.rttMs.toFixed(0) : '—'} ms`
        : '';
      const role = d.replica === next ? (d.replicationActive ? 'carrying replicas' : 'engaged') : d.prepared === next ? 'prepared' : 'standby';
      nextText = `${linkChip(next)} <span class="${role === 'prepared' || role === 'carrying replicas' ? 'text-sky-300' : 'text-slate-400'} font-semibold">${role}</span> <span class="num text-slate-500">· ${detail}</span>`;
    }
    S.html(r.next, 'next', nextText);

    // Action.
    const cls = d.replicate?.REALTIME ? 'critical + real-time' : 'critical';
    if (d.protecting && !d.replicationActive) {
      this._action(`Draining bulk traffic to ${linkName(d.replica)} (no critical or real-time flows to replicate) · switch when ${linkName(id)} loss > ${(P.switchLoss * 100).toFixed(0)} %`, 'is-warn');
      this._draw(snapshot, id, pred);
      return;
    }
    switch (stage) {
      case 'PREDICT':
        this._action(d.prepared ? `Prepare ${linkName(d.prepared)}` : 'Search for an alternate path', 'is-warn');
        break;
      case 'PREPARE':
        this._action(`Keep ${linkName(d.prepared)} ready · replicate critical traffic if time-to-failure < ${P.ttfTriggerS.toFixed(1)} s`, 'is-warn');
        break;
      case 'REPLICATE':
        this._action(
          d.replicationActive
            ? `Replicating ${cls} traffic on ${linkName(id)} + ${linkName(d.replica)} · switch when ${linkName(id)} loss > ${(P.switchLoss * 100).toFixed(0)} %`
            : `Draining bulk traffic to ${linkName(d.replica)} (nothing to replicate) · switch when ${linkName(id)} loss > ${(P.switchLoss * 100).toFixed(0)} %`,
          d.replicationActive ? 'is-repl' : 'is-warn',
        );
        break;
      case 'SWITCH':
      case 'CONTINUE':
        this._action(`${linkName(id)} is primary · sessions continue on the anchor IP`, 'is-ok');
        break;
      default:
        this._action('Monitor every link · no action needed', '');
    }
    this._draw(snapshot, id, pred);
  }

  _action(text, cls) {
    const key = `${cls}|${text}`;
    if (this.set.cache.action === key) return;
    this.set.cache.action = key;
    this.refs.action.textContent = text;
    this.refs.action.className = `action-box mt-1.5 ${cls}`;
  }

  _draw(snapshot, id, pred) {
    const cv = this.refs.canvas;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "600 9px 'JetBrains Mono', monospace";

    const spec = id ? INTERFACE_SPECS[id] : null;
    if (!spec || spec.tech === 'wired' || !pred || this.samples.length < 2) {
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.fillText(spec?.tech === 'wired' ? 'wired dock: carrier only, no radio signal trend' : 'collecting signal samples…', w / 2, h / 2 + 3);
      return;
    }
    const now = snapshot.t;
    const xNow = w * 0.6;
    const xOf = (t) => xNow + ((t - now) / (t <= now ? HIST_S : FUT_S)) * (t <= now ? xNow : w - xNow);
    const vals = this.samples.map((s) => s.v);
    const fail = pred.failLevel;
    let lo = Math.min(fail - 5, ...vals);
    let hi = Math.max(fail + 10, ...vals) + 3;
    if (hi - lo < 16) lo = hi - 16;
    const yOf = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (h - 14);

    // Now marker and failure level.
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xNow, 4);
    ctx.lineTo(xNow, h - 4);
    ctx.stroke();
    const yFail = yOf(fail);
    ctx.strokeStyle = 'rgba(239,68,68,0.75)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, yFail);
    ctx.lineTo(w, yFail);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(248,113,113,0.9)';
    ctx.textAlign = 'left';
    ctx.fillText(`15% loss level ${fail.toFixed(1)} ${spec.signalUnit}`, 4, Math.min(h - 3, yFail + 11));

    // Measured history.
    ctx.strokeStyle = spec.color;
    ctx.lineWidth = 1.8;
    ctx.shadowColor = spec.color;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    this.samples.forEach((s, i) => {
      const x = xOf(s.t);
      const y = yOf(s.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Trend extrapolation to the failure level: the same estimate the text shows — the fast 1 s trend once
    // the time-to-failure trigger is armed, otherwise the 3 s early-warning trend.
    const last = this.samples[this.samples.length - 1];
    const slope = pred.triggers.ttf && Number.isFinite(pred.ttf) ? pred.signalSlope : pred.signalSlopeLong;
    if (Number.isFinite(slope) && slope < -P.minSignalSlope) {
      const tCross = Math.max(0, (pred.signal - fail) / -slope);
      const horizon = Math.min(FUT_S, tCross);
      const x1 = xOf(now + horizon);
      const y1 = yOf(last.v + slope * horizon);
      ctx.strokeStyle = 'rgba(250,204,21,0.9)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(xOf(last.t), yOf(last.v));
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      if (tCross <= FUT_S) {
        ctx.fillStyle = '#facc15';
        ctx.beginPath();
        ctx.arc(x1, y1, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.textAlign = x1 > w - 40 ? 'right' : 'left';
        ctx.fillText(`≈ ${secs(tCross)} s`, x1 + (x1 > w - 40 ? -6 : 6), Math.max(10, y1 - 5));
      } else {
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(250,204,21,0.8)';
        ctx.fillText(`> ${FUT_S} s`, w - 4, Math.max(10, y1 - 5));
      }
    }
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'right';
    ctx.fillText('now', xNow - 3, h - 4);
    ctx.textAlign = 'left';
    ctx.fillText(`−${HIST_S} s`, 3, 10);
  }
}
