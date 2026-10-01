/**
 * ExperimentRunner.js — headless batch experiments (scenarios × speeds × seeds).
 *
 * Runs the exact same SimulationEngine as the interactive twin, without a renderer. Every run drives
 * FlexiPath and Legacy *together* on the same seed, route, RF field and fault timing, so each run is a
 * matched pair. Results are reported as measured differences (FlexiPath − Legacy) with a 95 % confidence
 * interval over the paired trials — no score, no "winner".
 *
 * Works in the browser (chunked, with progress) and in Node (scripts/benchmark.js).
 */
import { SimulationEngine, VERSION, ANCHOR_IP } from './SimulationEngine.js';
import { RunningStats, round } from '../utils/Metrics.js';
import { toCSV } from '../utils/Export.js';
import { SCENARIOS, EXPERIMENT_SCENARIOS } from './Scenarios.js';

export { SCENARIOS, EXPERIMENT_SCENARIOS };

/** Metrics shown in the paired comparison (Metric | Legacy | FlexiPath | Difference). */
export const COMPARISON_METRICS = [
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
];

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
export function runSingle({ seed, speedKmh = 60, scenario = 'mission', failSafe = true, maxSimSeconds = 900 }) {
  const engine = new SimulationEngine({ seed, speedKmh, failSafe, scenario, recordHistory: false, maxSimSeconds });
  while (!engine.completed) engine.step();
  const summary = engine.getSummary();
  return { seed: engine.config.seed, speedKmh, scenario, failSafe, simTimeS: round(engine.t, 1), ...summary };
}

export class ExperimentRunner {
  constructor({ seeds = [1, 2, 3, 4, 5], speeds = [30, 60, 90, 120], scenarios = EXPERIMENT_SCENARIOS, failSafe = true } = {}) {
    this.seeds = seeds;
    this.speeds = speeds;
    this.scenarios = scenarios;
    this.failSafe = failSafe;
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
      const run = runSingle({ ...jobs[i], failSafe: this.failSafe });
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
        aborted: !!signal?.aborted,
      },
      aggregate: ExperimentRunner.aggregate(runs),
      comparison: Object.fromEntries(this.scenarios.map((s) => [s, ExperimentRunner.paired(runs.filter((r) => r.scenario === s))])),
      runs,
    };
  }

  /** Mean / std / min / max per scenario × engine. */
  static aggregate(runs) {
    const groups = {};
    for (const run of runs) {
      for (const engine of ['flexipath', 'legacy']) {
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

  /** One CSV row per run with both engines side by side. */
  static toCSV(results) {
    const rows = results.runs.map((r) => {
      const row = { scenario: r.scenario, seed: r.seed, speed_kmh: r.speedKmh, fail_safe: r.failSafe, sim_time_s: r.simTimeS };
      for (const m of SUMMARY_METRICS) {
        row[`fp_${m}`] = r.flexipath[m];
        row[`lg_${m}`] = r.legacy[m];
      }
      return row;
    });
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
