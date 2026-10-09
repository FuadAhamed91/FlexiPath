/**
 * GuidedDemo.js — the guided demo: scenario A flown live, paused at each real decision with a short caption.
 *
 * It does not script outcomes. One orientation card at T+0, then the flight runs and the engine's own events
 * pause the simulation: when the controller actually predicts, protects or switches, and when the legacy stack
 * actually interrupts and recovers, the demo holds the moment for a few seconds, says what is happening in two or
 * three sentences built from the decision record and the measured values of that tick, marks the panel where it
 * shows with a ring, and resumes. The visitor can hold the flight at any time (the card's Hold button, the play
 * button or Space) and continue when ready (Continue or →). It ends with the result of the run and a button for
 * 10 paired trials.
 */
import { LEGACY_WIRELESS_STALL_S } from '../simulation/LegacyController.js';
import { ANCHOR_IP } from '../simulation/SimulationEngine.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';
import { esc, linkName } from './format.js';

const HOLD_BASE_MS = 6000; // every pause lasts at least this long …
const HOLD_PER_WORD_MS = 75; // … plus reading time for the caption
const BURST_MS = Math.round(POWER_PARAMS.burstWindowS * 1000);
const W = POWER_PARAMS.tierWatts;
const MARGIN = 12;

const sentence = (s) => (!s ? '' : /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const holdFor = (body) => HOLD_BASE_MS + HOLD_PER_WORD_MS * String(body).replace(/<[^>]+>/g, '').split(/\s+/).length;

export class GuidedDemo {
  constructor(dash) {
    this.dash = dash;
    this.engine = dash.engine;
    this.active = false;
    this.spec = null;
    this.unsubs = [];
    this.timer = null;
    this.raf = 0;
    this.held = false;
    this._last = {};
    this._frame = this._frame.bind(this);
    this._build();
  }

  // ── DOM ───────────────────────────────────────────────────────────────
  _build() {
    const host = this.dash.refs.tour;
    host.innerHTML = `
      <div class="tour-spot" data-ref="spot" hidden></div>
      <div class="tour-card" data-ref="card" hidden role="status" aria-live="polite">
        <div class="flex items-center justify-between gap-2">
          <span class="step" data-ref="step"></span>
          <div class="flex shrink-0 items-center gap-1.5">
            <button type="button" class="btn h-[24px]! px-2! text-[10.5px]!" data-ref="hold" hidden></button>
            <button type="button" class="btn h-[24px]! px-2! text-[10.5px]!" data-ref="exit" title="Exit the demo (Esc)">Exit demo</button>
          </div>
        </div>
        <div class="title" data-ref="title"></div>
        <div class="body" data-ref="body"></div>
        <div class="mt-2.5 flex flex-wrap items-center gap-1.5 empty:hidden" data-ref="actions"></div>
        <div class="bar"><span data-ref="bar"></span></div>
      </div>`;
    this.refs = {};
    host.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.refs.hold.addEventListener('click', () => this.toggleHold());
    this.refs.exit.addEventListener('click', () => this.stop());
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  start() {
    const d = this.dash;
    this.stop({ silent: true });
    d.closeModal();
    d.hideIntro();
    if (d.view.theatre) d.setTheatre(false);
    d.setMode('mission', { quiet: true });
    d.setFocus('flexipath', { quiet: true });
    d.setGhost(true);
    d.setCamera('chase');
    d.setRate(1);
    this.active = true;
    this.seen = new Set();
    this.predictBeats = 0;
    this.held = false;
    const e = this.engine;
    this.unsubs = [
      e.on('event', (ev) => this._onEvent(ev)),
      e.on('tick', (s) => this._onTick(s)),
      e.on('complete', () => this._onComplete()),
      e.on('reset', () => {
        if (!this._resetting) this.stop();
      }),
    ];
    this._resetting = true;
    d.restart({ scenario: 'demo', seed: 2026, speedKmh: 60 }, { quiet: true });
    this._resetting = false;
    d.refs.shell.dataset.demo = '1';
    this.refs.card.hidden = false;
    this._last = {};
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this._frame);
    this._beat({
      step: 'GUIDED DEMO · SCENARIO A · Wi-Fi → 5G',
      title: 'Two drones, one corridor, the same simulated radio',
      body: '<b>Cyan</b> is FlexiPath: it predicts a fading link and prepares the next one before anything fails. <b>Crimson</b> is a legacy stack: it reacts only after the link has failed. The loop above shows FlexiPath’s stage; the scoreboard below counts simulated interruption. The flight starts in a moment: hold it any time with the Hold button, the play button or Space.',
    });
  }

  stop({ silent = false } = {}) {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    clearTimeout(this.timer);
    this.timer = null;
    cancelAnimationFrame(this.raf);
    const wasActive = this.active;
    this.active = false;
    this.spec = null;
    this.refs.card.hidden = true;
    this.refs.spot.hidden = true;
    this.dash.refs.shell.dataset.demo = '0';
    if (wasActive && !silent) {
      this.dash.setRate(1);
      // Leave the visitor with a running simulation unless they paused it themselves.
      if (this.engine.paused && !this.held && !this.engine.completed) {
        this.engine.setPaused(false);
        this.dash._updatePlay();
      }
    }
    this.held = false;
  }

  /** Keyboard, from the dashboard: → continues a paused moment. */
  onKey(key) {
    if (!this.active) return false;
    if (key === 'arrowright' || key === 'enter') return this.primary(), true;
    return false;
  }

  /** The visitor paused or resumed the simulation themselves (play button or Space). */
  onUserPause(paused) {
    if (!this.active) return;
    if (paused) {
      clearTimeout(this.timer);
      this.timer = null;
      this.held = true;
      this._freezeBar();
    } else {
      this.held = false;
      this._setBar(0);
    }
    this._syncNav();
  }

  primary() {
    if (this.engine.paused && !this.engine.completed) this._release();
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  _render(spec) {
    this.spec = spec;
    const R = this.refs;
    R.step.textContent = spec.step ?? '';
    R.title.textContent = spec.title ?? '';
    R.body.innerHTML = spec.body ?? '';
    R.actions.innerHTML = '';
    if (spec.continueBtn !== false) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-primary h-[26px]! px-3! text-[11px]!';
      b.innerHTML = 'Continue<i data-lucide="chevron-right"></i>';
      b.addEventListener('click', () => this.primary());
      b.hidden = true;
      R.actions.append(b);
      this.continueBtn = b;
    } else this.continueBtn = null;
    for (const a of spec.actions ?? []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn h-[26px]! px-2.5! text-[11px]! ${a.primary ? 'btn-primary' : ''}`;
      b.textContent = a.label;
      b.addEventListener('click', () => a.run());
      R.actions.append(b);
    }
    this.dash.renderIcons(R.actions);
    this._setBar(spec.holdMs ?? 0);
    this._last = {};
    this._syncNav();
    this._layout();
  }

  /** The Hold / Resume button and the Continue button follow the engine's pause state. */
  _syncNav() {
    const s = this.spec;
    if (!s) return;
    const R = this.refs;
    const running = !this.engine.completed;
    const paused = this.engine.paused;
    const key = `${running}|${paused}`;
    if (this._last.nav === key) return;
    this._last.nav = key;
    R.hold.hidden = !running;
    if (running) {
      R.hold.innerHTML = `<i data-lucide="${paused ? 'play' : 'pause'}"></i>${paused ? 'Resume flight' : 'Hold flight'}`;
      R.hold.title = paused ? 'Resume the flight (Space)' : 'Hold the flight here (Space)';
      this.dash.renderIcons(R.hold);
    }
    if (this.continueBtn) this.continueBtn.hidden = !(running && paused);
  }

  _setBar(ms) {
    const bar = this.refs.bar;
    bar.style.transition = 'none';
    bar.style.width = '0%';
    if (ms > 0) {
      void bar.offsetWidth;
      bar.style.transition = `width ${ms}ms linear`;
      bar.style.width = '100%';
    }
  }

  _freezeBar() {
    const bar = this.refs.bar;
    const w = getComputedStyle(bar).width;
    bar.style.transition = 'none';
    bar.style.width = w;
  }

  _frame() {
    if (!this.active) return;
    this.raf = requestAnimationFrame(this._frame);
    this._syncNav();
    this._layout();
  }

  /** The card sits over the lower part of the twin; the ring marks the panel the caption talks about. */
  _layout() {
    const s = this.spec;
    if (!s) return;
    const R = this.refs;
    const L = this._last;
    const el = typeof s.target === 'function' ? s.target() : null;
    const rect = el?.getBoundingClientRect();
    const spot = R.spot;
    if (rect && rect.width > 2 && rect.height > 2 && this.engine.paused) {
      const key = `${rect.left | 0},${rect.top | 0},${rect.width | 0},${rect.height | 0}`;
      if (L.spot !== key) {
        L.spot = key;
        spot.hidden = false;
        spot.style.left = `${rect.left - 5}px`;
        spot.style.top = `${rect.top - 5}px`;
        spot.style.width = `${rect.width + 10}px`;
        spot.style.height = `${rect.height + 10}px`;
      }
    } else if (!spot.hidden) {
      spot.hidden = true;
      L.spot = null;
    }
    const v = this.dash.refs.viewport.getBoundingClientRect();
    const w = R.card.offsetWidth;
    const h = R.card.offsetHeight;
    const x = clamp(v.left + v.width / 2 - w / 2, MARGIN, window.innerWidth - w - MARGIN);
    const y = clamp(v.bottom - h - 64, MARGIN, window.innerHeight - h - MARGIN);
    const key = `${x | 0},${y | 0}`;
    if (L.card !== key) {
      L.card = key;
      R.card.style.left = `${x}px`;
      R.card.style.top = `${y}px`;
    }
  }

  // ── Beats ─────────────────────────────────────────────────────────────
  _beat({ step, title, body, target, pause = true, hold, actions, continueBtn }) {
    clearTimeout(this.timer);
    this.timer = null;
    const e = this.engine;
    if (pause && !e.completed) {
      e.setPaused(true);
      this.dash._updatePlay();
    }
    this.held = false;
    const holdMs = pause && !e.completed ? (hold ?? holdFor(body)) : 0;
    this._render({ step, title, body, target, holdMs, actions, continueBtn });
    if (holdMs) this.timer = setTimeout(() => this._release(), holdMs);
  }

  _release() {
    clearTimeout(this.timer);
    this.timer = null;
    this.held = false;
    if (this.active && this.engine.paused && !this.engine.completed) {
      this.engine.setPaused(false);
      this.dash._updatePlay();
    }
    this._setBar(0);
    this._syncNav();
  }

  _holdHere() {
    clearTimeout(this.timer);
    this.timer = null;
    this.held = true;
    this.engine.setPaused(true);
    this.dash._updatePlay();
    this._freezeBar();
    this._syncNav();
  }

  toggleHold() {
    if (this.engine.paused) this._release();
    else this._holdHere();
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
    const R = this.dash.refs;
    const once = (k) => {
      if (this.seen.has(k)) return false;
      this.seen.add(k);
      return true;
    };
    if (ev.engine === 'flexipath') {
      if (ev.code === 'PREDICT' && !this.seen.has('repl') && once('predict')) {
        const r = this._lastRecord('PREDICT');
        const cur = r?.current?.name ?? 'The current link';
        const next = r?.alternate?.name ?? 'the next link';
        this.predictBeats += 1;
        this._beat({
          step: '1 · DETECT → PREDICT → PREPARE',
          title: `${cur} is fading — FlexiPath predicts it`,
          body: `Measured: ${esc(sentence(r?.reason ?? ev.message))} It wakes the ${esc(next)} modem now and validates it while ${esc(cur)} still works. The legacy drone keeps flying on ${esc(cur)}: it has no prediction.`,
          target: () => R.loop,
          hold: this.predictBeats > 1 ? HOLD_BASE_MS : undefined,
        });
      } else if (ev.code === 'TREND_OFF' && this.seen.has('predict') && !this.seen.has('repl')) {
        // Honest behaviour: a trend that reverses releases the prediction without spending anything.
        this.seen.delete('predict');
        this._beat({
          step: '1 · PREDICT',
          title: 'The signal recovered — prediction released',
          body: 'Nothing was replicated and nothing was spent. The woken modem goes back to sleep after its dwell.',
          target: () => R.loop,
          pause: false,
        });
      } else if (ev.code === 'REPL_ON' && once('repl')) {
        const r = this._lastRecord('PROTECT');
        const from = r?.current?.name ?? 'the current link';
        const to = r?.alternate?.name ?? 'the next link';
        this._beat({
          step: '2 · REPLICATE',
          title: `Critical traffic now rides ${from} and ${to} at once`,
          body: `${esc(from)} is about to fail, so for the next ${BURST_MS} ms every critical packet (purple) is sent on both paths and the receiver keeps whichever copy arrives first. Video and uploads are not duplicated. The radio draws ${W[2]} W for this window only.`,
          target: () => R.glance,
        });
        this.dash.setRate(0.5); // slow motion while both paths carry critical traffic
      } else if (ev.code === 'REPL_RT' && this.seen.has('repl') && once('rt')) {
        this._beat({
          step: '2 · TRAFFIC-AWARE',
          title: 'Voice joins the protection',
          body: `${esc(ev.message)}. Voice stayed on one path while its loss was inside the ${(this.engine.agents.flexipath.controller.p.realtimeLossBudget * 100).toFixed(0)} % budget that concealment can hide.`,
          target: () => R.glance,
          pause: false,
        });
      } else if ((ev.code === 'HOT_SWAP' || ev.code === 'FAILOVER') && this.seen.has('repl') && once('switch')) {
        const fp = this._fp();
        const ep = fp.trace.episode;
        let failure = '';
        if (ep && ep.failureT !== null) {
          this.seen.add('fail');
          failure = ` ${linkName(ep.from)} failed at T+${ep.failureT.toFixed(1)} s, ${(ep.failureT - (ep.actionT ?? ep.failureT)).toFixed(1)} s after protection started.`;
        }
        this.dash.setRate(1);
        this._beat({
          step: '3 · SWITCH → CONTINUE',
          title: ev.code === 'HOT_SWAP' ? `Switched to ${linkName(ev.to)} — 0 ms gap` : `Failover to ${linkName(ev.to)}`,
          body: `${esc(linkName(ev.to))} is now the primary path and the old radio goes back to sleep.${esc(failure)} Remote services still see the same address, so no session was reset. FlexiPath so far: ${fp.stats.stallTime.toFixed(2)} s of simulated interruption, ${fp.stats.criticalLost} critical packets lost.`,
          target: () => R.pill,
        });
      }
    } else if (ev.engine === 'legacy') {
      if (ev.code === 'LINK_LOST' && this.seen.has('predict') && once('lost')) {
        this.dash.setRate(1);
        this._beat({
          step: '4 · LEGACY OS',
          title: 'The legacy drone reacts only now',
          body: `Its Wi-Fi has failed. It tears the connection down first, then looks for another link: ${LEGACY_WIRELESS_STALL_S.toFixed(1)} s of simulated recovery, and every TCP session resets because its address changes. Watch the <b>LG</b> counter in the scoreboard. If its C2 link stays silent for more than ${Math.round(this.engine.config.failSafeS * 1000)} ms, it must stop and hover.`,
          target: () => R.lanes,
        });
      } else if (ev.code === 'FAILSAFE' && this.seen.has('lost') && once('failsafe')) {
        this._beat({
          step: '4 · LEGACY OS',
          title: 'Fail-safe hover',
          body: `C2 telemetry silent for more than ${Math.round(this.engine.config.failSafeS * 1000)} ms: the legacy drone stops and hovers in place. The FlexiPath drone flies on.`,
          target: () => R.lanes,
          pause: false,
        });
      } else if (ev.code === 'RECONNECTED' && this.seen.has('lost') && once('recovered')) {
        const s = this.engine.snapshot.agents;
        const A = this.engine.agents;
        const fpT = A.flexipath.tunnel.state;
        const lgT = A.legacy.tunnel.state;
        this._beat({
          step: '5 · RESULT OF THIS RUN',
          title: 'Same corridor, same radio — the difference',
          body: `Simulated interruption: FlexiPath <b>${s.flexipath.stats.stallTime.toFixed(2)} s</b>, Legacy <b>${s.legacy.stats.stallTime.toFixed(2)} s</b>. Address changes seen by remote services: Legacy ${lgT.remoteIpChanges}, FlexiPath ${fpT.remoteIpChanges} (it always shows ${ANCHOR_IP}). Mean radio power: FlexiPath ${A.flexipath.power.state.meanWatts.toFixed(2)} W, Legacy ${A.legacy.power.state.meanWatts.toFixed(2)} W. Duplicate bytes: ${s.flexipath.stats.overheadPct.toFixed(1)} % of the protected traffic.`,
          target: () => R.glance,
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
        step: '3 · FAILURE',
        title: `${linkName(ep.from)} has now actually failed`,
        body: `FlexiPath had already moved to ${esc(linkName(ep.to))} ${(ep.failureT - ep.stages.SWITCH).toFixed(1)} s earlier, so nothing was carried on the failing path.`,
        target: () => this.dash.refs.loop,
        pause: false,
      });
    }
  }

  _onComplete() {
    if (!this.active) return;
    this.dash.setRate(1);
    const s = this.engine.snapshot.agents;
    const lgStops = s.legacy.stats.failSafeStops ?? 0;
    this._beat({
      step: 'RUN COMPLETE',
      title: `FlexiPath flew through the handover; the legacy drone had to ${lgStops ? 'hover' : 'wait'}`,
      body: `Simulated interruption: FlexiPath ${s.flexipath.stats.stallTime.toFixed(2)} s, Legacy ${s.legacy.stats.stallTime.toFixed(2)} s${lgStops ? ` with ${lgStops} fail-safe hover${lgStops === 1 ? '' : 's'}` : ''}. One run is an example: 10 paired trials of this scenario, 10 seeds, both stacks on identical conditions, give the evidence with 95 % confidence intervals.`,
      pause: false,
      continueBtn: false,
      actions: [
        { label: 'Run 10 paired trials', primary: true, run: () => this.dash.openExperiments({ scenario: 'A', trials: 10, speed: 60, autoRun: true, title: 'Experimental proof · scenario A · 10 paired trials' }) },
        { label: 'Replay demo', run: () => this.start() },
        { label: 'Explore freely', run: () => this.stop() },
      ],
    });
  }
}
