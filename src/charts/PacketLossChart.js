/**
 * PacketLossChart.js — packet loss of the critical + real-time flows (%, 1 s sliding window).
 * FlexiPath stays low while replication covers its handovers; Legacy climbs on its sticky,
 * degrading link and reaches 100 % during a simulated interruption. Gaps = no packet flows.
 */
import { BaseTimeSeriesChart } from './BaseTimeSeriesChart.js';

export class PacketLossChart extends BaseTimeSeriesChart {
  constructor(canvas) {
    super(canvas, {
      yMin: 0,
      yMax: 100,
      formatY: (v) => `${v}%`,
      formatValue: (v) => `${v.toFixed(2)} %`,
    });
  }

  pushSnapshot(snapshot) {
    const { flexipath, legacy } = snapshot.agents;
    this.push(snapshot.t, flexipath.metrics.lossPct, legacy.metrics.lossPct);
  }
}
