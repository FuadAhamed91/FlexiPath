/**
 * HolChart.js — head-of-line stall of the bulk (TCP-like) flows (ms), 60 s rolling window.
 * A lost segment blocks in-order delivery until it is repaired: one RTT with fast retransmit, or a
 * 200–500 ms retransmission timeout once the window is too small for three duplicate ACKs. Legacy
 * rides degrading links into that regime; FlexiPath leaves them first. Critical / real-time packets
 * never wait (first copy delivered), so they are not plotted. Gaps = no bulk traffic.
 */
import { BaseTimeSeriesChart } from './BaseTimeSeriesChart.js';
import { HOL_PARAMS } from '../simulation/ReorderingBuffer.js';

export class HolChart extends BaseTimeSeriesChart {
  constructor(canvas) {
    super(canvas, {
      yMin: 0,
      yMax: 520,
      stepped: true,
      formatY: (v) => `${v}`,
      formatValue: (v) => `${v.toFixed(0)} ms`,
      lines: [{ value: HOL_PARAMS.rtoMinMs, color: 'rgba(220, 38, 38, 0.7)', label: `TCP RTO min ${HOL_PARAMS.rtoMinMs} ms` }],
    });
  }

  pushSnapshot(snapshot) {
    const { flexipath, legacy } = snapshot.agents;
    this.push(snapshot.t, flexipath.metrics.bulkHolMs, legacy.metrics.bulkHolMs);
  }
}
