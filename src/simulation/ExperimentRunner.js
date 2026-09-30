/**
 * ExperimentRunner.js — headless batch benchmark (seeds × speeds × scenarios).
 *
 * Runs the exact same SimulationEngine as the interactive twin, without a
 * renderer, and aggregates FlexiPath vs Legacy results for submission tables.
 * Works in the browser (chunked, with progress) and in Node (scripts/benchmark.js).
 */
import { SimulationEngine, VERSION, ANCHOR_IP } from './SimulationEngine.js';
import { RunningStats, round } from '../utils/Metrics.js';
import { toCSV } from '../utils/Export.js';

export const SCENARIOS = {
  baseline: { id: 'baseline', label: 'Baseline drive (4 zones)', faults: [] },
  'wifi-fade': { id: 'wifi-fade', label: 'Rapid Wi-Fi fade at X = 20', faults: [{ type: 'wifi-fade', atX: 20 }] },
  'cell-outage': { id: 'cell-outage', label: '5G cell outage at X = 125', faults: [{ type: 'cell-outage', atX: 125 }] },
};

export const SUMMARY_METRICS = [
  'stallTimeS',
  'stallEvents',
  'criticalLost',
  'criticalLossPct',
  'meanMos',
  'minMos',
  'timeBelowMos36S',
  'meanLatencyMs',
  'meanThroughputMbps',
  'seamlessHandovers',
  'breakBeforeMakeHandovers',
  'tcpResets',
  'replicationTimeS',
  'replicationOverheadPct',
  'duplicatesDiscarded',
  'journeyTimeS',
];

/** Run one scenario to completion and return its summary. */
export function runSingle({ seed, speedKmh = 60, scenario = 'baseline', failSafe = true, maxSimSeconds = 900 }) {
  const engine = new SimulationEngine({ seed, speedKmh, failSafe, recordHistory: false, maxSimSeconds });
  const pending = [...(SCENARIOS[scenario]?.faults ?? [])];
  while (!engine.completed) {
    const x = engine.agents.flexipath.mobility.state.cx;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (x >= pending[i].atX) {
        engine.injectFault(pending[i].type);
        pending.splice(i, 1);
      }
    }
    engine.step();
  }
  const summary = engine.getSummary();
  return { seed: engine.config.seed, speedKmh, scenario, failSafe, simTimeS: round(engine.t, 1), ...summary };
}

export class ExperimentRunner {
  constructor({
    seeds = [1, 2, 3, 4, 5],
    speeds = [30, 60, 90, 120],
    scenarios = Object.keys(SCENARIOS),
    failSafe = true,
  } = {}) {
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
        anchorIp: ANCHOR_IP,
        generatedAt: new Date().toISOString(),
        wallTimeMs: Date.now() - started,
        seeds: this.seeds,
        speeds: this.speeds,
        scenarios: this.scenarios.map((s) => SCENARIOS[s]),
        failSafe: this.failSafe,
      },
      aggregate: ExperimentRunner.aggregate(runs),
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

  /** Compact aggregate table (means) for console / UI display. */
  static table(results, metrics = ['stallTimeS', 'criticalLossPct', 'meanMos', 'timeBelowMos36S', 'tcpResets']) {
    return results.aggregate.map((a) => ({
      scenario: a.scenario,
      engine: a.engine,
      runs: a.runs,
      ...Object.fromEntries(metrics.map((m) => [m, a[m]?.mean])),
    }));
  }
}
