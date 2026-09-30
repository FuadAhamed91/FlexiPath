/**
 * RTTChart.js — comparative critical-flow latency (ms, log scale).
 *
 * While a Legacy socket is stalled, the application-visible latency keeps
 * growing (packets queue behind the dead connection) — the log axis keeps
 * both the 5–65 ms steady state and the multi-second stall spike legible.
 * With replication active, FlexiPath's latency is that of the first copy to arrive.
 */
import { BaseTimeSeriesChart } from './BaseTimeSeriesChart.js';

export class RTTChart extends BaseTimeSeriesChart {
  constructor(canvas) {
    super(canvas, {
      yType: 'logarithmic',
      yMin: 2,
      yMax: 6000,
      yTicks: [2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000],
      formatY: (v) => (v >= 1000 ? `${v / 1000}s` : `${v}`),
      formatValue: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`),
    });
  }

  pushSnapshot(snapshot) {
    const { flexipath, legacy } = snapshot.agents;
    this.push(snapshot.t, flexipath.metrics.latencyMs, legacy.metrics.latencyMs);
  }
}
