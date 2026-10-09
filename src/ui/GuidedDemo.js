/**
 * GuidedDemo.js — the guided demo: the full mission flown live, paused at each real moment with a short caption.
 *
 * It does not script outcomes. One orientation card on the dock, then the flight runs (dock → Wi-Fi → 5G → LEO) and
 * the engine's own events pause the simulation: when the controller actually predicts, protects or switches, and when
 * the legacy stack actually interrupts and recovers, the demo holds the moment for a few seconds, says what is
 * happening in two or three sentences built from the decision record and the measured values of that tick, rings the
 * dashboard panel where it shows and says what that panel is, then resumes. Each kind of moment gets its full
 * explanation the first time and a shorter one afterwards. After the second handover's result it shows where the
 * rest of the numbers live: the Advanced view and its Charts button. The visitor can hold the flight at any time (the
 * card's Hold button, the play button or Space) and continue when ready (Continue or →). It ends with the result of
 * the mission and a button for 10 paired trials.
 */
import { ANCHOR_IP } from '../simulation/SimulationEngine.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';
import { esc, linkName } from './format.js';

const HOLD_BASE_MS = 6000; // a full explanation lasts at least this long …
const HOLD_SHORT_MS = 4000; // … a repeat at least this long …
const HOLD_PER_WORD_MS = 75; // … plus reading time for the caption
const BURST_MS = Math.round(POWER_PARAMS.burstWindowS * 1000);
const W = POWER_PARAMS.tierWatts;
const MARGIN = 12;

