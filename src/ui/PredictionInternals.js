/**
 * PredictionInternals.js — advanced view: every trigger of the FlexiPath predictor with its live
 * measured value, its threshold (a model parameter) and whether it is armed / firing.
 */
import { FLEXIPATH_PARAMS } from '../simulation/FlexiPathController.js';
import { INTERFACE_SPECS } from '../simulation/LinkModel.js';
import { POWER_PARAMS, RADIO_STATES } from '../simulation/PowerModel.js';
import { esc, linkName, makeSetter, tag } from './format.js';

const P = FLEXIPATH_PARAMS;
const PW = POWER_PARAMS;
const BURST_MS = Math.round(P.burstWindowS * 1000);
const ROWS = [
  ['dLoss', 'ΔLoss (1 s)', `> ${(P.deltaLossTrigger * 100).toFixed(0)} %`],
  ['loss', 'Loss (EWMA)', `> ${(P.lossTrigger * 100).toFixed(0)} %`],
  ['rtt', 'RTT drift', `> ${(P.rttDriftFactor * 100).toFixed(0)} % base/s & > ${P.rttDriftLevel}× base`],
  ['ttf', 'Time-to-failure (1 s)', `< ${P.ttfTriggerS.toFixed(1)} s · within ${P.ttfMarginDb} dB · ${P.ttfConfirmTicks} ticks`],
  ['fade', 'Rapid fade', `< −${P.rapidFadeSlope} dB/s`],
  ['watch', 'Early warning (3 s trend)', `< ${P.watchHorizonS} s · within ${P.watchMarginDb} dB`],
  ['ploss', 'Predicted loss (2 s)', `> ${(P.switchLoss * 100).toFixed(0)} % ⇒ imminent`],
  ['rt', 'Real-time budget', `> ${(P.realtimeLossBudget * 100).toFixed(0)} % or TTF < ${P.realtimeTtfS} s`],
  ['health', 'Primary health (wake)', `≤ ${PW.healthWakeScore} ⇒ wake a secondary`],
  ['wake', 'ΔLoss (1 s) · wake', `> ${(PW.lossDeltaWake * 100).toFixed(0)} % ⇒ wake a secondary`],
  ['warm', 'Woken modem', `validated after ${PW.warmValidateS} s of ${PW.heartbeatBytes}-byte heartbeats`],
  ['switch', 'Switch', `end of the ${BURST_MS} ms burst`],
];

const secs = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1));

