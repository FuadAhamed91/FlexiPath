/**
 * InfoContent.js — "WHY FLEXIPATH?": what makes the approach different, how the loop decides,
 * what is a model parameter vs. a measured simulation result, and the keyboard shortcuts.
 */
import { FLEXIPATH_PARAMS } from '../simulation/FlexiPathController.js';
import { LEGACY_PARAMS, LEGACY_WIRELESS_STALL_S } from '../simulation/LegacyController.js';
import { TRAFFIC_CLASSES } from '../simulation/TrafficManager.js';
import { ANCHOR_IP } from '../simulation/SimulationEngine.js';
import { esc, tag } from './format.js';

const P = FLEXIPATH_PARAMS;

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
          <li><b class="text-[#00F0FF]">Detect.</b> Every link is measured at 10 Hz: loss, RTT, throughput, signal (EWMA-smoothed probes).</li>
          <li><b class="text-[#FACC15]">Predict.</b> A 3 s trend of the signal is extrapolated to the level where loss reaches ${(P.switchLoss * 100).toFixed(0)} %. Within ${P.watchHorizonS} s, the path is watched.</li>
          <li><b class="text-[#60A5FA]">Prepare.</b> The best alternate (critical score, loss ≤ ${(P.candidateMaxLoss * 100).toFixed(0)} %, up ≥ ${P.candidateMinUpS} s) is selected and kept validated.</li>
          <li><b class="text-repl">Replicate.</b> When time-to-failure &lt; ${P.ttfTriggerS} s (or loss, RTT drift, rapid fade), critical packets go on both paths; real-time joins above ${(P.realtimeLossBudget * 100).toFixed(0)} % loss; bulk never.</li>
          <li><b class="text-slate-100">Switch.</b> At primary loss &gt; ${(P.switchLoss * 100).toFixed(0)} % or a ${P.switchScoreRatio}× score advantage, the prepared path becomes primary.</li>
          <li><b class="text-[#22C55E]">Continue.</b> Sessions keep the anchor IP ${ANCHOR_IP}, so no socket is reset by a path change.</li>
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

    <div class="mt-5 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <div class="hud-label mb-2">What the numbers are</div>
      <div class="grid gap-2 text-[11.5px] leading-relaxed text-slate-400 md:grid-cols-3">
        <div>${tag('param')}<div class="mt-1">Thresholds, link capacities, RF constants and the legacy recovery phases are set in the model.</div></div>
        <div>${tag('measured')}<div class="mt-1">Interruptions, packet delivery, MOS, overhead and action-vs-failure times are measured from simulated runs.</div></div>
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
