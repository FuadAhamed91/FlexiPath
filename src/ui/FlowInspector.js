/**
 * FlowInspector.js — live breakdown of active flows, their class, path(s),
 * replication status and the receiver-side duplicate-discard counter.
 */
import { INTERFACE_SPECS } from '../simulation/LinkModel.js';
import { FLOW_DEFS } from '../simulation/TrafficManager.js';

const chip = (id, text = id) => `<span class="path-chip" style="--c:${INTERFACE_SPECS[id].color}">${text}</span>`;
const BADGE = {
  CRITICAL: ['CRIT', 'cls-badge cls-critical'],
  REALTIME: ['RT', 'cls-badge cls-realtime'],
  BULK: ['BULK', 'cls-badge cls-bulk'],
};

export class FlowInspector {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 class="hud-title">Flow Inspector</h2>
        <span class="chip" data-ref="repl">REPLICATION IDLE</span>
      </div>
      <div class="grid grid-cols-3 gap-2 px-3 pb-2">
        <div><div class="hud-label">Dups discarded</div><div class="num mt-1 text-[15px] font-bold text-repl" data-ref="dups">0</div></div>
        <div><div class="hud-label">Critical lost</div><div class="num mt-1 text-[15px] font-bold text-slate-900" data-ref="lost">0</div></div>
        <div><div class="hud-label">Overhead</div><div class="num mt-1 text-[15px] font-bold text-slate-900" data-ref="rtime">0.0%</div></div>
      </div>
      <div class="flex flex-col gap-1.5 px-2 pb-3" data-ref="flows"></div>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.cache = {};
    this.setFlows(FLOW_DEFS);
  }

  /** Rebuild rows for the flows of the current scenario (traffic profile). */
  setFlows(flows) {
    const key = flows.map((f) => f.id).join(',');
    if (key === this.flowKey) return;
    this.flowKey = key;
    this.refs.flows.innerHTML = [...flows]
      .sort((a, b) => a.priority - b.priority)
      .map((f) => {
        const [text, cls] = BADGE[f.cls] ?? BADGE.BULK;
        return `
          <div class="flow-row" data-flow="${f.id}">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="${cls}">${text}</span>
                <span class="font-mono text-[11px] font-semibold text-slate-900">${f.tag ?? f.id}</span>
              </div>
              <div class="mt-0.5 truncate text-[10px] text-slate-500">${f.label}</div>
            </div>
            <div class="text-right">
              <div class="num text-[11px] font-semibold text-slate-900" data-ref="rate">—</div>
              <div class="num text-[9px] text-slate-500" data-ref="lat">—</div>
            </div>
            <div class="col-span-2 mt-1 flex min-h-[17px] flex-wrap items-center gap-1" data-ref="paths"></div>
          </div>`;
      })
      .join('');
    this.rows = {};
    this.refs.flows.querySelectorAll('[data-flow]').forEach((row) => {
      const r = {};
      row.querySelectorAll('[data-ref]').forEach((n) => (r[n.dataset.ref] = n));
      this.rows[row.dataset.flow] = { el: row, refs: r, cache: {} };
    });
  }

  _set(el, key, value, cache = this.cache) {
    if (cache[key] === value) return;
    cache[key] = value;
    el.textContent = value;
  }

  _html(el, key, value, cache) {
    if (cache[key] === value) return;
    cache[key] = value;
    el.innerHTML = value;
  }

  update(agent, engine) {
    const d = agent.decision;
    const tr = agent.traffic;
    const st = agent.stats;

    let replText = 'REPLICATION IDLE';
    let replColor = '#64748b';
    if (engine === 'legacy') {
      replText = d.stalled ? 'SOCKETS STALLED' : 'NOT SUPPORTED';
      replColor = d.stalled ? '#dc2626' : '#64748b';
    } else if (d.replicationActive) {
      replText = `ACTIVE · ${d.replicationElapsed.toFixed(1)} s`;
      replColor = '#7c3aed';
    } else if (d.protecting) {
      replText = 'PROTECTION · NO ELIGIBLE FLOWS';
      replColor = '#2563eb';
    } else if (d.watching && d.prepared) {
      replText = `ARMED · ${d.prepared} PREPARED`;
      replColor = '#2563eb';
    }
    if (this.cache.replText !== replText) {
      this.cache.replText = replText;
      this.refs.repl.textContent = replText;
      this.refs.repl.style.color = replColor;
      this.refs.repl.style.borderColor = replColor === '#64748b' ? '' : `${replColor}88`;
    }
    this._set(this.refs.dups, 'dups', st.duplicatesDiscarded.toLocaleString('en-US'));
    this._set(this.refs.lost, 'lost', st.criticalLost.toLocaleString('en-US'));
    this.refs.lost.style.color = st.criticalLost > 0 && engine === 'legacy' ? '#dc2626' : '';
    this._set(this.refs.rtime, 'rtime', `${(st.overheadPct ?? 0).toFixed(1)}%`);

    for (const f of tr.flows) {
      const row = this.rows[f.id];
      if (!row) continue;
      let rate;
      let lat;
      let paths;
      if (f.mode === 'packet') {
        const pct = f.sent ? (f.delivered / f.sent) * 100 : 0;
        rate = `${pct.toFixed(pct === 100 ? 0 : 1)}% dlvd`;
        lat = f.delivered ? `${(f.oneWayMs * 2).toFixed(1)} ms RTT` : 'no delivery';
        if (!f.paths.length) paths = `<span class="role role-stalled">STALLED · TCP RST</span>`;
        else if (f.paths.length > 1) {
          paths = `${chip(f.paths[0])}<span class="text-[11px] font-bold text-repl">⇉</span>${chip(f.paths[1])}<span class="num ml-auto text-[9px] text-repl">${f.dups} late dup${f.dups === 1 ? '' : 's'} discarded</span>`;
        } else paths = `${chip(f.paths[0])}<span class="num ml-auto text-[9px] text-slate-500">HoL 0 ms · seq #${f.seqNext}</span>`;
      } else {
        rate = `${f.mbps.toFixed(1)} Mbps`;
        lat = f.holStallMs > 0 ? `HoL ${f.holStallMs.toFixed(0)} ms${f.rto ? ' · RTO' : ''}` : 'HoL 0 ms';
        const entries = Object.entries(f.alloc || {}).filter(([, v]) => v > 0.05);
        const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
        paths = entries.length
          ? entries.map(([id, v]) => chip(id, `${id} ${Math.round((v / total) * 100)}%`)).join('') +
            (f.pacing ? `<span class="num ml-auto text-[9px] text-sky-700">paced: ${f.pacing.slowPath} +${f.pacing.offsetMs.toFixed(0)} ms</span>` : '')
          : `<span class="role role-stalled">STALLED</span>`;
      }
      this._set(row.refs.rate, 'rate', rate, row.cache);
      this._set(row.refs.lat, 'lat', lat, row.cache);
      this._html(row.refs.paths, 'paths', paths, row.cache);
    }
  }
}
