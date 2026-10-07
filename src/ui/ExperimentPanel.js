/**
 * ExperimentPanel.js — "EXPERIMENTAL PROOF": controlled, paired Legacy vs FlexiPath experiments, plus the
 * baselines modelled on existing mechanisms (reactive multipath, always duplicate) on the same runs.
 *
 * Each trial runs both engines together on the same seed, route, RF field and fault timing (one
 * SimulationEngine). The table reports measured means, standard deviations and the mean paired
 * difference (FlexiPath − Legacy) with a 95 % confidence interval. No score, no winner label.
 */
import { ExperimentRunner, EXPERIMENT_SCENARIOS, SCENARIOS, seedsFor } from '../simulation/ExperimentRunner.js';
import { ENGINES } from '../simulation/SimulationEngine.js';
import { LEGACY_WIRELESS_STALL_S } from '../simulation/LegacyController.js';
import { FLEXIPATH_PARAMS } from '../simulation/FlexiPathController.js';
import { MULTIPATH_PARAMS } from '../simulation/MultipathController.js';
import { TRAFFIC_PROFILES } from '../simulation/TrafficManager.js';
import { downloadText, timestampedName, toJSON } from '../utils/Export.js';
import { esc, tag } from './format.js';

const fmtV = (v, d) => (Number.isFinite(v) ? (v < 0 ? `−${Math.abs(v).toFixed(d)}` : v.toFixed(d)) : '—');
const unitOf = (m) => (m.unit ? ` ${m.unit}` : '');
// A difference between two percentages is in percentage points.
const diffUnitOf = (m) => (m.unit === '%' ? ' pp' : unitOf(m));

function cell(stat, m) {
  if (!stat) return '<td>—</td>';
  const sd = stat.n > 1 ? ` <span class="sd">± ${fmtV(stat.sd, m.digits)}</span>` : '';
  return `<td>${fmtV(stat.mean, m.digits)}${esc(unitOf(m))}${sd}</td>`;
}

function diffCell(diff, m) {
  if (!diff) return '<td>—</td><td>—</td>';
  const v = diff.mean;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
  const ci = Number.isFinite(diff.ci95) ? `± ${fmtV(diff.ci95, m.digits)}${esc(diffUnitOf(m))}` : 'n < 2';
  return `<td class="font-semibold">${sign}${fmtV(Math.abs(v), m.digits)}${esc(diffUnitOf(m))}</td><td class="sd">${ci} <span class="text-slate-600">(n=${diff.n})</span></td>`;
}

export function comparisonTable(table) {
  const rows = table
    .filter((m) => m.legacy || m.flexipath)
    .map(
      (m) => `<tr>
        <td>${esc(m.label)}${m.note ? ` <span class="text-slate-600" title="${esc(m.note)}">ⓘ</span>` : ''}</td>
        ${cell(m.legacy, m)}${cell(m.flexipath, m)}${diffCell(m.diff, m)}
      </tr>`,
    )
    .join('');
  const notes = table.filter((m) => m.note && (m.legacy || m.flexipath)).map((m) => `${m.label}: ${m.note}.`);
  return `
    <div class="hud-scroll overflow-x-auto">
      <table class="exp-table">
        <thead><tr><th>Metric</th><th class="text-legacy!">Legacy</th><th class="text-fp!">FlexiPath</th><th>Difference (FP − LG)</th><th>95 % CI</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${notes.length ? `<p class="mt-2 font-mono text-[10px] leading-relaxed text-slate-500">${esc(notes.join(' '))}</p>` : ''}`;
}

const MECHANISM_ROWS = ['interruptionS', 'longestInterruptionS', 'criticalDeliveryPct', 'meanMos', 'replicationOverheadPct', 'meanPowerW', 'energyJ', 'tcpResets', 'remoteIpChanges', 'actionVsFailureS'];

