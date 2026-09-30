/**
 * FlowInspector.js — live breakdown of active flows, their path(s),
 * replication status and the receiver-side duplicate-discard counter.
 */
import { INTERFACE_SPECS } from '../simulation/LinkModel.js';
import { FLOW_DEFS } from '../simulation/TrafficManager.js';

const chip = (id, text = id) => `<span class="path-chip" style="--c:${INTERFACE_SPECS[id].color}">${text}</span>`;

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
        <div><div class="hud-label">Critical lost</div><div class="num mt-1 text-[15px] font-bold text-slate-100" data-ref="lost">0</div></div>
        <div><div class="hud-label">Repl. time</div><div class="num mt-1 text-[15px] font-bold text-slate-100" data-ref="rtime">0.0s</div></div>
      </div>
      <div class="flex flex-col gap-1.5 px-2 pb-3" data-ref="flows">
        ${FLOW_DEFS.map(
          (f) => `
          <div class="flow-row" data-flow="${f.id}">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="role ${f.cls === 'CRITICAL' ? 'role-replica' : 'role-share'}" style="animation:none">${f.cls === 'CRITICAL' ? 'CRIT' : 'BULK'}</span>
                <span class="font-mono text-[11px] font-semibold text-slate-100">${f.id}</span>
              </div>
              <div class="mt-0.5 truncate text-[10px] text-slate-500">${f.label}</div>
            </div>
            <div class="text-right">
              <div class="num text-[11px] font-semibold text-slate-100" data-ref="rate">—</div>
              <div class="num text-[9px] text-slate-500" data-ref="lat">—</div>
            </div>
            <div class="col-span-2 mt-1 flex min-h-[17px] flex-wrap items-center gap-1" data-ref="paths"></div>
          </div>`,
        ).join('')}
      </div>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => {
      if (!n.closest('[data-flow]')) this.refs[n.dataset.ref] = n;
    });
    this.rows = {};
    root.querySelectorAll('[data-flow]').forEach((row) => {
      const r = {};
      row.querySelectorAll('[data-ref]').forEach((n) => (r[n.dataset.ref] = n));
      this.rows[row.dataset.flow] = { el: row, refs: r, cache: {} };
    });
    this.cache = {};
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
      replColor = d.stalled ? '#fb7185' : '#64748b';
    } else if (d.replicationActive) {
      replText = `ACTIVE · ${d.replicationElapsed.toFixed(1)} s`;
      replColor = '#d8b4fe';
    }
    if (this.cache.replText !== replText) {
      this.cache.replText = replText;
      this.refs.repl.textContent = replText;
      this.refs.repl.style.color = replColor;
      this.refs.repl.style.borderColor = replColor === '#64748b' ? '' : `${replColor}88`;
    }
    this._set(this.refs.dups, 'dups', st.duplicatesDiscarded.toLocaleString('en-US'));
    this._set(this.refs.lost, 'lost', st.criticalLost.toLocaleString('en-US'));
    this.refs.lost.style.color = st.criticalLost > 0 && engine === 'legacy' ? '#fb7185' : '';
    this._set(this.refs.rtime, 'rtime', `${st.replicationTime.toFixed(1)}s`);

    for (const f of tr.flows) {
      const row = this.rows[f.id];
      if (!row) continue;
      let rate;
      let lat;
      let paths;
      if (f.cls === 'CRITICAL') {
        const pct = f.sent ? (f.delivered / f.sent) * 100 : 0;
        rate = `${pct.toFixed(pct === 100 ? 0 : 1)}% dlvd`;
        lat = f.delivered ? `${(f.oneWayMs * 2).toFixed(1)} ms RTT` : 'no delivery';
        if (!f.paths.length) paths = `<span class="role role-stalled">STALLED · TCP RST</span>`;
        else if (f.paths.length > 1) {
          paths = `${chip(f.paths[0])}<span class="text-[11px] font-bold text-repl">⇉</span>${chip(f.paths[1])}<span class="num ml-auto text-[9px] text-repl">+${f.dups} dups</span>`;
        } else paths = chip(f.paths[0]);
      } else {
        rate = `${f.mbps.toFixed(1)} Mbps`;
        lat = `demand ${f.demandMbps}`;
        const entries = Object.entries(f.alloc || {}).filter(([, v]) => v > 0.05);
        const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
        paths = entries.length
          ? entries.map(([id, v]) => chip(id, `${id} ${Math.round((v / total) * 100)}%`)).join('')
          : `<span class="role role-stalled">STALLED</span>`;
      }
      this._set(row.refs.rate, 'rate', rate, row.cache);
      this._set(row.refs.lat, 'lat', lat, row.cache);
      this._html(row.refs.paths, 'paths', paths, row.cache);
    }
  }
}
