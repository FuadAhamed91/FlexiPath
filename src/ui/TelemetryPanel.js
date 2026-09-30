/**
 * TelemetryPanel.js — left telemetry deck: one health card per interface
 * (eth0 / wlan0 / wwan0 / sat0) with live RSSI/RSRP bars, throughput, RTT,
 * loss, jitter and the 0–100 utility score, as seen by the focused engine.
 */
import { INTERFACE_IDS, INTERFACE_SPECS } from '../simulation/LinkModel.js';
import { LEGACY_PARAMS } from '../simulation/LegacyController.js';

const ICON = { eth0: 'cable', wlan0: 'wifi', wwan0: 'radio-tower', sat0: 'satellite' };
const BAR_HEIGHTS = [3, 5, 7, 9, 12];

const fmt = {
  signal(id, v) {
    const s = INTERFACE_SPECS[id];
    if (s.tech === 'wired') return v ? 'LINK UP' : 'NO CARRIER';
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return `${v.toFixed(1)} ${s.signalUnit}`;
  },
  mbps: (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)),
  ms: (v) => (Number.isFinite(v) ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) : '—'),
  pct: (v) => (v >= 0.1 ? (v * 100).toFixed(1) : (v * 100).toFixed(2)),
};

function cardHTML(id) {
  const s = INTERFACE_SPECS[id];
  return `
  <article class="iface-card" style="--c:${s.color}" data-id="${id}">
    <header class="flex items-center gap-2">
      <i data-lucide="${ICON[id]}" class="size-4 shrink-0" style="color:var(--c)"></i>
      <div class="flex min-w-0 flex-1 items-baseline gap-2">
        <span class="font-mono text-[12px] font-bold text-slate-100">${id}</span>
        <span class="truncate text-[10px] text-slate-500">${s.label}</span>
      </div>
      <span class="role role-standby" data-ref="role">STANDBY</span>
    </header>
    <div class="mt-2 flex items-center gap-2">
      <span class="hud-label w-10 shrink-0">${s.signalLabel === 'CARRIER' ? 'LINK' : s.signalLabel}</span>
      <span class="num w-[76px] shrink-0 text-[12px] font-semibold text-slate-100" data-ref="signal">—</span>
      <div class="sig-bars" data-ref="bars">${BAR_HEIGHTS.map((h) => `<i style="height:${h}px"></i>`).join('')}</div>
      <span class="num ml-auto truncate text-[9px] text-slate-500" data-ref="extra"></span>
    </div>
    <div class="mt-1.5 grid grid-cols-4 gap-1">
      <div><div class="hud-label">Thr</div><div class="num text-[11px] text-slate-200"><span data-ref="thr">—</span><span class="text-[8px] text-slate-500"> Mb</span></div></div>
      <div><div class="hud-label">RTT</div><div class="num text-[11px] text-slate-200"><span data-ref="rtt">—</span><span class="text-[8px] text-slate-500"> ms</span></div></div>
      <div><div class="hud-label">Loss</div><div class="num text-[11px]"><span data-ref="loss">—</span><span class="text-[8px] text-slate-500"> %</span></div></div>
      <div><div class="hud-label">Jitter</div><div class="num text-[11px] text-slate-200"><span data-ref="jit">—</span><span class="text-[8px] text-slate-500"> ms</span></div></div>
    </div>
    <div class="mt-2 flex items-center gap-2">
      <span class="hud-label w-10 shrink-0" data-ref="scoreLabel">Score</span>
      <div class="meter flex-1"><span data-ref="meter"></span></div>
      <span class="num w-8 text-right text-[13px] font-bold" style="color:var(--c)" data-ref="score">0</span>
    </div>
    <div class="num mt-1 flex justify-between gap-2 text-[9px] text-slate-500">
      <span class="truncate" data-ref="sub"></span><span class="shrink-0 text-right" data-ref="pred"></span>
    </div>
  </article>`;
}

