#!/usr/bin/env node
/**
 * Headless experiments: FlexiPath vs Legacy, paired by seed, across scenarios × speeds.
 *
 *   npm run benchmark                                   (scenarios A–F, 5 seeds, 30/60/90/120 km/h)
 *   npm run benchmark -- --quick                        (3 seeds, 60 km/h)
 *   npm run benchmark -- --seeds 10 --speeds 60 --scenarios A,D
 *   npm run benchmark -- --scenarios baseline,wifi-fade,cell-outage   (original matrix)
 *   npm run benchmark -- --baselines none               (FlexiPath vs Legacy only)
 *
 * Writes results/benchmark_<stamp>.json, .csv (per-run rows, every engine side by side),
 * _comparison.csv (Metric | Legacy | FlexiPath | Difference with 95 % CI) and, with the baselines
 * modelled on existing mechanisms (default: reactive multipath + always duplicate), _mechanisms.csv.
 * All numbers are measured simulation results, not real-world measurements.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentRunner, EXPERIMENT_SCENARIOS, SCENARIOS, BASELINE_ENGINES, seedsFor } from '../src/simulation/ExperimentRunner.js';
import { ENGINES } from '../src/simulation/SimulationEngine.js';
import { toJSON, timestampedName } from '../src/utils/Export.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const quick = args.includes('--quick');
const seeds = seedsFor(Number(opt('seeds', quick ? 3 : 5)));
const speeds = opt('speeds', quick ? '60' : '30,60,90,120').split(',').map(Number);
const scenarios = opt('scenarios', EXPERIMENT_SCENARIOS.join(',')).split(',');
const unknown = scenarios.filter((s) => !SCENARIOS[s]);
if (unknown.length) {
  console.error(`Unknown scenario(s): ${unknown.join(', ')} · available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}
const failSafe = !args.includes('--no-failsafe');
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', opt('out', 'results'));
const baselineArg = opt('baselines', BASELINE_ENGINES.join(','));
const baselines = baselineArg === 'none' ? [] : baselineArg.split(',');
const badBaseline = baselines.filter((b) => !BASELINE_ENGINES.includes(b));
if (badBaseline.length) {
  console.error(`Unknown baseline(s): ${badBaseline.join(', ')} · available: ${BASELINE_ENGINES.join(', ')} or none`);
  process.exit(1);
}

const runner = new ExperimentRunner({ seeds, speeds, scenarios, failSafe, baselines });
const total = runner.plan.length;
console.log(`FlexiPath experiments · ${total} paired runs (${seeds.length} seeds × ${speeds.length} speeds × ${scenarios.length} scenarios)`);
console.log('All values are measured SIMULATION results (model, not hardware).');

const results = await runner.run({
  yieldEvery: 50,
  onProgress: (done) => {
    if (done % Math.max(1, Math.floor(total / 20)) === 0 || done === total) {
      process.stdout.write(`\r  progress ${String(done).padStart(4)}/${total}`);
    }
  },
});
process.stdout.write('\n');

const fmt = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pick = ['interruptionS', 'criticalDeliveryPct', 'meanMos', 'replicationOverheadPct', 'actionVsFailureS', 'meanPowerW', 'energyJ', 'bulkHolMeanMs', 'bulkHolPeakMs', 'bulkRtoStalls', 'remoteIpChanges', 'meanThroughputMbps'];
for (const scenario of scenarios) {
  const table = results.comparison[scenario].filter((m) => pick.includes(m.key));
  console.log(`\n${scenario} · ${SCENARIOS[scenario].label}`);
  const rows = {};
  for (const m of table) {
    rows[m.label] = {
      Legacy: fmt(m.legacy?.mean, m.digits),
      FlexiPath: fmt(m.flexipath?.mean, m.digits),
      'Δ (FP − LG)': m.diff ? `${m.diff.mean >= 0 ? '+' : ''}${fmt(m.diff.mean, m.digits)}${m.diff.ci95 !== null ? ` ± ${fmt(m.diff.ci95, m.digits)}` : ''}` : '—',
      unit: m.unit,
    };
  }
  console.table(rows);
}

// Existing mechanisms, same runs: Legacy | baselines | FlexiPath (means over the paired runs).
const mechPick = ['interruptionS', 'longestInterruptionS', 'criticalDeliveryPct', 'meanMos', 'replicationOverheadPct', 'meanPowerW', 'energyJ', 'tcpResets', 'remoteIpChanges', 'actionVsFailureS'];
if (results.mechanisms) {
  for (const scenario of scenarios) {
    console.log(`\n${scenario} · existing mechanisms vs FlexiPath`);
    const rows = {};
    for (const m of results.mechanisms[scenario].filter((x) => mechPick.includes(x.key))) {
      rows[m.label] = Object.fromEntries(Object.entries(m.engines).map(([id, st]) => [ENGINES[id].label, fmt(st?.mean, m.digits)]));
      rows[m.label].unit = m.unit;
    }
    console.table(rows);
  }
}

mkdirSync(outDir, { recursive: true });
const jsonPath = resolve(outDir, timestampedName('benchmark', 'json'));
const csvPath = resolve(outDir, timestampedName('benchmark', 'csv'));
const cmpPath = resolve(outDir, timestampedName('benchmark_comparison', 'csv'));
writeFileSync(jsonPath, toJSON(results));
writeFileSync(csvPath, ExperimentRunner.toCSV(results));
writeFileSync(cmpPath, ExperimentRunner.comparisonCSV(results));
const written = [jsonPath, csvPath, cmpPath];
if (results.mechanisms) {
  const mechPath = resolve(outDir, timestampedName('benchmark_mechanisms', 'csv'));
  writeFileSync(mechPath, ExperimentRunner.mechanismsCSV(results));
  written.push(mechPath);
}
console.log(`\n${written.map((p) => `wrote ${p}`).join('\n')}\n(${results.meta.wallTimeMs} ms wall time)`);
