/**
 * format.js — small shared helpers for the HUD panels (chips, badges, number formats).
 */
import { INTERFACE_SPECS } from '../simulation/LinkModel.js';
import { TRAFFIC_CLASSES } from '../simulation/TrafficManager.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const linkName = (id) => (id ? INTERFACE_SPECS[id]?.name ?? id : '—');
export const linkColor = (id) => (id ? INTERFACE_SPECS[id]?.color ?? '#64748b' : '#64748b');

/** Coloured link chip, e.g. "Wi-Fi" in cyan. */
export function linkChip(id, text) {
  if (!id) return '<span class="text-slate-500">—</span>';
  return `<span class="path-chip" style="--c:${linkColor(id)}">${esc(text ?? linkName(id))}</span>`;
}

/** "P1 · CRITICAL" style class badge. */
export function classBadge(cls, priority) {
  const c = TRAFFIC_CLASSES[cls];
  return `<span class="cls-badge cls-${cls.toLowerCase()}" title="${esc(c?.examples ?? '')}">P${priority} · ${esc((c?.label ?? cls).toUpperCase())}</span>`;
}

export const fmtT = (t) => (Number.isFinite(t) ? `T+${t.toFixed(1)}` : '—');
export const fmtS = (v, d = 1) => (Number.isFinite(v) ? `${v < 1 && d < 2 ? v.toFixed(2) : v.toFixed(d)} s` : '—');
export const fmtRel = (dt) => {
  if (!Number.isFinite(dt)) return '';
  if (Math.abs(dt) < 0.05) return '±0.0 s';
  return `${dt > 0 ? '+' : '−'}${Math.abs(dt).toFixed(1)} s`;
};
export const fmtPct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
export const fmtNum = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
export const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');

/** Signal value with unit, or a carrier label for the wired link. */
export function fmtSignal(id, v) {
  const s = INTERFACE_SPECS[id];
  if (!s) return '—';
  if (s.tech === 'wired') return v ? 'carrier up' : 'no carrier';
  return Number.isFinite(v) ? `${v.toFixed(1)} ${s.signalUnit}` : '—';
}

/** Data-provenance tag: MODEL PARAMETER · MEASURED (SIM) · REAL-WORLD. */
export const tag = (kind) => {
  const map = { param: ['MODEL PARAMETER', 'tag-param'], measured: ['MEASURED · SIM', 'tag-measured'], sim: ['SIMULATED', 'tag-sim'] };
  const [label, cls] = map[kind] ?? map.sim;
  return `<span class="prov-tag ${cls}">${label}</span>`;
};

/** Cached setter for text/innerHTML to keep per-frame DOM writes minimal. */
export function makeSetter(cache = {}) {
  return {
    text(el, key, value) {
      if (cache[key] === value) return;
      cache[key] = value;
      el.textContent = value;
    },
    html(el, key, value) {
      if (cache[key] === value) return;
      cache[key] = value;
      el.innerHTML = value;
    },
    attr(el, key, name, value) {
      const k = `${key}@${name}`;
      if (cache[k] === value) return;
      cache[k] = value;
      if (value === null || value === undefined) el.removeAttribute(name);
      else el.setAttribute(name, value);
    },
    cache,
  };
}
