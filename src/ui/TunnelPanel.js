/**
 * TunnelPanel.js — advanced view: the relay tunnel in detail. Session ID, anchor relay, the outer
 * address(es) currently carrying the tunnel, every interface's lease, and recent rebinds — next to the
 * legacy stack, whose sockets are bound to whatever physical address it has.
 */
import { INTERFACE_IDS } from '../simulation/LinkModel.js';
import { RELAY_PARAMS } from '../simulation/RelayTunnelModel.js';
import { esc, fmtT, linkName, makeSetter } from './format.js';

export class TunnelPanel {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 class="hud-title">Relay tunnel</h2>
        <span class="chip" data-ref="session">SESSION —</span>
      </div>
      <div class="px-3 pb-3">
        <div class="font-mono text-[10px] leading-relaxed text-slate-400">
          Anchor relay <b class="text-fp">${RELAY_PARAMS.anchorIp}:${RELAY_PARAMS.relayPort}</b> · ${esc(RELAY_PARAMS.encapsulation)}
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-1 text-[11px]" data-ref="outer">—</div>
        <table class="exp-table mt-2">
          <thead><tr><th>Interface</th><th>Physical address</th><th>Network</th><th>Leases</th></tr></thead>
          <tbody data-ref="leases"></tbody>
        </table>
        <div class="hud-label mt-2.5 mb-1">Recent rebinds (remote side unchanged)</div>
        <div class="flex flex-col gap-0.5 font-mono text-[10px] text-slate-400" data-ref="history">—</div>
        <div class="legacy-rule mt-2.5" data-ref="legacy">Legacy OS · —</div>
      </div>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.set = makeSetter();
  }

  update(snapshot) {
    const fp = snapshot.agents.flexipath.tunnel;
    const lg = snapshot.agents.legacy.tunnel;
    const S = this.set;
    S.text(this.refs.session, 'session', `SESSION ${fp.sessionId ?? '—'}`);
    S.html(
      this.refs.outer,
      'outer',
      fp.outer.length
        ? `<span class="text-slate-500">Outer</span> ${fp.outer.map((o) => `<span class="path-chip" style="--c:#94a3b8">${esc(linkName(o.iface))} ${esc(o.ip)}:${o.port}</span>`).join('')} <b class="text-slate-500">→</b> <span class="text-slate-500">remote sees</span> <b class="text-fp">${esc(fp.remoteIp ?? '—')}</b>`
        : '<span class="text-slate-500">No path</span>',
    );
    S.html(
      this.refs.leases,
      'leases',
      INTERFACE_IDS.map((id) => {
        const l = fp.leases[id];
        const cur = fp.outer.some((o) => o.iface === id);
        return `<tr><td>${esc(linkName(id))}${cur ? ' <span class="text-fp">●</span>' : ''}</td><td>${l ? esc(l.ip) : '—'}</td><td>${l ? esc(l.label) : 'not attached'}</td><td>${l ? l.count : 0}</td></tr>`;
      }).join(''),
    );
    S.html(
      this.refs.history,
      'history',
      fp.history.length
        ? [...fp.history].reverse().slice(0, 5).map((h) => `<div>${fmtT(h.t)} · ${esc(h.from)} → ${esc(h.to)} · remote ${esc(h.remote)}</div>`).join('')
        : '<div>No path change yet</div>',
    );
    S.text(
      this.refs.legacy,
      'legacy',
      `Legacy OS · sockets bound to ${lg.clientIp ?? '—'} · remote services saw ${lg.remoteIpChanges} address change${lg.remoteIpChanges === 1 ? '' : 's'} · ${snapshot.agents.legacy.stats.tcpResets} TCP resets`,
    );
  }
}
