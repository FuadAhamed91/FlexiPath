#!/usr/bin/env node
/**
 * Headless experiments: FlexiPath vs Legacy, paired by seed, across scenarios × speeds.
 *
 *   npm run benchmark                                   (scenarios A–H, 5 seeds, 30/60/90/120 km/h)
 *   npm run benchmark -- --quick                        (3 seeds, 60 km/h)
 *   npm run benchmark -- --seeds 10 --speeds 60 --scenarios A,D
 *   npm run benchmark -- --scenarios baseline,wifi-fade,cell-outage   (original matrix)
 *   npm run benchmark -- --baselines none               (no existing-mechanism baselines)
 *   npm run benchmark -- --ablations none               (no FlexiPath ablations)
 *   npm run benchmark -- --seed-block test              (held-out seeds, never used while tuning)
 *
 * Writes results/benchmark_<stamp>.json, .csv (per-run rows, every engine side by side),
 * _comparison.csv (Metric | Legacy | FlexiPath | Difference with 95 % CI), _prediction.csv (precision,
 * recall and lead time of FlexiPath's early moves), and — with the baselines modelled on existing
 * mechanisms (default: reactive multipath + always duplicate) — _mechanisms.csv, and — with the
 * ablations (default: no trend prediction, no burst, no coverage map) — _ablations.csv.
 * All numbers are measured simulation results, not real-world measurements.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentRunner, EXPERIMENT_SCENARIOS, SCENARIOS, BASELINE_ENGINES, ABLATION_ENGINES, SEED_BLOCKS, seedsFor } from '../src/simulation/ExperimentRunner.js';
import { ENGINES } from '../src/simulation/SimulationEngine.js';
import { toJSON, timestampedName } from '../src/utils/Export.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const quick = args.includes('--quick');
const seedBlock = opt('seed-block', 'dev');
if (!SEED_BLOCKS[seedBlock]) {
  console.error(`Unknown seed block: ${seedBlock} · available: ${Object.keys(SEED_BLOCKS).join(', ')}`);
  process.exit(1);
}
const seeds = seedsFor(Number(opt('seeds', quick ? 3 : 5)), SEED_BLOCKS[seedBlock].base);
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
const ablationArg = opt('ablations', ABLATION_ENGINES.join(','));
const ablations = ablationArg === 'none' ? [] : ablationArg.split(',');
const badAblation = ablations.filter((a) => !ABLATION_ENGINES.includes(a));
if (badAblation.length) {
  console.error(`Unknown ablation(s): ${badAblation.join(', ')} · available: ${ABLATION_ENGINES.join(', ')} or none`);
  process.exit(1);
}

const runner = new ExperimentRunner({ seeds, speeds, scenarios, failSafe, baselines, ablations, seedBlock });
const total = runner.plan.length;
console.log(`FlexiPath experiments · ${total} paired runs (${seeds.length} seeds × ${speeds.length} speeds × ${scenarios.length} scenarios)`);
console.log(`Seeds: ${SEED_BLOCKS[seedBlock].label} · ${seeds.join(', ')}`);
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
const pick = ['c2KeptPct', 'interruptionS', 'criticalDeliveryPct', 'meanMos', 'replicationOverheadPct', 'actionVsFailureS', 'meanPowerW', 'energyJ', 'bulkHolMeanMs', 'bulkHolPeakMs', 'bulkRtoStalls', 'remoteIpChanges', 'meanThroughputMbps'];
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
const mechPick = ['c2KeptPct', 'interruptionS', 'longestInterruptionS', 'criticalDeliveryPct', 'meanMos', 'replicationOverheadPct', 'meanPowerW', 'energyJ', 'tcpResets', 'remoteIpChanges', 'actionVsFailureS'];
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

// Ablations, same runs: FlexiPath | FlexiPath with one part switched off.
const ablPick = ['c2KeptPct', 'interruptionS', 'criticalDeliveryPct', 'criticalLost', 'meanMos', 'actionVsFailureS', 'meanPowerW', 'seamlessHandovers'];
if (results.ablation) {
  for (const scenario of scenarios) {
    console.log(`\n${scenario} · ablations (what each part of FlexiPath contributes)`);
    const rows = {};
    for (const m of results.ablation[scenario].filter((x) => ablPick.includes(x.key))) {
      rows[m.label] = Object.fromEntries(Object.entries(m.engines).map(([id, st]) => [ENGINES[id].label, fmt(st?.mean, m.digits)]));
      rows[m.label].unit = m.unit;
    }
    console.table(rows);
  }
}

// Prediction quality, pooled per scenario.
console.log('\nPrediction quality (pooled): recall = failures acted on early / all failures · precision = early moves confirmed by a failure / all early moves');
const predRows = {};
for (const scenario of scenarios) {
  for (const [id, p] of Object.entries(results.prediction[scenario] ?? {})) {
    predRows[`${scenario} · ${ENGINES[id].label}`] = {
      failures: p.pathFailures,
      'early moves': p.earlyActions,
      recall: p.recall === null ? '—' : `${(p.recall * 100).toFixed(0)} %`,
      precision: p.precision === null ? '—' : `${(p.precision * 100).toFixed(0)} %`,
      'lead (s)': fmt(p.meanLeadS, 2),
    };
  }
}
console.table(predRows);

mkdirSync(outDir, { recursive: true });
const jsonPath = resolve(outDir, timestampedName('benchmark', 'json'));
const csvPath = resolve(outDir, timestampedName('benchmark', 'csv'));
const cmpPath = resolve(outDir, timestampedName('benchmark_comparison', 'csv'));
const predPath = resolve(outDir, timestampedName('benchmark_prediction', 'csv'));
writeFileSync(jsonPath, toJSON(results));
writeFileSync(csvPath, ExperimentRunner.toCSV(results));
writeFileSync(cmpPath, ExperimentRunner.comparisonCSV(results));
writeFileSync(predPath, ExperimentRunner.predictionCSV(results));
const written = [jsonPath, csvPath, cmpPath, predPath];
if (results.mechanisms) {
  const mechPath = resolve(outDir, timestampedName('benchmark_mechanisms', 'csv'));
  writeFileSync(mechPath, ExperimentRunner.mechanismsCSV(results));
  written.push(mechPath);
}
if (results.ablation) {
  const ablPath = resolve(outDir, timestampedName('benchmark_ablations', 'csv'));
  writeFileSync(ablPath, ExperimentRunner.ablationCSV(results));
  written.push(ablPath);
}
console.log(`\n${written.map((p) => `wrote ${p}`).join('\n')}\n(${results.meta.wallTimeMs} ms wall time)`);
