import { describe, it, expect } from 'vitest';
import { runSingle, BASELINE_ENGINES, ABLATION_ENGINES } from '../src/simulation/ExperimentRunner.js';
import { SimulationEngine } from '../src/simulation/SimulationEngine.js';

const ALL = { baselines: BASELINE_ENGINES, ablations: ABLATION_ENGINES };

describe('determinism', () => {
  it('gives the same summary for the same seed (every engine)', () => {
    const a = runSingle({ seed: 1000, speedKmh: 60, scenario: 'D', ...ALL });
    const b = runSingle({ seed: 1000, speedKmh: 60, scenario: 'D', ...ALL });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('gives the same tick-by-tick history for the same seed', () => {
    const history = () => {
      const e = new SimulationEngine({ seed: 2026, speedKmh: 90, scenario: 'mission', recordHistory: true });
      while (!e.completed) e.step();
      return JSON.stringify(e.history ?? e.getSummary());
    };
    expect(history()).toBe(history());
  });

  it("treats '2026' and 2026 as the same seed", () => {
    const a = runSingle({ seed: 2026, speedKmh: 60, scenario: 'A' });
    const b = runSingle({ seed: '2026', speedKmh: 60, scenario: 'A' });
    expect({ ...b, seed: a.seed }).toEqual(a);
  });

  it('gives a different run for a different seed', () => {
    const a = runSingle({ seed: 1000, speedKmh: 60, scenario: 'A' });
    const b = runSingle({ seed: 8919, speedKmh: 60, scenario: 'A' });
    expect(JSON.stringify(b.flexipath)).not.toBe(JSON.stringify(a.flexipath));
  });

  it('baselines and ablations never change the FlexiPath / Legacy values', () => {
    for (const scenario of ['A', 'D', 'G']) {
      const lean = runSingle({ seed: 16838, speedKmh: 120, scenario });
      const full = runSingle({ seed: 16838, speedKmh: 120, scenario, ...ALL });
      expect(full.flexipath, scenario).toEqual(lean.flexipath);
      expect(full.legacy, scenario).toEqual(lean.legacy);
    }
  });

  it('the no-map ablation equals FlexiPath when nothing is on the map (A–F)', () => {
    for (const scenario of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const r = runSingle({ seed: 1000, speedKmh: 60, scenario, ablations: ['fpNoMap'] });
      expect({ ...r.fpNoMap, engine: 'flexipath' }, scenario).toEqual(r.flexipath);
    }
  });
});
