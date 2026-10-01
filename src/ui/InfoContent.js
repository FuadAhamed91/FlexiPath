/**
 * InfoContent.js — "WHY FLEXIPATH?": what makes the approach different, how the loop decides,
 * what is a model parameter vs. a measured simulation result, and the keyboard shortcuts.
 */
import { FLEXIPATH_PARAMS } from '../simulation/FlexiPathController.js';
import { LEGACY_PARAMS, LEGACY_WIRELESS_STALL_S } from '../simulation/LegacyController.js';
import { TRAFFIC_CLASSES } from '../simulation/TrafficManager.js';
import { ANCHOR_IP } from '../simulation/SimulationEngine.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';
import { HOL_PARAMS } from '../simulation/ReorderingBuffer.js';
import { FIRST_LEASE } from '../simulation/RelayTunnelModel.js';
import { esc, tag } from './format.js';

const P = FLEXIPATH_PARAMS;
const PW = POWER_PARAMS;
const W = PW.tierWatts;
const BURST_MS = Math.round(P.burstWindowS * 1000);

// Engineering objections and how the model answers them (mechanisms; values are model parameters).
const OBJECTIONS = [
  [
    'Battery drain',
    'Three-tier radio sleep model',
    `One radio carries the traffic; every other modem sleeps in 3GPP DRX (${W[0]} W system draw) and measures signal once per ${PW.drxCycleS} s. ` +
      `A secondary wakes to Warm Probe (${W[1]} W, ${PW.heartbeatBytes}-byte heartbeats every ${PW.heartbeatIntervalS * 1000} ms) only when the primary's health falls to ≤ ${PW.healthWakeScore}, ` +
      `its loss rises > ${(PW.lossDeltaWake * 100).toFixed(0)} % in 1 s, or degradation is predicted. Both radios transmit (${W[2]} W) only for the ~${BURST_MS} ms handoff burst.`,
  ],
  [
    'Packet reordering',
    'Sequence numbers + delay-compensated pacing',
    `Critical packets carry a 32-bit sequence number: the receiver delivers the first copy and discards the late duplicate, so replication adds no head-of-line delay. ` +
      `Bulk spanning two paths during a burst is paced: segments on the slower path are sent ahead by the one-way delay difference (ΔRTT / 2) so they arrive in order. ` +
      `The legacy baseline is single-path TCP: a loss stalls in-order delivery until fast retransmit or a retransmission timeout (${HOL_PARAMS.rtoMinMs}–${HOL_PARAMS.rtoMaxStallMs} ms).`,
  ],
  [
    'Carrier middleboxes & IP changes',
    'Userspace UDP tunnel to an anchor relay',
    `Every flow rides UDP to the anchor relay ${ANCHOR_IP}, which passes carrier middleboxes. The physical address changes with the network ` +
      `(e.g. Wi-Fi ${FIRST_LEASE.flexipath.wlan0} → 5G CGNAT ${FIRST_LEASE.flexipath.wwan0}), and the relay re-learns it from the tunnel packets, including after a NAT rebinding. ` +
      `Remote services only ever see ${ANCHOR_IP}, so no TCP session is reset. The legacy stack's sockets are bound to its physical address: every reattach changes its source IP.`,
  ],
];

const WHY = [
  ['01', 'Predictive', 'Acts before the current path becomes unusable: a measured signal trend projects when the path will reach its failure level.'],
  ['02', 'Traffic-aware', 'Different traffic receives different protection: critical, real-time and bulk flows are handled by their own rules.'],
  ['03', 'Selective replication', 'Critical flows can be protected without duplicating everything: copies are sent only during a risk window, only for the classes that need them.'],
  ['04', 'Explainable', 'Every major connectivity decision has a visible reason, built from the values the controller measured when it acted.'],
];

