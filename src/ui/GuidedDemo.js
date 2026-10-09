/**
 * GuidedDemo.js — the guided demo: the full mission flown live, paused at each real moment until the visitor
 * continues, with the dashboards that moment changed shown one by one before the flight resumes.
 *
 * It does not script outcomes. One orientation card on the dock, then the flight runs (dock → Wi-Fi → 5G → LEO)
 * and the engine's own events pause the simulation: when the controller actually predicts, protects or switches,
 * and when the legacy stack actually interrupts and recovers, the demo stops and says what is happening in two or
 * three sentences built from the decision record and the measured values of that tick. Nothing resumes on its own.
 * Next then shows the panels that moment changed — a ring around each, with its live numbers; a panel that lives in
 * the Advanced view or the charts switches the view for that card — and the last card resumes the flight, back in
 * the Mission view, from where it paused. Hold flight, the play button or Space pause the running flight. The
 * mission end card offers 10 paired trials, a walk through every dashboard, a replay, or free exploration.
 */
import { ANCHOR_IP } from '../simulation/SimulationEngine.js';
import { POWER_PARAMS, POWER_TIERS, RADIO_STATES } from '../simulation/PowerModel.js';
import { INTERFACE_IDS, INTERFACE_SPECS } from '../simulation/LinkModel.js';
import { esc, fmtSignal, linkName } from './format.js';

const BURST_MS = Math.round(POWER_PARAMS.burstWindowS * 1000);
const W = POWER_PARAMS.tierWatts;
const MARGIN = 12;
/** Every dashboard, in walk order (the mission end card offers them all). */
const ALL_PANELS = ['pill', 'loop', 'decision', 'glance', 'lanes', 'history', 'prediction', 'links', 'traffic', 'session', 'controls', 'log', 'charts'];

