/**
 * Export.js — CSV / JSON serialisation for experiment data.
 *
 * The serialisers are pure (usable from Node for the batch benchmark script);
 * `downloadText` is the only browser-specific helper and is guarded.
 */

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(Math.round(value * 1e6) / 1e6);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise an array of flat objects to RFC-4180 CSV.
 * @param {object[]} rows
 * @param {string[]} [columns] explicit column order (defaults to union of keys)
 */
export function toCSV(rows, columns) {
  if (!rows.length) return columns ? `${columns.join(',')}\r\n` : '';
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(cols.map((c) => escapeCsvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Flattens nested objects: {a: {b: 1}} → {'a.b': 1} (arrays are JSON-encoded). */
export function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, name, out);
    else out[name] = value;
  }
  return out;
}

/** JSON with non-finite numbers mapped to null and floats trimmed. */
export function toJSON(data, space = 2) {
  return JSON.stringify(
    data,
    (_key, value) => {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return Number.isInteger(value) ? value : Math.round(value * 1e5) / 1e5;
      }
      return value;
    },
    space,
  );
}

export function timestampedName(prefix, ext, seed) {
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
  return `${prefix}${seed !== undefined ? `_seed-${seed}` : ''}_${stamp}.${ext}`;
}

/** Triggers a client-side file download (no-op outside the browser). */
export function downloadText(filename, text, mime = 'text/plain') {
  if (typeof document === 'undefined') return false;
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return true;
}
