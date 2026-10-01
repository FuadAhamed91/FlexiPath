/**
 * DecisionPanel.js — "WHY DID FLEXIPATH DO THAT?"
 *
 * Renders the structured decision records produced by FlexiPathController at the moment it acted:
 * current path, status, alternate, traffic, radio power, action and reason — built from the values the
 * controller measured at that tick. Thresholds quoted in the reason and the radio tier draws are model
 * parameters. No confidence score is shown because the predictor does not compute one.
 */
import { POWER_TIERS } from '../simulation/PowerModel.js';
import { esc, fmtPct, fmtT, linkChip, makeSetter, tag } from './format.js';

export const KIND_META = {
  ATTACH: { label: 'ATTACH', color: '#94a3b8' },
  PREDICT: { label: 'PREDICT', color: '#facc15' },
  PREPARE: { label: 'PREPARE', color: '#60a5fa' },
  PROTECT: { label: 'PROTECT', color: '#c084fc' },
  PROTECT_RT: { label: 'PROTECT · RT', color: '#c084fc' },
  UPGRADE: { label: 'UPGRADE', color: '#22d3ee' },
  RETARGET: { label: 'RETARGET', color: '#60a5fa' },
  SWITCH: { label: 'SWITCH', color: '#4ade80' },
  FAILOVER: { label: 'FAILOVER', color: '#fb923c' },
  STAND_DOWN: { label: 'STAND DOWN', color: '#94a3b8' },
  NO_PATH: { label: 'NO PATH', color: '#f87171' },
};

const secs = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1));
const RADIO_WHAT = ['secondary modems asleep in DRX', 'one secondary modem awake, probing', 'both radios transmitting'];

/** Radio power tier the decision puts the system in (model parameter per tier). */
function radioText(p) {
  if (!p) return '<span class="text-slate-500">—</span>';
  const tier = POWER_TIERS[p.tier] ?? POWER_TIERS[0];
  return `<span class="tier-badge" style="--c:${tier.color}">${esc(p.label ?? tier.label)}</span> <span class="num font-semibold text-slate-200">${p.watts.toFixed(1)} W</span> <span class="text-slate-500">· ${esc(RADIO_WHAT[p.tier] ?? '')}</span>`;
}

function currentText(c) {
  if (!c) return '—';
  const bits = [];
  if (c.signalText) bits.push(c.signalText);
  if (Number.isFinite(c.loss)) bits.push(`loss ${fmtPct(c.loss)}`);
  if (Number.isFinite(c.rttMs)) bits.push(`RTT ${c.rttMs.toFixed(0)} ms`);
  return `${linkChip(c.link, c.name)} <span class="num text-slate-400">${esc(bits.join(' · '))}</span>`;
}

function statusText(c) {
  if (!c) return '—';
  const lvl = { ok: 'lvl-ok', warn: 'lvl-warn', crit: 'lvl-crit' }[c.level] ?? '';
  const bits = [];
  if (Number.isFinite(c.slope) && Math.abs(c.slope) > 0.05) bits.push(`trend ${c.slope.toFixed(1)} dB/s`);
  if (Number.isFinite(c.ttf)) bits.push(`TTF ${secs(c.ttf)} s`);
  else if (Number.isFinite(c.projectedTtf)) bits.push(`projected failure ${secs(c.projectedTtf)} s`);
  if (Number.isFinite(c.marginDb)) bits.push(`${c.marginDb.toFixed(1)} dB margin`);
  return `<span class="font-semibold ${lvl}">${esc(c.status)}</span>${bits.length ? ` <span class="num text-slate-400">· ${esc(bits.join(' · '))}</span>` : ''}`;
}

function altText(a) {
  if (!a) return '<span class="text-slate-500">none</span>';
  if (a.estimated) {
    // Asleep in DRX (or just woken): only its signal has been sampled — no RTT / loss measured yet.
    return `${linkChip(a.link, a.name)} <span class="num text-slate-400">est. score ${a.score.toFixed(0)} · from its DRX signal, RTT / loss not measured yet</span>`;
  }
  const bits = [`score ${a.score.toFixed(0)}`];
  if (Number.isFinite(a.loss)) bits.push(`loss ${fmtPct(a.loss)}`);
  if (Number.isFinite(a.rttMs)) bits.push(`RTT ${a.rttMs.toFixed(0)} ms`);
  return `${linkChip(a.link, a.name)} <span class="num text-slate-400">${esc(bits.join(' · '))}</span>`;
}