const sentence = (s) => {
  if (!s) return '';
  const t = s.trim();
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const nth = (n) => ['First', 'Second', 'Third', 'Fourth', 'Fifth'][n] ?? `${n + 1}th`;
const secs = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1));
const strip = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class GuidedDemo {
  constructor(dash) {
    this.dash = dash;
    this.engine = dash.engine;
    this.active = false;
    this.spec = null;
    this.moment = null; // the card of the moment the flight is paused at (or the last caption while it runs)
    this.walk = null; // the dashboard cards of the current stop
    this.endCard = null;
    this.unsubs = [];
    this.raf = 0;
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
            <button type="button" class="btn h-[24px]! px-2! text-[10.5px]!" data-ref="hold" hidden title="Hold the flight here (Space)"><i data-lucide="pause"></i>Hold flight</button>
            <button type="button" class="btn h-[24px]! px-2! text-[10.5px]!" data-ref="exit" title="Exit the demo and keep flying (Esc)">Exit demo</button>
          </div>
        </div>
        <div class="title" data-ref="title"></div>
        <div class="body" data-ref="body"></div>
        <div class="mt-2.5 flex flex-wrap items-center gap-1.5 empty:hidden" data-ref="actions"></div>
      </div>`;
    this.refs = {};
    host.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.dash.renderIcons(host);
    this.refs.hold.addEventListener('click', () => this.dash.togglePause(true));
    this.refs.exit.addEventListener('click', () => this.stop());
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  start() {
    const d = this.dash;
    this.stop({ silent: true });
    d.closeModal();
    d.hideIntro();
    this._missionView();
    d.setGhost(true);
    d.setCamera('chase');
    d.setRate(1);
    this.active = true;
    this.seen = new Set();
    this.switches = 0; // FlexiPath handovers so far
    this.lgLost = 0; // legacy interruptions so far
    this.lgBack = 0; // legacy recoveries so far
    this.predictedFor = null; // handover index whose prediction was already told
    this.walk = null;
    this.endCard = null;
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
    this._moment({
      step: 'GUIDED DEMO · FULL MISSION · DOCK → Wi-Fi → 5G → LEO',
      title: 'One mission, two drones, the same simulated radio',
      body: 'The drone starts on its dock on a wired link and flies out through Wi-Fi, 5G and LEO satellite coverage. <b>Cyan</b> is FlexiPath: it predicts a fading link and prepares the next one before anything fails. <b>Crimson</b> is a legacy stack: it reacts only after a link has failed. The flight pauses at each real decision and waits for you: read what happened, step through the panels it changed, then resume.',
      panels: [],
      resumeLabel: 'Start the flight',
    });
  }

  /** Exit: the card and the ring go, the flight keeps going (or stays finished). */
  stop({ silent = false } = {}) {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    cancelAnimationFrame(this.raf);
    const wasActive = this.active;
    this.active = false;
    this.spec = null;
    this.moment = null;
    this.walk = null;
    this.refs.card.hidden = true;
    this.refs.spot.hidden = true;
    this.dash.refs.shell.dataset.demo = '0';
    if (wasActive && !silent) {
      this.dash.setRate(1);
      if (this.engine.paused && !this.engine.completed) this.dash.togglePause(false);
    }
  }

  /** The mission end card's "Explore freely": leave the demo and fly the mission again, hands on. */
  explore() {
    this.stop({ silent: true });
    this._missionView();
    this.dash.setRate(1);
    this.dash.restart({ scenario: 'mission' });
  }

  /** Keyboard, from the dashboard: → / Enter next, ← back. */
  onKey(key) {
    if (!this.active) return false;
    if (key === 'arrowright' || key === 'enter') return this.next(), true;
    if (key === 'arrowleft') return this.back(), true;
    return false;
  }

  /** The visitor paused or resumed the simulation themselves (Hold flight, the play button or Space). */
  onUserPause(paused) {
    if (!this.active || this.engine.completed) return;
    if (paused) {
      if (this.walk) return; // already stepping through a stop's panels
      this._render({ ...(this.moment ?? { step: 'FLIGHT HELD', title: 'Flight held', body: 'Resume when you are ready.' }), held: true });
    } else {
      this.walk = null;
      this._missionView();
      this._render({ ...(this.moment ?? {}), running: true });
    }
  }

  next() {
    const s = this.spec;
    if (!s) return;
    if (s.walkIdx !== undefined) {
      if (s.walkIdx + 1 < this.walk.length) this._showWalk(s.walkIdx + 1);
      else this.resume();
    } else if (s.panels?.length) this._startWalk(s.panels, s.step);
    else if (this.engine.paused && !this.engine.completed) this.resume();
  }

  back() {
    const s = this.spec;
    if (!s || s.walkIdx === undefined) return;
    if (s.walkIdx > 0) this._showWalk(s.walkIdx - 1);
    else {
      this.walk = null;
      this._missionView();
      if (this.engine.completed) this._render(this.endCard);
      else this._render(this.moment);
    }
  }

  /** Back to the Mission view, then the flight goes on from where it paused (or, after the mission, back to its result). */
  resume() {
    this.walk = null;
    this._missionView();
    if (this.engine.completed) this._render(this.endCard);
    else if (this.engine.paused) this.dash.togglePause(false);
    else this._render({ ...(this.moment ?? {}), running: true });
  }

  _missionView() {
    const d = this.dash;
    if (d.view.theatre) d.setTheatre(false);
    if (d.view.mode !== 'mission') d.setMode('mission', { quiet: true });
    if (d.view.charts) d.setCharts(false);
    if (d.view.tab !== 'decision') d.setPanelTab('decision');
    if (d.view.focus !== 'flexipath') d.setFocus('flexipath', { quiet: true });
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  _render(spec) {
    this.spec = spec;
    const R = this.refs;
    R.step.textContent = spec.step ?? '';
    R.title.textContent = spec.title ?? '';
    R.body.innerHTML = spec.body ?? '';
    R.actions.innerHTML = '';
    const button = (label, run, { primary = false, icon = null } = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn h-[26px]! px-2.5! text-[11px]! ${primary ? 'btn-primary' : ''}`;
      b.innerHTML = `${icon === 'left' ? '<i data-lucide="chevron-left"></i>' : ''}${esc(label)}${icon === 'right' ? '<i data-lucide="chevron-right"></i>' : ''}`;
      b.addEventListener('click', run);
      R.actions.append(b);
      return b;
    };
    const completed = this.engine.completed;
    const paused = this.engine.paused && !completed;
    const leave = completed ? 'Back to the result' : 'Resume the flight';
    if (spec.walkIdx !== undefined) {
      const last = spec.walkIdx + 1 >= this.walk.length;
      button('Back', () => this.back(), { icon: 'left' });
      const count = document.createElement('span');
      count.className = 'px-1 font-mono text-[10px] tracking-[0.06em] text-slate-500';
      count.textContent = `${spec.walkIdx + 1} / ${this.walk.length}`;
      R.actions.append(count);
      if (last) button(leave, () => this.resume(), { primary: true, icon: 'right' });
      else button('Next', () => this.next(), { primary: true, icon: 'right' });
    } else if (paused && spec.panels?.length) {
      button(`Next: ${plural(spec.panels.length, 'panel')} this changed`, () => this.next(), { primary: true, icon: 'right' });
      button(spec.resumeLabel ?? 'Resume the flight', () => this.resume());
    } else if (paused) {
      button(spec.resumeLabel ?? 'Resume the flight', () => this.resume(), { primary: true, icon: 'right' });
    }
    for (const a of spec.actions ?? []) button(a.label, a.run, { primary: !!a.primary });
    this.dash.renderIcons(R.actions);
    R.hold.hidden = !(spec.running && !completed);
    this._last = {};
    this._layout();
    const el = this._target(spec);
    if (el && (paused || completed)) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  _frame() {
    if (!this.active) return;
    this.raf = requestAnimationFrame(this._frame);
    this._layout();
  }

  _target(spec) {
    const t = typeof spec?.target === 'function' ? spec.target() : null;
    if (!t) return null;
    return Array.isArray(t) ? t.find((el) => el instanceof Element) ?? null : t;
  }

  /** Union rectangle of the card's target element(s), or null. */
  _rectOf(spec) {
    const t = typeof spec?.target === 'function' ? spec.target() : null;
    if (!t) return null;
    let l = Infinity;
    let tp = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const el of Array.isArray(t) ? t : [t]) {
      if (!(el instanceof Element)) continue;
      const rc = el.getBoundingClientRect();
      if (rc.width < 2 || rc.height < 2) continue;
      l = Math.min(l, rc.left);
      tp = Math.min(tp, rc.top);
      r = Math.max(r, rc.right);
      b = Math.max(b, rc.bottom);
    }
    return Number.isFinite(l) ? { left: l, top: tp, width: r - l, height: b - tp } : null;
  }

  /** The ring marks the panel the card talks about while the flight is paused; the card keeps out of its way. */
  _layout() {
    const s = this.spec;
    if (!s) return;
    const R = this.refs;
    const L = this._last;
    const rect = this.engine.paused || this.engine.completed ? this._rectOf(s) : null;
    const spot = R.spot;
    if (rect) {
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
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const v = this.dash.refs.viewport.getBoundingClientRect();
    const w = R.card.offsetWidth;
    const h = R.card.offsetHeight;
    const x = clamp(v.left + v.width / 2 - w / 2, MARGIN, vw - w - MARGIN);
    let y = v.bottom - h - 64;
    if (y < MARGIN || v.bottom < h + 80) {
      // The twin is scrolled away (small screens): keep the card clear of the ringed panel.
      y = rect && rect.top + rect.height / 2 < vh / 2 ? vh - h - MARGIN : MARGIN;
    }
    if (rect && y < rect.top + rect.height + 6 && y + h > rect.top - 6) {
      const above = rect.top - h - 10;
      const below = rect.top + rect.height + 10;
      y = above >= MARGIN ? above : Math.min(below, vh - h - MARGIN);
    }
    y = clamp(y, MARGIN, Math.max(MARGIN, vh - h - MARGIN));
    const key = `${x | 0},${y | 0}`;
    if (L.card !== key) {
      L.card = key;
      R.card.style.left = `${x}px`;
      R.card.style.top = `${y}px`;
    }
  }

  // ── Moments ───────────────────────────────────────────────────────────
  /** A real moment: pause the flight and wait for the visitor (step through the panels it changed, or resume). */
  _moment(spec) {
    const e = this.engine;
    if (!e.completed) {
      e.setPaused(true);
      this.dash._updatePlay();
    }
    this.moment = { ...spec, panels: spec.panels ?? [], resumeLabel: spec.resumeLabel ?? 'Resume the flight' };
    this.walk = null;
    this._render(this.moment);
  }

  /** A caption while the flight runs; it never replaces a paused moment's card. */
  _caption(spec) {
    if (this.engine.paused) return;
    this.moment = { ...spec, panels: [] };
    this._render({ ...this.moment, running: true });
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
    const n = this.switches; // which handover this is for FlexiPath
    if (ev.engine === 'flexipath') {
      if (ev.code === 'PREDICT' && this.predictedFor !== n) {
        this.predictedFor = n;
        const r = this._lastRecord('PREDICT');
        const cur = r?.current?.name ?? 'The current link';
        const next = r?.alternate?.name ?? 'the next';
        const dock = /dock/i.test(r?.reason ?? ev.message);
        this._moment({
          step: `${nth(n)} handover · DETECT → PREDICT → PREPARE`,
          title: dock ? 'Dock release — the wired link is about to end' : `${cur} is fading — FlexiPath predicts it`,
          body: `${dock ? '' : 'Measured: '}${esc(sentence(r?.reason ?? ev.message))} It wakes the ${esc(next)} modem now and validates it while ${esc(cur)} still works; the legacy drone will notice nothing until ${esc(cur)} is gone.`,
          target: () => R.loop,
          panels: n === 0 ? ['pill', 'loop', 'decision', 'glance', 'prediction', 'links'] : n === 1 ? ['loop', 'decision', 'prediction', 'links'] : ['prediction', 'links'],
        });
      } else if (ev.code === 'TREND_OFF' && this.predictedFor === n) {
        // Honest behaviour: a trend that reverses releases the prediction without spending anything.
        this.predictedFor = null;
        this._caption({ step: 'PREDICT', title: 'The signal recovered — prediction released', body: 'Nothing was replicated and nothing was spent; the woken modem goes back to sleep after its dwell.' });
      } else if (ev.code === 'PREPARE') {
        const id = /(?:validated:|→)\s*(\w+)/.exec(ev.message)?.[1];
        this._caption({ step: 'PREPARE', title: `${id ? linkName(id) : 'Next path'} validated as the next path`, body: `${esc(ev.message)}. Validated means measured: heartbeats over the woken modem gave its RTT and loss before it carries anything.` });
      } else if (ev.code === 'REPL_ON') {
        const r = this._lastRecord('PROTECT');
        const from = r?.current?.name ?? 'the current link';
        const to = r?.alternate?.name ?? 'the next link';
        if (n === 1) {
          this._moment({
            step: `${nth(n)} handover · REPLICATE`,
            title: `Critical traffic now rides ${from} and ${to} at once`,
            body: `${esc(from)} is about to fail, so for ${BURST_MS} ms every critical packet (purple) goes on both paths and the receiver keeps whichever copy arrives first; video and uploads are not duplicated. The radio draws ${W[2]} W for this window only.`,
            target: () => R.glance,
            panels: ['glance', 'traffic', 'session'],
          });
          this.dash.setRate(0.5); // slow motion while both paths carry critical traffic
        } else this._caption({ step: 'REPLICATE', title: `${BURST_MS} ms burst: critical traffic on ${from} and ${to}`, body: esc(ev.message) });
      } else if (ev.code === 'HOT_SWAP' || ev.code === 'FAILOVER') {
        const fp = this._fp();
        const to = linkName(ev.to);
        const from = linkName(ev.from);
        const r = this._lastRecord(ev.code === 'HOT_SWAP' ? 'SWITCH' : 'FAILOVER');
        this.switches += 1;
        this.lastSwitchT = ev.t ?? this.engine.snapshot.t;
        this.dash.setRate(1);
        const tally = n > 0 ? ` ${nth(n)} handover, still ${fp.stats.stallTime.toFixed(2)} s of simulated interruption.` : '';
        this._moment({
          step: `${nth(n)} handover · SWITCH → CONTINUE`,
          title: ev.code === 'HOT_SWAP' ? `Switched to ${to} — 0 ms gap` : `Failover to ${to}`,
          body: `${esc(to)} is now the primary path and the ${esc(from)} radio goes back to sleep. ${n === 0 ? 'Remote services still see the same address, so no session was reset.' : esc(sentence(r?.reason ?? ''))}${esc(tally)}`,
          target: () => R.pill,
          panels: n === 0 ? ['pill', 'decision', 'session'] : ['pill', 'charts'],
        });
      }
    } else if (ev.engine === 'legacy') {
      if (ev.code === 'LINK_LOST') {
        const k = this.lgLost;
        this.lgLost += 1;
        const msg = ev.message.replace(/ → break-before-make.*$/, '');
        const ago = Number.isFinite(this.lastSwitchT) ? ` FlexiPath left that link ${(this.engine.snapshot.t - this.lastSwitchT).toFixed(0)} s ago.` : '';
        this._moment({
          step: 'LEGACY OS · INTERRUPTED',
          title: k === 0 ? 'The legacy drone only notices when the link is gone' : 'The legacy drone reacts only now',
          body:
            k === 0
              ? `${esc(sentence(msg))} Everything stalls while it tears the connection down, scans for another link and resets every TCP session, and when its C2 link is silent for more than ${Math.round(this.engine.config.failSafeS * 1000)} ms it must stop and hover.`
              : `${esc(sentence(msg))}${esc(ago)} It tears down, scans and attaches again: interrupted and hovering once more, while the FlexiPath drone flies on.`,
          target: () => R.lanes,
          panels: k === 0 ? ['pillLegacy', 'lanes', 'log'] : k === 1 ? ['lanes', 'charts'] : ['lanes'],
        });
      } else if (ev.code === 'FAILSAFE') {
        this._caption({ step: 'LEGACY OS', title: 'Fail-safe hover', body: `C2 telemetry silent for more than ${Math.round(this.engine.config.failSafeS * 1000)} ms: the legacy drone stops and hovers while it scans. The FlexiPath drone flies on.` });
      } else if (ev.code === 'RECONNECTED') {
        const k = this.lgBack;
        this.lgBack += 1;
        const s = this.engine.snapshot.agents;
        if (k === 1) {
          const A = this.engine.agents;
          this._moment({
            step: 'RESULT SO FAR',
            title: 'Same corridor, same radio — the difference so far',
            body: `Simulated interruption: FlexiPath <b>${s.flexipath.stats.stallTime.toFixed(2)} s</b>, Legacy <b>${s.legacy.stats.stallTime.toFixed(2)} s</b>. Radio power on average: FlexiPath ${A.flexipath.power.state.meanWatts.toFixed(2)} W, Legacy ${A.legacy.power.state.meanWatts.toFixed(2)} W. Address changes remote services saw: Legacy ${A.legacy.tunnel.state.remoteIpChanges}, FlexiPath ${A.flexipath.tunnel.state.remoteIpChanges} — it always shows the anchor ${ANCHOR_IP}.`,
            target: () => R.glance,
            panels: ['glance', 'lanes', 'session', 'charts'],
          });
        } else this._caption({ step: 'LEGACY OS', title: `Legacy is back on ${linkName(ev.to)}`, body: `${esc(sentence(ev.message))} With a new address, so every TCP session was reset. FlexiPath never stopped.` });
      }
    }
  }

  _onTick(snapshot) {
    // The old link's actual failure, after FlexiPath already left it: a caption, never a pause.
    if (!this.active) return;
    const tr = snapshot.agents.flexipath.trace;
    const ep = tr.episode ?? tr.last;
    if (!ep || ep.failureT === null || ep.stages.SWITCH === null) return;
    const key = `fail:${ep.from}:${ep.stages.SWITCH}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const lead = ep.failureT - ep.stages.SWITCH;
    if (lead > 0) this._caption({ step: 'FAILURE', title: `${linkName(ep.from)} has now actually failed`, body: `FlexiPath had already moved to ${esc(linkName(ep.to))} ${lead.toFixed(1)} s earlier, so nothing was carried on the failing path.` });
  }

  _onComplete() {
    if (!this.active) return;
    const d = this.dash;
    d.setRate(1);
    this.walk = null;
    this._missionView();
    const s = this.engine.snapshot.agents;
    const lgStops = s.legacy.stats.failSafeStops ?? 0;
    this.moment = null;
    this.endCard = {
      step: 'MISSION COMPLETE',
      title: `FlexiPath flew the whole mission; the legacy drone had to ${lgStops ? `hover ${plural(lgStops, 'time')}` : 'wait'}`,
      body: `${this.switches} handovers on the same simulated radio. Simulated interruption: FlexiPath <b>${s.flexipath.stats.stallTime.toFixed(2)} s</b>, Legacy <b>${s.legacy.stats.stallTime.toFixed(2)} s</b>. One run is an example: 10 paired trials of this mission, 10 seeds, both stacks on identical conditions, give the evidence with 95 % confidence intervals.`,
      actions: [
        { label: 'Run 10 paired trials', primary: true, run: () => d.openExperiments({ scenario: 'mission', trials: 10, speed: 60, autoRun: true, title: 'Experimental proof · full mission · 10 paired trials' }) },
        { label: 'Show me every dashboard', run: () => this._startWalk(ALL_PANELS, 'MISSION COMPLETE') },
        { label: 'Replay demo', run: () => this.start() },
        { label: 'Explore freely', run: () => this.explore() },
      ],
    };
    this._render(this.endCard);
  }

  // ── The panels a stop changed, one card each, read live ───────────────
  _startWalk(keys, step) {
    const cards = this._panelCards();
    this.walk = keys.map((k) => cards[k]).filter(Boolean);
    this.walkStep = step ?? this.moment?.step ?? '';
    if (this.walk.length) this._showWalk(0);
  }

  _showWalk(i) {
    const c = this.walk[i];
    c.onShow?.();
    this._render({ ...c, walkIdx: i, step: `${this.walkStep} · PANEL ${i + 1} / ${this.walk.length}` });
  }

  _panelCards() {
    const d = this.dash;
    const R = d.refs;
    const e = this.engine;
    const snap = e.snapshot;
    const fp = snap.agents.flexipath;
    const lg = snap.agents.legacy;
    const dec = fp.decision ?? {};
    const n = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
    const mission = () => this._missionView();
    const advanced = (tab) => () => {
      if (d.view.theatre) d.setTheatre(false);
      if (d.view.focus !== 'flexipath') d.setFocus('flexipath', { quiet: true });
      if (d.view.mode !== 'advanced') d.setMode('advanced', { quiet: true });
      if (d.view.charts) d.setCharts(false);
      d.setPanelTab(tab);
    };

    // Live readings.
    const pill = d._pillFor(fp, 'flexipath', snap.t);
    const lgPill = d._pillFor(lg, 'legacy', snap.t);
    const stage = fp.trace.stage ?? 'DETECT';
    const stageCap = d.loop.cells[stage]?.cap.textContent ?? '';
    const rec = d.decision.current;
    const classes = strip(d.glance._classes(fp)).replace(/\s+(Critical|Voice|Bulk)/g, ' · $1');
    const fpHol = fp.hol?.stats?.bulkHolPeakMs;
    const lgHol = lg.hol?.stats?.bulkHolPeakMs;
    const fpc = fp.trace.counts ?? { predictedFailures: 0, pathFailures: 0 };
    const lgc = lg.trace.counts ?? { predictedFailures: 0, pathFailures: 0 };
    const pred = dec.prediction;
    const next = dec.prepared ?? dec.warmTarget ?? null;
    const radio = dec.radio ?? {};
    const radioLine = INTERFACE_IDS.map((id) => {
      const st = id === dec.primary ? 'primary' : id === dec.replica && dec.replicationActive ? 'replica' : (RADIO_STATES[radio[id]]?.badge ?? radio[id] ?? '—').toLowerCase();
      return `${linkName(id)} ${st}`;
    }).join(' · ');
    const flows = fp.flows ?? [];
    const flowLine = flows
      .map((f) => {
        const on = f.cls === 'BULK' ? (dec.protecting ? 'paced, never copied' : 'one path') : dec.replicate?.[f.cls] ? 'on two paths' : 'one path';
        return `${f.name} (${f.cls.toLowerCase()}): ${on}`;
      })
      .join('; ');
    const tier = POWER_TIERS[fp.power?.tier ?? 0];
    const events = e.events.slice(-2).map((ev) => `T+${ev.t.toFixed(1)} ${ev.engine === 'legacy' ? 'LG' : ev.engine === 'flexipath' ? 'FP' : ev.engine.toUpperCase()}: ${ev.message.split(' · ')[0]}`);
    const m = { fp: fp.metrics ?? {}, lg: lg.metrics ?? {} };
    const wired = INTERFACE_SPECS[dec.primary]?.tech === 'wired';
    const trend = wired ? 'no radio trend on a wired link' : Number.isFinite(pred?.signalSlopeLong) ? `${pred.signalSlopeLong > 0 ? '+' : ''}${pred.signalSlopeLong.toFixed(1)} dB/s` : 'collecting';
    const ttf = pred?.triggers?.context ? 'the carrier ends at dock release' : Number.isFinite(pred?.ttf) ? `time to failure ${secs(pred.ttf)} s` : Number.isFinite(pred?.projectedTtf) ? `projected failure in ${secs(pred.projectedTtf)} s` : 'no failure predicted';
    const rebinds = fp.tunnel?.history?.length ?? 0;
    const lgIp = lg.tunnel?.remoteIpChanges ?? 0;

    return {
      pill: {
        title: 'The status pill — FlexiPath’s state right now',
        body: `Now: <b>${esc(pill.text)}</b> · ${esc(pill.detail)}. Cyan means monitoring on one link with the other modems asleep; amber, a degradation is predicted; purple, critical traffic on two paths; green, a switch with a 0 ms gap; red, no usable path.`,
        target: () => R.pill,
        onShow: mission,
      },
      pillLegacy: {
        title: 'The status pill — seen from the legacy stack',
        body: `Now: <b>${esc(lgPill.text)}</b> · ${esc(lgPill.detail)}. Press 2 at any time to see the flight through the legacy stack, 1 to return to FlexiPath.`,
        target: () => R.pill,
        onShow: () => {
          mission();
          d.setFocus('legacy', { quiet: true });
        },
      },
      loop: {
        title: 'The decision loop — DETECT → PREDICT → PREPARE → REPLICATE → SWITCH → CONTINUE',
        body: `Now at <b>${esc(stage)}</b>: ${esc(stageCap)}. A stage lights up when the controller actually reaches it, with the time it got there; a skipped stage says why (an abrupt outage cannot be predicted). Hover a stage for its caption.`,
        target: () => R.loop,
        onShow: mission,
      },
      decision: {
        title: 'Why did FlexiPath do that? — the decision record',
        body: `Latest: <b>${esc(rec?.headline ?? 'no decision yet')}</b>. ${rec?.action ? `Action: ${esc(sentence(rec.action))} ` : ''}Every decision is recorded with the values measured at that tick; Show details opens the current path and its status, the alternate and its score, and the radio tier. The grey line is what the legacy stack does at the same moment.`,
        target: () => R.decision,
        onShow: mission,
      },
      glance: {
        title: 'At a glance — what is protected, and three numbers',
        body: `Protection now: <b>${esc(classes || '—')}</b>. Radio power FlexiPath ${n(fp.power?.watts)} W vs Legacy ${n(lg.power?.watts)} W; longest bulk data stall ${n(fpHol, 0)} vs ${n(lgHol, 0)} ms; address changes seen by remote services ${fp.tunnel?.remoteIpChanges ?? 0} vs ${lgIp}. Hover a label for its definition.`,
        target: () => R.glance,
        onShow: mission,
      },
      lanes: {
        title: 'The scoreboard — Legacy vs FlexiPath',
        body: `Simulated interruption FlexiPath <b>${fp.stats.stallTime.toFixed(2)} s</b> vs Legacy <b>${lg.stats.stallTime.toFixed(2)} s</b>; critical packets lost ${fp.stats.criticalLost} vs ${lg.stats.criticalLost}; path failures acted on before the path failed ${fpc.predictedFailures}/${fpc.pathFailures} vs ${lgc.predictedFailures}/${lgc.pathFailures}. Show steps opens the step-by-step timeline of the latest handover for both stacks.`,
        target: () => R.lanes,
        onShow: mission,
      },
      history: {
        title: 'The Advanced view — the decision record and its history',
        body: `The same decision card with everything open, plus the <b>decision history</b>: ${plural(d.decision.records.length, 'decision')} so far; press a row to pin one and read the values it was made on. The tabs above pick a group of panels.`,
        target: () => [R.tabBar, R.decision],
        onShow: advanced('decision'),
      },
      prediction: {
        title: 'Prediction · live and its internals (Advanced view)',
        body: `Current link <b>${esc(linkName(dec.primary))}</b> ${esc(dec.primary ? fmtSignal(dec.primary, pred?.signal) : '')}, trend ${esc(trend)}, ${esc(ttf)}; next path ${next ? `<b>${esc(linkName(next))}</b> (${esc((RADIO_STATES[radio[next]]?.badge ?? radio[next] ?? '').toLowerCase())})` : 'none'}. The sparkline is the measured signal against the failure level, with the trend extrapolated to where it crosses it; the internals table lists every trigger’s live value against its threshold.`,
        target: () => [R.prediction, R.internals],
        onShow: advanced('prediction'),
      },
      links: {
        title: 'Interface health — one card per modem (Advanced view)',
        body: `Now: ${esc(radioLine)}. Each card shows signal, throughput, RTT, loss, jitter, a 0–100 score and the radio state; a modem asleep in DRX reports signal only, so its score is an estimate.`,
        target: () => R.telemetry,
        onShow: advanced('links'),
      },
      traffic: {
        title: 'Traffic-aware protection and the flow inspector (Advanced view)',
        body: `Now: ${esc(flowLine || 'no flows')}. Replication overhead so far ${n(fp.stats.overheadPct)} % of protected bytes; ${fp.hol?.stats?.duplicatesDiscarded ?? 0} late duplicates discarded at the receiver. The flow inspector below lists each flow’s rate and latency.`,
        target: () => [R.traffic, R.flows],
        onShow: advanced('traffic'),
      },
      session: {
        title: 'Battery · ordering · session, and the relay tunnel (Advanced view)',
        body: `Radio power ${n(fp.power?.watts)} W (${esc(tier.label.toLowerCase())}) vs Legacy ${n(lg.power?.watts)} W; head-of-line: critical and voice never wait, a bulk TCP stream stalls on loss (longest ${n(fpHol, 0)} ms). The tunnel to ${ANCHOR_IP} has rebound ${plural(rebinds, 'time')} and remote services never saw a change; the legacy stack’s address changed ${plural(lgIp, 'time')} (${lg.stats.tcpResets} TCP resets).`,
        target: () => [R.engineering, R.tunnel],
        onShow: advanced('session'),
      },
      controls: {
        title: 'Simulation controls (Advanced view)',
        body: `Focus FlexiPath or Legacy, show or hide the ghost drone, the fail-safe hover rule, the drone speed (${e.config.speedKmh} km/h), a reproducible seed (${esc(String(e.config.seed))}), fault injection (a Wi-Fi fade with F, a 5G outage with G) and the exports: a JSON with the full record and the 10 Hz CSV time series.`,
        target: () => R.controls,
        onShow: advanced('controls'),
      },
      log: {
        title: 'The event log (Advanced view)',
        body: `Every decision, fault and link event with its time, newest first, filterable by stack. Latest: ${events.length ? esc(events.reverse().join(' — ')) : 'none yet'}.`,
        target: () => R.log,
        onShow: advanced('log'),
      },
      charts: {
        title: 'The six live charts — the last 60 s, FlexiPath against Legacy',
        body: `Throughput ${n(m.fp.throughputMbps, 0)} vs ${n(m.lg.throughputMbps, 0)} Mbps, critical-flow latency ${n(m.fp.latencyMs, 0)} vs ${n(m.lg.latencyMs, 0)} ms, packet loss ${n(m.fp.lossPct)} vs ${n(m.lg.lossPct)} %, voice MOS ${n(m.fp.mos, 2)} vs ${n(m.lg.mos, 2)}, radio power ${n(m.fp.powerW)} vs ${n(m.lg.powerW)} W, bulk stall ${n(m.fp.bulkHolMs, 0)} vs ${n(m.lg.bulkHolMs, 0)} ms. Purple bands are replication bursts, red bands are legacy interruptions. The Charts button opens them in the Advanced view.`,
        target: () => [R.chartsBtn, R.chartsRow],
        onShow: () => {
          advanced(d.view.tab ?? 'decision')();
          d.setCharts(true);
        },
      },
    };
  }
}
