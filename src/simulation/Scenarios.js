/**
 * Scenarios.js — controlled experiments shared by the live twin and the batch runner.
 *
 * A scenario fixes the route segment, the scheduled faults (triggered by the FlexiPath vehicle's X
 * position) and the traffic mix. Both engines always run it *together*: same seed, same RF field,
 * same fault timing — every FlexiPath / Legacy comparison is paired by construction.
 *
 * Route X: 0 → 240 scene units (1 unit = 5 m). Zones: 1 depot/Wi-Fi 0–40 · 2 corridor 40–90 ·
 * 3 5G core 90–160 · 4 rural/LEO 160–240.
 */
import { TRAFFIC_PROFILES } from './TrafficManager.js';

const CORRIDOR = { startX: 40, endX: 135, rolling: true };

export const SCENARIOS = {
  mission: {
    id: 'mission',
    code: '·',
    label: 'Full mission · depot → LEO',
    description: 'Wired dock → Wi-Fi → 5G → LEO across all four zones. Inject faults by hand.',
    startX: 1.5,
    endX: 240,
    faults: [],
    traffic: 'mixed',
  },
  A: {
    id: 'A',
    code: 'A',
    label: 'Wi-Fi → 5G',
    description: 'Wi-Fi degrades gradually in the handover corridor; 5G is the next path.',
    ...CORRIDOR,
    faults: [],
    traffic: 'mixed',
  },
  B: {
    id: 'B',
    code: 'B',
    label: 'Wi-Fi → 5G → LEO',
    description: 'Two predictable degradations: the corridor (Wi-Fi → 5G) and the rural ridge (5G → LEO).',
    startX: 40,
    endX: 240,
    rolling: true,
    faults: [],
    traffic: 'mixed',
  },
  C: {
    id: 'C',
    code: 'C',
    label: '5G degradation → LEO',
    description: '5G fades behind the rural ridge; the LEO satellite is the only alternate.',
    startX: 140,
    endX: 240,
    rolling: true,
    faults: [],
    traffic: 'mixed',
  },
  D: {
    id: 'D',
    code: 'D',
    label: 'Multiple network degradation',
    description: 'A rapid Wi-Fi fade, an abrupt (unpredictable) 5G cell outage and the rural ridge in one run.',
    startX: 12,
    endX: 240,
    rolling: true,
    faults: [
      { type: 'wifi-fade', atX: 30 },
      { type: 'cell-outage', atX: 130 },
    ],
    traffic: 'mixed',
  },
  E: {
    id: 'E',
    code: 'E',
    label: 'Critical traffic during handover',
    description: 'Scenario A carrying only critical + real-time flows: how much protection, at what overhead.',
    ...CORRIDOR,
    faults: [],
    traffic: 'protected',
  },
  F: {
    id: 'F',
    code: 'F',
    label: 'Bulk traffic during handover',
    description: 'Scenario A carrying only bulk flows: replication never engages; bulk is striped and drained instead.',
    ...CORRIDOR,
    faults: [],
    traffic: 'bulk',
  },
  // Guided demo: scenario A, cut shortly after the legacy vehicle recovers.
  demo: {
    id: 'demo',
    code: 'A',
    hidden: true,
    label: 'Guided demo · Wi-Fi → 5G',
    description: 'Scenario A, shortened for the guided demonstration.',
    startX: 40,
    endX: 112,
    rolling: true,
    faults: [],
    traffic: 'mixed',
  },
  // Original benchmark matrix (kept for the CLI and earlier exports).
  baseline: {
    id: 'baseline',
    code: '0',
    legacyMatrix: true,
    label: 'Baseline drive (4 zones)',
    description: 'Same route as the full mission, no faults.',
    startX: 1.5,
    endX: 240,
    faults: [],
    traffic: 'mixed',
  },
  'wifi-fade': {
    id: 'wifi-fade',
    code: '1',
    legacyMatrix: true,
    label: 'Rapid Wi-Fi fade at X = 20',
    description: 'Full mission with a rapid Wi-Fi fade injected in zone 1.',
    startX: 1.5,
    endX: 240,
    faults: [{ type: 'wifi-fade', atX: 20 }],
    traffic: 'mixed',
  },
  'cell-outage': {
    id: 'cell-outage',
    code: '2',
    legacyMatrix: true,
    label: '5G cell outage at X = 125',
    description: 'Full mission with an abrupt 5G cell outage in zone 3.',
    startX: 1.5,
    endX: 240,
    faults: [{ type: 'cell-outage', atX: 125 }],
    traffic: 'mixed',
  },
};

/** Scenarios A–F: the controlled experiment set. */
export const EXPERIMENT_SCENARIOS = ['A', 'B', 'C', 'D', 'E', 'F'];
/** Scenarios offered in the live scenario picker. */
export const LIVE_SCENARIOS = ['mission', ...EXPERIMENT_SCENARIOS];

export function resolveScenario(id) {
  return SCENARIOS[id] ?? SCENARIOS.mission;
}

export function scenarioTrafficLabel(id) {
  return TRAFFIC_PROFILES[resolveScenario(id).traffic]?.label ?? '';
}
