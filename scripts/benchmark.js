#!/usr/bin/env node
/**
 * Headless benchmark: FlexiPath vs Legacy across seeds × speeds × scenarios.
 *
 *   npm run benchmark
 *   npm run benchmark -- --seeds 10 --speeds 30,60,90,120 --scenarios baseline,wifi-fade,cell-outage
 *   npm run benchmark -- --quick          (3 seeds, 60 km/h, all scenarios)
 *
 * Writes results/benchmark_<stamp>.json and .csv (per-run rows, both engines side by side).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentRunner, SCENARIOS } from '../src/simulation/ExperimentRunner.js';
import { toJSON, timestampedName } from '../src/utils/Export.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const quick = args.includes('--quick');
const nSeeds = Number(opt('seeds', quick ? 3 : 5));
const seeds = Array.from({ length: nSeeds }, (_, i) => 1000 + i * 7919);
const speeds = opt('speeds', quick ? '60' : '30,60,90,120').split(',').map(Number);
const scenarios = opt('scenarios', Object.keys(SCENARIOS).join(',')).split(',');
const failSafe = !args.includes('--no-failsafe');
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', opt('out', 'results'));

const runner = new ExperimentRunner({ seeds, speeds, scenarios, failSafe });
const total = runner.plan.length;
console.log(`FlexiPath benchmark · ${total} runs (${seeds.length} seeds × ${speeds.length} speeds × ${scenarios.length} scenarios)`);

const results = await runner.run({
  yieldEvery: 50,
  onProgress: (done) => {
    if (done % Math.max(1, Math.floor(total / 20)) === 0 || done === total) {
      process.stdout.write(`\r  progress ${String(done).padStart(4)}/${total}`);
    }
  },
});
process.stdout.write('\n');

const fmt = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '—');
const rows = {};
for (const a of results.aggregate) {
  rows[`${a.scenario} · ${a.engine}`] = {
    runs: a.runs,
    'stall s': fmt(a.stallTimeS.mean),
    'crit loss %': fmt(a.criticalLossPct.mean, 3),
    'mean MOS': fmt(a.meanMos.mean, 3),
    'min MOS': fmt(a.minMos.mean, 2),
    's < MOS 3.6': fmt(a.timeBelowMos36S.mean, 1),
    'TCP RST': fmt(a.tcpResets.mean, 1),
    'hot-swaps': fmt(a.seamlessHandovers.mean, 1),
    'journey s': fmt(a.journeyTimeS.mean, 1),
  };
}
console.table(rows);

mkdirSync(outDir, { recursive: true });
const jsonPath = resolve(outDir, timestampedName('benchmark', 'json'));
const csvPath = resolve(outDir, timestampedName('benchmark', 'csv'));
writeFileSync(jsonPath, toJSON(results));
writeFileSync(csvPath, ExperimentRunner.toCSV(results));
console.log(`wrote ${jsonPath}\nwrote ${csvPath}\n(${results.meta.wallTimeMs} ms wall time)`);
