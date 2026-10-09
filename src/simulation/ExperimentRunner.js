/**
 * ExperimentRunner.js — headless batch experiments (scenarios × speeds × seeds).
 *
 * Runs the exact same SimulationEngine as the interactive twin, without a renderer. Every run drives
 * FlexiPath and Legacy *together* on the same seed, route, RF field and fault timing, so each run is a
 * matched pair. Results are reported as measured differences (FlexiPath − Legacy) with a 95 % confidence
 * interval over the paired trials — no score, no "winner".
 *
 * By default each run also drives the baselines modelled on existing mechanisms (reactive multipath:
 * MPTCP backup subflow / ATSSS active-standby; always duplicate: MPTCP redundant scheduler / PDCP
 * duplication) in the same engine, so the "mechanisms" table compares all four on identical conditions.
 * They never change the FlexiPath / Legacy results: each agent has its own random streams.
 *
 * Ablations (default on in the CLI) fly FlexiPath again with one part switched off — signal-trend
 * prediction, the duplication burst, the coverage map — so each part's contribution is measured on the
 * same pairs. Prediction quality (precision, recall, lead time) is pooled over all runs of a scenario.
 *
 * Seed blocks: `dev` (1000 + 7919·i) is the block FlexiPath was built and tuned on; `test`
 * (900001 + 7919·i) is a held-out block, run once to check that the results carry over to new conditions.
 *
 * Works in the browser (chunked, with progress) and in Node (scripts/benchmark.js).
 */
import { SimulationEngine, VERSION, ANCHOR_IP, ENGINES, BASELINE_ENGINES, ABLATION_ENGINES, FAILSAFE_OUTAGE_S } from './SimulationEngine.js';
import { RunningStats, round } from '../utils/Metrics.js';
import { toCSV } from '../utils/Export.js';
import { SCENARIOS, EXPERIMENT_SCENARIOS } from './Scenarios.js';

export { SCENARIOS, EXPERIMENT_SCENARIOS, BASELINE_ENGINES, ABLATION_ENGINES };

/** Seed blocks: dev = the block used while building and tuning; test = held out, run once. */
export const SEED_BLOCKS = {
  dev: { base: 1000, label: 'development seeds (used while building and tuning FlexiPath)' },
  test: { base: 900001, label: 'held-out test seeds (never used before this run)' },
};

