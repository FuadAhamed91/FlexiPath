/**
 * GlancePanel.js — Mission view: the live comparison, kept to a few lines.
 *
 * Which traffic is protected right now (one state per class present), and the three engineering
 * numbers side by side: radio power, the longest data stall, client IP changes seen by remote
 * services. The full panels (prediction, traffic-aware protection, battery · ordering · session)
 * are in the Advanced view; "Details" switches to it.
 */
import { POWER_TIERS } from '../simulation/PowerModel.js';
import { RELAY_PARAMS } from '../simulation/RelayTunnelModel.js';
import { esc, fmtInt, makeSetter, tag } from './format.js';

const state = (text, cls) => `<span class="repl-state ${cls}">${esc(text)}</span>`;

export class GlancePanel {
  constructor(root, { onDetails } = {}) {
    this.root = root;
    root.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 class="hud-title text-slate-200!">At a glance</h2>
        <div class="flex items-center gap-1.5">
          ${tag('measured')}
          <button type="button" class="btn h-[20px]! px-2! text-[10px]!" data-ref="details" title="Full detail in the Advanced view (M)">Details</button>
        </div>
      </div>
      <div class="flex flex-wrap gap-x-3 gap-y-1.5 px-3 pb-3" data-ref="classes" aria-label="Protection by traffic class"></div>
      <div class="glance-grid px-3 pb-2.5">
        <span></span><span class="glance-head text-fp">FlexiPath</span><span class="glance-head text-legacy">Legacy</span>
        <span class="glance-label" title="Radio subsystem draw right now. Model tiers: 1.2 W DRX standby · 1.8 W warm probe · 3.4 W burst (400 ms).">Radio power</span>
        <b class="glance-v text-fp" data-ref="fpW">—</b><b class="glance-v text-legacy" data-ref="lgW">—</b>
        <span class="glance-label" title="Longest head-of-line stall of a bulk TCP stream so far: a lost segment holds back everything behind it until fast retransmit or a 200–500 ms timeout repairs it.">Longest data stall</span>
        <b class="glance-v text-fp" data-ref="fpHol">—</b><b class="glance-v text-legacy" data-ref="lgHol">—</b>
        <span class="glance-label" title="Client address changes that remote services saw. FlexiPath tunnels every flow to the anchor relay ${RELAY_PARAMS.anchorIp}; each legacy change resets its TCP sessions.">IP changes seen</span>
        <b class="glance-v text-fp" data-ref="fpIp">—</b><b class="glance-v text-legacy" data-ref="lgIp">—</b>
      </div>
      <div class="glance-note flow-meta truncate border-t border-slate-800/80 px-3 py-2" data-ref="note">—</div>`;
    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.refs.details.addEventListener('click', () => onDetails?.());
    this.set = makeSetter();
  }

  _classes(fp) {
    const d = fp.decision;
    if (!d) return '';
    const c = d.classes ?? {};
    if (!d.primary) return state('No usable path · buffering', 'st-stalled');
    const out = [];
    if (c.CRITICAL) {
      if (d.replicate?.CRITICAL) out.push(state('Critical ⇉ 2 paths', 'st-active'));
      else if (d.watching && d.prepared) out.push(state('Critical · armed', 'st-armed'));
      else out.push(state('Critical · 1 path', 'st-off'));
    }
    if (c.REALTIME) {
      if (d.replicate?.REALTIME) out.push(state('Voice ⇉ 2 paths', 'st-active'));
      else if (d.protecting) out.push(state('Voice · standby', 'st-standby'));
      else out.push(state('Voice · 1 path', 'st-off'));
    }
    if (c.BULK) out.push(d.protecting ? state('Bulk · paced, not copied', 'st-armed') : state('Bulk · never copied', 'st-off'));
    return out.join('');
  }

  update(snapshot) {
    const R = this.refs;
    const S = this.set;
    const fp = snapshot.agents.flexipath;
    const lg = snapshot.agents.legacy;

    S.html(R.classes, 'classes', this._classes(fp));

    const tier = POWER_TIERS[fp.power?.tier ?? 0];
    S.text(R.fpW, 'fpW', `${(fp.power?.watts ?? 0).toFixed(1)} W`);
    S.text(R.lgW, 'lgW', `${(lg.power?.watts ?? 0).toFixed(1)} W`);
    if (S.cache.tierKey !== tier.key) {
      S.cache.tierKey = tier.key;
      R.fpW.title = tier.label;
    }

    const st = fp.hol?.stats;
    const sl = lg.hol?.stats;
    const bulk = st && st.bulkHolMeanMs !== null;
    S.text(R.fpHol, 'fpHol', bulk ? `${st.bulkHolPeakMs.toFixed(0)} ms` : '—');
    S.text(R.lgHol, 'lgHol', bulk ? `${sl.bulkHolPeakMs.toFixed(0)} ms` : '—');

    S.text(R.fpIp, 'fpIp', String(fp.tunnel?.remoteIpChanges ?? 0));
    S.text(R.lgIp, 'lgIp', String(lg.tunnel?.remoteIpChanges ?? 0));

    let note;
    if (fp.hasCritical || fp.hasVoice) note = `Critical + voice stall ${(st?.packetHolMaxMs ?? 0).toFixed(0)} ms · ${fmtInt(st?.duplicatesDiscarded ?? 0)} late duplicates discarded`;
    else note = bulk ? 'No critical or voice flows in this scenario' : '—';
    S.text(R.note, 'note', note);
  }
}
