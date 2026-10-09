/**
 * GuidedDemo.js — the guided tour: onboarding for the twin and the HUD, then the live demonstration.
 *
 * Four parts, one card at a time, each with a spotlight on the thing it talks about:
 *
 *   1 THE SCREEN    scenario A is held at T+0. Each step spotlights one part of the twin or the HUD and says what
 *                   it shows; several ask the visitor to press the control themselves (legend, camera, details,
 *                   steps, play) and move on once they did, with "Do it for me" and "Skip" as fallbacks.
 *   2 LIVE FLIGHT   the flight runs. It is not scripted: when the controller actually predicts, protects or
 *                   switches — and when the legacy stack actually interrupts and recovers — the tour pauses the
 *                   simulation and captions the moment from the decision record and measured values of that tick,
 *                   pointing at the panel where it shows. The visitor can hold the flight at any time (the card's
 *                   Hold button, the play button or Space) and continue when ready.
 *   3 ADVANCED      after the run, the Advanced view tab by tab, with the whole run in every panel.
 *   4 PROOF         10 paired trials of scenario A in the Experiments window.
 *
 * The tour owns its DOM (the spotlight and the card live in the dashboard's tour layer) and holds no simulation
 * state: everything it says comes from the engine's events, records and snapshot.
 */
import { LEGACY_PARAMS, LEGACY_WIRELESS_STALL_S } from '../simulation/LegacyController.js';
import { ANCHOR_IP } from '../simulation/SimulationEngine.js';
import { POWER_PARAMS } from '../simulation/PowerModel.js';
import { esc, linkName } from './format.js';

const HOLD = { beat: 6500, short: 4500 };
const W = POWER_PARAMS.tierWatts;
const BURST_MS = Math.round(POWER_PARAMS.burstWindowS * 1000);
const PARTS = {
  intro: 'GUIDED TOUR · PART 1 / 4 · THE SCREEN',
  live: 'GUIDED TOUR · PART 2 / 4 · LIVE FLIGHT',
  advanced: 'GUIDED TOUR · PART 3 / 4 · ADVANCED VIEW',
  proof: 'GUIDED TOUR · PART 4 / 4 · PROOF',
};
const MARGIN = 12; // card / window edge
const GAP = 14; // card / spotlight
const PAD = 6; // spotlight / target
const DONE_MS = 800; // a satisfied task shows its tick for this long before the next step

