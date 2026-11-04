/**
 * Regression: a quick benchmark must reproduce the README's five-stack comparison tables ("Comparison with existing
 * mechanisms": held-out seeds, speed-consistent hover rule) within the tolerances below.
 *
 * Quick run: 3 held-out seeds (`seedBlock: 'test'`, the block those tables use) × 60 and 90 km/h × A–H, every engine
 * (48 paired runs). The README numbers come from the full held-out benchmark (5 seeds × 30/60/90/120 km/h). Two speeds
 * are needed, not one: the hover rule is 300 ms at ≤ 60 km/h and 1 s above, so "kept C2" is a step in speed (reactive
 * multipath hovers at ≤ 60 km/h in D, G and H and keeps C2 above: 50 % over four speeds, 0 % at 60 km/h alone). 60 + 90
 * km/h sample both sides equally. The tolerances cover the sampling difference (3 of 5 seeds, 2 of 4 speeds) and
 * nothing more.
 *
 * Opt-in (`npm run test:full`, which sets FLEXIPATH_FULL=1): every full benchmark archived in results/published/ (see
 * its MANIFEST.md) must reproduce its CSVs byte for byte.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentRunner, BASELINE_ENGINES, ABLATION_ENGINES, EXPERIMENT_SCENARIOS, SEED_BLOCKS, seedsFor } from '../src/simulation/ExperimentRunner.js';
import { POWER_PARAMS } from '../src/simulation/PowerModel.js';
import { MULTIPATH_PARAMS } from '../src/simulation/MultipathController.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// README cell order: Legacy · Reactive multipath · Reactive multipath, 60 ms detection · Always duplicate · FlexiPath
const STACKS = ['legacy', 'mptcp', 'mptcpFast', 'redundant', 'flexipath'];
const TABLE_MARKER = 'Each cell reads **Legacy · Reactive multipath · Reactive multipath, 60 ms detection · Always duplicate · FlexiPath**';
const rel = (f, floor) => (_s, ref) => Math.max(floor, f * Math.abs(ref));

// The two README tables after the marker, column by column: metric key and allowed |quick − README| per stack.
// Largest deviation seen when the tolerances were set (quick vs README) in brackets.
const TABLES = [
  [
    // One flight of the 6 per scenario hovers or not: mptcpFast in D (100 vs 95), always duplicate in G (83 vs 80).
    // Legacy (always hovers), reactive multipath (hovers exactly at ≤ 60 km/h) and FlexiPath (never) must match exactly.
    { key: 'c2KeptPct', tol: (s) => (s === 'mptcpFast' || s === 'redundant' ? 10 : 0) },
    { key: 'longestInterruptionS', tol: () => 0.05 }, // [0.033 s: FlexiPath H 0.133 vs 0.10]
    { key: 'criticalDeliveryPct', tol: (s) => (s === 'legacy' ? 2.0 : 0.4) }, // [legacy 1.45, others 0.25 pp]
    { key: 'meanMos', tol: (s) => (s === 'legacy' ? 0.1 : 0.05) }, // [legacy 0.07, others 0.027]
  ],
  [
    { key: 'meanThroughputMbps', tol: rel(0.08, 0.1) }, // [6.5 % in D, every stack]
    { key: 'meanPowerW', tol: () => 0.05 }, // [0.028 W]
    // Energy per journey scales with journey time, so it depends on speed: 60 + 90 km/h fly faster than the
    // four-speed mean (30–120 km/h). [23 % in D] The power column above is the speed-independent check.
    { key: 'energyJ', tol: rel(0.3, 0.5) },
    { key: 'replicationOverheadPct', tol: rel(0.12, 0.3) }, // [7.8 %: always duplicate D, FlexiPath G]
  ],
];

/** Parse the README's two five-stack tables (held-out seeds) into { scenario: { metric: { stack: value } } }. */
function readmeMechanismTables() {
  const lines = readFileSync(resolve(ROOT, 'README.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes(TABLE_MARKER));
  expect(start, 'README five-stack tables not found').toBeGreaterThan(-1);
  const table = {};
  let t = -1;
  for (const line of lines.slice(start)) {
    if (line.startsWith('| Scenario |')) {
      if (++t >= TABLES.length) break;
      continue;
    }
    const m = line.match(/^\| ([A-H]) · /);
    if (!m) {
      if (t === TABLES.length - 1 && table.H && !line.startsWith('|')) break;
      continue;
    }
    const cells = line.split('|').slice(2, -1).map((c) => c.trim().replace(/\*\*/g, ''));
    table[m[1]] ??= {};
    TABLES[t].forEach((col, i) => {
      const parts = cells[i].split('·').map((p) => Number.parseFloat(p.trim().replace('−', '-')));
      table[m[1]][col.key] = parts.length === STACKS.length && parts.every(Number.isFinite) ? Object.fromEntries(STACKS.map((s, j) => [s, parts[j]])) : null;
    });
  }
  expect(t, 'README: both five-stack tables after the marker').toBe(TABLES.length - 1);
  return table;
}

const byKey = (results, s) => Object.fromEntries(results.mechanisms[s].map((x) => [x.key, x.engines]));

describe('quick benchmark reproduces the README', () => {
  let results;
  let readme;
  beforeAll(async () => {
    readme = readmeMechanismTables();
    const runner = new ExperimentRunner({
      seeds: seedsFor(3, SEED_BLOCKS.test.base),
      speeds: [60, 90],
      baselines: BASELINE_ENGINES,
      ablations: ABLATION_ENGINES,
      seedBlock: 'test',
    });
    results = await runner.run({ yieldEvery: 1e9 });
  });

  it('the README tables list A–H; the comparison has five engines', () => {
    expect(Object.keys(readme)).toEqual(EXPERIMENT_SCENARIOS);
    expect(BASELINE_ENGINES).toEqual(['mptcp', 'mptcpFast', 'redundant']);
  });

  for (const scenario of EXPERIMENT_SCENARIOS) {
    it(`${scenario}: five-stack numbers within tolerance`, () => {
      const metrics = Object.fromEntries(results.mechanisms[scenario].map((m) => [m.key, m]));
      for (const col of TABLES.flat()) {
        const ref = readme[scenario][col.key];
        if (!ref) continue; // "—" in the README (F has no C2 traffic)
        for (const stack of STACKS) {
          const got = metrics[col.key].engines[stack]?.mean;
          const tol = col.tol(stack, ref[stack]);
          expect(Math.abs(got - ref[stack]), `${scenario} ${col.key} ${stack}: quick ${got} vs README ${ref[stack]} (±${tol})`).toBeLessThanOrEqual(tol + 1e-9);
        }
      }
    });
  }

  it('the headline claims hold in the quick run', () => {
    for (const s of ['A', 'B', 'E']) {
      const m = byKey(results, s);
      expect(m.longestInterruptionS.legacy.mean, s).toBeCloseTo(3.8, 6); // the 3.8 s wireless break
      expect(m.interruptionS.flexipath.mean, s).toBe(0);
    }
    expect(byKey(results, 'C').interruptionS.flexipath.mean).toBe(0);
    for (const s of ['A', 'B', 'C', 'D', 'E', 'G', 'H']) {
      const m = byKey(results, s);
      expect(m.c2KeptPct.legacy.mean, `${s}: legacy hovers on every flight`).toBe(0);
      expect(m.c2KeptPct.flexipath.mean, `${s}: FlexiPath keeps C2 on every flight`).toBe(100);
      // Delivery order: always duplicate > FlexiPath > reactive 60 ms ≥ reactive 250 ms.
      expect(m.criticalDeliveryPct.redundant.mean, s).toBeGreaterThan(m.criticalDeliveryPct.flexipath.mean);
      expect(m.criticalDeliveryPct.flexipath.mean, s).toBeGreaterThan(m.criticalDeliveryPct.mptcpFast.mean);
      expect(m.criticalDeliveryPct.mptcpFast.mean, s).toBeGreaterThanOrEqual(m.criticalDeliveryPct.mptcp.mean);
      // Power: always duplicate draws more than twice FlexiPath; FlexiPath pays a little over reactive multipath.
      expect(m.meanPowerW.redundant.mean, s).toBeGreaterThan(2 * m.meanPowerW.flexipath.mean);
      expect(m.meanPowerW.flexipath.mean - m.meanPowerW.mptcp.mean, s).toBeGreaterThan(0);
      expect(m.meanPowerW.flexipath.mean - m.meanPowerW.mptcp.mean, s).toBeLessThan(0.25);
      expect(m.replicationOverheadPct.flexipath.mean, s).toBeLessThan(3.5); // README: 1–3 % of protected bytes
    }
    // A–C: no abrupt drop, so the two reactive baselines are identical.
    for (const s of ['A', 'B', 'C']) {
      const m = byKey(results, s);
      expect(m.criticalDeliveryPct.mptcpFast.mean, s).toBe(m.criticalDeliveryPct.mptcp.mean);
    }
    // Speed-consistent rule: reactive multipath's 0.35 s gap hovers at ≤ 60 km/h (300 ms) but not above (1 s).
    for (const s of ['D', 'G', 'H']) {
      const m = byKey(results, s);
      expect(m.c2KeptPct.mptcp.mean, s).toBe(50);
      expect(m.longestInterruptionS.mptcp.mean, s).toBeCloseTo(0.35, 6);
    }
    // G: the shared dead zone; only FlexiPath (with the coverage map) avoids the gap.
    const g = byKey(results, 'G');
    expect(g.longestInterruptionS.flexipath.mean).toBe(0);
    expect(g.longestInterruptionS.mptcpFast.mean).toBeGreaterThan(0);
    // Pooled headline (A–D, G, H): FlexiPath loses fewer critical packets than both reactive baselines, more against
    // the 250 ms one than against the 60 ms one (README: 38 % and 30 %); always duplicate loses fewer than FlexiPath.
    const h = Object.fromEntries(ExperimentRunner.headline(results).map((r) => [r.baseline, r]));
    expect(Object.keys(h)).toEqual(['mptcp', 'mptcpFast', 'redundant']);
    expect(Math.abs(h.mptcp.lossReductionPct - 37.9), `vs reactive multipath: ${h.mptcp.lossReductionPct} %`).toBeLessThan(8);
    expect(Math.abs(h.mptcpFast.lossReductionPct - 29.9), `vs 60 ms variant: ${h.mptcpFast.lossReductionPct} %`).toBeLessThan(8);
    expect(h.mptcp.lossReductionPct).toBeGreaterThan(h.mptcpFast.lossReductionPct);
    expect(h.mptcpFast.lossReductionLo).toBeGreaterThan(0);
    expect(h.redundant.lossReductionPct).toBeLessThan(0);
    expect(Math.abs(h.mptcp.powerW - 0.12), `power vs reactive multipath: ${h.mptcp.powerW} W`).toBeLessThan(0.05);
  });
});

// ── Opt-in: the full benchmarks must reproduce the archived CSVs exactly ─────────────────────────────────────────
// One entry per folder of results/published/ (the commands are in its MANIFEST.md).
const PUBLISHED = resolve(ROOT, 'results/published');
const PUBLISHED_RUNS = [
  { dir: 'default', block: 'dev' },
  { dir: 'test', block: 'test' },
  { dir: 'failsafe300', block: 'dev', failSafeMs: 300 },
  { dir: 'failsafe300-test', block: 'test', failSafeMs: 300 },
  { dir: 'failsafe1000', block: 'dev', failSafeMs: 1000 },
  { dir: 'failsafe1000-test', block: 'test', failSafeMs: 1000 },
  { dir: 'wake260', block: 'dev', wakeMs: 260 },
  { dir: 'wake260-test', block: 'test', wakeMs: 260 },
  { dir: 'rto60', block: 'dev', rtoMs: 60 },
  { dir: 'rto60-test', block: 'test', rtoMs: 60 },
];
const csvWriters = {
  '': ExperimentRunner.toCSV,
  _comparison: ExperimentRunner.comparisonCSV,
  _prediction: ExperimentRunner.predictionCSV,
  _mechanisms: ExperimentRunner.mechanismsCSV,
  _efficiency: ExperimentRunner.efficiencyCSV,
  _headline: ExperimentRunner.headlineCSV,
  _ablations: ExperimentRunner.ablationCSV,
};

describe.skipIf(!process.env.FLEXIPATH_FULL)('full benchmark reproduces results/published', () => {
  for (const { dir: folder, block, failSafeMs, wakeMs, rtoMs } of PUBLISHED_RUNS) {
    it(`${folder}: every CSV is byte-identical`, async () => {
      const dir = resolve(PUBLISHED, folder);
      const files = readdirSync(dir).filter((f) => f.endsWith('.csv'));
      // The same file-name tag as scripts/benchmark.js.
      const tag = (failSafeMs ? `_failsafe${failSafeMs}ms` : '') + (wakeMs ? `_wake${wakeMs}ms` : '') + (rtoMs ? `_rto${rtoMs}ms` : '');
      // The CLI's --wake-ms / --rto-ms override these module parameters before the runs; restore them afterwards.
      const saved = { wake: POWER_PARAMS.wakeLatencyS, mpWake: MULTIPATH_PARAMS.wakeLatencyS, rto: MULTIPATH_PARAMS.rtoS };
      try {
        if (wakeMs) POWER_PARAMS.wakeLatencyS = MULTIPATH_PARAMS.wakeLatencyS = wakeMs / 1000;
        if (rtoMs) MULTIPATH_PARAMS.rtoS = rtoMs / 1000;
        const runner = new ExperimentRunner({
          seeds: seedsFor(5, SEED_BLOCKS[block].base),
          speeds: [30, 60, 90, 120],
          scenarios: EXPERIMENT_SCENARIOS,
          baselines: BASELINE_ENGINES,
          ablations: ABLATION_ENGINES,
          seedBlock: block,
          ...(failSafeMs ? { failSafeRule: 'fixed', failSafeS: failSafeMs / 1000 } : {}),
        });
        const results = await runner.run({ yieldEvery: 1e9 });
        for (const [suffix, write] of Object.entries(csvWriters)) {
          const name = files.find((f) => f.replace(/_\d{4}-\d{2}-\d{2}T[\d-]+\.csv$/, '') === `benchmark${tag}${suffix}`);
          expect(name, `${folder}: benchmark${tag}${suffix} CSV`).toBeTruthy();
          expect(write(results), `${folder}: ${name}`).toBe(readFileSync(resolve(dir, name), 'utf8'));
        }
        expect(files.length, `${folder}: no extra CSVs`).toBe(Object.keys(csvWriters).length);
      } finally {
        POWER_PARAMS.wakeLatencyS = saved.wake;
        MULTIPATH_PARAMS.wakeLatencyS = saved.mpWake;
        MULTIPATH_PARAMS.rtoS = saved.rto;
      }
    }, 300_000);
  }
});
