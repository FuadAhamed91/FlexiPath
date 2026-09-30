/**
 * Controls.js — right-hand mission-control deck.
 *
 *   • cumulative handover stall-time counter (FlexiPath vs Legacy)
 *   • engine toggle (FlexiPath Mode / Legacy OS Mode), ghost + fail-safe toggles
 *   • vehicle speed slider (0–120 km/h), reproducible seed input
 *   • fault injection: rapid Wi-Fi fade, 5G cell outage, reset scenario
 *   • data export (JSON / CSV) and batch benchmark
 */
const SPEED_TICKS = [0, 30, 60, 90, 120];

export class Controls {
  /**
   * @param {HTMLElement} root
   * @param {Record<string, Function>} handlers
   */
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    root.innerHTML = `
      <div class="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 class="hud-title">Mission Control</h2>
        <span class="chip" data-ref="seedChip">SEED —</span>
      </div>

      <section class="px-3" aria-label="Cumulative handover stall time">
        <div class="hud-label mb-1.5">Cumulative handover stall time</div>
        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-lg border border-fp/25 bg-fp/5 px-2.5 py-2">
            <div class="flex items-center gap-1.5 text-[9px] font-bold tracking-[0.18em] text-fp"><span class="legend-dot bg-fp"></span>FLEXIPATH</div>
            <div class="stall-value mt-1.5 text-fp" data-ref="fpStall">0.00<span class="text-[13px] text-slate-500"> s</span></div>
            <div class="num mt-1 text-[9.5px] text-slate-400" data-ref="fpSub">0 hot-swaps · 0 lost</div>
          </div>
          <div class="rounded-lg border border-legacy/30 bg-legacy/5 px-2.5 py-2">
            <div class="flex items-center gap-1.5 text-[9px] font-bold tracking-[0.18em] text-legacy"><span class="legend-dot bg-legacy"></span>LEGACY OS</div>
            <div class="stall-value stall-lg mt-1.5 text-legacy" data-ref="lgStall">0.00<span class="text-[13px] text-slate-500"> s</span></div>
            <div class="num mt-1 text-[9.5px] text-slate-400" data-ref="lgSub">0 stalls · 0 TCP RST</div>
          </div>
        </div>
      </section>

      <section class="mt-3 px-3" aria-label="Engine">
        <div class="hud-label mb-1.5">Engine focus</div>
        <div class="seg seg-engine" role="group" aria-label="Engine toggle">
          <button type="button" data-engine="flexipath" aria-pressed="true"><i data-lucide="zap"></i>FlexiPath Mode</button>
          <button type="button" data-value="legacy" data-engine="legacy" aria-pressed="false"><i data-lucide="history"></i>Legacy OS Mode</button>
        </div>
        <div class="mt-2 flex flex-col gap-1.5">
          <label class="flex cursor-pointer items-center justify-between gap-2 text-[11px] text-slate-300">
            <span class="flex items-center gap-1.5"><i data-lucide="ghost" class="size-3.5 text-slate-500"></i>Side-by-side ghost vehicle</span>
            <button type="button" class="toggle" role="switch" aria-checked="true" data-ref="ghost" aria-label="Show comparison vehicle"></button>
          </label>
          <label class="flex cursor-pointer items-center justify-between gap-2 text-[11px] text-slate-300">
            <span class="flex items-center gap-1.5"><i data-lucide="siren" class="size-3.5 text-slate-500"></i>Fail-safe braking on link loss</span>
            <button type="button" class="toggle" role="switch" aria-checked="true" data-ref="failsafe" aria-label="Fail-safe braking"></button>
          </label>
        </div>
      </section>

      <section class="mt-3 px-3" aria-label="Vehicle speed">
        <div class="flex items-baseline justify-between">
          <label class="hud-label" for="speed-range">Vehicle speed</label>
          <span class="num text-[15px] font-bold text-slate-100"><span data-ref="speedVal">60</span><span class="text-[10px] text-slate-500"> km/h</span></span>
        </div>
        <input id="speed-range" class="speed-range mt-1" type="range" min="0" max="120" step="1" value="60" data-ref="speed" />
        <div class="num flex justify-between px-0.5 text-[8.5px] text-slate-600">${SPEED_TICKS.map((v) => `<span>${v}</span>`).join('')}</div>
      </section>

      <section class="mt-2.5 px-3" aria-label="Random seed">
        <label class="hud-label" for="seed-input">Random seed · reproducible runs</label>
        <div class="mt-1.5 flex gap-1.5">
          <input id="seed-input" class="hud-input flex-1" type="text" inputmode="numeric" spellcheck="false" data-ref="seed" />
          <button type="button" class="btn btn-primary" data-ref="seedApply" title="Restart with this seed"><i data-lucide="play"></i>Apply</button>
          <button type="button" class="btn" data-ref="seedRandom" title="Random seed" aria-label="Random seed"><i data-lucide="dice-5"></i></button>
        </div>
      </section>

      <section class="mt-3 px-3" aria-label="Fault injection">
        <div class="hud-label mb-1.5">Fault injection</div>
        <div class="flex flex-col gap-1.5">
          <button type="button" class="btn btn-fault" data-fault="wifi-fade"><i data-lucide="wifi-off"></i>Simulate Rapid Wi-Fi Fade<span class="kbd">F</span></button>
          <button type="button" class="btn btn-fault" data-fault="cell-outage"><i data-lucide="tower-control"></i>Simulate 5G Cell Outage<span class="kbd">G</span></button>
          <button type="button" class="btn btn-fault" data-ref="reset" style="border-color:rgba(148,163,184,.25);background:rgba(15,23,42,.6);color:#cbd5e1"><i data-lucide="rotate-ccw"></i>Reset Scenario<span class="kbd">R</span></button>
        </div>
      </section>

      <section class="mt-3 px-3 pb-3" aria-label="Data export">
        <div class="hud-label mb-1.5">Data export</div>
        <button type="button" class="btn btn-primary w-full" data-ref="exportJson" title="Full experiment record: config, summary, events, 10 Hz time series"><i data-lucide="file-json"></i>Export Experiment Data (JSON)</button>
        <div class="mt-1.5 grid grid-cols-2 gap-1.5">
          <button type="button" class="btn" data-ref="exportCsv" title="10 Hz time series for both engines"><i data-lucide="file-spreadsheet"></i>Export CSV</button>
          <button type="button" class="btn" data-ref="bench" title="Seeds × speeds × fault scenarios, headless"><i data-lucide="flask-conical"></i>Batch benchmark</button>
        </div>
      </section>`;