const sentence = (s) => (!s ? '' : /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class GuidedDemo {
  constructor(dash) {
    this.dash = dash;
    this.engine = dash.engine;
    this.active = false;
    this.phase = null;
    this.spec = null;
    this.steps = [];
    this.idx = -1;
    this.unsubs = [];
    this.timer = null;
    this.doneTimer = null;
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
      <div class="tour-card" data-ref="card" hidden role="dialog" aria-label="Guided tour" aria-live="polite">
        <span class="arrow" data-ref="arrow" hidden></span>
        <div class="flex items-center justify-between gap-2">
          <span class="step" data-ref="step"></span>
          <div class="flex shrink-0 items-center gap-1.5">
            <button type="button" class="btn h-[24px]! px-2! text-[10.5px]!" data-ref="hold" hidden></button>
            <button type="button" class="btn h-[24px]! px-2! text-[10.5px]!" data-ref="exit" title="Exit the tour (Esc)">Exit tour</button>
          </div>
        </div>
        <div class="title" data-ref="title"></div>
        <div class="body" data-ref="body"></div>
        <div class="tour-task" data-ref="task" hidden><i data-lucide="mouse-pointer-click"></i><span data-ref="taskText"></span></div>
        <div class="mt-2 flex flex-wrap gap-1.5 empty:hidden" data-ref="actions"></div>
        <div class="tour-nav">
          <button type="button" class="btn h-[26px]! px-2! text-[11px]!" data-ref="back"><i data-lucide="chevron-left"></i>Back</button>
          <span class="count" data-ref="count"></span>
          <button type="button" class="btn h-[26px]! px-2.5! text-[11px]!" data-ref="skip">Skip</button>
          <button type="button" class="btn btn-primary h-[26px]! px-3! text-[11px]!" data-ref="next"><span data-ref="nextText">Next</span><i data-lucide="chevron-right"></i></button>
        </div>
        <div class="bar"><span data-ref="bar"></span></div>
      </div>`;
    this.refs = {};
    host.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.dash.renderIcons(host);
    const R = this.refs;
    R.hold.addEventListener('click', () => this.toggleHold());
    R.exit.addEventListener('click', () => this.stop());
    R.back.addEventListener('click', () => this.back());
    R.skip.addEventListener('click', () => this.next());
    R.next.addEventListener('click', () => this.primary());
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
    d.setLegend(false);
    d.setCharts(false);
    d.setPanelTab('decision');
    d.decision.setExpanded(false);
    d.lanes.setOpen(false);
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
    e.setPaused(true);
    d._updatePlay();
    d.refs.shell.dataset.demo = '1';
    this.refs.card.hidden = false;
    this._last = {};
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this._frame);
    this._startIntro();
  }

  stop({ silent = false } = {}) {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    clearTimeout(this.timer);
    clearTimeout(this.doneTimer);
    cancelAnimationFrame(this.raf);
    const wasActive = this.active;
    this.active = false;
    this.phase = null;
    this.spec = null;
    this.steps = [];
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

  /** Keyboard, from the dashboard: → primary action, ← back. */
  onKey(key) {
    if (!this.active) return false;
    if (key === 'arrowright') return this.primary(), true;
    if (key === 'arrowleft') return this.back(), true;
    return false;
  }

  /** The visitor paused or resumed the simulation themselves (play button or Space). */
  onUserPause(paused) {
    if (!this.active) return;
    if (this.phase === 'intro') {
      // Pressing play during part 1 launches the flight: skip ahead to the live part.
      if (!paused) this._startLive();
      return;
    }
    if (this.phase !== 'live') return;
    if (paused) {
      clearTimeout(this.timer);
      this.timer = null;
      this.held = true;
      this._freezeBar();
    } else {
      this.held = false;
      this._setBar(0);
    }
  }

  // ── Steps ─────────────────────────────────────────────────────────────
  primary() {
    const s = this.spec;
    if (!s) return;
    if (s.expect && !s.done) return void s.expect.run?.(); // "Do it for me": the check passes on the next frame
    if (s.live && this.engine.paused && !this.engine.completed) return this._release(); // "Continue" the flight
    this.next();
  }

  next() {
    const s = this.spec;
    if (!s) return;
    clearTimeout(this.doneTimer);
    s.onLeave?.();
    if (s.onNext) return s.onNext();
    if (this.steps.length) this._go(this.idx + 1);
  }

  back() {
    if (!this.spec || this.spec.live || this.idx <= 0) return;
    clearTimeout(this.doneTimer);
    this.spec.onLeave?.();
    this._go(this.idx - 1);
  }

  _go(i) {
    if (i >= this.steps.length) return this._endPart();
    this.idx = i;
    const st = this.steps[i];
    st.onEnter?.();
    const base = { ...st, part: this.phase, step: PARTS[this.phase], count: `${i + 1} / ${this.steps.length}`, canBack: i > 0, done: false };
    // A task that is already done (the legend was open, the view was already Advanced …) is shown as information.
    if (st.expect && st.expect.check()) this._render({ ...base, ...(st.expect.then ?? {}), expect: null, done: true });
    else this._render(base);
  }

  _endPart() {
    if (this.phase === 'intro') this._startLive();
    else if (this.phase === 'advanced') this._startProof();
    else this.stop();
  }

  _satisfied() {
    const s = this.spec;
    s.done = true;
    if (s.expect.then) return this._render({ ...s, ...s.expect.then, expect: null, done: true });
    this._renderTask(s);
    this._last.nav = null;
    this._syncNav();
    this.doneTimer = setTimeout(() => {
      if (this.spec === s) this.next();
    }, DONE_MS);
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  _render(spec) {
    this.spec = spec;
    const R = this.refs;
    R.step.textContent = spec.step ?? '';
    R.title.textContent = spec.title ?? '';
    R.body.innerHTML = spec.body ?? '';
    R.card.dataset.wide = spec.live || !spec.target ? '1' : '0';
    R.back.hidden = !spec.canBack || !!spec.live;
    R.count.textContent = spec.count ?? '';
    R.actions.innerHTML = '';
    for (const a of spec.actions ?? []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn h-[26px]! px-2.5! text-[11px]! ${a.primary ? 'btn-primary' : ''}`;
      b.textContent = a.label;
      b.addEventListener('click', () => a.run());
      R.actions.append(b);
    }
    this._renderTask(spec);
    this._setBar(spec.holdMs ?? 0);
    this._last = {};
    this._syncNav();
    if (spec.scrollTo !== false) this._scrollToTarget(spec);
    this._layout();
  }

  _renderTask(spec) {
    const R = this.refs;
    const pending = !!spec.expect && !spec.done;
    const justDone = !!spec.expect && spec.done;
    R.task.hidden = !pending && !justDone;
    R.task.classList.toggle('is-done', justDone);
    if (pending || justDone) {
      R.task.innerHTML = `<i data-lucide="${justDone ? 'check' : 'mouse-pointer-click'}"></i><span>${esc(justDone ? 'Done' : spec.expect.text)}</span>`;
      this.dash.renderIcons(R.task);
    }
    R.skip.hidden = !pending;
    R.nextText.textContent = pending ? 'Do it for me' : (spec.nextLabel ?? 'Next');
    R.next.classList.toggle('btn-primary', !pending);
  }

  /** Hold button and the live "Continue" button follow the engine's pause state. */
  _syncNav() {
    const s = this.spec;
    if (!s) return;
    const R = this.refs;
    const live = !!s.live && !this.engine.completed;
    const paused = this.engine.paused;
    const key = `${live}|${paused}|${!!s.expect && !s.done}`;
    if (this._last.nav === key) return;
    this._last.nav = key;
    R.hold.hidden = !live;
    if (live) {
      R.hold.innerHTML = `<i data-lucide="${paused ? 'play' : 'pause'}"></i>${paused ? 'Resume flight' : 'Hold flight'}`;
      R.hold.title = paused ? 'Resume the flight (Space)' : 'Hold the flight here (Space)';
      this.dash.renderIcons(R.hold);
    }
    if (s.live) {
      R.next.hidden = !paused || this.engine.completed;
      R.nextText.textContent = 'Continue';
    } else R.next.hidden = false;
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

  _scrollToTarget(spec) {
    const t = this._targets(spec)[0];
    // Instant, so the layout that follows sees the final position (the spotlight and card animate anyway).
    if (t instanceof Element) t.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  }

  _targets(spec) {
    const t = typeof spec.target === 'function' ? spec.target() : spec.target;
    if (!t) return [];
    return Array.isArray(t) ? t.filter(Boolean) : [t];
  }

  /** Spotlight rectangle (window coordinates) around the step's target: elements, or a circle on the twin. */
  _rectOf(spec) {
    const targets = this._targets(spec);
    if (!targets.length) return null;
    const c = targets[0];
    if (!(c instanceof Element)) {
      const v = this.dash.refs.viewport.getBoundingClientRect();
      const r = c.r ?? 40;
      if (c.x < -r || c.y < -r || c.x > v.width + r || c.y > v.height + r) return null;
      return { left: v.left + c.x - r, top: v.top + c.y - r, width: 2 * r, height: 2 * r, round: true };
    }
    let l = Infinity;
    let t = Infinity;
    let rgt = -Infinity;
    let b = -Infinity;
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      l = Math.min(l, r.left);
      t = Math.min(t, r.top);
      rgt = Math.max(rgt, r.right);
      b = Math.max(b, r.bottom);
    }
    if (!Number.isFinite(l)) return null;
    return { left: l - PAD, top: t - PAD, width: rgt - l + 2 * PAD, height: b - t + 2 * PAD, round: false };
  }

  _frame() {
    if (!this.active) return;
    this.raf = requestAnimationFrame(this._frame);
    const s = this.spec;
    if (!s) return;
    if (s.expect && !s.done && s.expect.check()) this._satisfied();
    this._syncNav();
    this._layout();
  }

  _layout() {
    const s = this.spec;
    if (!s) return;
    const R = this.refs;
    const rect = this._rectOf(s);
    const L = this._last;
    const spot = R.spot;
    if (rect) {
      const key = `${rect.left | 0},${rect.top | 0},${rect.width | 0},${rect.height | 0},${rect.round},${!!s.expect && !s.done}`;
      if (L.spot !== key) {
        L.spot = key;
        spot.hidden = false;
        spot.style.left = `${rect.left}px`;
        spot.style.top = `${rect.top}px`;
        spot.style.width = `${rect.width}px`;
        spot.style.height = `${rect.height}px`;
        spot.classList.toggle('is-round', rect.round);
        spot.classList.toggle('is-task', !!s.expect && !s.done);
      }
    } else if (!spot.hidden) {
      spot.hidden = true;
      L.spot = null;
    }

    const card = R.card;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x;
    let y;
    let place = null;
    let ax = 0;
    let ay = 0;
    if (rect) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const order = s.place ? [s.place, 'bottom', 'top', 'right', 'left'] : ['bottom', 'top', 'right', 'left'];
      for (const p of order) {
        if (p === 'bottom') {
          y = rect.top + rect.height + GAP;
          x = clamp(cx - w / 2, MARGIN, vw - w - MARGIN);
          if (y >= MARGIN && y + h <= vh - MARGIN) place = p;
        } else if (p === 'top') {
          y = rect.top - GAP - h;
          x = clamp(cx - w / 2, MARGIN, vw - w - MARGIN);
          if (y >= MARGIN && y + h <= vh - MARGIN) place = p;
        } else if (p === 'right') {
          x = rect.left + rect.width + GAP;
          y = clamp(cy - h / 2, MARGIN, vh - h - MARGIN);
          if (x + w <= vw - MARGIN) place = p;
        } else if (p === 'left') {
          x = rect.left - GAP - w;
          y = clamp(cy - h / 2, MARGIN, vh - h - MARGIN);
          if (x >= MARGIN) place = p;
        }
        if (place) break;
      }
      if (place) {
        ax = clamp(cx - x, 18, w - 18);
        ay = clamp(cy - y, 18, h - 18);
      } else {
        x = clamp((vw - w) / 2, MARGIN, vw - w - MARGIN);
        y = Math.max(MARGIN, vh - h - MARGIN);
      }
    } else {
      // No target: over the lower part of the twin, above the playback bar.
      const v = this.dash.refs.viewport.getBoundingClientRect();
      x = clamp(v.left + v.width / 2 - w / 2, MARGIN, vw - w - MARGIN);
      y = clamp(v.bottom - h - 64, MARGIN, vh - h - MARGIN);
    }
    const key = `${x | 0},${y | 0},${place},${ax | 0},${ay | 0}`;
    if (L.card !== key) {
      L.card = key;
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      card.dataset.place = place ?? 'none';
      card.style.setProperty('--ax', `${ax}px`);
      card.style.setProperty('--ay', `${ay}px`);
      R.arrow.hidden = !place;
    }
  }

  // ── Live beats (part 2) ───────────────────────────────────────────────
  _beat({ step, title, body, target, place, hold = HOLD.beat, pause = true, actions }) {
    clearTimeout(this.timer);
    this.timer = null;
    const e = this.engine;
    if (pause) {
      e.setPaused(true);
      this.dash._updatePlay();
    }
    this.held = false;
    this._render({ part: 'live', step: step ? `LIVE FLIGHT · ${step}` : PARTS.live, title, body, target, place, live: true, holdMs: pause ? hold : 0, actions });
    if (pause) this.timer = setTimeout(() => this._release(), hold);
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
    if (!this.active || this.phase !== 'live') return;
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
        this.predictBeats += 1;
        this._beat({
          step: 'DETECT → PREDICT → PREPARE',
          title: `${cur} is degrading — FlexiPath predicts it`,
          body: `${esc(sentence(r?.reason ?? ev.message))} ${r?.action ? `<b>Action:</b> ${esc(sentence(r.action))} ` : ''}Until now that modem slept in DRX to save battery. In the loop, PREDICT is lit with the time to failure, and the status pill has turned amber. The legacy stack keeps using ${esc(cur)}: it has no prediction.`,
          target: () => R.loop,
          hold: this.predictBeats > 1 ? HOLD.short : HOLD.beat,
        });
      } else if (ev.code === 'TREND_OFF' && this.seen.has('predict') && !this.seen.has('repl')) {
        // Honest behaviour: a trend that reverses releases the prediction without spending anything.
        this.seen.delete('predict');
        this._beat({
          step: 'PREDICT',
          title: 'Trend reversed — prediction released',
          body: 'The signal recovered (shadowing), so FlexiPath released the prediction without replicating anything: no overhead was spent. The woken modem goes back to DRX sleep after its dwell.',
          target: () => R.loop,
          pause: false,
        });
      } else if (ev.code === 'REPL_ON' && once('repl')) {
        const r = this._lastRecord('PROTECT');
        this._beat({
          step: 'REPLICATE · DECISION ENGINE',
          title: r?.headline ?? 'Critical flow protection enabled',
          body: `<b>Action:</b> ${esc(sentence(r?.action))} <b>Reason:</b> ${esc(sentence(r?.reason))} Purple packets now carry critical traffic on both paths, for this ${BURST_MS} ms window only; the receiver keeps the first copy of each sequence number and discards the late duplicate, so delivery never waits. At a glance shows <b>Critical ⇉ 2 paths</b> and the radio at ${W[2]} W. Video and data sync are not duplicated: bulk is paced instead.`,
          target: () => R.glance,
          place: 'left',
        });
        this.dash.setRate(0.5); // slow motion while both paths carry critical traffic
      } else if (ev.code === 'REPL_RT' && this.seen.has('repl') && once('rt')) {
        this._beat({
          step: 'TRAFFIC-AWARE',
          title: 'Real-time traffic joins the protection',
          body: `${esc(ev.message)}. Voice was kept on one path while its loss stayed inside the ${(this.engine.agents.flexipath.controller.p.realtimeLossBudget * 100).toFixed(0)} % budget, which packet-loss concealment can hide.`,
          target: () => R.glance,
          place: 'left',
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
          step: 'FAILURE → SWITCH → CONTINUE',
          title: r?.headline ?? `Switched to ${linkName(ev.to)}`,
          body: `${esc(sentence(r?.reason))}${esc(failure)} The status pill reads <b>${ev.code === 'HOT_SWAP' ? 'SWITCHED · 0 MS GAP' : 'UNPLANNED FAILOVER'}</b>: sessions kept, nothing waited. FlexiPath so far: ${fp.stats.stallTime.toFixed(2)} s of simulated interruption, ${fp.stats.criticalLost} critical packets lost. The old radio is back in DRX; the drone continues.`,
          target: () => R.pill,
        });
      }
    } else if (ev.engine === 'legacy') {
      if (ev.code === 'LINK_LOST' && this.seen.has('predict') && once('lost')) {
        const ph = LEGACY_PARAMS.stallPhases.wireless.map((p) => `${p.key} ${p.duration.toFixed(1)} s`).join(' → ');
        this.dash.setRate(1);
        this._beat({
          step: 'LEGACY OS',
          title: 'Legacy reacts only now: CONNECTION INTERRUPTED',
          body: `${esc(ev.message.replace(' → break-before-make · all sockets stalled', ''))}. It tears the link down first, then looks for another one. Simulated recovery: ${esc(ph)} = ${LEGACY_WIRELESS_STALL_S.toFixed(1)} s (model parameters). Watch the <b>LG</b> interruption counter in the scoreboard: it keeps counting until the link is back, and the crimson drone's label reads SIMULATED INTERRUPTION. Its sockets are bound to its physical address, so the new one will reset every TCP session.`,
          target: () => R.lanes,
        });
      } else if (ev.code === 'FAILSAFE' && this.seen.has('lost') && once('failsafe')) {
        this._beat({
          step: 'LEGACY OS',
          title: 'Fail-safe hover',
          body: `C2 telemetry has been silent for more than ${Math.round(this.engine.config.failSafeS * 1000)} ms, so the legacy drone stops and hovers in place (simulated lost-link policy). The FlexiPath drone flies on.`,
          target: () => R.lanes,
          pause: false,
        });
      } else if (ev.code === 'RECONNECTED' && this.seen.has('lost') && once('recovered')) {
        const s = this.engine.snapshot.agents;
        const A = this.engine.agents;
        const fpT = A.flexipath.tunnel.state;
        const lgT = A.legacy.tunnel.state;
        this._beat({
          step: 'RESULT OF THIS RUN',
          title: 'Legacy recovered — same corridor, same radio conditions',
          body: `${esc(sentence(ev.message))} Simulated interruption so far: FlexiPath ${s.flexipath.stats.stallTime.toFixed(2)} s · Legacy ${s.legacy.stats.stallTime.toFixed(2)} s. In At a glance, <b>IP changes seen</b>: remote services saw Legacy's address change ${lgT.remoteIpChanges}× (sessions reset) while FlexiPath's stayed ${ANCHOR_IP} (${fpT.remoteIpChanges} changes). Mean radio power FlexiPath ${A.flexipath.power.state.meanWatts.toFixed(2)} W · Legacy ${A.legacy.power.state.meanWatts.toFixed(2)} W. Replication cost ${s.flexipath.stats.overheadPct.toFixed(1)} % of protected-flow bytes.`,
          target: () => R.glance,
          place: 'left',
          hold: HOLD.beat + 1500,
        });
      }
    }
  }

  _onTick(snapshot) {
    // A failure that comes *before* the switch is told in the switch step (they are a tick apart);
    // only a failure that arrives after FlexiPath already switched away gets its own caption.
    if (!this.active || this.phase !== 'live' || this.seen.has('fail') || !this.seen.has('switch')) return;
    const tr = snapshot.agents.flexipath.trace;
    const ep = tr.episode ?? tr.last;
    if (ep && ep.failureT !== null && ep.stages.SWITCH !== null) {
      this.seen.add('fail');
      this._beat({
        step: 'FAILURE',
        title: `${linkName(ep.from)} has now actually failed (loss > 15 %)`,
        body: `FlexiPath had already moved to ${esc(linkName(ep.to))} ${(ep.failureT - ep.stages.SWITCH).toFixed(1)} s earlier, so nothing was carried on the failing path.`,
        target: () => this.dash.refs.loop,
        pause: false,
      });
    }
  }

  _onComplete() {
    if (!this.active) return;
    this.dash.setRate(1);
    if (this.phase === 'live') this._startAdvanced();
  }

  // ── Part 1: the screen ────────────────────────────────────────────────
  _startIntro() {
    this.phase = 'intro';
    this.steps = this._introSteps();
    this._go(0);
  }

  _agent(id, r = 46) {
    const p = this.dash.hooks.projectAgent?.(id);
    return p ? { x: p.x, y: p.y, r } : null;
  }

  _introSteps() {
    const d = this.dash;
    const R = d.refs;
    const mission = () => {
      if (d.view.theatre) d.setTheatre(false);
      if (d.view.mode !== 'mission') d.setMode('mission', { quiet: true });
    };
    return [
      {
        title: 'Welcome to the FlexiPath digital twin',
        body: 'Two identical drones are about to fly the same corridor under the same simulated radio conditions. The <b>cyan</b> one runs FlexiPath; the <b>crimson</b> one runs a legacy stack that reacts only after a link has failed. This tour pauses the flight whenever there is something to explain, and you can hold it yourself at any time with the Hold button on this card, the play button or Space. Everything on screen is simulated.',
        nextLabel: 'Start the tour',
        actions: [{ label: 'Skip to the flight', run: () => this._startLive() }],
        onEnter: mission,
      },
      {
        title: 'This is the FlexiPath drone',
        body: 'Its label shows its state and the link it is on. The beams from the drone to the masts are the links it uses; their colour is the technology. Purple packets are protected copies of critical traffic; a dashed beam is a warm probe to the next path.',
        target: () => this._agent('flexipath'),
        place: 'right',
        onEnter: mission,
      },
      {
        title: '… and the legacy drone',
        body: 'Same route, same seed, same radio. When it loses a link it tears everything down before it looks for another one; those moments are labelled <b>SIMULATED INTERRUPTION</b>. Whenever it leaves the frame, an edge marker says where it is and what it is doing.',
        target: () => this._agent('legacy'),
        place: 'left',
        onEnter: mission,
      },
      {
        title: 'Press the legend button',
        body: 'It opens the key to the beam colours: wired, Wi-Fi 6, 5G SA, LEO satellite, purple replication, a dashed warm probe to the next path, and red for a failure.',
        target: () => R.legendBtn,
        place: 'top',
        expect: { text: 'Press the list button in the playback bar', check: () => R.shell.dataset.legend === '1', run: () => d.setLegend(true) },
        onEnter: mission,
      },
      {
        title: 'The route strip',
        body: 'The corridor crosses four zones: the wired dock, Wi-Fi 6, 5G SA and LEO satellite. The two markers are the drones. In scenarios G and H, red hatching marks a radio shadow on the route, and a dashed outline marks what the coverage map recorded.',
        target: () => R.routeStrip,
        onEnter: mission,
      },
      {
        title: 'Cameras and looks',
        body: '<b>Chase</b> follows the drone, <b>Cinematic</b> sweeps along the corridor and <b>Overview</b> shows the whole route (C cycles them). <b>Real / Twin</b> switches between the night city and the neon digital twin (L); the maximise button gives the twin the whole screen (T).',
        target: () => R.camctl,
        expect: { text: 'Press Overview', check: () => d.view.camera === 'overview', run: () => d.setCamera('overview') },
        onEnter: mission,
        onLeave: () => d.setCamera('chase'),
      },
      {
        title: 'FlexiPath’s state, right now',
        body: '<b>MONITORING · DRX STANDBY</b> means the primary link is measured ten times a second while the other modems sleep to save battery; the figure is the radio draw. The pill turns amber when a degradation is predicted, purple while critical traffic runs on two paths, and green when a switch completed with a 0 ms gap.',
        target: () => R.pill,
        onEnter: mission,
      },
      {
        title: 'The decision loop',
        body: 'DETECT → PREDICT → PREPARE → REPLICATE → SWITCH → CONTINUE. The lit stage is where FlexiPath is now, with what it is doing and when it got there; hover any stage for its caption. A stage that was skipped says why (an abrupt outage cannot be predicted).',
        target: () => R.loop,
        onEnter: mission,
      },
      {
        title: 'Every decision has a reason',
        body: 'Each action is recorded with the values the controller measured at that tick: the current path and its status, the alternate and its score, the radio tier, the action and the reason. The grey line is what the legacy stack does at the same moment.',
        target: () => R.decision,
        place: 'left',
        expect: { text: 'Press Show details on the card', check: () => d.decision.expanded, run: () => d.decision.setExpanded(true) },
        onEnter: mission,
      },
      {
        title: 'At a glance',
        body: 'Which traffic is protected right now (critical, voice, bulk) and three numbers for each stack: <b>radio power</b> in watts, the <b>longest data stall</b> of a bulk stream in milliseconds, and how many client <b>address changes</b> remote services saw. Hover a label for its definition; Details opens the Advanced view.',
        target: () => R.glance,
        place: 'left',
        onEnter: mission,
      },
      {
        title: 'The scoreboard',
        body: '<b>Simulated interruption</b> in seconds for each stack, <b>critical packets lost</b>, and how many path failures each stack <b>acted on before</b> the path actually failed. Show steps opens a step-by-step timeline of the latest handover for both.',
        target: () => R.lanes,
        place: 'top',
        expect: { text: 'Press Show steps', check: () => d.lanes.isOpen(), run: () => d.lanes.setOpen(true) },
        onEnter: mission,
      },
      {
        title: 'The toolbar',
        body: '<b>Mission</b> is this view; <b>Advanced</b> holds every panel (we go there after the flight). The dropdown picks a scenario A–H or the full mission. The red buttons inject a Wi-Fi fade (F) or a 5G outage (G) at any moment, the flask runs paired experiments (X) and ⓘ explains FlexiPath.',
        target: () => R.toolbar,
        onEnter: mission,
      },
      {
        title: 'Press ▶ to launch the flight',
        body: 'The flight runs at 1× (0.5× to 4× are available). The tour will pause it at each real decision so you can read what happened; hold it yourself at any time with this button, the Hold button on the card or Space.',
        target: () => R.playbar,
        place: 'top',
        expect: { text: 'Press the play button', check: () => !this.engine.paused, run: () => d.togglePause(false) },
        onEnter: mission,
      },
    ];
  }

  // ── Part 2: live flight ───────────────────────────────────────────────
  _startLive() {
    if (this.phase === 'live') return;
    clearTimeout(this.doneTimer);
    this.phase = 'live';
    this.steps = [];
    this.idx = -1;
    this.held = false;
    const d = this.dash;
    if (d.view.mode !== 'mission') d.setMode('mission', { quiet: true });
    d.setCamera('chase');
    if (this.engine.paused && !this.engine.completed) {
      this.engine.setPaused(false);
      d._updatePlay();
    }
    this._render({
      part: 'live',
      step: PARTS.live,
      title: 'The flight is on',
      body: 'FlexiPath measures Wi-Fi ten times a second as the drone flies away from the access point. The tour pauses at the first real prediction; until then, watch the loop and the status pill. Hold the flight at any time with the Hold button, the play button or Space.',
      live: true,
    });
  }

  // ── Part 3: the Advanced view ─────────────────────────────────────────
  _startAdvanced() {
    this.phase = 'advanced';
    this.steps = this._advancedSteps();
    this.dash.setCharts(false);
    this.dash.setPanelTab('decision');
    this._go(0);
  }

  _advancedSteps() {
    const d = this.dash;
    const R = d.refs;
    const tabBtn = (id) => d.tabButtons.find((b) => b.dataset.tab === id);
    const advanced = () => {
      if (d.view.theatre) d.setTheatre(false);
      if (d.view.mode !== 'advanced') d.setMode('advanced', { quiet: true });
    };
    const tab = (id, label, then) => ({
      title: `Press ${label}`,
      body: then.intro,
      target: () => tabBtn(id),
      expect: { text: `Press the ${label} tab`, check: () => d.view.mode === 'advanced' && d.view.tab === id, run: () => d.setPanelTab(id), then: { target: then.target, place: 'left', title: then.title, body: then.body } },
      onEnter: advanced,
    });
    return [
      {
        title: 'Flight complete — now the Advanced view',
        body: 'The panels now hold the whole run. <b>Advanced</b> (M) shows every panel beside the twin, one tab at a time, plus the six live charts and the event log.',
        target: () => d.modeButtons.find((b) => b.dataset.mode === 'advanced'),
        expect: { text: 'Press Advanced in the toolbar', check: () => d.view.mode === 'advanced', run: () => d.setMode('advanced') },
        actions: [{ label: 'Skip to the proof', run: () => this._startProof() }],
        onEnter: () => {
          if (d.view.theatre) d.setTheatre(false);
        },
      },
      {
        title: 'Decision · the full record and its history',
        body: 'The same card as in the Mission view, always expanded, plus the <b>decision history</b>: every PREDICT, PROTECT, SWITCH and STAND DOWN of the run with its time and headline. Press a row to pin that decision and read the values it was made on; <b>Follow latest</b> returns to live.',
        target: () => R.decision,
        place: 'left',
        expect: { text: 'Press any row in Decision history', check: () => d.decision.pinned !== null, run: () => d.decision.pinFirst() },
        onEnter: () => {
          advanced();
          d.setPanelTab('decision');
        },
        onLeave: () => d.decision.select(null),
      },
      tab('prediction', 'Prediction', {
        intro: 'What the predictor sees and why it fires.',
        target: () => [R.prediction, R.internals],
        title: 'Prediction · live and its internals',
        body: '<b>Prediction · live</b>: the current link’s signal and loss, its <b>trend</b> in dB/s, the predicted <b>time to failure</b>, and the next path with its radio state. The sparkline is the measured signal, the dotted failure level, and the trend extrapolated to where it crosses it. <b>Prediction internals</b> lists every trigger with its live value against its threshold (a model parameter) and whether it is armed or firing.',
      }),
      tab('links', 'Links', {
        intro: 'Every modem as the focused stack sees it.',
        target: () => R.telemetry,
        title: 'Interface health',
        body: 'One card per modem: signal bars and value, throughput, RTT, loss and jitter, a 0–100 <b>score</b> and the <b>radio badge</b> (DRX, waking, warm, active). A modem asleep in DRX reports signal only, so its data metrics are greyed and its score is an estimate. The chip at the top says which stack you are looking at: 1 for FlexiPath, 2 for Legacy.',
      }),
      tab('traffic', 'Traffic', {
        intro: 'Not all traffic is treated the same.',
        target: () => [R.traffic, R.flows],
        title: 'Traffic-aware protection and the flow inspector',
        body: 'A card per flow with its class and priority, the path it is on, its backup, and whether it is <b>replicated</b>, <b>paced</b> or left alone, with the reason. Below it, the replication overhead of this run. The <b>Flow inspector</b> counts duplicates discarded at the receiver and critical packets lost, and shows each flow’s rate and latency.',
      }),
      tab('session', 'Session', {
        intro: 'Battery, packet ordering and the session.',
        target: () => [R.engineering, R.tunnel],
        title: 'Battery · ordering · session',
        body: '<b>Radio power</b> of both stacks with each modem’s state and the energy of the journey; <b>head-of-line blocking</b> (critical and voice never wait, a bulk TCP stream stalls on loss); and the <b>relay tunnel</b>: the drone’s physical address changes while remote services keep seeing the anchor. The Relay tunnel panel lists the session, the outer addresses, every interface’s lease and the recent rebinds.',
      }),
      tab('controls', 'Controls', {
        intro: 'Run your own experiments.',
        target: () => R.controls,
        title: 'Simulation controls',
        body: 'Focus FlexiPath or Legacy, show or hide the ghost drone, the <b>fail-safe hover</b> rule, the drone speed, a reproducible <b>seed</b>, fault injection (F / G) and the exports: a JSON with the full record and the 10 Hz CSV time series. Experiments opens the paired trials.',
      }),
      tab('log', 'Log', {
        intro: 'Every event of the run.',
        target: () => R.log,
        title: 'The event log',
        body: 'Every decision, fault and link event with its time, newest first, filterable by stack (FP, LG) or environment.',
      }),
      {
        title: 'Press Charts',
        body: 'Six 60 s charts record the whole run while hidden.',
        target: () => R.chartsBtn,
        expect: {
          text: 'Press the Charts button in the toolbar',
          check: () => d.view.mode === 'advanced' && d.view.charts,
          run: () => d.setCharts(true),
          then: {
            target: () => R.chartsRow,
            place: 'top',
            title: 'The six live charts',
            body: '<b>Throughput</b>, <b>critical-flow latency</b> (log scale), <b>packet loss</b>, <b>voice MOS</b>, <b>radio power</b> and <b>bulk head-of-line stall</b>, FlexiPath against Legacy over the last 60 s. Purple bands are replication bursts; red bands are legacy interruptions.',
          },
        },
        onEnter: advanced,
      },
    ];
  }

  // ── Part 4: proof ─────────────────────────────────────────────────────
  _startProof() {
    clearTimeout(this.doneTimer);
    this.phase = 'proof';
    const d = this.dash;
    this.steps = [
      {
        title: 'One run is an anecdote — now 10 paired trials',
        body: 'Press the flask to open the Experiments window, then <b>Run paired trials</b>: scenario A again with 10 different seeds, both stacks on identical conditions in every trial. The table reports measured differences with 95 % confidence intervals, no score and no winner.',
        target: () => d.refs.expBtn,
        expect: {
          text: 'Press the flask button in the toolbar',
          check: () => !d.refs.modal.hidden,
          run: () => d.openExperiments({ scenario: 'A', trials: 10, speed: 60, autoRun: true, title: 'Experimental proof · scenario A · 10 paired trials' }),
        },
      },
      {
        title: 'Tour complete',
        body: 'From here, explore freely: pick another scenario from the dropdown, inject a fault with F or G, press 2 to watch the flight through the legacy stack, or replay the tour with D. Everything you saw is simulated; the README documents every parameter and result.',
        nextLabel: 'Finish',
        actions: [
          { label: 'Replay the tour', run: () => this.start() },
          { label: 'Why FlexiPath?', run: () => d.openInfo() },
        ],
      },
    ];
    this.idx = -1;
    this._go(0);
  }
}
