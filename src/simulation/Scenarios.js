/**
 * Scenarios.js — controlled experiments shared by the live twin and the batch runner.
 *
 * A scenario fixes the route segment, the scheduled faults (triggered by the FlexiPath drone's X
 * position) and the traffic mix. Both engines always run it *together*: same seed, same RF field,
 * same fault timing — every FlexiPath / Legacy comparison is paired by construction.
 *
 * Route X: 0 → 240 scene units (1 unit = 5 m). Zones: 1 dock/Wi-Fi 0–40 · 2 corridor 40–90 ·
 * 3 5G core 90–160 · 4 rural/LEO 160–240.
 *
 * Radio shadows are persistent geography (an urban canyon, a ridge cut): stretches where some links are
 * blocked by an extra `depthDb` of loss, with `edge`-unit ramps. `shadows` is what is really there;
 * `mapShadows` is what the coverage map from earlier survey flights recorded (default: an up-to-date map).
 * Transient faults (the Wi-Fi fade, the cell outage) are never on a map.
 */

const CORRIDOR = { startX: 40, endX: 135, rolling: true };

/** Wi-Fi and 5G blocked together for 40 m between high-rise towers; the LEO satellite still sees the sky. */
const CANYON = { x0: 58, x1: 66, edge: 1, links: ['wlan0', 'wwan0'], depthDb: 60, label: 'Urban canyon' };

export const SCENARIOS = {
  mission: {
    id: 'mission',
    code: '·',
    label: 'Full mission · dock → LEO',
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
    description: 'Scenario A carrying only bulk flows: replication never engages; bulk is moved to the next path with delay-compensated pacing instead.',
    ...CORRIDOR,
    faults: [],
    traffic: 'bulk',
  },
  G: {
    id: 'G',
    code: 'G',
    label: 'Radio shadow on the route',
    description:
      'An urban canyon blocks Wi-Fi and 5G at the same place for 40 m; only the LEO satellite sees the drone there. The coverage map from earlier survey flights knows it.',
    startX: 30,
    endX: 135,
    rolling: true,
    faults: [],
    traffic: 'mixed',
    shadows: [CANYON],
  },
  H: {
    id: 'H',
    code: 'H',
    label: 'Coverage map out of date',
    description:
      'The canyon on the map is gone (its towers were demolished) and a new shadow the map does not know blocks 5G further on: the stale map costs a needless move and cannot help with the new shadow.',
    startX: 30,
    endX: 135,
    rolling: true,
    faults: [],
    traffic: 'mixed',
    shadows: [{ x0: 100, x1: 108, edge: 1, links: ['wlan0', 'wwan0'], depthDb: 60, label: 'New shadow (not on the map)' }],
    mapShadows: [CANYON],
  },
  // Guided demo: scenario A, cut shortly after the legacy drone recovers.
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
    label: 'Baseline flight (4 zones)',
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

/** Scenarios A–H: the controlled experiment set (G and H test the coverage map). */
export const EXPERIMENT_SCENARIOS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
/** Scenarios offered in the live scenario picker. */
export const LIVE_SCENARIOS = ['mission', ...EXPERIMENT_SCENARIOS];

export function resolveScenario(id) {
  return SCENARIOS[id] ?? SCENARIOS.mission;
}

/**
 * The coverage map along the flight plan, as earlier survey flights recorded it: the stretches where a
 * link died (a radio shadow and its edges). Only persistent geography is on it; the scenario decides
 * whether the map is up to date (`mapShadows`).
 */
export function coverageMapFor(scenario) {
  const shadows = scenario?.mapShadows ?? scenario?.shadows ?? [];
  return {
    source: 'survey flights',
    zones: shadows.map((s, i) => {
      const edge = s.edge ?? 1;
      return { id: i + 1, x0: s.x0 - edge, x1: s.x1 + edge, links: [...s.links], label: s.label };
    }),
  };
}