/** Metrics shown in the paired comparison (Metric | Legacy | FlexiPath | Difference). */
export const COMPARISON_METRICS = [
  { key: 'c2KeptPct', label: 'Flights that kept the C2 link (no fail-safe hover)', unit: '%', digits: 0 },
  { key: 'interruptionS', label: 'Simulated interruption (total)', unit: 's', digits: 2 },
  { key: 'longestInterruptionS', label: 'Longest single interruption', unit: 's', digits: 2 },
  { key: 'meanRecoveryS', label: 'Recovery time per interruption', unit: 's', digits: 2, note: 'Only runs with at least one interruption' },
  { key: 'packetDeliveryPct', label: 'Packet delivery (critical + real-time)', unit: '%', digits: 2 },
  { key: 'criticalDeliveryPct', label: 'Critical packet delivery', unit: '%', digits: 2 },
  { key: 'packetLossPct', label: 'Packet loss (critical + real-time)', unit: '%', digits: 2 },
  { key: 'meanThroughputMbps', label: 'Mean throughput', unit: 'Mbps', digits: 1 },
  { key: 'meanLatencyMs', label: 'Mean critical-flow RTT', unit: 'ms', digits: 1 },
  { key: 'meanMos', label: 'Voice QoE · mean MOS (G.107)', unit: '', digits: 2 },
  { key: 'timeBelowMos36S', label: 'Time below MOS 3.6', unit: 's', digits: 1 },
  { key: 'replicationOverheadPct', label: 'Replication overhead · protected-flow bytes', unit: '%', digits: 2 },
  { key: 'replicationOverheadTotalPct', label: 'Replication overhead · all traffic bytes', unit: '%', digits: 3 },
  { key: 'actionVsFailureS', label: 'Action time vs. path failure', unit: 's', digits: 2, note: 'Negative = acted before the path failed' },
  { key: 'tcpResets', label: 'TCP connection resets', unit: '', digits: 1 },
  { key: 'journeyTimeS', label: 'Journey time', unit: 's', digits: 1 },
  { key: 'meanPowerW', label: 'Mean radio power', unit: 'W', digits: 3, note: 'Model tiers: DRX 1.2 W · warm probe 1.8 W · burst 3.4 W' },
  { key: 'energyJ', label: 'Radio energy per journey', unit: 'J', digits: 1 },
  { key: 'burstTimeS', label: 'Dual-radio burst time', unit: 's', digits: 2 },
  { key: 'duplicatesDiscarded', label: 'Duplicate packets discarded', unit: '', digits: 0 },
  { key: 'criticalHolStallMs', label: 'HoL stall · critical + real-time', unit: 'ms', digits: 1, note: 'First copy delivered on arrival' },
  { key: 'inOrderWaitMaxMs', label: 'In-order delivery would have added (max)', unit: 'ms', digits: 1 },
  { key: 'bulkHolMeanMs', label: 'HoL buffer latency · bulk (mean)', unit: 'ms', digits: 2 },
  { key: 'bulkHolPeakMs', label: 'HoL stall · bulk (peak)', unit: 'ms', digits: 0 },
  { key: 'bulkRtoStalls', label: 'TCP retransmission-timeout stalls', unit: '', digits: 1 },
  { key: 'remoteIpChanges', label: 'Client IP changes seen by remote services', unit: '', digits: 1 },
  { key: 'physicalIpChanges', label: 'Physical IP changes (radio side)', unit: '', digits: 1 },
];

/** Metrics compared across mechanisms: Legacy | Reactive multipath | Always duplicate | FlexiPath. */
export const MECHANISM_METRICS = [
  { key: 'c2KeptPct', label: 'Flights that kept the C2 link (no fail-safe hover)', unit: '%', digits: 0 },
  { key: 'interruptionS', label: 'Simulated interruption (total)', unit: 's', digits: 2 },
  { key: 'longestInterruptionS', label: 'Longest single interruption', unit: 's', digits: 2 },
  { key: 'criticalDeliveryPct', label: 'Critical packet delivery', unit: '%', digits: 2 },
  { key: 'meanMos', label: 'Voice QoE · mean MOS (G.107)', unit: '', digits: 2 },
  { key: 'timeBelowMos36S', label: 'Time below MOS 3.6', unit: 's', digits: 1 },
  { key: 'replicationOverheadPct', label: 'Duplicate bytes · protected flows', unit: '%', digits: 1 },
  { key: 'replicationOverheadTotalPct', label: 'Duplicate bytes · all traffic', unit: '%', digits: 3 },
  { key: 'meanPowerW', label: 'Mean radio power', unit: 'W', digits: 2, note: 'Model tiers: DRX 1.2 W · warm probe 1.8 W · two radios transmitting 3.4 W' },
  { key: 'energyJ', label: 'Radio energy per journey', unit: 'J', digits: 1 },
  { key: 'tcpResets', label: 'TCP connection resets', unit: '', digits: 1 },
  { key: 'remoteIpChanges', label: 'Client IP changes seen by remote services', unit: '', digits: 1 },
  { key: 'bulkHolPeakMs', label: 'HoL stall · bulk (peak)', unit: 'ms', digits: 0 },
  { key: 'actionVsFailureS', label: 'Action time vs. path failure', unit: 's', digits: 2, note: 'Negative = acted before the path failed' },
  { key: 'journeyTimeS', label: 'Journey time', unit: 's', digits: 1 },
];

