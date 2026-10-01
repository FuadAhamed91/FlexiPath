/**
 * PowerChart.js — radio subsystem power (W), 60 s rolling window.
 * Three-tier model: DRX standby 1.2 W, warm probing 1.8 W, burst replication 3.4 W (model parameters).
 * FlexiPath steps up only around a predicted handoff; Legacy scans (1.8 W) only after a failure.
 */
import { BaseTimeSeriesChart } from './BaseTimeSeriesChart.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';

export class PowerChart extends BaseTimeSeriesChart {
  constructor(canvas) {
    const [drx, warm, burst] = POWER_PARAMS.tierWatts;
    super(canvas, {
      yMin: 0.8,
      yMax: 3.8,
      stepped: true,
      formatY: (v) => `${v.toFixed(1)}`,
      formatValue: (v) => `${v.toFixed(1)} W`,
      lines: [
        { value: drx, color: 'rgba(34, 197, 94, 0.35)', label: `DRX ${drx} W` },
        { value: warm, color: 'rgba(96, 165, 250, 0.35)', label: `warm ${warm} W` },
        { value: burst, color: 'rgba(192, 132, 252, 0.4)', label: `burst ${burst} W` },
      ],
    });
  }

  pushSnapshot(snapshot) {
    const { flexipath, legacy } = snapshot.agents;
    this.push(snapshot.t, flexipath.metrics.powerW, legacy.metrics.powerW);
  }
}
