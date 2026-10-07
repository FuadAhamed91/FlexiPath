/**
 * GuidedDemo.js — the competition demonstration, driven by real simulation events.
 *
 * It does not script outcomes: it restarts scenario A (Wi-Fi → 5G, seed 2026), then listens to the
 * engine. When the controller actually predicts, protects or switches — and when the legacy stack
 * actually interrupts and recovers — it pauses briefly and captions the moment using the decision
 * record and measured values of that tick. At the end it runs paired trials for the experiment table.
 */
import { LEGACY_PARAMS, LEGACY_WIRELESS_STALL_S } from '../simulation/LegacyController.js';
import { FAILSAFE_OUTAGE_S, ANCHOR_IP } from '../simulation/SimulationEngine.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';
import { linkName } from './format.js';

const HOLD = { intro: 5200, beat: 5200, short: 4200 };
const sentence = (s) => (!s ? '' : /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export class GuidedDemo {
  constructor(dash) {
    this.dash = dash;
    this.engine = dash.engine;
    this.active = false;
    this.unsubs = [];
  }

  start() {
    const d = this.dash;
    this.stop({ silent: true });
    d.closeModal();
    d.hideIntro();
    d.setMode('mission');
    d.setFocus('flexipath', { quiet: true });
    d.setGhost(true);
    d.setCamera('chase');
    d.setRate(1);
    this.active = true;
    this.seen = new Set();
    this.n = 0;
    const e = this.engine;
    this.unsubs = [
      e.on('event', (ev) => this._onEvent(ev)),
      e.on('tick', (s) => this._onTick(s)),
      e.on('complete', (s) => this._onComplete(s)),
      e.on('reset', () => {
        if (!this._resetting) this.stop();
      }),
    ];
    this._resetting = true;
    d.restart({ scenario: 'demo', seed: 2026, speedKmh: 60 }, { quiet: true });
    this._resetting = false;
    this._beat({
      step: 'GUIDED DEMO · SCENARIO A · Wi-Fi → 5G',
      title: 'Connectivity shouldn’t wait for failure.',
      body: 'Two identical drones fly the same corridor with the same seed and the same radio conditions. Cyan = FlexiPath: it predicts, prepares and protects. Crimson = Legacy OS: it reacts only after the link has failed. Everything shown is simulated.',
      hold: HOLD.intro,
    });
  }

  stop({ silent = false } = {}) {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    clearTimeout(this.timer);
    if (this.active && !silent) {
      this.dash.hideCaption();
      this.dash.setRate(1);
    }
    this.active = false;
  }

  _beat({ step, title, body, hold = HOLD.beat, pause = true, actions }) {
    clearTimeout(this.timer);
    const e = this.engine;
    if (pause) e.setPaused(true);
    this.dash._updatePlay?.();
    const resume = () => {
      clearTimeout(this.timer);
      if (pause && this.active) {
        e.setPaused(false);
        this.dash._updatePlay?.();
      }
    };
    this.dash.showCaption({
      step,
      title,
      body,
      holdMs: pause ? hold : 0,
      onNext: pause ? resume : null,
      onExit: () => {
        resume();
        this.stop();
      },
      actions,
    });
    if (pause) this.timer = setTimeout(resume, hold);
  }

  _fp() {
    return this.engine.snapshot.agents.flexipath;
  }

  _lastRecord(kind) {
    const list = this.engine.decisions;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].engine === 'flexipath' && list[i].kind === kind) return list[i];
    return null;
  }

  _onEvent(ev) {
    if (!this.active) return;
    const once = (k) => {
      if (this.seen.has(k)) return false;
      this.seen.add(k);
      return true;
    };
    if (ev.engine === 'flexipath') {
      if (ev.code === 'PREDICT' && !this.seen.has('repl') && once('predict')) {
        const r = this._lastRecord('PREDICT');
        this.predictBeats = (this.predictBeats ?? 0) + 1;
        this._beat({
          step: '1 / 6 · DETECT → PREDICT → PREPARE',
          title: `${r?.current?.name ?? 'The current link'} is degrading — FlexiPath predicts it`,
          body: `${sentence(r?.reason ?? ev.message)} ${r?.action ? `Action: ${sentence(r.action)} ` : ''}Until now that modem slept in DRX to save battery. The Legacy OS keeps using ${r?.current?.name ?? 'the link'}: it has no prediction.`,
          hold: this.predictBeats > 1 ? HOLD.short : HOLD.beat,
        });
      } else if (ev.code === 'TREND_OFF' && this.seen.has('predict') && !this.seen.has('repl')) {
        // Honest behaviour: a trend that reverses releases the prediction without spending anything.
        this.seen.delete('predict');
        this._beat({
          step: '1 / 6 · PREDICT',
          title: 'Trend reversed — prediction released',
          body: 'The signal recovered (shadowing), so FlexiPath released the prediction without replicating anything: no overhead was spent. The woken modem goes back to DRX sleep after its dwell.',
          pause: false,
        });
      } else if (ev.code === 'REPL_ON' && once('repl')) {
        const r = this._lastRecord('PROTECT');
        this._beat({
          step: '2 / 6 · REPLICATE · DECISION ENGINE',
          title: r?.headline ?? 'Critical flow protection enabled',
          body: `Action: ${sentence(r?.action)} Reason: ${sentence(r?.reason)} Purple packets carry critical traffic on both paths for this window only; the receiver keeps the first copy of each sequence number and discards the late duplicate, so delivery never waits (HoL 0 ms). Video and data sync are not duplicated: bulk moves with delay-compensated pacing.`,
        });
        this.dash.setRate(0.5); // slow motion while both paths carry critical traffic
      } else if (ev.code === 'REPL_RT' && this.seen.has('repl') && once('rt')) {
        this._beat({
          step: '2 / 6 · TRAFFIC-AWARE',
          title: 'Real-time traffic joins the protection',
          body: `${ev.message}. Voice was kept on one path while its loss stayed inside the ${(this.engine.agents.flexipath.controller.p.realtimeLossBudget * 100).toFixed(0)} % budget, which packet-loss concealment can hide.`,
          pause: false,
        });
      } else if ((ev.code === 'HOT_SWAP' || ev.code === 'FAILOVER') && this.seen.has('repl') && once('switch')) {
        const r = this._lastRecord(ev.code === 'HOT_SWAP' ? 'SWITCH' : 'FAILOVER');
        const fp = this._fp();
        const ep = fp.trace.episode;
        let failure = '';
        if (ep && ep.failureT !== null) {
          this.seen.add('fail');
          const lead = ep.failureT - (ep.actionT ?? ep.failureT);
          failure = ` ${linkName(ep.from)} reached its failure level (loss > 15 %) at T+${ep.failureT.toFixed(1)} s; protection had started ${lead.toFixed(1)} s before that.`;
        }
        this.dash.setRate(1);
        this._beat({
          step: '3 / 6 · FAILURE → SWITCH → CONTINUE',
          title: r?.headline ?? `Switched to ${linkName(ev.to)}`,
          body: `${sentence(r?.reason)}${failure} FlexiPath so far: ${fp.stats.stallTime.toFixed(2)} s of simulated interruption, ${fp.stats.criticalLost} critical packets lost. The old radio is back in DRX; the drone continues.`,
        });
      }
    } else if (ev.engine === 'legacy') {
      if (ev.code === 'LINK_LOST' && this.seen.has('predict') && once('lost')) {
        const ph = LEGACY_PARAMS.stallPhases.wireless.map((p) => `${p.key} ${p.duration.toFixed(1)} s`).join(' → ');
        this.dash.setRate(1);
        this._beat({
          step: '4 / 6 · LEGACY OS',
          title: 'Legacy reacts only now: CONNECTION INTERRUPTED',
          body: `${ev.message.replace(' → break-before-make · all sockets stalled', '')}. It tears the link down first, then looks for another one. Simulated recovery: ${ph} = ${LEGACY_WIRELESS_STALL_S.toFixed(1)} s (model parameters). Its sockets are bound to its physical address, so the new one will reset every TCP session.`,
        });
      } else if (ev.code === 'FAILSAFE' && this.seen.has('lost') && once('failsafe')) {
        this._beat({
          step: '4 / 6 · LEGACY OS',
          title: 'Fail-safe hover',
          body: `C2 telemetry has been silent for more than ${FAILSAFE_OUTAGE_S * 1000} ms, so the legacy drone stops and hovers in place (simulated lost-link policy).`,
          pause: false,
        });
      } else if (ev.code === 'RECONNECTED' && this.seen.has('lost') && once('recovered')) {
        const s = this.engine.snapshot.agents;
        const A = this.engine.agents;
        const fpT = A.flexipath.tunnel.state;
        const lgT = A.legacy.tunnel.state;
        this._beat({
          step: '5 / 6 · RESULT OF THIS RUN',
          title: 'Legacy recovered — same corridor, same radio conditions',
          body: `${sentence(ev.message)} Simulated interruption so far: FlexiPath ${s.flexipath.stats.stallTime.toFixed(2)} s · Legacy ${s.legacy.stats.stallTime.toFixed(2)} s. Remote services saw Legacy's source address change ${lgT.remoteIpChanges}× (sessions reset); FlexiPath's stayed ${ANCHOR_IP} (${fpT.remoteIpChanges} changes). Mean radio power FlexiPath ${A.flexipath.power.state.meanWatts.toFixed(2)} W · Legacy ${A.legacy.power.state.meanWatts.toFixed(2)} W (both radios always on: ${POWER_PARAMS.tierWatts[2]} W, model parameter). Replication cost ${s.flexipath.stats.overheadPct.toFixed(1)} % of protected-flow bytes.`,
          hold: HOLD.beat,
        });
      }
    }
  }

  _onTick(snapshot) {
    // A failure that comes *before* the switch is told in the switch step (they are a tick apart);
    // only a failure that arrives after FlexiPath already switched away gets its own caption.
    if (!this.active || this.seen.has('fail') || !this.seen.has('switch')) return;
    const tr = snapshot.agents.flexipath.trace;
    const ep = tr.episode ?? tr.last;
    if (ep && ep.failureT !== null && ep.stages.SWITCH !== null) {
      this.seen.add('fail');
      this._beat({
        step: '3 / 6 · FAILURE',
        title: `${linkName(ep.from)} has now actually failed (loss > 15 %)`,
        body: `FlexiPath had already moved to ${linkName(ep.to)} ${(ep.failureT - ep.stages.SWITCH).toFixed(1)} s earlier, so nothing was carried on the failing path.`,
        pause: false,
      });
    }
  }

  _onComplete() {
    if (!this.active) return;
    this.dash.setRate(1);
    this._beat({
      step: '6 / 6 · EXPERIMENTAL PROOF',
      title: 'One run is an anecdote — now 10 paired trials',
      body: 'Scenario A again, 10 different seeds, both stacks on identical conditions in every trial. The table reports measured differences with 95 % confidence intervals. DETECT → PREDICT → PREPARE → REPLICATE → SWITCH → CONTINUE.',
      pause: false,
      actions: [
        { label: 'Replay demo', primary: false, run: () => this.start() },
        { label: 'Why FlexiPath?', primary: false, run: () => this.dash.openInfo() },
      ],
    });
    setTimeout(() => {
      if (!this.active) return;
      this.dash.openExperiments({ scenario: 'A', trials: 10, speed: 60, autoRun: true, title: 'Experimental proof · scenario A · 10 paired trials' });
    }, 1400);
  }
}