/** Metrics compared across ablations: FlexiPath | FlexiPath with one part off. */
export const ABLATION_METRICS = [
  { key: 'c2KeptPct', label: 'Flights that kept the C2 link (no fail-safe hover)', unit: '%', digits: 0 },
  { key: 'interruptionS', label: 'Simulated interruption (total)', unit: 's', digits: 2 },
  { key: 'criticalDeliveryPct', label: 'Critical packet delivery', unit: '%', digits: 2 },
  { key: 'criticalLost', label: 'Critical packets lost per flight', unit: '', digits: 1 },
  { key: 'meanMos', label: 'Voice QoE · mean MOS (G.107)', unit: '', digits: 2 },
  { key: 'timeBelowMos36S', label: 'Time below MOS 3.6', unit: 's', digits: 1 },
  { key: 'actionVsFailureS', label: 'Action time vs. path failure', unit: 's', digits: 2, note: 'Negative = acted before the path failed' },
  { key: 'bulkHolPeakMs', label: 'HoL stall · bulk (peak)', unit: 'ms', digits: 0 },
  { key: 'meanThroughputMbps', label: 'Mean throughput', unit: 'Mbps', digits: 1 },
  { key: 'replicationOverheadPct', label: 'Duplicate bytes · protected flows', unit: '%', digits: 2 },
  { key: 'meanPowerW', label: 'Mean radio power', unit: 'W', digits: 3 },
  { key: 'seamlessHandovers', label: 'Path changes (seamless)', unit: '', digits: 1 },
];

/** Engines present in a run summary, in display order (FlexiPath, Legacy, then any baselines). */
const enginesOf = (run) => Object.keys(ENGINES).filter((id) => run[id]);

export const SUMMARY_METRICS = [
  'interruptionS',
  'interruptionEvents',
  'longestInterruptionS',
  'meanRecoveryS',
  'stallTimeS',
  'stallEvents',
  'packetDeliveryPct',
  'packetLossPct',
  'criticalDeliveryPct',
  'criticalLost',
  'criticalLossPct',
  'realtimeDeliveryPct',
  'meanMos',
  'minMos',
  'timeBelowMos36S',
  'meanLatencyMs',
  'meanThroughputMbps',
  'seamlessHandovers',
  'breakBeforeMakeHandovers',
  'unplannedFailovers',
  'tcpResets',
  'replicationTimeS',
  'replicationOverheadPct',
  'replicationOverheadTotalPct',
  'duplicatesDiscarded',
  'actionVsFailureS',
  'pathFailures',
  'predictedFailures',
  'falseAlarms',
  'journeyTimeS',
  'meanPowerW',
  'energyJ',
  'peakPowerW',
  'warmTimeS',
  'burstTimeS',
  'bursts',
  'radioWakes',
  'probeBytes',
  'criticalHolStallMs',
  'inOrderWaitMeanMs',
  'inOrderWaitMaxMs',
  'reorderedArrivals',
  'bulkHolMeanMs',
  'bulkHolUnpacedMeanMs',
  'bulkHolPeakMs',
  'bulkRtoStalls',
  'pacingMaxOffsetMs',
  'physicalIpChanges',
  'remoteIpChanges',
  'tunnelRebinds',
  'natRebinds',
  // Added with the coverage map and the ablation study (appended so earlier columns keep their order).
  'c2KeptPct',
  'failSafeStops',
  'abruptFailures',
  'earlyActions',
  'earlyActionsConfirmed',
];

// Two-sided 95 % Student-t critical values, df = 1…30 (df > 30 → 1.96).
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12,
  2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];
export const tCritical95 = (df) => (df < 1 ? NaN : df <= 30 ? T95[df - 1] : 1.96);

/** Seeds used for a batch: deterministic and well spread. */
export const seedsFor = (n, base = 1000) => Array.from({ length: n }, (_, i) => base + i * 7919);

/** Run one scenario to completion and return its summary. */
export function runSingle({ seed, speedKmh = 60, scenario = 'mission', failSafe = true, failSafeS = FAILSAFE_OUTAGE_S, maxSimSeconds = 900, baselines = [], ablations = [] }) {
  const agents = ['flexipath', 'legacy', ...baselines, ...ablations];
  const engine = new SimulationEngine({ seed, speedKmh, failSafe, failSafeS, scenario, recordHistory: false, maxSimSeconds, agents });
  while (!engine.completed) engine.step();
  const summary = engine.getSummary();
  return { seed: engine.config.seed, speedKmh, scenario, failSafe, simTimeS: round(engine.t, 1), ...summary };
}

