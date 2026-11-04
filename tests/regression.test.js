/**
 * Regression: a quick benchmark (3 development seeds × 60 km/h × A–H, every engine) must reproduce the README's
 * four-stack table within the tolerances below. The README numbers come from the full default benchmark
 * (5 seeds × 4 speeds), so the quick run differs by sampling; the tolerances cover that and nothing more.
 *
 * Opt-in (`npm run test:full`, which sets FLEXIPATH_FULL=1): the full default and held-out benchmarks must reproduce the CSVs
 * archived in results/published/ byte for byte.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentRunner, BASELINE_ENGINES, ABLATION_ENGINES, EXPERIMENT_SCENARIOS, SEED_BLOCKS, seedsFor } from '../src/simulation/ExperimentRunner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STACKS = ['legacy', 'mptcp', 'redundant', 'flexipath']; // README cell order: Legacy · Reactive · Always duplicate · FlexiPath

// Columns of the README table → metric key and allowed |quick − README| per stack.
// interruptionS: absolute 0.15 s or 25 % of the README value, whichever is larger (the legacy total grows with the
// number of faults a short sample happens to meet).
const COLUMNS = [
  { key: 'c2KeptPct', tol: (stack) => (stack === 'redundant' ? 35 : 0) }, // always duplicate in G: 40 % of 20 flights vs 2 of 3
  { key: 'interruptionS', tol: (_s, ref) => Math.max(0.15, 0.25 * Math.abs(ref)) },
  // Legacy delivery depends on speed (a fixed 3.8 s break costs more of a slow flight), so it moves most at 60 km/h only.
  { key: 'criticalDeliveryPct', tol: (stack) => (stack === 'legacy' ? 3.0 : 1.0) },
  { key: 'meanMos', tol: () => 0.1 },
  { key: 'replicationOverheadPct', tol: () => 4.0 },
  { key: 'meanPowerW', tol: () => 0.12 },
];

/** Parse the README's "Legacy · Reactive multipath · Always duplicate · FlexiPath" table. */
function readmeMechanismTable() {
  const lines = readFileSync(resolve(ROOT, 'README.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes('Each cell reads **Legacy · Reactive multipath · Always duplicate · FlexiPath**'));
  expect(start, 'README mechanisms table not found').toBeGreaterThan(-1);
  const table = {};
  for (const line of lines.slice(start)) {
    const m = line.match(/^\| ([A-H]) · /);
    if (!m) {
      if (Object.keys(table).length && !line.startsWith('|')) break;
      continue;
    }
    const cells = line.split('|').slice(2, -1).map((c) => c.trim());
    table[m[1]] = Object.fromEntries(
      COLUMNS.map((col, i) => {
        const parts = cells[i].split('·').map((p) => Number.parseFloat(p.trim()));
        return [col.key, parts.length === 4 && parts.every(Number.isFinite) ? Object.fromEntries(STACKS.map((s, j) => [s, parts[j]])) : null];
      }),
    );
  }
  return table;
}

describe('quick benchmark reproduces the README', () => {
  let results;
  let readme;
  beforeAll(async () => {
    readme = readmeMechanismTable();
    const runner = new ExperimentRunner({ seeds: seedsFor(3), speeds: [60], baselines: BASELINE_ENGINES, ablations: ABLATION_ENGINES, seedBlock: 'dev' });
    results = await runner.run({ yieldEvery: 1e9 });
  });

  it('the README table lists A–H', () => {
    expect(Object.keys(readme)).toEqual(EXPERIMENT_SCENARIOS);
  });

  for (const scenario of EXPERIMENT_SCENARIOS) {
    it(`${scenario}: four-stack numbers within tolerance`, () => {
      const metrics = Object.fromEntries(results.mechanisms[scenario].map((m) => [m.key, m]));
      for (const col of COLUMNS) {
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
    for (const s of ['A', 'B', 'C', 'E']) {
      const m = Object.fromEntries(results.mechanisms[s].map((x) => [x.key, x.engines]));
      expect(m.interruptionS.legacy.mean, s).toBeCloseTo(s === 'B' ? 7.6 : 3.8, 6); // one (two in B) 3.8 s breaks
      expect(m.interruptionS.flexipath.mean, s).toBe(0);
    }
    for (const s of ['A', 'B', 'C', 'D', 'E', 'G', 'H']) {
      const m = Object.fromEntries(results.mechanisms[s].map((x) => [x.key, x.engines]));
      expect(m.c2KeptPct.flexipath.mean, `${s}: FlexiPath keeps C2 on every flight`).toBe(100);
      expect(m.criticalDeliveryPct.flexipath.mean, s).toBeGreaterThan(m.criticalDeliveryPct.mptcp.mean);
      expect(m.criticalDeliveryPct.redundant.mean, s).toBeGreaterThan(m.criticalDeliveryPct.flexipath.mean);
      expect(m.meanPowerW.redundant.mean, s).toBeGreaterThan(2 * m.meanPowerW.flexipath.mean);
      expect(m.replicationOverheadPct.flexipath.mean, s).toBeLessThan(3);
    }
    // G: the shared dead zone; only FlexiPath (with the coverage map) avoids the gap.
    const g = Object.fromEntries(results.mechanisms.G.map((x) => [x.key, x.engines]));
    expect(g.interruptionS.flexipath.mean).toBe(0);
    expect(g.c2KeptPct.mptcp.mean).toBe(0);
  });
});

// ── Opt-in: the full benchmarks must reproduce the archived CSVs exactly ─────────────────────────────────────────
const PUBLISHED = resolve(ROOT, 'results/published');
const csvWriters = {
  '': ExperimentRunner.toCSV,
  _comparison: ExperimentRunner.comparisonCSV,
  _prediction: ExperimentRunner.predictionCSV,
  _mechanisms: ExperimentRunner.mechanismsCSV,
  _efficiency: ExperimentRunner.efficiencyCSV,
  _ablations: ExperimentRunner.ablationCSV,
};

describe.skipIf(!process.env.FLEXIPATH_FULL)('full benchmark reproduces results/published', () => {
  for (const block of ['dev', 'test']) {
    it(`${block} seed block: every CSV is byte-identical`, async () => {
      const dir = resolve(PUBLISHED, block === 'dev' ? 'default' : 'test');
      const files = readdirSync(dir).filter((f) => f.endsWith('.csv'));
      const runner = new ExperimentRunner({
        seeds: seedsFor(5, SEED_BLOCKS[block].base),
        speeds: [30, 60, 90, 120],
        scenarios: EXPERIMENT_SCENARIOS,
        baselines: BASELINE_ENGINES,
        ablations: ABLATION_ENGINES,
        seedBlock: block,
      });
      const results = await runner.run({ yieldEvery: 1e9 });
      for (const [suffix, write] of Object.entries(csvWriters)) {
        const name = files.find((f) => f.replace(/_\d{4}-\d{2}-\d{2}T[\d-]+\.csv$/, '') === `benchmark${suffix}`);
        expect(name, `${block}: benchmark${suffix} CSV in ${dir}`).toBeTruthy();
        expect(write(results), `${block}: ${name}`).toBe(readFileSync(resolve(dir, name), 'utf8'));
      }
    }, 300_000);
  }
});
