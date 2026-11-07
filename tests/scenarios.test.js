import { describe, it, expect } from 'vitest';
import { EXPERIMENT_SCENARIOS, BASELINE_ENGINES, ABLATION_ENGINES } from '../src/simulation/ExperimentRunner.js';
import { SimulationEngine } from '../src/simulation/SimulationEngine.js';

const AGENTS = ['flexipath', 'legacy', ...BASELINE_ENGINES, ...ABLATION_ENGINES];
const MAX_SIM_S = 900;

describe('scenarios A–H run to completion', () => {
  it('has the eight scenarios A–H', () => {
    expect(EXPERIMENT_SCENARIOS).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });

  for (const scenario of EXPERIMENT_SCENARIOS) {
    for (const speedKmh of [30, 120]) {
      it(`${scenario} at ${speedKmh} km/h: every drone reaches the end of the route`, () => {
        const e = new SimulationEngine({ seed: 1000, speedKmh, scenario, recordHistory: false, maxSimSeconds: MAX_SIM_S, agents: AGENTS });
        while (!e.completed) e.step();
        // Completion must come from the finish line, not from the time limit.
        expect(e.t).toBeLessThan(MAX_SIM_S);
        const summary = e.getSummary();
        for (const id of AGENTS) {
          expect(e.agents[id].mobility.finished, id).toBe(true);
          const s = summary[id];
          expect(s.finished, id).toBe(true);
          expect(s.journeyTimeS, id).toBeGreaterThan(0);
          expect(Number.isFinite(s.interruptionS), id).toBe(true);
          expect(Number.isFinite(s.meanPowerW), id).toBe(true);
          if (scenario !== 'F') expect(s.criticalDeliveryPct, id).toBeGreaterThan(0); // F carries no C2 traffic
        }
      });
    }
  }
});