export class ExperimentRunner {
  constructor({
    seeds = [1, 2, 3, 4, 5],
    speeds = [30, 60, 90, 120],
    scenarios = EXPERIMENT_SCENARIOS,
    failSafe = true,
    failSafeS = FAILSAFE_OUTAGE_S,
    baselines = BASELINE_ENGINES,
    ablations = [],
    seedBlock = null,
  } = {}) {
    this.seeds = seeds;
    this.speeds = speeds;
    this.scenarios = scenarios;
    this.failSafe = failSafe;
    this.failSafeS = failSafeS;
    this.baselines = baselines.filter((id) => BASELINE_ENGINES.includes(id));
    this.ablations = ablations.filter((id) => ABLATION_ENGINES.includes(id));
    this.seedBlock = seedBlock;
  }

  get plan() {
    const jobs = [];
    for (const scenario of this.scenarios)
      for (const speedKmh of this.speeds) for (const seed of this.seeds) jobs.push({ scenario, speedKmh, seed });
    return jobs;
  }

  /**
   * @param {{onProgress?: (done:number, total:number, run:object)=>void, yieldEvery?: number, signal?: AbortSignal}} opts
   */
  async run({ onProgress, yieldEvery = 1, signal } = {}) {
    const jobs = this.plan;
    const runs = [];
    const started = Date.now();
    for (let i = 0; i < jobs.length; i++) {
      if (signal?.aborted) break;
      const run = runSingle({ ...jobs[i], failSafe: this.failSafe, failSafeS: this.failSafeS, baselines: this.baselines, ablations: this.ablations });
      runs.push(run);
      onProgress?.(i + 1, jobs.length, run);
      if ((i + 1) % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return {
      meta: {
        project: 'FlexiPath',
        version: VERSION,
        dataSource: 'simulation',
        note: 'Measured simulation results. Each run is a matched pair: FlexiPath and Legacy on the same seed, route, RF field and fault timing.',
        anchorIp: ANCHOR_IP,
        generatedAt: new Date().toISOString(),
        wallTimeMs: Date.now() - started,
        seeds: this.seeds,
        speeds: this.speeds,
        scenarios: this.scenarios.map((s) => SCENARIOS[s]),
        failSafe: this.failSafe,
        failSafeS: this.failSafeS,
        baselines: this.baselines.map((id) => ({ id, label: ENGINES[id].label, mechanism: ENGINES[id].mechanism })),
        ablations: this.ablations.map((id) => ({ id, label: ENGINES[id].label, ablation: ENGINES[id].ablation })),
        seedBlock: this.seedBlock,
        aborted: !!signal?.aborted,
      },
      aggregate: ExperimentRunner.aggregate(runs),
      comparison: Object.fromEntries(this.scenarios.map((s) => [s, ExperimentRunner.paired(runs.filter((r) => r.scenario === s))])),
      mechanisms: this.baselines.length
        ? Object.fromEntries(this.scenarios.map((s) => [s, ExperimentRunner.mechanisms(runs.filter((r) => r.scenario === s), this.baselines)]))
        : null,
      ablation: this.ablations.length
        ? Object.fromEntries(this.scenarios.map((s) => [s, ExperimentRunner.ablation(runs.filter((r) => r.scenario === s), this.ablations)]))
        : null,
      prediction: Object.fromEntries(
        this.scenarios.map((s) => [s, ExperimentRunner.prediction(runs.filter((r) => r.scenario === s), ['flexipath', ...this.ablations])]),
      ),
      runs,
    };
  }

  /**
   * Ablation study over matched runs: FlexiPath and each variant with one part off, and the paired
   * difference FlexiPath − variant (what that part contributes) with its 95 % confidence interval.
   */
  static ablation(runs, ablations = ABLATION_ENGINES, metrics = ABLATION_METRICS) {
    const engines = ['flexipath', ...ablations];
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    return metrics.map((m) => {
      const stats = Object.fromEntries(engines.map((id) => [id, new RunningStats()]));
      const diffs = Object.fromEntries(ablations.map((id) => [id, new RunningStats()]));
      for (const r of runs) {
        const fp = r.flexipath?.[m.key];
        for (const id of engines) {
          const v = r[id]?.[m.key];
          if (num(v)) stats[id].push(v);
          if (diffs[id] && num(v) && num(fp)) diffs[id].push(fp - v);
        }
      }
      return {
        ...m,
        engines: Object.fromEntries(engines.map((id) => [id, stats[id].count ? { mean: stats[id].mean, sd: stats[id].std, n: stats[id].count } : null])),
        diff: Object.fromEntries(
          Object.entries(diffs).map(([id, d]) => {
            const n = d.count;
            return [id, n ? { mean: d.mean, sd: d.std, n, ci95: n > 1 ? tCritical95(n - 1) * (d.std / Math.sqrt(n)) : null } : null];
          }),
        ),
      };
    });
  }

  /**
   * Prediction quality, pooled over every run of a scenario:
   *   recall    = path failures acted on before they happened / all path failures (abrupt ones included)
   *   precision = early moves the path's later failure confirmed / all early moves
   *   lead time = mean time from the action to the failure, over failures acted on early
   */
  static prediction(runs, engines = ['flexipath']) {
    const out = {};
    for (const id of engines) {
      const sum = { runs: 0, pathFailures: 0, predictedFailures: 0, abruptFailures: 0, earlyActions: 0, earlyActionsConfirmed: 0 };
      const lead = new RunningStats();
      for (const r of runs) {
        const s = r[id];
        if (!s) continue;
        sum.runs++;
        for (const k of ['pathFailures', 'predictedFailures', 'abruptFailures', 'earlyActions', 'earlyActionsConfirmed']) sum[k] += s[k] ?? 0;
        if (typeof s.actionVsFailureS === 'number' && Number.isFinite(s.actionVsFailureS)) lead.push(-s.actionVsFailureS);
      }
      if (!sum.runs) continue;
      out[id] = {
        ...sum,
        recall: sum.pathFailures ? sum.predictedFailures / sum.pathFailures : null,
        precision: sum.earlyActions ? sum.earlyActionsConfirmed / sum.earlyActions : null,
        meanLeadS: lead.count ? lead.mean : null,
      };
    }
    return out;
  }

  /** Ablation study as flat CSV rows (one per scenario × metric). */
  static ablationCSV(results) {
    const rows = [];
    for (const [scenario, table] of Object.entries(results.ablation ?? {})) {
      for (const m of table) {
        const row = { scenario, metric: m.key, label: m.label, unit: m.unit };
        for (const [id, st] of Object.entries(m.engines)) {
          row[`${id}_mean`] = st?.mean ?? null;
          row[`${id}_sd`] = st?.sd ?? null;
        }
        for (const [id, d] of Object.entries(m.diff)) {
          row[`fp_minus_${id}`] = d?.mean ?? null;
          row[`fp_minus_${id}_ci95`] = d?.ci95 ?? null;
        }
        row.pairs = m.engines.flexipath?.n ?? 0;
        rows.push(row);
      }
    }
    return toCSV(rows);
  }

  /** Prediction quality as flat CSV rows (one per scenario × FlexiPath variant). */
  static predictionCSV(results) {
    const rows = [];
    for (const [scenario, table] of Object.entries(results.prediction ?? {})) {
      for (const [engine, p] of Object.entries(table)) rows.push({ scenario, engine, ...p });
    }
    return toCSV(rows);
  }

  /** Mean / std / min / max per scenario × engine. */
  static aggregate(runs) {
    const groups = {};
    for (const run of runs) {
      for (const engine of enginesOf(run)) {
        const key = `${run.scenario}|${engine}`;
        groups[key] ??= { scenario: run.scenario, engine, runs: 0, metrics: {} };
        const g = groups[key];
        g.runs++;
        for (const m of SUMMARY_METRICS) {
          g.metrics[m] ??= new RunningStats();
          const v = run[engine][m];
          if (typeof v === 'number') g.metrics[m].push(v);
        }
      }
    }
    return Object.values(groups).map((g) => ({
      scenario: g.scenario,
      engine: g.engine,
      runs: g.runs,
      ...Object.fromEntries(Object.entries(g.metrics).map(([m, s]) => [m, s.toJSON()])),
    }));
  }

  /**
   * Paired comparison over matched runs: per metric, Legacy and FlexiPath mean ± sd and the mean of the
   * per-run differences (FlexiPath − Legacy) with its 95 % confidence interval.
   */
  static paired(runs, metrics = COMPARISON_METRICS) {
    return metrics.map((m) => {
      const lg = new RunningStats();
      const fp = new RunningStats();
      const diff = new RunningStats();
      for (const r of runs) {
        const a = r.legacy[m.key];
        const b = r.flexipath[m.key];
        if (typeof a === 'number' && Number.isFinite(a)) lg.push(a);
        if (typeof b === 'number' && Number.isFinite(b)) fp.push(b);
        if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) diff.push(b - a);
      }
      const n = diff.count;
      const half = n > 1 ? tCritical95(n - 1) * (diff.std / Math.sqrt(n)) : null;
      return {
        ...m,
        legacy: lg.count ? { mean: lg.mean, sd: lg.std, n: lg.count } : null,
        flexipath: fp.count ? { mean: fp.mean, sd: fp.std, n: fp.count } : null,
        diff: n ? { mean: diff.mean, sd: diff.std, n, ci95: half } : null,
      };
    });
  }

  /**
   * Mechanism comparison over matched runs: per metric, every engine's mean ± sd and the mean paired
   * difference FlexiPath − engine with its 95 % confidence interval.
   */
  static mechanisms(runs, baselines = BASELINE_ENGINES, metrics = MECHANISM_METRICS) {
    const engines = ['legacy', ...baselines, 'flexipath'];
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    return metrics.map((m) => {
      const stats = Object.fromEntries(engines.map((id) => [id, new RunningStats()]));
      const diffs = Object.fromEntries(engines.filter((id) => id !== 'flexipath').map((id) => [id, new RunningStats()]));
      for (const r of runs) {
        const fp = r.flexipath?.[m.key];
        for (const id of engines) {
          const v = r[id]?.[m.key];
          if (num(v)) stats[id].push(v);
          if (diffs[id] && num(v) && num(fp)) diffs[id].push(fp - v);
        }
      }
      const engineStats = Object.fromEntries(
        engines.map((id) => [id, stats[id].count ? { mean: stats[id].mean, sd: stats[id].std, n: stats[id].count } : null]),
      );
      const diff = Object.fromEntries(
        Object.entries(diffs).map(([id, d]) => {
          const n = d.count;
          return [id, n ? { mean: d.mean, sd: d.std, n, ci95: n > 1 ? tCritical95(n - 1) * (d.std / Math.sqrt(n)) : null } : null];
        }),
      );
      return { ...m, engines: engineStats, diff };
    });
  }

  /**
   * Reliability per extra watt, between neighbours on the power axis: the paired mean gain in critical delivery (pp)
   * divided by the paired mean extra radio power (W). FlexiPath over reactive multipath, and always duplicate over
   * FlexiPath. Needs the `mptcp` and `redundant` baselines; scenarios without C2 traffic (F) are left out.
   */
  static efficiency(results) {
    const out = {};
    for (const [scenario, table] of Object.entries(results.mechanisms ?? {})) {
      const delivery = table.find((m) => m.key === 'criticalDeliveryPct');
      const power = table.find((m) => m.key === 'meanPowerW');
      if (!delivery?.engines.flexipath || !power) continue;
      const step = (gainPp, extraW) =>
        Number.isFinite(gainPp) && Number.isFinite(extraW) && extraW > 0 ? { gainPp, extraW, ppPerW: gainPp / extraW } : null;
      // `diff` holds FlexiPath − engine, so the step from FlexiPath up to always duplicate flips its sign.
      const row = {
        flexipathOverReactive: step(delivery.diff.mptcp?.mean, power.diff.mptcp?.mean),
        duplicateOverFlexipath: step(-delivery.diff.redundant?.mean, -power.diff.redundant?.mean),
      };
      if (row.flexipathOverReactive || row.duplicateOverFlexipath) out[scenario] = row;
    }
    return out;
  }

  /** Reliability per extra watt as flat CSV rows (one per scenario). */
  static efficiencyCSV(results) {
    const rows = Object.entries(ExperimentRunner.efficiency(results)).map(([scenario, e]) => ({
      scenario,
      fp_over_mp_delivery_pp: e.flexipathOverReactive?.gainPp ?? null,
      fp_over_mp_power_w: e.flexipathOverReactive?.extraW ?? null,
      fp_over_mp_pp_per_w: e.flexipathOverReactive?.ppPerW ?? null,
      rd_over_fp_delivery_pp: e.duplicateOverFlexipath?.gainPp ?? null,
      rd_over_fp_power_w: e.duplicateOverFlexipath?.extraW ?? null,
      rd_over_fp_pp_per_w: e.duplicateOverFlexipath?.ppPerW ?? null,
    }));
    return toCSV(rows);
  }

  /** One CSV row per run with every engine side by side (fp_, lg_, then mp_ / rd_ for the baselines). */
  static toCSV(results) {
    const rows = results.runs.map((r) => {
      const row = { scenario: r.scenario, seed: r.seed, speed_kmh: r.speedKmh, fail_safe: r.failSafe, sim_time_s: r.simTimeS };
      const prefixes = enginesOf(r).map((id) => [id, ENGINES[id].short.toLowerCase()]);
      for (const m of SUMMARY_METRICS) for (const [id, px] of prefixes) row[`${px}_${m}`] = r[id][m];
      return row;
    });
    return toCSV(rows);
  }

  /** Mechanism comparison as flat CSV rows (one per scenario × metric). */
  static mechanismsCSV(results) {
    const rows = [];
    for (const [scenario, table] of Object.entries(results.mechanisms ?? {})) {
      for (const m of table) {
        const row = { scenario, metric: m.key, label: m.label, unit: m.unit };
        for (const [id, st] of Object.entries(m.engines)) {
          row[`${id}_mean`] = st?.mean ?? null;
          row[`${id}_sd`] = st?.sd ?? null;
        }
        for (const [id, d] of Object.entries(m.diff)) {
          row[`fp_minus_${id}`] = d?.mean ?? null;
          row[`fp_minus_${id}_ci95`] = d?.ci95 ?? null;
        }
        row.pairs = m.engines.flexipath?.n ?? 0;
        rows.push(row);
      }
    }
    return toCSV(rows);
  }

  /** Paired comparison as flat CSV rows (one per scenario × metric). */
  static comparisonCSV(results) {
    const rows = [];
    for (const [scenario, table] of Object.entries(results.comparison ?? {})) {
      for (const m of table) {
        rows.push({
          scenario,
          metric: m.key,
          label: m.label,
          unit: m.unit,
          legacy_mean: m.legacy?.mean ?? null,
          legacy_sd: m.legacy?.sd ?? null,
          flexipath_mean: m.flexipath?.mean ?? null,
          flexipath_sd: m.flexipath?.sd ?? null,
          diff_mean: m.diff?.mean ?? null,
          diff_ci95: m.diff?.ci95 ?? null,
          pairs: m.diff?.n ?? 0,
        });
      }
    }
    return toCSV(rows);
  }

  /** Compact aggregate table (means) for console / UI display. */
  static table(results, metrics = ['interruptionS', 'criticalLossPct', 'meanMos', 'timeBelowMos36S', 'tcpResets']) {
    return results.aggregate.map((a) => ({
      scenario: a.scenario,
      engine: a.engine,
      runs: a.runs,
      ...Object.fromEntries(metrics.map((m) => [m, a[m]?.mean])),
    }));
  }
}
