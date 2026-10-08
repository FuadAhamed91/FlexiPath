#!/usr/bin/env node
/**
 * Trade-off chart: critical (C2) packets delivered vs mean radio power, one marker per scenario and stack.
 *
 *   node scripts/tradeoff-chart.js results/benchmark_mechanisms_<stamp>.csv
 *
 * Reads the _mechanisms.csv of a default `npm run benchmark` and writes public/landing/tradeoff.svg, which the
 * README and the landing page show. Re-run it whenever the published results change.
 * E is left out (its C2 numbers equal A's) and so is F (no C2 traffic).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/tradeoff-chart.js results/benchmark_mechanisms_<stamp>.csv');
  process.exit(1);
}
const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'landing', 'tradeoff.svg');

const SCENARIOS = ['A', 'B', 'C', 'D', 'G', 'H'];
// Deep palette that reads on white (CLAUDE.md, light HUD).
const STACKS = [
  { id: 'redundant', label: 'Always duplicate', color: '#4D7C0F' },
  { id: 'flexipath', label: 'FlexiPath', color: '#0891B2' },
  { id: 'mptcp', label: 'Reactive multipath', color: '#B45309' },
  { id: 'legacy', label: 'Legacy OS', color: '#DC2626' },
];

function parseCSV(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const split = (line) => {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  const keys = split(head);
  return lines.map((l) => Object.fromEntries(split(l).map((v, i) => [keys[i], v])));
}

const rows = parseCSV(readFileSync(src, 'utf8'));
const value = (scenario, metric, stack) => {
  const row = rows.find((r) => r.scenario === scenario && r.metric === metric);
  const v = Number(row?.[`${stack}_mean`]);
  if (!Number.isFinite(v)) throw new Error(`missing ${metric} for ${stack} in ${scenario}`);
  return v;
};
const points = STACKS.map((s) => ({
  ...s,
  pts: SCENARIOS.map((sc) => ({ sc, w: value(sc, 'meanPowerW', s.id), pct: value(sc, 'criticalDeliveryPct', s.id) })),
}));
const range = (arr) => [Math.min(...arr), Math.max(...arr)];

// Plot frame. Legacy sits far below the y range and is reported in a note instead of a marker.
const W = 800;
const H = 470;
const M = { l: 70, r: 28, t: 92, b: 60 };
const X0 = 1.0;
const X1 = 3.6;
const Y0 = 96.5;
const Y1 = 100.0;
const px = (w) => M.l + ((w - X0) / (X1 - X0)) * (W - M.l - M.r);
const py = (p) => H - M.b - ((p - Y0) / (Y1 - Y0)) * (H - M.t - M.b);
const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);

const grid = [];
for (let w = X0; w <= X1 + 1e-9; w += 0.5) {
  grid.push(`<line x1="${px(w)}" y1="${M.t}" x2="${px(w)}" y2="${H - M.b}" class="grid"/>`);
  grid.push(`<text x="${px(w)}" y="${H - M.b + 18}" class="tick" text-anchor="middle">${f1(w)}</text>`);
}
for (let p = Y0; p <= Y1 + 1e-9; p += 0.5) {
  grid.push(`<line x1="${M.l}" y1="${py(p)}" x2="${W - M.r}" y2="${py(p)}" class="grid"/>`);
  grid.push(`<text x="${M.l - 8}" y="${py(p) + 4}" class="tick" text-anchor="end">${f1(p)}</text>`);
}

const marks = [];
const labels = [];
for (const s of points) {
  if (s.id === 'legacy') continue;
  for (const p of s.pts) {
    marks.push(`<circle cx="${px(p.w).toFixed(1)}" cy="${py(p.pct).toFixed(1)}" r="5.5" fill="${s.color}" fill-opacity="0.85" stroke="#fff" stroke-width="1.5"><title>${s.label} · ${p.sc}: ${f2(p.pct)} % at ${f2(p.w)} W</title></circle>`);
  }
  const [w0, w1] = range(s.pts.map((p) => p.w));
  const [p0, p1] = range(s.pts.map((p) => p.pct));
  const text = `${f1(p0)}–${f1(p1)} % · ${f2(w0)}–${f2(w1)} W`;
  // Label to the right of the cluster, except for the rightmost cluster (label on its left).
  const right = w1 < 2.5;
  const lx = right ? px(w1) + 14 : px(w0) - 14;
  const ly = py((p0 + p1) / 2);
  const anchor = right ? 'start' : 'end';
  labels.push(`<text x="${lx}" y="${ly - 3}" text-anchor="${anchor}" class="lab" style="fill:${s.color}">${s.label}</text>`);
  labels.push(`<text x="${lx}" y="${ly + 13}" text-anchor="${anchor}" class="sub">${text}</text>`);
}
const lg = points.find((s) => s.id === 'legacy');
const [lgP0, lgP1] = range(lg.pts.map((p) => p.pct));
const [lgW0, lgW1] = range(lg.pts.map((p) => p.w));
const lgText = `Legacy OS (below the chart): ${f1(lgP0)}–${f1(lgP1)} % at ${f2(lgW0) === f2(lgW1) ? f2(lgW0) : `${f2(lgW0)}–${f2(lgW1)}`} W`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
  <title id="t">Reliability vs radio power</title>
  <desc id="d">Critical (C2) packets delivered against mean radio power for always duplicate, FlexiPath and reactive multipath in scenarios A–D, G and H. Measured simulation results, means of 20 paired flights per scenario.</desc>
  <style>
    text { font-family: Inter, 'Segoe UI', system-ui, -apple-system, sans-serif; fill: #0f172a; }
    .h { font-size: 19px; font-weight: 700; }
    .s { font-size: 12.5px; fill: #475569; }
    .tick { font-size: 11.5px; fill: #64748b; }
    .ax { font-size: 12.5px; fill: #334155; font-weight: 600; }
    .grid { stroke: #e2e8f0; stroke-width: 1; }
    .lab { font-size: 13.5px; font-weight: 700; }
    .sub { font-size: 11.5px; fill: #475569; }
    .note { font-size: 11.5px; fill: #b91c1c; }
    .tag { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; fill: #0e7490; }
  </style>
  <rect width="${W}" height="${H}" rx="14" fill="#ffffff"/>
  <text x="${M.l}" y="36" class="h">Reliability vs radio power</text>
  <text x="${M.l}" y="58" class="s">Critical (C2) packets delivered against mean radio power · scenarios A–D, G, H · each marker is the mean of 20 paired flights</text>
  <rect x="${W - M.r - 112}" y="22" width="112" height="20" rx="10" fill="#ecfeff" stroke="#a5f3fc"/>
  <text x="${W - M.r - 56}" y="36" text-anchor="middle" class="tag">MEASURED · SIM</text>
  ${grid.join('\n  ')}
  <rect x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}" fill="none" stroke="#cbd5e1"/>
  <text x="${M.l + 10}" y="${M.t + 18}" class="sub">↖ better: more delivered, less power</text>
  ${marks.join('\n  ')}
  ${labels.join('\n  ')}
  <text x="${M.l + 10}" y="${H - M.b - 10}" class="note">↓ ${lgText}</text>
  <text x="${(M.l + W - M.r) / 2}" y="${H - 14}" text-anchor="middle" class="ax">Mean radio power (W)</text>
  <text transform="translate(18 ${(M.t + H - M.b) / 2}) rotate(-90)" text-anchor="middle" class="ax">Critical packets delivered (%)</text>
</svg>
`;
writeFileSync(out, svg);
console.log(`wrote ${out}`);
for (const s of points) {
  console.log(`${s.label.padEnd(20)} ${s.pts.map((p) => `${p.sc} ${f2(p.pct)}% ${f2(p.w)}W`).join(' · ')}`);
}
