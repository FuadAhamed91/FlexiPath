/**
 * PacketLossChart.js — critical-flow packet loss (%, 1 s sliding window).
 * FlexiPath hugs the floor (replication covers every handover) while Legacy
 * climbs on its sticky, degrading link and spikes to 100 % during a stall.
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
