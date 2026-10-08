/**
 * EngineeringPanel.js — "BATTERY · ORDERING · SESSION": the three classic objections, measured live.
 *
 *   Battery   radio power of both stacks (three-tier sleep model) and each radio's state
 *   Ordering  head-of-line blocking: critical / real-time never wait (first copy delivered, late
 *             duplicate discarded); bulk TCP stalls from loss recovery; pacing offset during a burst
 *   Session   the client's physical IP vs. the static anchor relay that remote services see
 */
import { INTERFACE_IDS } from '../simulation/LinkModel.js';
import { RADIO_STATES, POWER_TIERS } from '../simulation/PowerModel.js';
import { esc, fmtInt, linkName, makeSetter, tag } from './format.js';

export function radioBadge(id, state) {
  const r = RADIO_STATES[state] ?? RADIO_STATES.OFF;
  return `<span class="radio-badge" style="--c:${r.color}" title="${esc(r.desc)}">${esc(linkName(id))} · ${esc(r.badge)}</span>`;
}

export class EngineeringPanel {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="flex items-start justify-between gap-2 px-3 pt-3 pb-1">
        <div>
          <h2 class="hud-title text-slate-800!">Battery · ordering · session</h2>
          <div class="mt-1 font-mono text-[9.5px] text-slate-500">The three engineering objections, measured</div>
        </div>
        ${tag('measured')}
      </div>
      <div class="flex flex-col gap-2 px-2 pt-1.5 pb-3">
        <section class="eng-row">
          <div class="flex items-center justify-between gap-2">
            <span class="hud-label">Radio power</span>
            <span class="tier-badge" data-ref="tier">DRX STANDBY</span>
          </div>
          <div class="mt-1.5 grid grid-cols-2 gap-2">
            <div class="kpi-cell"><span class="text-[10px] font-bold tracking-[0.14em] text-fp">FP</span> <b class="v text-fp" data-ref="fpW">1.2</b><span class="text-[10px] text-slate-500"> W</span></div>
            <div class="kpi-cell"><span class="text-[10px] font-bold tracking-[0.14em] text-legacy">LG</span> <b class="v text-legacy" data-ref="lgW">1.2</b><span class="text-[10px] text-slate-500"> W</span></div>
          </div>
          <div class="mt-1.5 flex flex-wrap gap-1" data-ref="radios"></div>
          <div class="flow-meta mt-1.5" data-ref="energy">—</div>
        </section>
        <section class="eng-row">
          <span class="hud-label">Head-of-line blocking</span>
          <div class="mt-1.5 text-[11px] leading-snug text-slate-700" data-ref="crit">—</div>
          <div class="mt-1 text-[11px] leading-snug text-slate-700" data-ref="bulk">—</div>
          <div class="flow-meta mt-1" data-ref="holNow">—</div>
        </section>
        <section class="eng-row">
          <span class="hud-label">Session · relay tunnel</span>
          <div class="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-700" data-ref="path">—</div>
          <div class="mt-1 text-[11px] text-slate-700" data-ref="ipStats">—</div>
          <div class="flow-meta mt-1" data-ref="legacyIp">—</div>
        </section>
      </div>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.set = makeSetter();
  }

  update(snapshot) {
    const R = this.refs;
    const S = this.set;
    const fp = snapshot.agents.flexipath;
    const lg = snapshot.agents.legacy;

    // Battery.
    const tier = POWER_TIERS[fp.power.tier];
    if (S.cache.tier !== tier.key) {
      S.cache.tier = tier.key;
      R.tier.textContent = `FP · ${tier.label}`;
      R.tier.style.setProperty('--c', tier.color);
    }
    S.text(R.fpW, 'fpW', fp.power.watts.toFixed(1));
    S.text(R.lgW, 'lgW', lg.power.watts.toFixed(1));
    S.html(
      R.radios,
      'radios',
      INTERFACE_IDS.filter((id) => fp.power.radio[id] && fp.power.radio[id] !== 'OFF').map((id) => radioBadge(id, fp.power.radio[id])).join(''),
    );
    const bursts = fp.power.bursts;
    S.text(
      R.energy,
      'energy',
      `Journey energy FP ${fp.power.energyJ.toFixed(1)} J · LG ${lg.power.energyJ.toFixed(1)} J · mean FP ${fp.power.meanWatts.toFixed(2)} W vs LG ${lg.power.meanWatts.toFixed(2)} W · ${bursts} burst${bursts === 1 ? '' : 's'}`,
    );

    // Ordering.
    const hf = fp.hol;
    const hl = lg.hol;
    const st = hf.stats;
    const sl = hl.stats;
    S.html(
      R.crit,
      'crit',
      fp.hasCritical || fp.hasVoice
        ? `<b class="text-slate-900">Critical + real-time: ${st.packetHolMaxMs.toFixed(0)} ms</b> stall · <b class="text-repl">${fmtInt(st.duplicatesDiscarded)}</b> late duplicates discarded <span class="text-slate-500">(32-bit sequence, first copy delivered; in-order would have added up to ${st.inOrderWaitMaxMs.toFixed(0)} ms)</span>`
        : '<span class="text-slate-500">No critical or real-time flows in this scenario</span>',
    );
    S.html(
      R.bulk,
      'bulk',
      st.bulkHolMeanMs === null
        ? '<span class="text-slate-500">No bulk flows in this scenario</span>'
        : `<b class="text-slate-900">Bulk:</b> <span class="text-fp">FP ${st.bulkHolMeanMs.toFixed(1)} ms</span> mean · peak ${st.bulkHolPeakMs.toFixed(0)} ms &nbsp;<span class="text-legacy">LG ${sl.bulkHolMeanMs.toFixed(1)} ms</span> · peak ${sl.bulkHolPeakMs.toFixed(0)} ms · ${sl.bulkRtoEvents} TCP timeout stall${sl.bulkRtoEvents === 1 ? '' : 's'}`,
    );
    let now;
    if (hf.pacing) now = `Now: delay-compensated pacing — ${linkName(hf.pacing.slowPath)} sends offset ${hf.pacing.offsetMs.toFixed(0)} ms ahead of ${linkName(hf.pacing.fastPath)} (ΔRTT ${(hf.pacing.offsetMs * 2).toFixed(0)} ms)`;
    else if (hl.bulkRto || (hl.recentStallMs ?? 0) >= 150) now = `Now: Legacy TCP head-of-line stall ${hl.recentStallMs.toFixed(0)} ms (retransmission timeout on a lossy link)`;
    else now = `Now: FP bulk stall ${(hf.recentStallMs ?? 0).toFixed(0)} ms · LG ${(hl.recentStallMs ?? 0).toFixed(0)} ms (last 1 s)`;
    S.text(R.holNow, 'holNow', now);

    // Session.
    const tu = fp.tunnel;
    const client = tu.clientIp ? `<span class="path-chip" style="--c:#94a3b8">${esc(tu.clientIp)}</span><span class="text-slate-500">${esc(linkName(tu.clientIface))}${tu.clientKind === 'cgnat' ? ' · CGNAT' : ' · private'}</span>` : '<span class="text-slate-500">no path</span>';
    S.html(
      R.path,
      'path',
      `${client}<b class="text-slate-500">→</b><span class="path-chip" style="--c:#0891B2">relay ${esc(tu.anchorIp)}</span><b class="text-slate-500">→</b><span class="text-slate-600">remote sees</span> <b class="text-fp">${esc(tu.remoteIp ?? '—')}</b>`,
    );
    S.html(
      R.ipStats,
      'ipStats',
      `Physical IP changes <b class="text-slate-900">${tu.physicalIpChanges}</b> · seen by remote services <b class="text-fp">${tu.remoteIpChanges}</b> · socket resets <b class="text-fp">${fp.stats.tcpResets}</b>${tu.natRebinds ? ` · NAT rebinds ${tu.natRebinds}` : ''}`,
    );
    const lt = lg.tunnel;
    S.text(
      R.legacyIp,
      'legacyIp',
      `Legacy (no tunnel): remote services see ${lt.remoteIp ?? '—'} · ${lt.remoteIpChanges} address change${lt.remoteIpChanges === 1 ? '' : 's'} · ${lg.stats.tcpResets} TCP resets`,
    );
  }
}
