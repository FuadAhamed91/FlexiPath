/**
 * ThroughputChart.js — aggregated goodput (Mbps), 60 s rolling window.
 * FlexiPath keeps bulk on the primary (one radio awake) and moves it within the handoff
 * burst, so its aggregate keeps flowing through its handovers; Legacy drops to zero during
 * an interruption.
 */
import { BaseTimeSeriesChart } from './BaseTimeSeriesChart.js';

export class ThroughputChart extends BaseTimeSeriesChart {
  constructor(canvas) {
    super(canvas, {
      yMin: 0,
      suggestedMax: 220,
      fillFlexiPath: true,
      formatY: (v) => `${v}`,
      formatValue: (v) => `${v.toFixed(1)} Mbps`,
    });
  }

  pushSnapshot(snapshot) {
    const { flexipath, legacy } = snapshot.agents;
    this.push(snapshot.t, flexipath.metrics.throughputMbps, legacy.metrics.throughputMbps);
  }
}