const sentence = (s) => (!s ? '' : /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const words = (body) => String(body).replace(/<[^>]+>/g, '').split(/\s+/).length;
const nth = (n) => ['First', 'Second', 'Third', 'Fourth', 'Fifth'][n] ?? `${n + 1}th`;

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
    this.switches = 0; // FlexiPath handovers so far
    this.lgLost = 0; // legacy interruptions so far
    this.lgBack = 0; // legacy recoveries so far
    this.predictedFor = null; // handover index whose prediction was already told
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
    d.restart({ scenario: 'mission', seed: 2026, speedKmh: 60 }, { quiet: true });
    this._resetting = false;
    d.refs.shell.dataset.demo = '1';
    this.refs.card.hidden = false;
    this._last = {};
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this._frame);
    this._beat({
      step: 'GUIDED DEMO · FULL MISSION · DOCK → Wi-Fi → 5G → LEO',
      title: 'One mission, two drones, the same simulated radio',
      body: 'The drone starts on its dock on a wired link and flies out through Wi-Fi, 5G and LEO satellite coverage. <b>Cyan</b> is FlexiPath: it predicts a fading link and prepares the next one before anything fails. <b>Crimson</b> is a legacy stack: it reacts only after a link has failed. The flight starts in a moment; hold it any time with the Hold button, the play button or Space.',
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

  /** Keyboard, from the dashboard: → or Enter continues a paused moment. */
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
    // A ringed panel below the fold (small screens) is brought into view.
    const el = typeof spec.target === 'function' ? spec.target() : null;
    if (el instanceof Element && spec.holdMs) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  /**
   * A moment. `pause` holds the simulation for a hold that grows with the caption (`short` for a repeat); a
   * caption-only beat (`pause: false`) never replaces a held card. `onShow` / `onRelease` adjust the view around
   * the hold; `then` chains another beat on release before the flight resumes.
   */
  _beat({ step, title, body, target, pause = true, short = false, hold, actions, continueBtn, onShow, onRelease, then }) {
    const e = this.engine;
    if (!pause && e.paused && !e.completed) return; // a held moment keeps its card
    clearTimeout(this.timer);
    this.timer = null;
    if (pause && !e.completed) {
      e.setPaused(true);
      this.dash._updatePlay();
    }
    this.held = false;
    onShow?.();
    const holdMs = pause && !e.completed ? (hold ?? (short ? HOLD_SHORT_MS : HOLD_BASE_MS) + HOLD_PER_WORD_MS * words(body)) : 0;
    this._render({ step, title, body, target, holdMs, actions, continueBtn, onRelease, then });
    if (holdMs) this.timer = setTimeout(() => this._release(), holdMs);
  }

  _release() {
    clearTimeout(this.timer);
    this.timer = null;
    this.held = false;
    const s = this.spec;
    if (s?.onRelease) {
      const cb = s.onRelease;
      s.onRelease = null;
      cb();
    }
    if (s?.then) {
      const next = s.then;
      s.then = null;
      next();
      return;
    }
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
    const d = this.dash;
    const R = d.refs;
    const n = this.switches; // which handover this is for FlexiPath
    if (ev.engine === 'flexipath') {
      if (ev.code === 'PREDICT' && this.predictedFor !== n) {
        this.predictedFor = n;
        const r = this._lastRecord('PREDICT');
        const cur = r?.current?.name ?? 'The current link';
        const next = r?.alternate?.name ?? 'the next';
        const dock = /dock/i.test(r?.reason ?? ev.message);
        const panel = [
          `<b>The loop above</b> is FlexiPath’s decision stage: PREDICT is lit now, PREPARE follows once ${esc(next)} is validated.`,
          `<b>The card on the right</b> is the decision record: the action and the reason, built from the values measured at that tick.`,
        ][n] ?? '';
        this._beat({
          step: `${nth(n)} handover · DETECT → PREDICT → PREPARE`,
          title: dock ? 'Dock release — the wired link is about to end' : `${cur} is fading — FlexiPath predicts it`,
          body: `${dock ? '' : 'Measured: '}${esc(sentence(r?.reason ?? ev.message))} It wakes the ${esc(next)} modem now and validates it while ${esc(cur)} still works; the legacy drone will notice nothing until ${esc(cur)} is gone. ${panel}`,
          target: () => (n === 1 ? R.decision : R.loop),
          short: n >= 2,
        });
      } else if (ev.code === 'TREND_OFF' && this.predictedFor === n) {
        // Honest behaviour: a trend that reverses releases the prediction without spending anything.
        this.predictedFor = null;
        this._beat({ step: 'PREDICT', title: 'The signal recovered — prediction released', body: 'Nothing was replicated and nothing was spent; the woken modem goes back to sleep after its dwell.', pause: false });
      } else if (ev.code === 'PREPARE') {
        const id = /(?:validated:|→)\s*(\w+)/.exec(ev.message)?.[1];
        this._beat({ step: 'PREPARE', title: `${id ? linkName(id) : 'Next path'} validated as the next path`, body: `${esc(ev.message)}. Validated means measured: heartbeats over the woken modem gave its RTT and loss before it carries anything.`, pause: false });
      } else if (ev.code === 'REPL_ON') {
        const r = this._lastRecord('PROTECT');
        const from = r?.current?.name ?? 'the current link';
        const to = r?.alternate?.name ?? 'the next link';
        if (n === 1) {
          this._beat({
            step: `${nth(n)} handover · REPLICATE`,
            title: `Critical traffic now rides ${from} and ${to} at once`,
            body: `${esc(from)} is about to fail, so for ${BURST_MS} ms every critical packet (purple) goes on both paths and the receiver keeps whichever copy arrives first; video and uploads are not duplicated. <b>At a glance</b> shows which traffic is on two paths and the radio draw: ${W[2]} W for this window only.`,
            target: () => R.glance,
          });
          d.setRate(0.5); // slow motion while both paths carry critical traffic
        } else {
          this._beat({ step: 'REPLICATE', title: `${BURST_MS} ms burst: critical traffic on ${from} and ${to}`, body: esc(ev.message), pause: false });
        }
      } else if (ev.code === 'HOT_SWAP' || ev.code === 'FAILOVER') {
        const fp = this._fp();
        const to = linkName(ev.to);
        const from = linkName(ev.from);
        const r = this._lastRecord(ev.code === 'HOT_SWAP' ? 'SWITCH' : 'FAILOVER');
        this.switches += 1;
        this.lastSwitchT = ev.t ?? this.engine.snapshot.t;
        d.setRate(1);
        const panel = n === 0 ? ` <b>The pill at the top</b> is FlexiPath’s state right now: SWITCHED · 0 MS GAP · sessions kept.` : '';
        const tally = n > 0 ? ` ${nth(n)} handover, still ${fp.stats.stallTime.toFixed(2)} s of simulated interruption.` : '';
        this._beat({
          step: `${nth(n)} handover · SWITCH → CONTINUE`,
          title: ev.code === 'HOT_SWAP' ? `Switched to ${to} — 0 ms gap` : `Failover to ${to}`,
          body: `${esc(to)} is now the primary path and the ${esc(from)} radio goes back to sleep. ${n === 0 ? 'Remote services still see the same address, so no session was reset.' : esc(sentence(r?.reason ?? ''))}${esc(tally)}${panel}`,
          target: () => R.pill,
          short: n >= 1,
        });
      }
    } else if (ev.engine === 'legacy') {
      if (ev.code === 'LINK_LOST') {
        const k = this.lgLost;
        this.lgLost += 1;
        const msg = ev.message.replace(/ → break-before-make.*$/, '');
        if (k === 0) {
          this._beat({
            step: 'LEGACY OS · INTERRUPTED',
            title: 'The legacy drone only notices when the link is gone',
            body: `${esc(sentence(msg))} Everything stalls while it tears the connection down, scans for another link and resets every TCP session, and when its C2 link is silent for more than ${Math.round(this.engine.config.failSafeS * 1000)} ms it must stop and hover. <b>The scoreboard below</b> counts simulated interruption for each stack: watch LG rise.`,
            target: () => R.lanes,
          });
        } else if (k === 1) {
          const ago = Number.isFinite(this.lastSwitchT) ? ` FlexiPath left that link ${(this.engine.snapshot.t - this.lastSwitchT).toFixed(0)} s ago.` : '';
          this._beat({
            step: 'LEGACY OS · INTERRUPTED',
            title: 'The legacy drone reacts only now',
            body: `${esc(sentence(msg))}${esc(ago)} The legacy drone tears down, scans and attaches again: interrupted and hovering a second time.`,
            target: () => R.lanes,
            short: true,
          });
        } else this._beat({ step: 'LEGACY OS', title: 'Interrupted again', body: `${esc(sentence(msg))} Break-before-make, every time.`, pause: false });
      } else if (ev.code === 'FAILSAFE') {
        this._beat({ step: 'LEGACY OS', title: 'Fail-safe hover', body: `C2 telemetry silent for more than ${Math.round(this.engine.config.failSafeS * 1000)} ms: the legacy drone stops and hovers while it scans. The FlexiPath drone flies on.`, pause: false });
      } else if (ev.code === 'RECONNECTED') {
        const k = this.lgBack;
        this.lgBack += 1;
        const s = this.engine.snapshot.agents;
        if (k === 1) {
          const A = this.engine.agents;
          this._beat({
            step: 'RESULT SO FAR',
            title: 'Same corridor, same radio — the difference so far',
            body: `Simulated interruption: FlexiPath <b>${s.flexipath.stats.stallTime.toFixed(2)} s</b>, Legacy <b>${s.legacy.stats.stallTime.toFixed(2)} s</b>. <b>At a glance</b> shows the radio power of both stacks (FlexiPath ${A.flexipath.power.state.meanWatts.toFixed(2)} W, Legacy ${A.legacy.power.state.meanWatts.toFixed(2)} W on average) and the address changes remote services saw: Legacy ${A.legacy.tunnel.state.remoteIpChanges}, FlexiPath ${A.flexipath.tunnel.state.remoteIpChanges} — it always shows the anchor ${ANCHOR_IP}.`,
            target: () => R.glance,
            then: () => this._advancedBeat(),
          });
        } else {
          this._beat({ step: 'LEGACY OS', title: `Legacy is back on ${linkName(ev.to ?? ev.link)}`, body: `${esc(sentence(ev.message))} With a new address, so every TCP session was reset. FlexiPath never stopped.`, pause: false });
        }
      }
    }
  }

  /** Where the rest of the numbers live: the Advanced view, then its Charts button; back to the mission after. */
  _advancedBeat() {
    const d = this.dash;
    this._beat({
      step: 'MORE NUMBERS',
      title: 'More numbers live in the Advanced view',
      body: '<b>This button</b> opens the Advanced dashboard: every panel beside the twin, one tab at a time — the prediction internals, each modem’s health, traffic-aware protection, battery and session, and the event log.',
      target: () => d.modeButtons.find((b) => b.dataset.mode === 'advanced'),
      onShow: () => d.setMode('advanced', { quiet: true }),
      then: () =>
        this._beat({
          step: 'MORE NUMBERS',
          title: '… and this button opens the charts',
          body: 'Six live charts of the last 60 s: throughput, critical-flow latency, packet loss, voice MOS, radio power and bulk stall, FlexiPath against Legacy. Purple bands are replication bursts, red bands are legacy interruptions. Now back to the mission.',
          target: () => d.refs.chartsBtn,
          onShow: () => d.setCharts(true),
          onRelease: () => {
            d.setCharts(false);
            d.setMode('mission', { quiet: true });
          },
        }),
    });
  }

  _onTick(snapshot) {
    // The old link's actual failure, after FlexiPath already left it: a caption, never a pause.
    if (!this.active) return;
    const tr = snapshot.agents.flexipath.trace;
    const ep = tr.episode ?? tr.last;
    if (!ep || ep.failureT === null || ep.stages.SWITCH === null || this.seen.has(`fail:${ep.from}:${ep.stages.SWITCH}`)) return;
    this.seen.add(`fail:${ep.from}:${ep.stages.SWITCH}`);
    const lead = ep.failureT - ep.stages.SWITCH;
    if (lead <= 0) return;
    this._beat({
      step: 'FAILURE',
      title: `${linkName(ep.from)} has now actually failed`,
      body: `FlexiPath had already moved to ${esc(linkName(ep.to))} ${lead.toFixed(1)} s earlier, so nothing was carried on the failing path.`,
      pause: false,
    });
  }

  _onComplete() {
    if (!this.active) return;
    const d = this.dash;
    d.setRate(1);
    const s = this.engine.snapshot.agents;
    const lgStops = s.legacy.stats.failSafeStops ?? 0;
    this._beat({
      step: 'MISSION COMPLETE',
      title: `FlexiPath flew the whole mission; the legacy drone had to ${lgStops ? `hover ${lgStops} time${lgStops === 1 ? '' : 's'}` : 'wait'}`,
      body: `${this.switches} handovers on the same simulated radio. Simulated interruption: FlexiPath <b>${s.flexipath.stats.stallTime.toFixed(2)} s</b>, Legacy <b>${s.legacy.stats.stallTime.toFixed(2)} s</b>. One run is an example: 10 paired trials of this mission, 10 seeds, both stacks on identical conditions, give the evidence with 95 % confidence intervals.`,
      pause: false,
      continueBtn: false,
      actions: [
        { label: 'Run 10 paired trials', primary: true, run: () => d.openExperiments({ scenario: 'mission', trials: 10, speed: 60, autoRun: true, title: 'Experimental proof · full mission · 10 paired trials' }) },
        { label: 'Replay demo', run: () => this.start() },
        { label: 'Explore freely', run: () => this.stop() },
      ],
    });
  }
}