export class PredictionInternals {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 class="hud-title">Prediction internals</h2>
        <span class="chip" data-ref="link">—</span>
      </div>
      <div class="px-3 pb-1 flex flex-wrap items-center gap-1.5 text-[9.5px] text-slate-500">${tag('measured')}<span>value</span>${tag('param')}<span>threshold</span></div>
      <table class="exp-table px-3" style="margin:4px 12px 10px; width:calc(100% - 24px)">
        <thead><tr><th>Trigger</th><th>Value</th><th>Threshold</th><th></th></tr></thead>
        <tbody>
          ${ROWS.map(([k, label, thr]) => `<tr data-row="${k}"><td>${esc(label)}</td><td data-v>—</td><td class="sd" style="white-space:normal">${esc(thr)}</td><td data-s></td></tr>`).join('')}
        </tbody>
      </table>
      <p class="px-3 pb-3 font-mono text-[9.5px] leading-relaxed text-slate-500">
        Score W = T<sup>a</sup> / (RTT<sup>b</sup> · (1 + ${P.alpha}·L²)); critical a = 0.4, b = 1.2 · bulk a = 1.5, b = 0.5.
        The predictor extrapolates EWMA-smoothed probe signal linearly towards the level where packet loss reaches ${(P.switchLoss * 100).toFixed(0)} %.
        Modems asleep in DRX report signal only (every ${PW.drxCycleS} s), so their scores are estimates until a wake reason fires.
      </p>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.rows = {};
    for (const tr of root.querySelectorAll('[data-row]')) this.rows[tr.dataset.row] = { v: tr.querySelector('[data-v]'), s: tr.querySelector('[data-s]') };
    this.set = makeSetter();
  }

  _row(key, value, state) {
    const r = this.rows[key];
    this.set.text(r.v, `${key}v`, value);
    const [text, cls] = state === 'fire' ? ['FIRING', 'lvl-crit'] : state === 'armed' ? ['ARMED', 'lvl-warn'] : ['—', 'text-slate-600'];
    const k = `${key}s`;
    if (this.set.cache[k] !== text) {
      this.set.cache[k] = text;
      r.s.textContent = text;
      r.s.className = `font-bold ${cls}`;
    }
  }

  update(snapshot) {
    const d = snapshot.agents.flexipath.decision;
    const p = d?.prediction;
    this.set.text(this.refs.link, 'link', d?.primary ? `PRIMARY ${linkName(d.primary).toUpperCase()}` : 'NO PATH');
    if (!p) {
      for (const k of Object.keys(this.rows)) this._row(k, '—', null);
      return;
    }
    const spec = INTERFACE_SPECS[d.primary];
    const tr = p.triggers;
    this._row('dLoss', `${p.dLoss >= 0 ? '+' : ''}${(p.dLoss * 100).toFixed(2)} %`, tr.deltaLoss ? 'fire' : p.dLoss > P.deltaLossTrigger / 2 ? 'armed' : null);
    this._row('loss', `${(p.loss * 100).toFixed(2)} %`, tr.lossRate ? 'fire' : null);
    this._row('rtt', `${p.rttSlope >= 0 ? '+' : ''}${p.rttSlope.toFixed(1)} ms/s · ${p.rtt.toFixed(0)} ms`, tr.rttDrift ? 'fire' : null);
    this._row('ttf', Number.isFinite(p.ttf) ? `${secs(p.ttf)} s` : spec.tech === 'wired' ? 'n/a' : '∞', tr.ttf ? 'fire' : Number.isFinite(p.ttf) ? 'armed' : null);
    this._row('fade', spec.tech === 'wired' ? 'n/a' : `${p.signalSlope.toFixed(1)} dB/s`, tr.rapidFade ? 'fire' : null);
    this._row('watch', Number.isFinite(p.projectedTtf) ? `${secs(p.projectedTtf)} s` : '∞', d.watching ? 'armed' : null);
    this._row('ploss', `${(p.predictedLoss * 100).toFixed(1)} %`, p.predictedLoss > P.switchLoss ? 'fire' : null);
    this._row('rt', `${(p.loss * 100).toFixed(2)} %`, d.replicate?.REALTIME ? 'fire' : d.protecting ? 'armed' : null);
    const wired = spec.tech === 'wired';
    const h = d.health;
    this._row('health', wired ? 'n/a (wired)' : Number.isFinite(h) ? h.toFixed(0) : '—', !wired && Number.isFinite(h) && h <= PW.healthWakeScore ? 'fire' : null);
    this._row('wake', `${p.dLoss >= 0 ? '+' : ''}${(p.dLoss * 100).toFixed(2)} %`, p.dLoss > PW.lossDeltaWake ? 'fire' : null);
    const w = d.prepared ?? d.warmTarget;
    const ws = w ? d.radio?.[w] : null;
    this._row(
      'warm',
      w ? `${linkName(w)} · ${d.prepared === w ? 'validated' : (RADIO_STATES[ws]?.badge ?? ws ?? '—').toLowerCase()}` : 'none · all DRX',
      w && d.prepared === w ? 'fire' : ws === 'WARM' || ws === 'WAKING' ? 'armed' : null,
    );
    this._row('switch', d.protecting ? `${Math.round(d.replicationElapsed * 1000)} / ${BURST_MS} ms` : '—', d.protecting ? 'armed' : null);
  }
}
