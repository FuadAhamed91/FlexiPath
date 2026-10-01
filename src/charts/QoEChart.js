/**
 * QoEChart.js — running Mean Opinion Score of the VoIP flow (ITU-T G.107 E-model, 1.0 – 4.5).
 * The dashed line marks MOS 3.6 (R ≈ 70), below which users become dissatisfied.
 * Scenarios without a voice flow leave the chart empty (no MOS is invented).
 */
import { BaseTimeSeriesChart } from './BaseTimeSeriesChart.js';
import { MOS_THRESHOLD } from '../simulation/SimulationEngine.js';

export class QoEChart extends BaseTimeSeriesChart {
  constructor(canvas) {
    super(canvas, {
      yMin: 1,
      yMax: 4.5,
      formatY: (v) => v.toFixed(1),
      formatValue: (v) => `MOS ${v.toFixed(2)}`,
      lines: [{ value: MOS_THRESHOLD, color: 'rgba(250, 204, 21, 0.55)', label: `MOS ${MOS_THRESHOLD} satisfaction floor` }],
    });
  }

  pushSnapshot(snapshot) {
    const { flexipath, legacy } = snapshot.agents;
    this.push(snapshot.t, flexipath.metrics.mos, legacy.metrics.mos);
  }
}
