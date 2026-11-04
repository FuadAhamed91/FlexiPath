import { describe, it, expect } from 'vitest';
import { EXPERIMENT_SCENARIOS, BASELINE_ENGINES, seedsFor } from '../src/simulation/ExperimentRunner.js';
import { SimulationEngine } from '../src/simulation/SimulationEngine.js';
import { LEGACY_PARAMS, LEGACY_WIRELESS_STALL_S } from '../src/simulation/LegacyController.js';

const AGENTS = ['flexipath', 'legacy', ...BASELINE_ENGINES];
const phaseSum = (phases) => phases.reduce((a, p) => a + p.duration, 0);
// Legacy recovery lengths the model allows: a wireless break, a wired failover, or a route-metric reselect.
const LEGACY_STALLS_S = Object.values(LEGACY_PARAMS.stallPhases).map(phaseSum);
const close = (a, b) => Math.abs(a - b) < 1e-6;

/** Fly one run and record, tick by tick, what each controller decided and the link states it saw. */
function fly(scenario, seed, speedKmh) {
  const e = new SimulationEngine({ seed, speedKmh, scenario, recordHistory: false, maxSimSeconds: 900, agents: AGENTS });
  const v = { fpPrimaryDown: [], fpPathDown: [], fpStalledTicks: 0, fpReplicateNotMap: 0, legacyStalls: [], events: {} };
  let run = 0;
  while (!e.completed) {
    e.step();
    const fp = e.agents.flexipath;
    const d = fp.decision;
    const L = fp.linkStates;
    if (d.stalled) v.fpStalledTicks++;
    if (!d.stalled && d.primary && !L[d.primary]?.up) v.fpPrimaryDown.push({ t: e.t, link: d.primary });
    for (const p of d.criticalPaths ?? []) if (!L[p]?.up) v.fpPathDown.push({ t: e.t, link: p });
    if (d.replicate === undefined || d.replicate === null || typeof d.replicate !== 'object') v.fpReplicateNotMap++;

    if (e.agents.legacy.decision.stalled) run++;
    else if (run) {
      v.legacyStalls.push(run / 10);
      run = 0;
    }
    for (const id of AGENTS) {
      for (const ev of e.agents[id].decision.events ?? []) {
        v.events[id] ??= {};
        v.events[id][ev.code] = (v.events[id][ev.code] ?? 0) + 1;
      }
    }
  }
  if (run) v.legacyStalls.push(run / 10);
  return { v, summary: e.getSummary() };
}

describe('controller invariants', () => {
  it('the legacy wireless break is 3.8 s (detect 1.0 + attach 0.8 + DHCP 0.5 + reconnect 1.5)', () => {
    expect(LEGACY_WIRELESS_STALL_S).toBeCloseTo(3.8, 9);
  });

  for (const scenario of EXPERIMENT_SCENARIOS) {
    it(`${scenario}: FlexiPath never sends on a down link; legacy breaks have constant lengths`, () => {
      for (const seed of seedsFor(2)) {
        for (const speedKmh of [30, 120]) {
          const tag = `${scenario} seed ${seed} ${speedKmh} km/h`;
          const { v, summary } = fly(scenario, seed, speedKmh);

          // FlexiPath: its primary and every path it sends critical traffic on are up, and it never stalls.
          expect(v.fpPrimaryDown, tag).toEqual([]);
          expect(v.fpPathDown, tag).toEqual([]);
          expect(v.fpStalledTicks, tag).toBe(0);
          // decision.replicate must be an explicit per-class map (undefined would mirror every flow).
          expect(v.fpReplicateNotMap, tag).toBe(0);

          // Legacy: every break-before-make outage lasts exactly one of the modelled recovery sums, and at least
          // one handover in every scenario is the full 3.8 s wireless break.
          expect(v.legacyStalls.length, tag).toBeGreaterThan(0);
          for (const s of v.legacyStalls) expect(LEGACY_STALLS_S.some((x) => close(x, s)), `${tag}: legacy stall ${s} s`).toBe(true);
          expect(v.legacyStalls.some((s) => close(s, LEGACY_WIRELESS_STALL_S)), tag).toBe(true);
          expect(summary.legacy.longestInterruptionS, tag).toBeCloseTo(LEGACY_WIRELESS_STALL_S, 6);

          // Anchored stacks never reset TCP and never show the remote side a new client IP.
          for (const id of ['flexipath', ...BASELINE_ENGINES]) {
            expect(v.events[id]?.TCP_RST ?? 0, `${tag} ${id}`).toBe(0);
            expect(summary[id].tcpResets, `${tag} ${id}`).toBe(0);
            expect(summary[id].remoteIpChanges, `${tag} ${id}`).toBe(0);
          }
          expect(summary.legacy.tcpResets, tag).toBeGreaterThan(0);
          // The legacy stack never hot-swaps.
          expect(v.events.legacy?.HOT_SWAP ?? 0, tag).toBe(0);
        }
      }
    });
  }
});