const KEYS = [
  ['Space', 'Pause / resume'],
  ['M', 'Mission ↔ Advanced view'],
  ['D', 'Start the guided demo'],
  ['X', 'Experiments (paired trials)'],
  ['I', 'Why FlexiPath? (this page)'],
  ['F / G', 'Inject Wi-Fi fade / 5G cell outage'],
  ['R', 'Reset scenario (same seed)'],
  ['1 / 2', 'Focus FlexiPath / Legacy'],
  ['C · V · T', 'Camera · ghost vehicle · theatre'],
  ['E', 'Export run as JSON'],
];

export function infoHTML() {
  const legacyPhases = LEGACY_PARAMS.stallPhases.wireless.map((p) => `${esc(p.label)} ${p.duration.toFixed(1)} s`).join(' · ');
  return `
  <div class="px-5 py-4">
    <div class="text-center">
      <div class="font-display text-[18px] font-extrabold tracking-[0.1em] text-slate-100">WHY FLEXIPATH?</div>
      <p class="mx-auto mt-2 max-w-[560px] text-[13px] leading-relaxed text-slate-300">
        FlexiPath is a predictive, traffic-aware connectivity engine for heterogeneous networks (wired, Wi-Fi, 5G, LEO satellite).
        These four mechanisms exist in the networking field; <b class="text-slate-100">FlexiPath combines them into one simulation and decision framework.</b>
      </p>
    </div>
    <div class="mt-4 grid gap-2.5 sm:grid-cols-2">
      ${WHY.map(([n, t, d]) => `<div class="why-card"><div class="n">${n}</div><h3>${esc(t.toUpperCase())}</h3><p>${esc(d)}</p></div>`).join('')}
    </div>

    <div class="mt-5 grid gap-4 md:grid-cols-2">
      <div>
        <div class="hud-label mb-2">The difference in one line</div>
        <div class="space-y-2.5">
          <div><div class="mb-1 font-mono text-[10px] font-bold tracking-[0.16em] text-legacy">LEGACY</div>
            <div class="flow-seq"><span>FAIL</span><i>→</i><span>DISCOVER ALTERNATIVE</span><i>→</i><span>SWITCH</span></div></div>
          <div><div class="mb-1 font-mono text-[10px] font-bold tracking-[0.16em] text-fp">FLEXIPATH</div>
            <div class="flow-seq"><span>DEGRADATION</span><i>→</i><span>PREDICT</span><i>→</i><span>PREPARE</span><i>→</i><span>FAILURE</span><i>→</i><span>SWITCH</span></div></div>
        </div>
        <div class="hud-label mt-4 mb-2">The loop</div>
        <ol class="space-y-1.5 text-[12px] leading-relaxed text-slate-300">
          <li><b class="text-[#00F0FF]">Detect.</b> The primary is measured at 10 Hz (loss, RTT, throughput, signal; EWMA-smoothed probes). Other modems sleep in DRX (${W[0]} W) and report signal only.</li>
          <li><b class="text-[#FACC15]">Predict.</b> A 3 s trend of the signal is extrapolated to the level where loss reaches ${(P.switchLoss * 100).toFixed(0)} %. Within ${P.watchHorizonS} s, the path is watched.</li>
          <li><b class="text-[#60A5FA]">Prepare.</b> The best alternate is woken to Warm Probe (${W[1]} W); after ${PW.warmValidateS} s of heartbeats (loss ≤ ${(P.candidateMaxLoss * 100).toFixed(0)} %, best critical score) it is validated.</li>
          <li><b class="text-repl">Replicate.</b> When time-to-failure &lt; ${P.ttfTriggerS} s (or loss, RTT drift, rapid fade), critical packets go on both paths for a ${BURST_MS} ms burst (${W[2]} W); real-time joins above ${(P.realtimeLossBudget * 100).toFixed(0)} % loss; bulk never.</li>
          <li><b class="text-slate-100">Switch.</b> At the end of the burst the validated path becomes primary and the old radio returns to DRX. An abrupt loss is a failover: ${P.failoverDetectMs} ms detection + ${PW.wakeLatencyS * 1000} ms DRX wake.</li>
          <li><b class="text-[#22C55E]">Continue.</b> Flows are tunnelled to the anchor relay ${ANCHOR_IP}, so remote services see one address and no socket is reset by a path change.</li>
        </ol>
      </div>
      <div>
        <div class="hud-label mb-2">Traffic classes</div>
        <div class="space-y-1.5">
          ${Object.values(TRAFFIC_CLASSES)
            .map(
              (c) => `<div class="flow-card"><div class="flex items-center gap-2"><span class="cls-badge cls-${c.id.toLowerCase()}">P${c.priority}${c.id === 'BULK' ? '+' : ''} · ${esc(c.label.toUpperCase())}</span><span class="text-[11px] text-slate-400">${esc(c.examples)}</span></div><div class="flow-why">${esc(c.policy)}</div></div>`,
            )
            .join('')}
        </div>
        <div class="hud-label mt-4 mb-2">Legacy baseline (model)</div>
        <p class="text-[11.5px] leading-relaxed text-slate-400">
          One interface at a time by static metric (wired &gt; Wi-Fi &gt; 5G &gt; LEO), sticky until a hard floor (Wi-Fi ${LEGACY_PARAMS.floors.wlan0} dBm,
          5G ${LEGACY_PARAMS.floors.wwan0} dBm), then break-before-make: ${legacyPhases} = ${LEGACY_WIRELESS_STALL_S.toFixed(1)} s.
        </p>
      </div>
    </div>

    <div class="mt-5">
      <div class="hud-label mb-2">Engineering objections, answered in the model</div>
      <div class="grid gap-2.5 md:grid-cols-3">
        ${OBJECTIONS.map(([q, a, d]) => `<div class="why-card"><div class="n">${esc(q.toUpperCase())}</div><h3>${esc(a)}</h3><p>${esc(d)}</p></div>`).join('')}
      </div>
      <p class="mt-2 text-[11px] leading-relaxed text-slate-500">Measured per run: summarised in the Mission view's At a glance card, in full in the Advanced view (Battery · ordering · session panel, Radio Power and Bulk HoL graphs) and in the experiment table (energy in J, duplicates discarded, HoL stalls, remote-visible IP changes).</p>
    </div>

    <div class="mt-5 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <div class="hud-label mb-2">What the numbers are</div>
      <div class="grid gap-2 text-[11.5px] leading-relaxed text-slate-400 md:grid-cols-3">
        <div>${tag('param')}<div class="mt-1">Thresholds, link capacities, RF constants, radio tier power draws, TCP timer values and the legacy recovery phases are set in the model.</div></div>
        <div>${tag('measured')}<div class="mt-1">Interruptions, packet delivery, MOS, overhead, energy, head-of-line stalls, duplicates discarded and action-vs-failure times are measured from simulated runs.</div></div>
        <div><span class="prov-tag" style="color:#94a3b8;border-color:rgba(148,163,184,.35)">REAL-WORLD MEASUREMENT</span><div class="mt-1">None. This is a simulation prototype; no hardware measurements are included.</div></div>
      </div>
    </div>

    <div class="mt-5">
      <div class="hud-label mb-2">Keyboard</div>
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11.5px] text-slate-300 sm:grid-cols-[auto_1fr_auto_1fr]">
        ${KEYS.map(([k, d]) => `<span class="kbd justify-self-start">${esc(k)}</span><span>${esc(d)}</span>`).join('')}
      </div>
      <p class="mt-3 font-mono text-[10px] leading-relaxed text-slate-500">URL: ?scenario=A&amp;seed=2026&amp;speed=90&amp;mode=advanced&amp;focus=legacy&amp;camera=overview&amp;intro=0&amp;paused=1</p>
    </div>
  </div>`;
}