/** Legacy | existing multipath mechanisms | FlexiPath, means over the same paired runs. */
export function mechanismsTable(table, baselines) {
  const cols = ['legacy', ...baselines.map((b) => b.id), 'flexipath'];
  const head = cols
    .map((id) => {
      const e = ENGINES[id];
      const cls = id === 'flexipath' ? 'text-fp!' : id === 'legacy' ? 'text-legacy!' : '';
      const sub = e.mechanism ? `<div class="mt-0.5 font-mono text-[9px] font-normal tracking-normal text-slate-500 normal-case">${esc(e.mechanism)}</div>` : '';
      return `<th class="${cls}">${esc(e.label)}${sub}</th>`;
    })
    .join('');
  const rows = table
    .filter((m) => MECHANISM_ROWS.includes(m.key) && Object.values(m.engines).some(Boolean))
    .map((m) => `<tr><td>${esc(m.label)}</td>${cols.map((id) => `<td>${m.engines[id] ? `${fmtV(m.engines[id].mean, m.digits)}${esc(unitOf(m))}` : '—'}</td>`).join('')}</tr>`)
    .join('');
  return `
    <div class="hud-scroll overflow-x-auto">
      <table class="exp-table">
        <thead><tr><th>Metric · mean</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function mechanismsNote() {
  const q = MULTIPATH_PARAMS;
  return `
    <p class="mt-2 text-[11px] leading-relaxed text-slate-400">
      ${tag('param')} Baselines modelled on existing mechanisms, with the legacy stack's path preference and thresholds and detection in their favour:
      reactive multipath moves traffic once the active path has lost &gt; ${(q.failLoss * 100).toFixed(0)} % for one ${Math.round(q.rtoS * 1000)} ms retransmission timeout (or dropped), after a ${Math.round(q.wakeLatencyS * 1000)} ms standby-radio wake;
      always-duplicate sends every critical and real-time packet on two paths with both radios transmitting. Sessions stay anchored for both (no socket resets). See docs/existing-mechanisms.md.
    </p>`;
}

function provenance(meta) {
  const p = FLEXIPATH_PARAMS;
  return `
    <div class="mt-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-[11px] leading-relaxed text-slate-400">
      <div class="mb-1.5 flex flex-wrap items-center gap-1.5">${tag('measured')}<span class="font-semibold text-slate-300">Measured simulation results, not real-world measurements.</span></div>
      Each trial runs FlexiPath and Legacy together on the same seed, route, RF field and fault timing, so every row compares matched pairs.
      Seeds: ${esc(meta.seeds.join(', '))} · speed ${esc(meta.speeds.join(', '))} km/h · fail-safe hover ${meta.failSafe ? 'on' : 'off'}.
      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">${tag('param')}<span>Values that come straight from the model:</span></div>
      legacy break-before-make recovery ${LEGACY_WIRELESS_STALL_S.toFixed(1)} s (detect 1.0 + attach 0.8 + DHCP 0.5 + TCP/TLS 1.5) · FlexiPath failover detection ${p.failoverDetectMs} ms · switch at ${(p.switchLoss * 100).toFixed(0)} % loss · protection trigger TTF &lt; ${p.ttfTriggerS} s.
      The interruption rows therefore reflect how <i>often</i> each stack breaks the session, with each break lasting a model-defined time.
    </div>`;
}

function matrix(results) {
  const pick = (table, key) => table.find((m) => m.key === key);
  const f = (s, d) => (s ? fmtV(s.mean, d) : '—');
  const rows = results.meta.scenarios
    .map((sc) => {
      const t = results.comparison[sc.id];
      const it = pick(t, 'interruptionS');
      const cd = pick(t, 'criticalDeliveryPct');
      const mos = pick(t, 'meanMos');
      const ov = pick(t, 'replicationOverheadPct');
      const ova = pick(t, 'replicationOverheadTotalPct');
      const avf = pick(t, 'actionVsFailureS');
      return `<tr data-scn="${sc.id}" class="cursor-pointer hover:bg-slate-900/60">
        <td><b class="text-slate-200">${esc(sc.code)}</b> · ${esc(sc.label)}</td>
        <td>${f(it.legacy, 2)} / ${f(it.flexipath, 2)}</td>
        <td>${f(cd.legacy, 1)} / ${f(cd.flexipath, 1)}</td>
        <td>${f(mos.legacy, 2)} / ${f(mos.flexipath, 2)}</td>
        <td>${f(ov.flexipath, 1)}% / ${f(ova.flexipath, 3)}%</td>
        <td>${f(avf.legacy, 1)} / ${f(avf.flexipath, 1)}</td>
      </tr>`;
    })
    .join('');
  return `
    <div class="hud-scroll overflow-x-auto">
      <table class="exp-table">
        <thead><tr><th>Scenario</th><th>Interruption s · LG / FP</th><th>Critical delivered % · LG / FP</th><th>MOS · LG / FP</th><th>FP overhead · protected / all</th><th>Action vs failure s · LG / FP</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="mt-1.5 font-mono text-[10px] text-slate-500">Means over paired trials. Click a scenario for its full table. Negative action time = acted before the path failed.</p>`;
}

/**
 * @param {import('./Dashboard.js').Dashboard} dash
 * @param {{scenario?: string, trials?: number, speed?: number, autoRun?: boolean, title?: string}} opts
 */
export function openExperiments(dash, { scenario = 'A', trials = 10, speed = null, autoRun = false, title } = {}) {
  const speedNow = speed ?? dash.engine.config.speedKmh;
  const scnOpts = [
    `<option value="__all__">All controlled scenarios (A–F)</option>`,
    ...EXPERIMENT_SCENARIOS.map((id) => `<option value="${id}" ${id === scenario ? 'selected' : ''}>${esc(`${id} · ${SCENARIOS[id].label}`)}</option>`),
    `<option value="mission" ${scenario === 'mission' ? 'selected' : ''}>Full mission · dock → LEO</option>`,
    ...['baseline', 'wifi-fade', 'cell-outage'].map((id) => `<option value="${id}" ${id === scenario ? 'selected' : ''}>${esc(`Original matrix · ${SCENARIOS[id].label}`)}</option>`),
  ].join('');
  const speeds = [30, 60, 90, 120];
  const nearest = speeds.reduce((a, b) => (Math.abs(b - speedNow) < Math.abs(a - speedNow) ? b : a), 60);

  dash.openModal(
    `
    ${dash._modalHeader(title ?? 'Experimental proof · Legacy vs FlexiPath', 'Controlled, paired experiments on the same simulation engine · measured differences, no score or winner')}
    <div class="px-5 py-4">
      <div class="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <label class="block"><div class="hud-label mb-1.5">Scenario</div><select class="toolbar-select w-full max-w-none!" name="scn">${scnOpts}</select></label>
        <label class="block"><div class="hud-label mb-1.5">Paired trials (seeds)</div>
          <select class="toolbar-select w-full max-w-none!" name="trials">${[3, 5, 10, 20].map((n) => `<option value="${n}" ${n === trials ? 'selected' : ''}>${n} trials</option>`).join('')}</select></label>
        <label class="block"><div class="hud-label mb-1.5">Speed</div>
          <select class="toolbar-select w-full max-w-none!" name="speed">${speeds.map((s) => `<option value="${s}" ${s === nearest ? 'selected' : ''}>${s} km/h</option>`).join('')}</select></label>
      </div>
      <p class="mt-2 text-[11.5px] leading-relaxed text-slate-400" data-ref="desc"></p>
      <div class="mt-3 flex items-center gap-3">
        <button type="button" class="btn btn-primary" data-act="run"><i data-lucide="flask-conical"></i>Run paired trials</button>
        <div class="meter flex-1" style="--c:#00F0FF"><span data-ref="bar"></span></div>
        <span class="num w-28 text-right text-[11px] text-slate-400" data-ref="status">idle</span>
      </div>
      <div class="mt-4" data-ref="results"></div>
    </div>`,
  );
  const body = dash.refs.modalBody;
  const q = (s) => body.querySelector(s);
  const desc = q('[data-ref="desc"]');
  const status = q('[data-ref="status"]');
  const bar = q('[data-ref="bar"]');
  const out = q('[data-ref="results"]');
  const runBtn = q('[data-act="run"]');
  const scnSel = q('[name="scn"]');

  const describe = () => {
    const id = scnSel.value;
    if (id === '__all__') {
      desc.textContent = 'Runs A–F with the same seeds: gradual, rapid and abrupt degradations, and critical-only vs bulk-only traffic.';
      return;
    }
    const sc = SCENARIOS[id];
    const faults = sc.faults.length ? ` Faults: ${sc.faults.map((f) => `${f.type} at X = ${f.atX}`).join(', ')}.` : '';
    desc.textContent = `${sc.description} Route X ${sc.startX} → ${sc.endX} · traffic: ${TRAFFIC_PROFILES[sc.traffic].label}.${faults}`;
  };
  scnSel.addEventListener('change', describe);
  describe();

  const render = (res, focus) => {
    const multi = res.meta.scenarios.length > 1;
    const show = focus ?? res.meta.scenarios[0].id;
    const sc = SCENARIOS[show];
    out.innerHTML = `
      ${multi ? `${matrix(res)}<div class="mt-4"></div>` : ''}
      <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-display text-[11px] font-bold tracking-[0.18em] text-slate-200">${esc(sc.code)} · ${esc(sc.label.toUpperCase())}</h3>
        <span class="font-mono text-[10px] text-slate-500">${res.meta.seeds.length} paired trials · ${res.meta.speeds.join(', ')} km/h · ${(res.meta.wallTimeMs / 1000).toFixed(1)} s compute</span>
      </div>
      ${comparisonTable(res.comparison[show])}
      ${
        res.mechanisms?.[show]
          ? `<div class="mt-5 mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 class="font-display text-[11px] font-bold tracking-[0.18em] text-slate-200">EXISTING MECHANISMS · SAME SEEDS</h3>
              <span class="font-mono text-[10px] text-slate-500">legacy · ${esc(res.meta.baselines.map((b) => b.label.toLowerCase()).join(' · '))} · FlexiPath</span>
            </div>
            ${mechanismsTable(res.mechanisms[show], res.meta.baselines)}
            ${mechanismsNote()}`
          : ''
      }
      ${provenance(res.meta)}
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" class="btn" data-act="json"><i data-lucide="download"></i>JSON</button>
        <button type="button" class="btn" data-act="csv"><i data-lucide="download"></i>Per-run CSV</button>
        ${res.mechanisms ? '<button type="button" class="btn" data-act="mcsv"><i data-lucide="download"></i>Mechanisms CSV</button>' : ''}
        <button type="button" class="btn btn-primary" data-act="ccsv"><i data-lucide="download"></i>Comparison CSV</button>
      </div>`;
    dash.renderIcons(out);
    out.querySelectorAll('[data-scn]').forEach((tr) => tr.addEventListener('click', () => render(res, tr.dataset.scn)));
    out.querySelector('[data-act="json"]').addEventListener('click', () => downloadText(timestampedName('flexipath_experiment', 'json'), toJSON(res), 'application/json'));
    out.querySelector('[data-act="csv"]').addEventListener('click', () => downloadText(timestampedName('flexipath_experiment_runs', 'csv'), ExperimentRunner.toCSV(res), 'text/csv'));
    out.querySelector('[data-act="ccsv"]').addEventListener('click', () =>
      downloadText(timestampedName('flexipath_experiment_comparison', 'csv'), ExperimentRunner.comparisonCSV(res), 'text/csv'),
    );
    out.querySelector('[data-act="mcsv"]')?.addEventListener('click', () =>
      downloadText(timestampedName('flexipath_experiment_mechanisms', 'csv'), ExperimentRunner.mechanismsCSV(res), 'text/csv'),
    );
  };

  const run = async () => {
    const id = scnSel.value;
    const scenarios = id === '__all__' ? EXPERIMENT_SCENARIOS : [id];
    const n = Number(q('[name="trials"]').value);
    const spd = Number(q('[name="speed"]').value);
    const runner = new ExperimentRunner({ seeds: seedsFor(n), speeds: [spd], scenarios, failSafe: dash.engine.config.failSafe });
    runBtn.disabled = true;
    out.innerHTML = '';
    dash._benchAbort = new AbortController();
    const res = await runner.run({
      signal: dash._benchAbort.signal,
      onProgress: (done, total) => {
        bar.style.width = `${(done / total) * 100}%`;
        status.textContent = `${done}/${total} trials`;
      },
    });
    dash._benchAbort = null;
    runBtn.disabled = false;
    if (dash.refs.modal.hidden || res.meta.aborted) return;
    status.textContent = `done · ${res.runs.length} trials`;
    dash.lastExperiment = res;
    render(res);
  };
  runBtn.addEventListener('click', run);
  if (autoRun) run();
}