    this.refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.engineButtons = [...root.querySelectorAll('[data-engine]')];
    this.cache = {};
    this._bind();
  }

  _bind() {
    const r = this.refs;
    for (const b of this.engineButtons) b.addEventListener('click', () => this.h.onEngine?.(b.dataset.engine));
    r.ghost.addEventListener('click', () => this.h.onGhost?.(r.ghost.getAttribute('aria-checked') !== 'true'));
    r.failsafe.addEventListener('click', () => this.h.onFailSafe?.(r.failsafe.getAttribute('aria-checked') !== 'true'));
    r.speed.addEventListener('input', () => {
      this._paintSpeed(Number(r.speed.value));
      this.h.onSpeed?.(Number(r.speed.value));
    });
    r.speed.addEventListener('change', () => this.h.onSpeedCommit?.(Number(r.speed.value)));
    r.seedApply.addEventListener('click', () => this.h.onSeedApply?.(r.seed.value.trim()));
    r.seed.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.h.onSeedApply?.(r.seed.value.trim());
    });
    r.seedRandom.addEventListener('click', () => this.h.onRandomSeed?.());
    for (const b of this.root.querySelectorAll('[data-fault]')) b.addEventListener('click', () => this.h.onFault?.(b.dataset.fault));
    r.reset.addEventListener('click', () => this.h.onReset?.());
    r.exportJson.addEventListener('click', () => this.h.onExportJSON?.());
    r.exportCsv.addEventListener('click', () => this.h.onExportCSV?.());
    r.bench.addEventListener('click', () => this.h.onBenchmark?.());
  }

  _paintSpeed(v) {
    this.refs.speedVal.textContent = String(v);
    this.refs.speed.style.setProperty('--fill', `${(v / 120) * 100}%`);
  }

  setEngine(id) {
    for (const b of this.engineButtons) b.setAttribute('aria-pressed', String(b.dataset.engine === id));
  }

  setGhost(on) {
    this.refs.ghost.setAttribute('aria-checked', String(on));
  }

  setFailSafe(on) {
    this.refs.failsafe.setAttribute('aria-checked', String(on));
  }

  setSpeed(v) {
    this.refs.speed.value = String(v);
    this._paintSpeed(v);
  }

  setSeed(seed) {
    this.refs.seed.value = String(seed);
    this.refs.seedChip.textContent = `SEED ${seed}`;
  }

  update(snapshot) {
    const fp = snapshot.agents.flexipath.stats;
    const lg = snapshot.agents.legacy.stats;
    const stalled = snapshot.agents.legacy.decision?.stalled;
    const fpVal = fp.stallTime.toFixed(2);
    const lgVal = lg.stallTime.toFixed(2);
    if (this.cache.fp !== fpVal) {
      this.cache.fp = fpVal;
      this.refs.fpStall.firstChild.nodeValue = fpVal;
    }
    if (this.cache.lg !== lgVal) {
      this.cache.lg = lgVal;
      this.refs.lgStall.firstChild.nodeValue = lgVal;
    }
    this.refs.lgStall.classList.toggle('is-ticking', !!stalled);
    const fpSub = `${fp.seamlessHandovers} hot-swap${fp.seamlessHandovers === 1 ? '' : 's'} · ${fp.unplannedFailovers ? `${fp.unplannedFailovers} failover · ` : ''}${fp.criticalLost} lost`;
    const lgSub = `${lg.stallEvents} stall${lg.stallEvents === 1 ? '' : 's'} · ${lg.tcpResets} TCP RST · ${lg.criticalLost} lost`;
    if (this.cache.fpSub !== fpSub) this.refs.fpSub.textContent = this.cache.fpSub = fpSub;
    if (this.cache.lgSub !== lgSub) this.refs.lgSub.textContent = this.cache.lgSub = lgSub;
  }
}
