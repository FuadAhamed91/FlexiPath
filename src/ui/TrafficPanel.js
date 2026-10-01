/**
 * TrafficPanel.js — "TRAFFIC-AWARE PROTECTION": not all traffic is treated the same.
 *
 * One card per active flow, ordered by priority: class, priority, current path(s), backup path,
 * replication status with its reason, and QoE sensitivity. The replication state is read from the
 * controller decision and the per-flow traffic result of this tick; the bulk "would cost" figure is the
 * flow's current rate against the backup path's measured capacity. Overhead totals are measured.
 * Replication only happens inside the ~400 ms handoff burst; bulk is moved with delay-compensated pacing.
 */
import { TRAFFIC_CLASSES } from '../simulation/TrafficManager.js';
import { FLEXIPATH_PARAMS } from '../simulation/FlexiPathController.js';
import { classBadge, esc, fmtInt, linkChip, linkName, makeSetter, tag } from './format.js';

const P = FLEXIPATH_PARAMS;
const BURST_MS = Math.round(P.burstWindowS * 1000);

export class TrafficPanel {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="flex items-start justify-between gap-2 px-3 pt-3 pb-1">
        <div>
          <h2 class="hud-title text-slate-200!">Traffic-aware protection</h2>
          <div class="mt-1 font-mono text-[9.5px] text-slate-500">Not all traffic is treated the same</div>
        </div>
        <span class="chip" data-ref="mode">FLEXIPATH</span>
      </div>
      <div class="flex flex-col gap-1.5 px-2 pt-1.5 pb-2" data-ref="list"></div>
      <div class="border-t border-slate-800/80 px-3 pt-2 pb-3">
        <div class="flex items-center justify-between gap-2">
          <span class="hud-label">Replication overhead · this run</span>${tag('measured')}
        </div>
        <div class="mt-1.5 grid grid-cols-2 gap-2">
          <div class="kpi-cell"><div class="v text-repl" data-ref="ovPkt">0.0%</div><div class="flow-meta mt-1">of critical + real-time bytes</div></div>
          <div class="kpi-cell"><div class="v text-slate-100" data-ref="ovAll">0.000%</div><div class="flow-meta mt-1">of all traffic bytes</div></div>
        </div>
        <div class="flow-meta mt-1.5" data-ref="ovSub">0 duplicates discarded at the receiver</div>
        <div class="flow-meta mt-1" >Legacy OS: one path for every flow, no replication · a loss stalls its TCP streams 200–500 ms (head-of-line).</div>
      </div>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.set = makeSetter();
    this.cards = {};
    this.flowKey = '';
  }

  _build(flows) {
    const sorted = [...flows].sort((a, b) => a.priority - b.priority);
    this.refs.list.innerHTML = sorted
      .map(
        (f) => `
      <article class="flow-card" data-flow="${f.id}">
        <header class="flex items-center gap-2">
          ${classBadge(f.cls, f.priority)}
          <span class="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-slate-100">${esc(f.name)}</span>
          <span class="num shrink-0 text-[11px] font-semibold text-slate-200" data-ref="metric">—</span>
        </header>
        <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
          <span class="flow-meta">path</span><span class="flex flex-wrap items-center gap-1" data-ref="paths">—</span>
          <span class="flow-meta ml-1">backup</span><span data-ref="backup">—</span>
        </div>
        <div class="mt-1.5 flex items-center justify-between gap-2">
          <span class="repl-state st-off" data-ref="state">OFF</span>
          <span class="flow-meta truncate" title="QoE sensitivity">${esc(TRAFFIC_CLASSES[f.cls].sensitivity)}</span>
        </div>
        <div class="flow-why" data-ref="why">—</div>
      </article>`,
      )
      .join('');
    this.cards = {};
    for (const el of this.refs.list.querySelectorAll('[data-flow]')) {
      const refs = {};
      el.querySelectorAll('[data-ref]').forEach((n) => (refs[n.dataset.ref] = n));
      this.cards[el.dataset.flow] = { el, refs, set: makeSetter() };
    }
  }

  update(snapshot) {
    const fp = snapshot.agents.flexipath;
    const flows = fp.flows ?? [];
    const key = flows.map((f) => f.id).join(',');
    if (key !== this.flowKey) {
      this.flowKey = key;
      this._build(flows);
    }
    const d = fp.decision;
    const tr = fp.traffic;
    if (!d || !tr) return;
    const results = Object.fromEntries(tr.flows.map((f) => [f.id, f]));
    const perFlow = fp.stats.perFlow ?? {};
    const backup = d.prepared ?? d.backup ?? null;
    const watching = d.watching && !d.protecting;
    const warming = watching && !d.prepared && d.warmTarget && (d.radio?.[d.warmTarget] === 'WARM' || d.radio?.[d.warmTarget] === 'WAKING') ? d.warmTarget : null;

    for (const f of flows) {
      const card = this.cards[f.id];
      const res = results[f.id];
      if (!card || !res) continue;
      const S = card.set;
      const R = card.refs;

      // Headline metric.
      let metric;
      if (f.mode === 'packet') {
        const tot = perFlow[f.id];
        const dl = tot && tot.sent ? (tot.delivered / tot.sent) * 100 : 100;
        metric = f.voice && Number.isFinite(fp.qoe?.mos) ? `MOS ${fp.qoe.mos.toFixed(2)} · ${dl.toFixed(1)}%` : `${dl.toFixed(dl >= 99.95 ? 0 : 1)}% delivered`;
      } else {
        metric = `${res.mbps.toFixed(1)} Mbps`;
      }
      S.text(R.metric, 'metric', metric);

      // Paths.
      let paths;
      if (!res.paths.length) paths = '<span class="text-rose-300">none · buffered</span>';
      else if (f.mode === 'packet') {
        paths = res.paths.length > 1 ? `${linkChip(res.paths[0])}<b class="text-repl">⇉</b>${linkChip(res.paths[1])}` : linkChip(res.paths[0]);
      } else {
        const entries = Object.entries(res.alloc || {}).filter(([, v]) => v > 0.05);
        const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
        paths = entries.map(([id, v]) => linkChip(id, `${linkName(id)} ${Math.round((v / total) * 100)}%`)).join('');
      }
      S.html(R.paths, 'paths', paths);
      S.html(R.backup, 'backup', backup ? linkChip(backup) : '<span class="text-slate-500">—</span>');

      // Replication state + reason.
      let state;
      let why;
      if (d.stalled) {
        state = ['STALLED', 'st-stalled'];
        why = 'No usable path: packets are buffered at the anchor';
      } else if (f.cls === 'CRITICAL') {
        if (res.replicated) {
          state = ['BURST', 'st-active'];
          why = `Sent on ${linkName(res.paths[0])} + ${linkName(res.paths[1])} for the ${BURST_MS} ms handoff window · receiver keeps the first copy of each sequence number, late duplicates discarded`;
        } else if (watching && d.prepared) {
          state = ['ARMED', 'st-armed'];
          why = `${linkName(d.prepared)} warm-validated · ${BURST_MS} ms burst if time-to-failure < ${P.ttfTriggerS.toFixed(1)} s`;
        } else if (warming) {
          state = ['PRIMING', 'st-standby'];
          why = `Degradation predicted · ${linkName(warming)} woken to warm probe, being validated by heartbeats`;
        } else {
          state = ['SINGLE PATH', 'st-off'];
          why = 'No degradation predicted · sequence-numbered, so a burst never stalls delivery';
        }
      } else if (f.cls === 'REALTIME') {
        if (res.replicated) {
          state = ['BURST', 'st-active'];
          why = `Joined the burst: loss above its ${(P.realtimeLossBudget * 100).toFixed(0)} % budget or failure < ${P.realtimeTtfS.toFixed(0)} s away`;
        } else if (d.protecting) {
          const loss = d.prediction?.loss ?? 0;
          state = ['STANDBY', 'st-standby'];
          why = `Loss ${(loss * 100).toFixed(1)} % within its ${(P.realtimeLossBudget * 100).toFixed(0)} % budget · joins if failure < ${P.realtimeTtfS.toFixed(0)} s away`;
        } else {
          state = ['SINGLE PATH', 'st-off'];
          why = 'Lowest-latency path · replicated only when it needs cover';
        }
      } else {
        state = ['OFF', 'st-off'];
        if (f.elastic) {
          why = 'Replication overhead not justified: elastic transfer, reliable transport retransmits and a copy would double its load';
        } else if (Number.isFinite(res.replicaCostPct) && backup) {
          why = `Replication overhead not justified for bulk priority: a copy would add ${res.mbps.toFixed(1)} Mbps ≈ ${res.replicaCostPct.toFixed(0)} % of ${linkName(backup)} capacity`;
        } else {
          why = 'Replication overhead not justified for bulk priority: kept on the primary (one radio awake), moved with delay-compensated pacing at a handoff';
        }
        if (d.protecting && d.replica) {
          const pc = res.pacing;
          const paced = pc && pc.offsetMs > 0.5 ? ` · paced: ${linkName(pc.slowPath)} segments sent ${pc.offsetMs.toFixed(0)} ms ahead so they arrive in order` : '';
          why = `Moved ⇢ ${linkName(d.replica)} within the burst${paced} · ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
        }
      }
      const stKey = state.join('|');
      if (S.cache.state !== stKey) {
        S.cache.state = stKey;
        R.state.textContent = state[0];
        R.state.className = `repl-state ${state[1]}`;
        card.el.classList.toggle('is-repl', state[1] === 'st-active');
      }
      S.text(R.why, 'why', why);
    }

    const st = fp.stats;
    this.set.text(this.refs.ovPkt, 'ovPkt', `+${(st.overheadPct ?? 0).toFixed(1)}%`);
    this.set.text(this.refs.ovAll, 'ovAll', `+${(st.overheadTotalPct ?? 0).toFixed(3)}%`);
    this.set.text(
      this.refs.ovSub,
      'ovSub',
      `${fmtInt(st.duplicatesDiscarded)} duplicates discarded at the receiver · ${(st.replicationTime ?? 0).toFixed(1)} s replicating`,
    );
  }
}