export class TelemetryPanel {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 class="hud-title">Interface Health</h2>
        <span class="chip" data-ref="focus">FLEXIPATH VIEW</span>
      </div>
      <div class="flex flex-col gap-2 px-2 pb-2">${INTERFACE_IDS.map(cardHTML).join('')}</div>`;
    this.focusChip = root.querySelector('[data-ref="focus"]');
    this.cards = {};
    for (const id of INTERFACE_IDS) {
      const el = root.querySelector(`[data-id="${id}"]`);
      const refs = {};
      el.querySelectorAll('[data-ref]').forEach((n) => (refs[n.dataset.ref] = n));
      refs.barEls = [...refs.bars.children];
      this.cards[id] = { el, refs, cache: {} };
    }
  }

  _set(card, key, value, prop = 'textContent') {
    if (card.cache[key] === value) return;
    card.cache[key] = value;
    if (prop === 'width') card.refs[key].style.width = value;
    else card.refs[key][prop] = value;
  }

  _roleFor(id, L, d, engine) {
    if (engine === 'legacy') {
      if (d.stalled && d.stall) {
        if (id === d.stall.from) return ['STALLED', 'role-stalled', 'is-stalled'];
        if (id === d.stall.to && L.up) return ['ATTACHING', 'role-share', ''];
      }
      if (!L.up) return ['DOWN', 'role-down', 'is-down'];
      if (id === d.primary) return ['ACTIVE ROUTE', 'role-primary', 'is-primary'];
      return ['IDLE', 'role-standby', ''];
    }
    if (!L.up) return ['DOWN', 'role-down', 'is-down'];
    if (id === d.primary) return ['PRIMARY', 'role-primary', 'is-primary'];
    if (id === d.replica) return ['REPLICA', 'role-replica', 'is-replica'];
    const share = d.bulkShares?.[id] ?? 0;
    if (share > 0.001) return [`BULK ${(share * 100).toFixed(0)}%`, 'role-share', ''];
    return ['STANDBY', 'role-standby', ''];
  }

  update(agent, engine) {
    this._setFocus(engine);
    const d = agent.decision;
    for (const id of INTERFACE_IDS) {
      const card = this.cards[id];
      const L = agent.links[id];
      const spec = INTERFACE_SPECS[id];
      const [roleText, roleCls, cardCls] = this._roleFor(id, L, d, engine);
      if (card.cache.role !== roleText) {
        card.cache.role = roleText;
        card.refs.role.textContent = roleText;
        card.refs.role.className = `role ${roleCls}`;
        card.el.className = `iface-card ${cardCls}`;
      }

      this._set(card, 'signal', fmt.signal(id, L.signal));
      const bars = Math.ceil(L.quality * 5);
      if (card.cache.bars !== bars) {
        card.cache.bars = bars;
        card.refs.barEls.forEach((b, i) => b.classList.toggle('on', i < bars));
      }
      let extra = '';
      if (id === 'sat0' && L.info) extra = `${L.info.servingSat} · el ${L.info.elevationDeg.toFixed(0)}°`;
      else if (L.up && L.snr !== null && spec.tech !== 'wired') extra = `${spec.tech === 'cellular' ? 'SINR' : 'SNR'} ${L.snr.toFixed(0)} dB`;
      this._set(card, 'extra', extra);

      this._set(card, 'thr', L.up ? fmt.mbps(L.throughputMbps) : '—');
      this._set(card, 'rtt', L.up ? fmt.ms(L.rttMs) : '—');
      this._set(card, 'loss', L.up ? fmt.pct(L.lossRate) : '100');
      const lossColor = !L.up || L.lossRate > 0.15 ? '#fb7185' : L.lossRate > 0.05 ? '#fbbf24' : '#e2e8f0';
      if (card.cache.lossColor !== lossColor) {
        card.cache.lossColor = lossColor;
        card.refs.loss.parentElement.style.color = lossColor;
      }
      this._set(card, 'jit', L.up ? fmt.ms(L.jitterMs) : '—');

      if (engine === 'legacy') {
        const floor = LEGACY_PARAMS.floors[id];
        this._set(card, 'scoreLabel', 'Metric');
        this._set(card, 'score', String(spec.legacyMetric));
        this._set(card, 'meter', `${Math.round(L.quality * 100)}%`, 'width');
        this._set(card, 'sub', floor !== undefined ? `hard floor ${floor} ${spec.signalUnit}` : 'carrier-sense only');
        this._set(card, 'pred', id === d.primary ? 'no prediction' : '');
      } else {
        const sc = d.scores?.[id];
        const norm = sc?.norm ?? { general: 0, critical: 0, bulk: 0 };
        this._set(card, 'scoreLabel', 'Score');
        this._set(card, 'score', String(Math.round(norm.general)));
        this._set(card, 'meter', `${norm.general.toFixed(0)}%`, 'width');
        this._set(card, 'sub', L.up ? `crit ${norm.critical.toFixed(0)} · bulk ${norm.bulk.toFixed(0)}` : 'probing…');
        let pred = '';
        const p = d.prediction;
        if (p && id === d.primary) {
          if (Number.isFinite(p.ttf) && p.triggers.ttf) pred = `TTF ${p.ttf.toFixed(1)} s`;
          else if (p.triggers.rapidFade) pred = `FADE ${p.signalSlope.toFixed(0)} dB/s`;
          else if (p.degrading) pred = `ΔL ${p.dLoss >= 0 ? '+' : ''}${(p.dLoss * 100).toFixed(1)}%`;
          else pred = `ΔL ${p.dLoss >= 0 ? '+' : ''}${(p.dLoss * 100).toFixed(1)}% · stable`;
        }
        this._set(card, 'pred', pred);
      }
    }
  }

  _setFocus(engine) {
    if (this._engine === engine) return;
    this._engine = engine;
    this.focusChip.textContent = engine === 'legacy' ? 'LEGACY OS VIEW' : 'FLEXIPATH VIEW';
    this.focusChip.style.color = engine === 'legacy' ? '#fb7185' : '#67e8f9';
    this.focusChip.style.borderColor = engine === 'legacy' ? 'rgba(244,63,94,.4)' : 'rgba(0,240,255,.35)';
  }
}