export class DecisionPanel {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="flex items-start justify-between gap-2 px-3 pt-3 pb-1">
        <div>
          <h2 class="hud-title text-slate-200!">Why did FlexiPath do that?</h2>
          <div class="mt-1 font-mono text-[9.5px] text-slate-500" data-ref="sub">Decision engine · waiting for the first decision</div>
        </div>
        <span class="decision-kind" data-ref="kind" hidden></span>
      </div>
      <div class="px-3 pb-3">
        <div class="decision-headline mt-1.5" data-ref="headline">—</div>
        <dl class="kv mt-2.5">
          <dt>Current path</dt><dd data-ref="cur">—</dd>
          <dt>Status</dt><dd data-ref="status">—</dd>
          <dt data-ref="altLabel">Alternate</dt><dd data-ref="alt">—</dd>
          <dt>Traffic</dt><dd data-ref="traffic">—</dd>
          <dt title="Radio subsystem draw in the tier this decision puts the system in (model parameter)">Radio</dt><dd data-ref="radio">—</dd>
          <dt>Action</dt><dd data-ref="action" class="font-semibold">—</dd>
          <dt>Reason</dt><dd data-ref="reason">—</dd>
        </dl>
        <div class="mt-2.5 flex flex-wrap items-center gap-1.5 text-[9.5px] text-slate-500">
          ${tag('measured')}<span>values at decision time</span>${tag('param')}<span>thresholds</span>
        </div>
        <div class="legacy-rule mt-2.5" data-ref="legacy" title="What the legacy OS stack is doing at the same moment">Legacy OS · —</div>
        <div class="mt-3 flex items-center justify-between">
          <span class="hud-label">Decision history</span>
          <button type="button" class="btn h-[22px]! px-2! text-[10px]!" data-ref="follow" hidden>Follow latest</button>
        </div>
        <div class="decision-history mt-1 flex flex-col gap-0.5" data-ref="history"></div>
      </div>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.refs.follow.addEventListener('click', () => this.select(null));
    this.refs.history.addEventListener('click', (e) => {
      const b = e.target.closest('[data-idx]');
      if (b) this.select(Number(b.dataset.idx));
    });
    this.set = makeSetter();
    this.records = [];
    this.pinned = null;
    this._dirty = true;
  }

  /** Replace the record list (engine reset). */
  setRecords(records) {
    this.records = records.filter((r) => r.engine === 'flexipath');
    this.pinned = null;
    this._dirty = true;
  }

  push(record) {
    if (record.engine !== 'flexipath') return;
    this.records.push(record);
    if (this.records.length > 200) this.records.shift();
    this._dirty = true;
  }

  select(idx) {
    this.pinned = idx;
    this._dirty = true;
  }

  get current() {
    if (this.pinned !== null && this.records[this.pinned]) return this.records[this.pinned];
    return this.records[this.records.length - 1] ?? null;
  }

  update(snapshot) {
    const lgRule = snapshot.agents.legacy.decision?.rule ?? '—';
    this.set.text(this.refs.legacy, 'legacy', `Legacy OS · ${lgRule}`);
    if (!this._dirty) return;
    this._dirty = false;
    const r = this.current;
    const R = this.refs;
    if (!r) return;
    const meta = KIND_META[r.kind] ?? { label: r.kind, color: '#94a3b8' };
    R.kind.hidden = false;
    R.kind.textContent = meta.label;
    R.kind.style.color = meta.color;
    R.sub.textContent = `Decision engine · ${fmtT(r.t)} s${this.pinned !== null ? ' · pinned' : ' · latest'}`;
    R.headline.textContent = r.headline;
    R.cur.innerHTML = currentText(r.current);
    R.status.innerHTML = statusText(r.current);
    R.altLabel.textContent = r.alternate?.label ?? 'Alternate';
    R.alt.innerHTML = altText(r.alternate);
    R.traffic.textContent = r.traffic?.text ?? '—';
    R.radio.innerHTML = radioText(r.power);
    R.action.textContent = r.action;
    R.reason.textContent = r.reason;
    R.follow.hidden = this.pinned === null;

    const start = Math.max(0, this.records.length - 7);
    const rows = [];
    for (let i = this.records.length - 1; i >= start; i--) {
      const rec = this.records[i];
      const m = KIND_META[rec.kind] ?? { label: rec.kind, color: '#94a3b8' };
      const current = rec === r;
      rows.push(
        `<button type="button" data-idx="${i}" aria-current="${current}"><span>${fmtT(rec.t)}</span><span style="color:${m.color}">${esc(m.label)}</span><span>${esc(rec.headline)}</span></button>`,
      );
    }
    R.history.innerHTML = rows.join('');
  }
}
