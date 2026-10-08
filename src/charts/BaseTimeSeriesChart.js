/**
 * BaseTimeSeriesChart.js — shared Chart.js setup for the 60-second rolling HUD graphs.
 *
 * FlexiPath (cyan) vs Legacy (crimson) series on a linear time axis, with
 * background bands: purple = FlexiPath predictive replication window,
 * red = Legacy socket stall.
 */
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  LogarithmicScale,
  Filler,
  Tooltip,
} from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, LogarithmicScale, Filler, Tooltip);

export const SERIES_COLORS = {
  flexipath: '#0891B2',
  legacy: '#E11D48',
  replication: 'rgba(124, 58, 237, 0.1)',
  stall: 'rgba(225, 29, 72, 0.1)',
};

const FONT = { family: "'JetBrains Mono', ui-monospace, monospace", size: 9 };

/** Draws shaded x-ranges behind the datasets and optional horizontal reference lines. */
const bandsPlugin = {
  id: 'fpBands',
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;
    const x = scales.x;
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
    ctx.clip();
    for (const band of opts.bands ?? []) {
      const x0 = x.getPixelForValue(band.from);
      const x1 = x.getPixelForValue(band.to);
      if (x1 < chartArea.left || x0 > chartArea.right) continue;
      ctx.fillStyle = band.color;
      ctx.fillRect(x0, chartArea.top, Math.max(1.5, x1 - x0), chartArea.height);
      ctx.fillStyle = band.edge ?? band.color;
      ctx.fillRect(x0, chartArea.top, 1, chartArea.height);
    }
    for (const line of opts.lines ?? []) {
      const y = scales.y.getPixelForValue(line.value);
      if (y < chartArea.top || y > chartArea.bottom) continue;
      ctx.strokeStyle = line.color;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      if (line.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = line.color;
        ctx.font = `600 8.5px ${FONT.family}`;
        ctx.textAlign = 'right';
        ctx.fillText(line.label, chartArea.right - 4, y - 3);
      }
    }
    ctx.restore();
  },
};

export class BaseTimeSeriesChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {'linear'|'logarithmic'} [opts.yType]
   * @param {number} [opts.yMin]
   * @param {number} [opts.yMax]
   * @param {number} [opts.suggestedMax]
   * @param {(v:number)=>string} [opts.formatY]
   * @param {number[]} [opts.yTicks] explicit tick values (log scale)
   * @param {boolean} [opts.fillFlexiPath]
   * @param {Array<{value:number,label?:string,color:string}>} [opts.lines]
   */
  constructor(canvas, opts = {}) {
    this.windowS = opts.windowS ?? 60;
    this.opts = opts;
    this.data = { flexipath: [], legacy: [] };
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 160);
    gradient.addColorStop(0, 'rgba(8, 145, 178, 0.2)');
    gradient.addColorStop(1, 'rgba(8, 145, 178, 0)');

    const yScale = {
      type: opts.yType ?? 'linear',
      min: opts.yMin,
      max: opts.yMax,
      suggestedMax: opts.suggestedMax,
      grid: { color: 'rgba(15, 23, 42, 0.06)', drawTicks: false },
      border: { display: false },
      ticks: {
        color: '#64748b',
        font: FONT,
        padding: 6,
        maxTicksLimit: 5,
        callback: opts.formatY ?? ((v) => v),
      },
    };
    if (opts.yTicks) {
      yScale.afterBuildTicks = (scale) => {
        scale.ticks = opts.yTicks.filter((v) => v >= scale.min && v <= scale.max).map((value) => ({ value }));
      };
    }

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'FlexiPath',
            data: this.data.flexipath,
            borderColor: SERIES_COLORS.flexipath,
            backgroundColor: opts.fillFlexiPath ? gradient : 'transparent',
            fill: opts.fillFlexiPath ? 'origin' : false,
            borderWidth: 1.8,
            pointRadius: 0,
            tension: opts.stepped ? 0 : 0.25,
            stepped: opts.stepped ? 'before' : false,
            order: 1,
          },
          {
            label: 'Legacy OS',
            data: this.data.legacy,
            borderColor: SERIES_COLORS.legacy,
            backgroundColor: 'transparent',
            fill: false,
            borderWidth: 1.6,
            pointRadius: 0,
            tension: opts.stepped ? 0 : 0.15,
            stepped: opts.stepped ? 'before' : false,
            order: 2,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        spanGaps: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 4, right: 6, bottom: 0, left: 0 } },
        scales: {
          x: {
            type: 'linear',
            grid: { color: 'rgba(15, 23, 42, 0.04)', drawTicks: false },
            border: { display: false },
            ticks: {
              color: '#64748b',
              font: FONT,
              maxTicksLimit: 7,
              padding: 4,
              stepSize: 10,
              callback: (v) => `${Math.round(v)}s`,
            },
          },
          y: yScale,
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(255, 255, 255, 0.97)',
            borderColor: '#e2e8f0',
            borderWidth: 1,
            titleColor: '#0f172a',
            bodyColor: '#334155',
            titleFont: FONT,
            bodyFont: FONT,
            padding: 8,
            callbacks: {
              title: (items) => `T+${items[0]?.parsed.x.toFixed(1)} s`,
              label: (item) => ` ${item.dataset.label}: ${(opts.formatValue ?? ((v) => v.toFixed(2)))(item.parsed.y)}`,
            },
          },
          fpBands: { bands: [], lines: opts.lines ?? [] },
        },
      },
      plugins: [bandsPlugin],
    });
  }

  /** Append one sample for each engine (null/NaN leaves a gap). */
  push(t, fp, lg) {
    const clampV = (v) => {
      if (v === null || v === undefined || !Number.isFinite(v)) return null;
      if (this.opts.yType === 'logarithmic') return Math.max(this.opts.yMin ?? 1, v);
      return v;
    };
    this.data.flexipath.push({ x: t, y: clampV(fp) });
    this.data.legacy.push({ x: t, y: clampV(lg) });
  }

  setBands(bands) {
    this.chart.options.plugins.fpBands.bands = bands;
  }

  /** Scroll the 60 s window to `now` and redraw. */
  render(now) {
    const min = Math.max(0, now - this.windowS);
    const cutoff = min - 2;
    for (const arr of Object.values(this.data)) {
      let drop = 0;
      while (drop < arr.length && arr[drop].x < cutoff) drop++;
      if (drop) arr.splice(0, drop);
    }
    this.chart.options.scales.x.min = min;
    this.chart.options.scales.x.max = Math.max(now, this.windowS);
    this.chart.update('none');
  }

  reset() {
    this.data.flexipath.length = 0;
    this.data.legacy.length = 0;
    this.setBands([]);
    this.chart.update('none');
  }

  latest(engine) {
    const arr = this.data[engine];
    return arr.length ? arr[arr.length - 1].y : null;
  }
}
