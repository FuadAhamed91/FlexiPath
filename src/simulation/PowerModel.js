/**
 * PowerModel.js — the battery cost of multi-radio connectivity: a three-tier radio sleep model.
 *
 *   Tier 0  DRX STANDBY   1.2 W  one radio carries all traffic; every other modem sleeps in 3GPP DRX.
 *                                A sleeping modem wakes once per DRX cycle to measure signal only:
 *                                no data, no probes, so its RTT and loss are unknown.
 *   Tier 1  WARM PROBING  1.8 W  one secondary modem is awake and sends 64-byte heartbeats every
 *                                100 ms, so its RTT / loss are measured before it is trusted.
 *   Tier 2  BURST TX      3.4 W  both radios transmit (replication) — only during the ~400 ms
 *                                handoff window. (The redundant baseline's DUAL TX state is the same
 *                                tier, held for as long as two radios carry duplicates.)
 *
 * Wake rules (FlexiPathController): a secondary sleeps while the primary's health score is > 75 and
 * wakes when the primary's loss rises > 2 % in 1 s, its health drops to ≤ 75, or degradation is
 * predicted. All figures here are model parameters (assumptions), not measurements.
 */

export const POWER_PARAMS = {
  tierWatts: [1.2, 1.8, 3.4], // DRX standby · warm probing · burst replication (whole radio subsystem)
  drxCycleS: 1.28, // 3GPP long DRX / paging cycle: signal-only measurement cadence while asleep
  wakeLatencyS: 0.1, // DRX → awake (RRC resume / C-DRX wake) before heartbeats can start
  heartbeatBytes: 64,
  heartbeatIntervalS: 0.1,
  warmValidateS: 0.3, // heartbeats (≈ 3) before a warm path is trusted for a handoff
  warmReleaseS: 2.0, // no wake reason for 2 s → back to DRX
  burstWindowS: 0.4, // dual-radio TX window around the predicted handoff
  healthWakeScore: 75, // DRX allowed while the primary's health score is above this
  lossDeltaWake: 0.02, // wake a secondary when the primary's loss rises > 2 % within 1 s
};

/** Per-interface radio states, as shown on the interface cards. */
export const RADIO_STATES = {
  ACTIVE: { id: 'ACTIVE', badge: 'ACTIVE TX', color: '#22d3ee', desc: 'carries the primary data path' },
  DRX: { id: 'DRX', badge: 'DRX SLEEP', color: '#94a3b8', desc: 'asleep in 3GPP DRX: signal measured once per cycle, no probes' },
  WAKING: { id: 'WAKING', badge: 'WAKING', color: '#93c5fd', desc: 'leaving DRX (RRC resume) — heartbeats start next' },
  WARM: { id: 'WARM', badge: 'WARM PROBE', color: '#60a5fa', desc: 'awake, 64-byte heartbeats every 100 ms' },
  BURST: { id: 'BURST', badge: 'BURST TX', color: '#c084fc', desc: 'dual-radio replication during the handoff window' },
  DUAL: { id: 'DUAL', badge: 'DUAL TX', color: '#a3e635', desc: 'redundant baseline: sends a copy of every protected packet, all the time' },
  IDLE: { id: 'IDLE', badge: 'WIRED IDLE', color: '#64748b', desc: 'wired port up, not carrying traffic (no radio)' },
  SCAN: { id: 'SCAN', badge: 'SCAN · ATTACH', color: '#fbbf24', desc: 'legacy stack scanning and attaching after a failure' },
  OFF: { id: 'OFF', badge: 'NO SIGNAL', color: '#475569', desc: 'not available here' },
};

export const POWER_TIERS = [
  { id: 0, key: 'DRX', label: 'DRX STANDBY', watts: POWER_PARAMS.tierWatts[0], color: '#22c55e' },
  { id: 1, key: 'WARM', label: 'WARM PROBING', watts: POWER_PARAMS.tierWatts[1], color: '#60a5fa' },
  { id: 2, key: 'BURST', label: 'BURST REPLICATION', watts: POWER_PARAMS.tierWatts[2], color: '#c084fc' },
];

/** System tier from the per-interface radio states. */
export function tierFor(radio) {
  let tier = 0;
  for (const s of Object.values(radio ?? {})) {
    if (s === 'BURST' || s === 'DUAL') return 2;
    if (s === 'WARM' || s === 'WAKING' || s === 'SCAN') tier = 1;
  }
  return tier;
}

/** Integrates radio power into energy, per engine. */
export class PowerTracker {
  constructor(params = POWER_PARAMS) {
    this.p = params;
    this.reset();
  }

  reset() {
    this.tier = 0;
    this.watts = this.p.tierWatts[0];
    this.energyJ = 0;
    this.timeS = 0;
    this.tierTimeS = [0, 0, 0];
    this.peakWatts = this.watts;
    this.transitions = 0;
    this.bursts = 0;
    this.wakes = 0;
    this.probeBytes = 0;
    this.radio = {};
  }

  /**
   * @param {Record<string,string>} radio per-interface radio state for this tick
   * @param {number} dt seconds
   * @param {{active?: boolean}} [opts] active = the vehicle is still on its route (energy is per journey)
   */
  update(radio, dt, { active = true } = {}) {
    const tier = tierFor(radio);
    if (tier !== this.tier) {
      this.transitions++;
      if (tier === 2) this.bursts++;
      if (tier >= 1 && this.tier === 0) this.wakes++;
    }
    this.tier = tier;
    this.watts = this.p.tierWatts[tier];
    if (!active) {
      this.radio = radio ?? {};
      return this.state;
    }
    this.energyJ += this.watts * dt;
    this.timeS += dt;
    this.tierTimeS[tier] += dt;
    this.peakWatts = Math.max(this.peakWatts, this.watts);
    const warm = Object.values(radio ?? {}).filter((s) => s === 'WARM').length;
    this.probeBytes += warm * this.p.heartbeatBytes * (dt / this.p.heartbeatIntervalS);
    this.radio = radio ?? {};
    return this.state;
  }

  get state() {
    return {
      tier: this.tier,
      tierLabel: POWER_TIERS[this.tier].label,
      watts: this.watts,
      energyJ: this.energyJ,
      meanWatts: this.timeS > 0 ? this.energyJ / this.timeS : this.watts,
      peakWatts: this.peakWatts,
      tierTimeS: [...this.tierTimeS],
      bursts: this.bursts,
      wakes: this.wakes,
      probeBytes: this.probeBytes,
      radio: { ...this.radio },
    };
  }
}
