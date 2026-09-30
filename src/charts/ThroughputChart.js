/**
 * ThroughputChart.js — aggregated goodput (Mbps), 60 s rolling window.
 * FlexiPath stripes bulk traffic across the score-weighted links, so its
 * aggregate stays up through every handover; Legacy drops to zero on a stall.
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
