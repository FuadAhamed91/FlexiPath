/**
 * Dashboard.js — cockpit HUD layout and component orchestrator.
 *
 *   header      status banner · connection-state pill · anchor IP · zone · clock
 *   left deck   TelemetryPanel (interface health) + FlowInspector
 *   centre      Three.js viewport + overlays (zone track, camera, playback, legend)
 *   right deck  Controls (stall counters, speed, seed, faults, export) + EventLog
 *   bottom      60 s rolling charts: throughput · latency · packet loss · MOS
 */
import {
  createIcons,
  Cable,
  Wifi,
  WifiOff,
  RadioTower,
  Satellite,
  Zap,
  History,
  Ghost,
  Siren,
  Play,
  Pause,
  Dice5,
  TowerControl,
  RotateCcw,
  FileJson,
  FileSpreadsheet,
  FlaskConical,
  Lock,
  MapPin,
  Timer,
  Crosshair,
  Video,
  Map as MapIcon,
  Keyboard,
  X,
  Download,
  Repeat,
  Box,
  CircleHelp,
  Maximize2,
  Minimize2,
} from 'lucide';
import { TelemetryPanel } from './TelemetryPanel.js';
import { FlowInspector } from './FlowInspector.js';
import { EventLog } from './EventLog.js';
import { Controls } from './Controls.js';
import { ThroughputChart } from '../charts/ThroughputChart.js';
import { RTTChart } from '../charts/RTTChart.js';
import { PacketLossChart } from '../charts/PacketLossChart.js';
import { QoEChart } from '../charts/QoEChart.js';
import { SERIES_COLORS } from '../charts/BaseTimeSeriesChart.js';
import { ANCHOR_IP, DT, MOS_THRESHOLD } from '../simulation/SimulationEngine.js';
import { ZONES } from '../simulation/NetworkEnvironment.js';
import { ROUTE_END_X } from '../simulation/MobilityModel.js';
import { INTERFACE_SPECS } from '../simulation/LinkModel.js';
import { ExperimentRunner, SCENARIOS } from '../simulation/ExperimentRunner.js';
import { downloadText, timestampedName, toCSV, toJSON } from '../utils/Export.js';

const ICONS = {
  Cable,
  Wifi,
  WifiOff,
  RadioTower,
  Satellite,
  Zap,
  History,
  Ghost,
  Siren,
  Play,
  Pause,
  Dice5,
  TowerControl,
  RotateCcw,
  FileJson,
  FileSpreadsheet,
  FlaskConical,
  Lock,
  MapPin,
  Timer,
  Crosshair,
  Video,
  Map: MapIcon,
  Keyboard,
  X,
  Download,
  Repeat,
  Box,
  CircleHelp,
  Maximize2,
  Minimize2,
};

export function renderIcons(root = document) {
  createIcons({ icons: ICONS, root, attrs: { 'stroke-width': '1.75' } });
}

const LOGO = `
  <svg viewBox="0 0 64 64" class="size-9 shrink-0 drop-shadow-[0_0_10px_rgba(0,240,255,0.55)]" aria-hidden="true">
    <path d="M6 44 C 20 44, 22 18, 32 18 S 44 44, 58 44" fill="none" stroke="#00F0FF" stroke-width="4" stroke-linecap="round"/>
    <path d="M6 44 C 20 44, 24 31, 32 31 S 44 44, 58 44" fill="none" stroke="#A855F7" stroke-width="4" stroke-linecap="round"/>
    <circle cx="6" cy="44" r="4.5" fill="#00F0FF"/><circle cx="58" cy="44" r="4.5" fill="#10B981"/>
  </svg>`;

const chartCard = (key, title, unit) => `
  <article class="hud-panel chart-card flex min-h-[172px] flex-col px-3 pt-2.5 pb-1.5">
    <header class="flex items-center justify-between gap-2">
      <h3 class="hud-title truncate">${title} <span class="font-mono text-[9px] tracking-normal text-slate-600 normal-case">${unit}</span></h3>
      <div class="num flex shrink-0 gap-2.5 text-[10.5px] font-semibold">
        <span class="text-fp" data-chart-fp="${key}">—</span><span class="text-legacy" data-chart-lg="${key}">—</span>
      </div>
    </header>
    <div class="relative mt-1 min-h-0 flex-1"><canvas data-chart="${key}" aria-label="${title} chart" role="img"></canvas></div>
  </article>`;

const fmtClock = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `T+${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};

export class Dashboard {
  constructor(root, engine) {
    this.root = root;
    this.engine = engine;
    this.view = { focus: 'flexipath', showGhost: true, camera: 'chase', theatre: false };
    this.hooks = {};
    this.replBands = [];
    this.stallBands = [];
    this.dirty = true;
    this._lastPanel = 0;
    this._lastChart = 0;
    this._build();

    this.telemetry = new TelemetryPanel(this.refs.telemetry);
    this.flows = new FlowInspector(this.refs.flows);
    this.log = new EventLog(this.refs.log);
    this.controls = new Controls(this.refs.controls, {
      onEngine: (id) => this.setFocus(id),
      onGhost: (on) => this.setGhost(on),
      onFailSafe: (on) => {
        this.engine.setFailSafe(on);
        this.controls.setFailSafe(on);
      },
      onSpeed: (v) => this.engine.setSpeedKmh(v),
      onSpeedCommit: (v) => this.engine.setSpeedKmh(v, { log: true }),
      onSeedApply: (seed) => this.restart({ seed: seed || this.engine.config.seed }),
      onRandomSeed: () => this.restart({ seed: 1 + Math.floor(Math.random() * 99999) }),
      onFault: (type) => this.injectFault(type),
      onReset: () => this.restart(),
      onExportJSON: () => this.exportJSON(),
      onExportCSV: () => this.exportCSV(),
      onBenchmark: () => this.openBenchmark(),
    });
    this.charts = {
      thr: new ThroughputChart(this.root.querySelector('[data-chart="thr"]')),
      rtt: new RTTChart(this.root.querySelector('[data-chart="rtt"]')),
      loss: new PacketLossChart(this.root.querySelector('[data-chart="loss"]')),
      qoe: new QoEChart(this.root.querySelector('[data-chart="qoe"]')),
    };
    this.chartLegends = {};
    for (const key of Object.keys(this.charts)) {
      this.chartLegends[key] = {
        fp: this.root.querySelector(`[data-chart-fp="${key}"]`),
        lg: this.root.querySelector(`[data-chart-lg="${key}"]`),
      };
    }

    renderIcons(this.root);
    this._bindOverlay();
    this._bindKeyboard();
    this._subscribe();
    this._syncFromEngine();
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  _build() {
    const zones = ZONES.map((z) => {
      const w = ((z.x1 - z.x0) / ROUTE_END_X) * 100;
      return `<div class="relative" style="width:${w}%">
        <div class="mb-1 truncate pr-1 font-mono text-[8.5px] font-bold tracking-[0.12em]" style="color:${z.color}">Z${z.id} · ${z.name.toUpperCase()}</div>
        <div class="seg-z rounded-sm" style="height:6px;background:${z.color}"></div>
      </div>`;
    }).join('');

    this.root.innerHTML = `
    <div class="flex h-full flex-col overflow-y-auto xl:overflow-hidden">
      <header class="relative z-10 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-cyan-400/10 bg-slate-950/70 px-4 py-2.5 backdrop-blur">
        <div class="flex shrink-0 items-center gap-3">
          ${LOGO}
          <div>
            <h1 class="font-display text-[14px] font-extrabold tracking-[0.26em] text-slate-100">FLEXIPATH <span class="text-fp">MULTI-LINK CONVERGENCE HUD</span></h1>
            <p class="font-mono text-[9px] tracking-[0.14em] text-slate-500">ATRC ADVANCED TECHNOLOGY PIONEERS 2026 · EDGE CHALLENGE</p>
          </div>
        </div>
        <div class="flex min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden max-xl:order-last max-xl:basis-full max-xl:justify-start">
          <div class="state-pill min-w-0" data-ref="pill" aria-live="polite">
            <span class="dot shrink-0"></span><span class="shrink-0" data-ref="pillText">INITIALISING</span>
            <span class="truncate font-mono text-[10px] font-semibold tracking-[0.04em] opacity-75" data-ref="pillDetail"></span>
          </div>
          <span class="chip hidden shrink-0 2xl:inline-flex" data-ref="pill2"></span>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <span class="chip border-fp/30!" title="Persistent anchor IP: applications keep one source address across every path swap, so no socket is ever reset">
            <i data-lucide="lock" class="text-fp"></i>ANCHOR IP <b class="text-slate-100">${ANCHOR_IP}</b><span class="hidden text-fp 2xl:inline">STATIC</span>
          </span>
          <span class="chip"><i data-lucide="map-pin"></i><span data-ref="zone">ZONE 1</span></span>
          <span class="chip"><i data-lucide="timer"></i><span class="text-slate-100" data-ref="clock">T+00:00.0</span></span>
        </div>
      </header>

      <div class="grid shrink-0 grid-cols-1 gap-2 p-2 xl:min-h-0 xl:flex-1 xl:shrink xl:grid-cols-[292px_minmax(0,1fr)_328px]" data-ref="mainGrid">
        <aside class="hud-scroll flex min-h-0 flex-col gap-2 xl:overflow-y-auto" aria-label="Telemetry deck" data-ref="leftDeck">
          <section class="hud-panel" data-ref="telemetry"></section>
          <section class="hud-panel" data-ref="flows"></section>
        </aside>

        <main class="viewport hud-panel relative order-first h-[62vh] min-h-[380px] overflow-hidden xl:order-none xl:h-auto" data-ref="viewport">
          <div class="absolute inset-0" data-ref="canvasHost"></div>
          <div class="viewport-vignette"></div>
          <div class="scanlines"></div>

          <div class="overlay-glass pointer-events-none absolute inset-x-3 top-3 px-3 pt-2 pb-2.5">
            <div class="relative">
              <div class="flex">${zones}</div>
              <div class="zone-marker fp" data-ref="markFp" style="left:0%" title="FlexiPath vehicle"></div>
              <div class="zone-marker lg" data-ref="markLg" style="left:0%" title="Legacy vehicle"></div>
            </div>
          </div>

          <div class="absolute top-[62px] right-3 flex items-center gap-2">
            <div class="seg overlay-glass" role="group" aria-label="Camera mode">
              <button type="button" class="px-2.5" data-cam="chase" aria-pressed="true"><i data-lucide="crosshair"></i>Chase</button>
              <button type="button" class="px-2.5" data-cam="cinematic" aria-pressed="false"><i data-lucide="video"></i>Cinematic</button>
              <button type="button" class="px-2.5" data-cam="overview" aria-pressed="false"><i data-lucide="map"></i>Overview</button>
            </div>
            <button type="button" class="btn overlay-glass h-[36px]!" data-ref="theatre" aria-label="Theatre mode (T)" title="Theatre mode (T)"><i data-lucide="maximize-2"></i></button>
            <button type="button" class="btn overlay-glass h-[36px]!" data-ref="help" aria-label="Keyboard shortcuts and help"><i data-lucide="circle-help"></i></button>
          </div>

          <div class="overlay-glass pointer-events-none absolute top-[62px] left-3 px-3 py-2" data-ref="kpi" hidden>
            <div class="hud-label">Cumulative handover stall time</div>
            <div class="num mt-1.5 flex items-baseline gap-5">
              <span class="text-[10px] font-bold tracking-[0.16em] text-fp">FLEXIPATH <b class="text-[22px]" data-ref="kpiFp">0.00</b> s</span>
              <span class="text-[10px] font-bold tracking-[0.16em] text-legacy">LEGACY OS <b class="text-[22px]" data-ref="kpiLg">0.00</b> s</span>
            </div>
          </div>

          <div class="overlay-glass pointer-events-none absolute bottom-3 left-3 hidden flex-col gap-1 px-2.5 py-2 md:flex" aria-label="Beam legend">
            ${[
              ['eth0 · wired', INTERFACE_SPECS.eth0.color],
              ['wlan0 · Wi-Fi 6', INTERFACE_SPECS.wlan0.color],
              ['wwan0 · 5G SA', INTERFACE_SPECS.wwan0.color],
              ['sat0 · LEO', INTERFACE_SPECS.sat0.color],
              ['replication window', '#A855F7'],
              ['legacy stall', '#F43F5E'],
            ]
              .map(([l, c]) => `<div class="flex items-center gap-2 font-mono text-[9.5px] text-slate-400"><span class="h-[3px] w-5 rounded-full" style="background:${c};box-shadow:0 0 8px ${c}"></span>${l}</div>`)
              .join('')}
          </div>

          <div class="overlay-glass absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 px-2 py-1.5">
            <button type="button" class="btn btn-primary w-[34px] px-0!" data-ref="play" aria-label="Pause simulation"><i data-lucide="pause"></i></button>
            <div class="seg p-[2px]!" role="group" aria-label="Simulation rate">
              ${[1, 2, 4].map((r) => `<button type="button" class="h-[24px]! px-2.5! font-mono" data-rate="${r}" aria-pressed="${r === 1}">${r}×</button>`).join('')}
            </div>
            <span class="num px-1 text-[11px] text-slate-400" data-ref="simInfo">10 Hz</span>
          </div>

          <div class="pointer-events-none absolute right-3 bottom-3 flex flex-col items-end gap-1.5">
            <span class="chip" data-ref="assets"><i data-lucide="box"></i>MODELS · LOADING</span>
          </div>
        </main>

        <aside class="hud-scroll flex min-h-0 flex-col gap-2 xl:overflow-y-auto" aria-label="Controls deck" data-ref="rightDeck">
          <section class="hud-panel shrink-0" data-ref="controls"></section>
          <section class="hud-panel flex min-h-[230px] flex-1 flex-col" data-ref="log"></section>
        </aside>
      </div>

      <section class="grid shrink-0 grid-cols-1 gap-2 px-2 pb-2 sm:grid-cols-2 xl:h-[200px] xl:grid-cols-4" aria-label="Real-time graphs" data-ref="chartsRow">
        ${chartCard('thr', 'Aggregated Throughput', 'Mbps')}
        ${chartCard('rtt', 'Critical-Flow Latency', 'ms · log')}
        ${chartCard('loss', 'Packet Loss', '% · 1 s window')}
        ${chartCard('qoe', 'QoE · MOS', 'ITU-T G.107')}
      </section>
    </div>
    <div class="toast-stack" data-ref="toasts" aria-live="polite"></div>
    <div class="modal-backdrop" hidden data-ref="modal" role="dialog" aria-modal="true">
      <div class="hud-panel hud-scroll max-h-[90vh] w-[min(760px,100%)] overflow-y-auto" data-ref="modalBody"></div>
    </div>`;

    this.refs = {};
    this.root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.viewportEl = this.refs.canvasHost;
  }

  _bindOverlay() {
    this.camButtons = [...this.root.querySelectorAll('[data-cam]')];
    for (const b of this.camButtons) b.addEventListener('click', () => this.setCamera(b.dataset.cam));
    this.rateButtons = [...this.root.querySelectorAll('[data-rate]')];
    for (const b of this.rateButtons) b.addEventListener('click', () => this.setRate(Number(b.dataset.rate)));
    this.refs.play.addEventListener('click', () => this.togglePause());
    this.refs.help.addEventListener('click', () => this.openHelp());
    this.refs.theatre.addEventListener('click', () => this.setTheatre(!this.view.theatre));
    this.refs.modal.addEventListener('click', (e) => {
      if (e.target === this.refs.modal) this.closeModal();
    });
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'escape') return this.closeModal();
      if (!this.refs.modal.hidden) return;
      const actions = {
        ' ': () => this.togglePause(),
        r: () => this.restart(),
        1: () => this.setFocus('flexipath'),
        2: () => this.setFocus('legacy'),
        f: () => this.injectFault('wifi-fade'),
        g: () => this.injectFault('cell-outage'),
        c: () => {
          const order = ['chase', 'cinematic', 'overview'];
          this.setCamera(order[(order.indexOf(this.view.camera) + 1) % order.length]);
        },
        v: () => this.setGhost(!this.view.showGhost),
        t: () => this.setTheatre(!this.view.theatre),
        e: () => this.exportJSON(),
        '?': () => this.openHelp(),
        h: () => this.openHelp(),
      };
      if (actions[key]) {
        e.preventDefault();
        actions[key]();
      }
    });
  }

  _subscribe() {
    const e = this.engine;
    e.on('tick', (snap) => this._onTick(snap));
    e.on('event', (ev) => {
      this.log.push(ev);
      if (ev.code === 'FAULT') this.toast(ev.message.replace('FAULT INJECTED · ', '⚠ '), 'warn');
    });
    e.on('reset', () => this._syncFromEngine());
    e.on('complete', (summary) => {
      this.dirty = true;
      setTimeout(() => this.openSummary(summary), 900);
    });
  }

  _syncFromEngine() {
    const e = this.engine;
    this.controls.setSeed(e.config.seed);
    this.controls.setSpeed(e.config.speedKmh);
    this.controls.setFailSafe(e.config.failSafe);
    this.controls.setEngine(this.view.focus);
    this.controls.setGhost(this.view.showGhost);
    this.replBands = [];
    this.stallBands = [];
    for (const c of Object.values(this.charts)) c.reset();
    this.log.rebuild(e.events);
    this._onTick(e.snapshot);
    this._renderCharts(e.snapshot.t);
    this._updatePlay();
    this.dirty = true;
  }

  // ── Per-tick data flow ──────────────────────────────────────────────────
  _trackBand(list, active, t, color, edge) {
    const last = list[list.length - 1];
    if (active) {
      if (last?.open) last.to = t;
      else list.push({ from: t - DT, to: t, open: true, color, edge });
    } else if (last?.open) last.open = false;
    while (list.length && list[0].to < t - 75) list.shift();
  }

  _onTick(snap) {
    for (const c of Object.values(this.charts)) c.pushSnapshot(snap);
    this._trackBand(this.replBands, snap.agents.flexipath.decision?.replicationActive, snap.t, SERIES_COLORS.replication, 'rgba(168,85,247,0.7)');
    this._trackBand(this.stallBands, snap.agents.legacy.decision?.stalled, snap.t, SERIES_COLORS.stall, 'rgba(244,63,94,0.8)');
    this.dirty = true;
    this._chartDirty = true;
  }

  _renderCharts(t) {
    const bands = [...this.replBands, ...this.stallBands];
    for (const c of Object.values(this.charts)) {
      c.setBands(bands);
      c.render(t);
    }
    this._chartDirty = false;
  }

  /** Called from the render loop every animation frame. */
  frame(now) {
    const snap = this.engine.snapshot;
    if (this.dirty && now - this._lastPanel > 90) {
      this._lastPanel = now;
      this.dirty = false;
      this._updatePanels(snap);
    }
    if (this._chartDirty && now - this._lastChart > 180) {
      this._lastChart = now;
      this._renderCharts(snap.t);
    }
  }

  _updatePanels(snap) {
    const focus = this.view.focus;
    const agent = snap.agents[focus];
    this.telemetry.update(agent, focus);
    this.flows.update(agent, focus);
    this.controls.update(snap);
    this._updateHeader(snap);
    if (this.view.theatre) {
      this.refs.kpiFp.textContent = snap.agents.flexipath.stats.stallTime.toFixed(2);
      this.refs.kpiLg.textContent = snap.agents.legacy.stats.stallTime.toFixed(2);
    }

    const fpX = snap.agents.flexipath.vehicle.cx;
    const lgX = snap.agents.legacy.vehicle.cx;
    this.refs.markFp.style.left = `${Math.min(100, Math.max(0, (fpX / ROUTE_END_X) * 100))}%`;
    this.refs.markLg.style.left = `${Math.min(100, Math.max(0, (lgX / ROUTE_END_X) * 100))}%`;
    this.refs.markLg.style.display = this.view.showGhost || focus === 'legacy' ? '' : 'none';
    this.refs.markFp.style.display = this.view.showGhost || focus === 'flexipath' ? '' : 'none';

    const fmt = {
      thr: (v) => `${v.toFixed(0)}`,
      rtt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v.toFixed(0)}ms`),
      loss: (v) => `${v.toFixed(1)}%`,
      qoe: (v) => v.toFixed(2),
    };
    const m = { fp: snap.agents.flexipath.metrics, lg: snap.agents.legacy.metrics };
    const pick = { thr: 'throughputMbps', rtt: 'latencyMs', loss: 'lossPct', qoe: 'mos' };
    for (const [key, legend] of Object.entries(this.chartLegends)) {
      legend.fp.textContent = `FP ${fmt[key](m.fp[pick[key]])}`;
      legend.lg.textContent = `LG ${fmt[key](m.lg[pick[key]])}`;
    }
  }

  _pillFor(agent, engine, t) {
    const d = agent.decision;
    if (engine === 'legacy') {
      if (d.stalled && d.stall) {
        return { text: 'SOCKET STALLED · TCP RESET', detail: `${d.stall.remaining.toFixed(1)} s left`, color: '#F43F5E', pulse: true };
      }
      return { text: 'LEGACY OS · BREAK-BEFORE-MAKE', detail: `route ${d.primary ?? '—'}`, color: '#FB7185', pulse: false };
    }
    if (d.replicationActive) {
      return { text: 'PREDICTIVE REPLICATION ACTIVE', detail: `${d.primary} ⇉ ${d.replica}`, color: '#A855F7', pulse: true };
    }
    const ls = d.lastSwitch;
    if (ls && t - ls.t < 2.5) {
      return ls.seamless
        ? { text: 'HOT-SWAP COMPLETE', detail: `${ls.from} → ${ls.to} · session unbroken`, color: '#10B981', pulse: false }
        : { text: 'UNPLANNED FAILOVER', detail: `${ls.from} → ${ls.to} · ${ls.blackoutMs} ms`, color: '#F59E0B', pulse: true };
    }
    return { text: 'MULTI-LINK CONVERGED', detail: `primary ${d.primary ?? '—'}`, color: '#00F0FF', pulse: false };
  }

  _updateHeader(snap) {
    const focus = this.view.focus;
    const other = focus === 'flexipath' ? 'legacy' : 'flexipath';
    const pill = this._pillFor(snap.agents[focus], focus, snap.t);
    const key = `${pill.text}|${pill.detail}`;
    if (this._pillKey !== key) {
      this._pillKey = key;
      this.refs.pillText.textContent = pill.text;
      this.refs.pillDetail.textContent = pill.detail;
      this.refs.pill.style.setProperty('--pill-c', pill.color);
      this.refs.pill.classList.toggle('is-pulsing', pill.pulse);
    }
    const od = snap.agents[other].decision;
    let short;
    let color;
    if (other === 'legacy') {
      short = od.stalled ? `LEGACY · STALLED ${od.stall?.remaining.toFixed(1) ?? ''}s` : `LEGACY · ROUTE ${od.primary ?? '—'}`;
      color = od.stalled ? '#F43F5E' : '#FB7185';
    } else {
      short = od.replicationActive ? `FLEXIPATH · REPLICATING` : `FLEXIPATH · PRIMARY ${od.primary ?? '—'}`;
      color = od.replicationActive ? '#C084FC' : '#67E8F9';
    }
    if (this._pill2Key !== short) {
      this._pill2Key = short;
      this.refs.pill2.textContent = short;
      this.refs.pill2.style.color = color;
      this.refs.pill2.style.borderColor = `${color}55`;
    }
    const zone = ZONES.find((z) => z.id === snap.agents[focus].vehicle.zone) ?? ZONES[0];
    if (this._zoneKey !== zone.id) {
      this._zoneKey = zone.id;
      this.refs.zone.textContent = `ZONE ${zone.id}`;
      this.refs.zone.title = zone.name;
      this.refs.zone.style.color = zone.color;
    }
    this.refs.clock.textContent = fmtClock(snap.t);
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  setFocus(id) {
    this.view.focus = id;
    this.controls.setEngine(id);
    this.dirty = true;
    this.toast(id === 'legacy' ? 'Focus: Legacy OS mode (break-before-make)' : 'Focus: FlexiPath mode (predictive multi-path)');
  }

  setGhost(on) {
    this.view.showGhost = on;
    this.controls.setGhost(on);
    this.dirty = true;
  }

  /** Theatre mode: hide the decks and charts so the 3D twin fills the screen (demos / video capture). */
  setTheatre(on) {
    this.view.theatre = on;
    this.refs.leftDeck.hidden = on;
    this.refs.rightDeck.hidden = on;
    this.refs.chartsRow.hidden = on;
    this.refs.kpi.hidden = !on;
    this.refs.mainGrid.style.gridTemplateColumns = on ? 'minmax(0, 1fr)' : '';
    this.refs.theatre.innerHTML = `<i data-lucide="${on ? 'minimize-2' : 'maximize-2'}"></i>`;
    renderIcons(this.refs.theatre);
    this.dirty = true;
    if (!on) this._chartDirty = true;
  }

  setCamera(mode) {
    this.view.camera = mode;
    for (const b of this.camButtons) b.setAttribute('aria-pressed', String(b.dataset.cam === mode));
    this.hooks.onCamera?.(mode);
  }

  setRate(rate) {
    this.engine.setSimRate(rate);
    for (const b of this.rateButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === rate));
    this.refs.simInfo.textContent = `${10 * rate} ticks/s`;
  }

  togglePause(force) {
    const paused = typeof force === 'boolean' ? force : !this.engine.paused;
    this.engine.setPaused(paused);
    this._updatePlay();
  }

  _updatePlay() {
    const paused = this.engine.paused;
    this.refs.play.innerHTML = `<i data-lucide="${paused ? 'play' : 'pause'}"></i>`;
    this.refs.play.setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
    renderIcons(this.refs.play);
  }

  restart(overrides = {}) {
    this.closeModal();
    this.hooks.onBeforeReset?.();
    this.engine.reset(overrides);
    this.engine.setPaused(false);
    this._updatePlay();
    this.toast(`Scenario reset · seed ${this.engine.config.seed}`);
  }

  injectFault(type) {
    if (this.engine.completed) {
      this.toast('Run complete — reset the scenario to inject faults', 'warn');
      return;
    }
    this.engine.injectFault(type);
  }

  exportJSON() {
    const data = this.engine.exportData();
    downloadText(timestampedName('flexipath_experiment', 'json', this.engine.config.seed), toJSON(data), 'application/json');
    this.toast(`Exported JSON · ${data.timeseries.length} samples · ${data.events.length} events`);
  }

  exportCSV() {
    const rows = this.engine.exportRows();
    downloadText(timestampedName('flexipath_timeseries', 'csv', this.engine.config.seed), toCSV(rows), 'text/csv');
    this.toast(`Exported CSV · ${rows.length} rows`);
  }

  setAssetSource({ vehicles, nodes }) {
    const all = [...Object.values(vehicles), ...Object.values(nodes)];
    const glb = all.filter(Boolean).length;
    const text = glb === all.length ? 'MODELS · BLENDER GLB' : glb === 0 ? 'MODELS · PROCEDURAL FALLBACK' : `MODELS · ${glb}/${all.length} GLB`;
    this.refs.assets.innerHTML = `<i data-lucide="box"></i>${text}`;
    renderIcons(this.refs.assets);
  }

  toast(message, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind === 'warn' ? 'warn' : ''}`;
    el.textContent = message;
    this.refs.toasts.append(el);
    setTimeout(() => el.remove(), 2800);
    while (this.refs.toasts.childElementCount > 4) this.refs.toasts.firstElementChild.remove();
  }

  // ── Modals ──────────────────────────────────────────────────────────────
  openModal(html) {
    this.refs.modalBody.innerHTML = html;
    this.refs.modal.hidden = false;
    renderIcons(this.refs.modalBody);
    this.refs.modalBody.querySelector('[data-close]')?.addEventListener('click', () => this.closeModal());
    this.refs.modalBody.querySelector('button')?.focus();
  }

  closeModal() {
    if (this._benchAbort) this._benchAbort.abort();
    this.refs.modal.hidden = true;
  }

  _modalHeader(title, sub) {
    return `<div class="flex items-start justify-between gap-4 border-b border-cyan-400/10 px-5 pt-4 pb-3">
      <div><h2 class="hud-title text-[11px]! text-slate-200!">${title}</h2>${sub ? `<p class="mt-1.5 font-mono text-[10.5px] text-slate-500">${sub}</p>` : ''}</div>
      <button type="button" class="btn w-[30px] px-0!" data-close aria-label="Close"><i data-lucide="x"></i></button>
    </div>`;
  }

  openSummary(summary) {
    const fp = summary.flexipath;
    const lg = summary.legacy;
    const row = (label, a, b, better = 'lower') => {
      const fpWins = better === 'lower' ? a.value <= b.value : a.value >= b.value;
      return `<tr class="border-t border-slate-800/80">
        <td class="py-2 pr-3 text-slate-400">${label}</td>
        <td class="py-2 pr-3 text-right font-semibold ${fpWins ? 'text-fp' : 'text-slate-300'}">${a.text}</td>
        <td class="py-2 text-right font-semibold ${fpWins ? 'text-legacy' : 'text-slate-300'}">${b.text}</td></tr>`;
    };
    const v = (value, text) => ({ value, text });
    const html = `
      ${this._modalHeader('Run complete · FlexiPath vs Legacy OS', `seed ${summary.meta.seed} · ${summary.meta.speedKmh} km/h · ${summary.meta.simTimeS} s simulated · ${summary.faults.length} fault(s) injected`)}
      <div class="px-5 py-4">
        <p class="text-[13px] leading-relaxed text-slate-300">
          FlexiPath carried every session across <b class="text-fp">${fp.seamlessHandovers} make-before-break hot-swaps</b>
          with <b class="text-fp">${fp.stallTimeS.toFixed(2)} s</b> of stall, while the legacy stack broke
          <b class="text-legacy">${lg.breakBeforeMakeHandovers} times</b>, stalled for <b class="text-legacy">${lg.stallTimeS.toFixed(2)} s</b>
          and reset <b class="text-legacy">${lg.tcpResets} TCP sockets</b>.
        </p>
        <table class="num mt-4 w-full text-[12px]">
          <thead><tr class="text-[10px] tracking-[0.14em] text-slate-500">
            <th class="pb-2 text-left font-semibold">METRIC</th><th class="pb-2 text-right font-semibold text-fp">FLEXIPATH</th><th class="pb-2 text-right font-semibold text-legacy">LEGACY OS</th>
          </tr></thead>
          <tbody>
            ${row('Handover stall time', v(fp.stallTimeS, `${fp.stallTimeS.toFixed(2)} s`), v(lg.stallTimeS, `${lg.stallTimeS.toFixed(2)} s`))}
            ${row('Break-before-make stalls', v(fp.breakBeforeMakeHandovers, fp.breakBeforeMakeHandovers), v(lg.breakBeforeMakeHandovers, lg.breakBeforeMakeHandovers))}
            ${row('TCP resets', v(fp.tcpResets, fp.tcpResets), v(lg.tcpResets, lg.tcpResets))}
            ${row('Critical packets lost', v(fp.criticalLost, `${fp.criticalLost} (${fp.criticalLossPct.toFixed(2)}%)`), v(lg.criticalLost, `${lg.criticalLost} (${lg.criticalLossPct.toFixed(2)}%)`))}
            ${row('Mean MOS (G.107)', v(fp.meanMos, fp.meanMos.toFixed(2)), v(lg.meanMos, lg.meanMos.toFixed(2)), 'higher')}
            ${row('Worst MOS', v(fp.minMos, fp.minMos?.toFixed(2)), v(lg.minMos, lg.minMos?.toFixed(2)), 'higher')}
            ${row(`Time below MOS ${MOS_THRESHOLD}`, v(fp.timeBelowMos36S, `${fp.timeBelowMos36S.toFixed(1)} s`), v(lg.timeBelowMos36S, `${lg.timeBelowMos36S.toFixed(1)} s`))}
            ${row('Mean aggregate throughput', v(fp.meanThroughputMbps, `${fp.meanThroughputMbps.toFixed(1)} Mbps`), v(lg.meanThroughputMbps, `${lg.meanThroughputMbps.toFixed(1)} Mbps`), 'higher')}
            ${row('Journey time (fail-safe braking)', v(fp.journeyTimeS ?? 1e9, fp.journeyTimeS ? `${fp.journeyTimeS.toFixed(1)} s` : '—'), v(lg.journeyTimeS ?? 1e9, lg.journeyTimeS ? `${lg.journeyTimeS.toFixed(1)} s` : '—'))}
            <tr class="border-t border-slate-800/80"><td class="py-2 pr-3 text-slate-400">Replication cost</td>
              <td class="py-2 pr-3 text-right text-repl">${fp.replicationTimeS.toFixed(1)} s · +${fp.replicationOverheadPct.toFixed(1)}% critical bytes · ${fp.duplicatesDiscarded} dups discarded</td>
              <td class="py-2 text-right text-slate-500">n/a</td></tr>
          </tbody>
        </table>
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" class="btn" data-act="json"><i data-lucide="file-json"></i>Export JSON</button>
          <button type="button" class="btn" data-act="csv"><i data-lucide="file-spreadsheet"></i>Export CSV</button>
          <button type="button" class="btn" data-act="new"><i data-lucide="dice-5"></i>New seed</button>
          <button type="button" class="btn btn-primary" data-act="replay"><i data-lucide="repeat"></i>Replay seed ${summary.meta.seed}</button>
        </div>
      </div>`;
    this.openModal(html);
    const body = this.refs.modalBody;
    body.querySelector('[data-act="json"]').addEventListener('click', () => this.exportJSON());
    body.querySelector('[data-act="csv"]').addEventListener('click', () => this.exportCSV());
    body.querySelector('[data-act="new"]').addEventListener('click', () => this.restart({ seed: 1 + Math.floor(Math.random() * 99999) }));
    body.querySelector('[data-act="replay"]').addEventListener('click', () => this.restart());
  }

  openHelp() {
    const keys = [
      ['Space', 'Pause / resume'],
      ['1 / 2', 'FlexiPath / Legacy focus'],
      ['F', 'Inject rapid Wi-Fi fade'],
      ['G', 'Inject 5G cell outage'],
      ['R', 'Reset scenario (same seed)'],
      ['C', 'Cycle camera mode'],
      ['V', 'Toggle ghost vehicle'],
      ['T', 'Theatre mode (full-screen twin)'],
      ['E', 'Export experiment JSON'],
    ];
    this.openModal(`
      ${this._modalHeader('How to read the twin', 'FlexiPath · DETECT → PREDICT → REPLICATE → SWITCH')}
      <div class="grid gap-5 px-5 py-4 md:grid-cols-2">
        <div class="space-y-2.5 text-[12px] leading-relaxed text-slate-300">
          <p><b class="text-fp">Detect.</b> Every link is probed at 10 Hz: throughput, EWMA RTT, jitter, loss and RSSI/RSRP.</p>
          <p><b class="text-fp">Predict.</b> ΔLoss over 1 s, RTT drift and signal time-to-failure flag a dying link <i>before</i> it drops.</p>
          <p><b class="text-repl">Replicate.</b> Critical packets are mirrored onto the best candidate; the receiver keeps the first copy.</p>
          <p><b class="text-cell">Switch.</b> When loss &gt; 15 % or the candidate scores 1.5× higher, the route hot-swaps behind the anchor IP ${ANCHOR_IP} — no socket resets.</p>
          <p><b class="text-legacy">Legacy.</b> Stays on the link until −85 dBm, then tears it down: detect → attach → DHCP → TCP RST → reconnect = 3.8 s stall.</p>
          <p class="font-mono text-[10.5px] text-slate-500">W = T<sup>a</sup> / (RTT<sup>b</sup> · (1 + 12·L²)) · critical a=0.4 b=1.2 · bulk a=1.5 b=0.5</p>
        </div>
        <div>
          <div class="hud-label mb-2 flex items-center gap-1.5"><i data-lucide="keyboard" class="size-3.5"></i>Keyboard shortcuts</div>
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11.5px] text-slate-300">
            ${keys.map(([k, d]) => `<span class="kbd justify-self-start">${k}</span><span>${d}</span>`).join('')}
          </div>
          <p class="mt-4 font-mono text-[10px] leading-relaxed text-slate-500">URL parameters: ?seed=2026&amp;speed=90&amp;focus=legacy&amp;camera=overview</p>
        </div>
      </div>`);
  }

  openBenchmark() {
    const scenarioOpts = Object.values(SCENARIOS)
      .map((s) => `<label class="flex items-center gap-2 text-[11.5px] text-slate-300"><input type="checkbox" class="accent-cyan-400" name="scn" value="${s.id}" checked />${s.label}</label>`)
      .join('');
    const speedOpts = [30, 60, 90, 120]
      .map((s) => `<label class="flex items-center gap-1.5 font-mono text-[11.5px] text-slate-300"><input type="checkbox" class="accent-cyan-400" name="spd" value="${s}" checked />${s}</label>`)
      .join('');
    this.openModal(`
      ${this._modalHeader('Batch benchmark', 'Headless runs of the same engine · deterministic seeds · results exportable for submission')}
      <div class="px-5 py-4">
        <div class="grid gap-4 md:grid-cols-3">
          <div><div class="hud-label mb-2">Seeds per cell</div>
            <select class="hud-input w-full" name="seeds"><option value="3">3 seeds</option><option value="5" selected>5 seeds</option><option value="10">10 seeds</option></select></div>
          <div><div class="hud-label mb-2">Speeds (km/h)</div><div class="flex flex-wrap gap-3">${speedOpts}</div></div>
          <div><div class="hud-label mb-2">Scenarios</div><div class="flex flex-col gap-1.5">${scenarioOpts}</div></div>
        </div>
        <div class="mt-4 flex items-center gap-3">
          <button type="button" class="btn btn-primary" data-act="run"><i data-lucide="flask-conical"></i>Run benchmark</button>
          <div class="meter flex-1" style="--c:#00F0FF"><span data-ref="bar"></span></div>
          <span class="num w-24 text-right text-[11px] text-slate-400" data-ref="status">idle</span>
        </div>
        <div class="mt-4" data-ref="results"></div>
      </div>`);
    const body = this.refs.modalBody;
    const status = body.querySelector('[data-ref="status"]');
    const bar = body.querySelector('[data-ref="bar"]');
    const results = body.querySelector('[data-ref="results"]');
    const runBtn = body.querySelector('[data-act="run"]');
    runBtn.addEventListener('click', async () => {
      const nSeeds = Number(body.querySelector('[name="seeds"]').value);
      const speeds = [...body.querySelectorAll('[name="spd"]:checked')].map((i) => Number(i.value));
      const scenarios = [...body.querySelectorAll('[name="scn"]:checked')].map((i) => i.value);
      if (!speeds.length || !scenarios.length) return this.toast('Pick at least one speed and one scenario', 'warn');
      const seeds = Array.from({ length: nSeeds }, (_, i) => 1000 + i * 7919);
      const runner = new ExperimentRunner({ seeds, speeds, scenarios, failSafe: this.engine.config.failSafe });
      runBtn.disabled = true;
      this._benchAbort = new AbortController();
      const res = await runner.run({
        signal: this._benchAbort.signal,
        onProgress: (done, total) => {
          bar.style.width = `${(done / total) * 100}%`;
          status.textContent = `${done}/${total} runs`;
        },
      });
      this._benchAbort = null;
      runBtn.disabled = false;
      if (this.refs.modal.hidden) return;
      status.textContent = `done · ${(res.meta.wallTimeMs / 1000).toFixed(1)} s`;
      const table = ExperimentRunner.table(res, ['stallTimeS', 'criticalLossPct', 'meanMos', 'timeBelowMos36S', 'tcpResets']);
      results.innerHTML = `
        <table class="num w-full text-[11.5px]">
          <thead><tr class="text-[9.5px] tracking-[0.12em] text-slate-500">
            <th class="pb-2 text-left">SCENARIO</th><th class="pb-2 text-left">ENGINE</th><th class="pb-2 text-right">RUNS</th>
            <th class="pb-2 text-right">STALL s</th><th class="pb-2 text-right">CRIT LOSS %</th><th class="pb-2 text-right">MEAN MOS</th><th class="pb-2 text-right">s &lt; MOS 3.6</th><th class="pb-2 text-right">TCP RST</th>
          </tr></thead>
          <tbody>${table
            .map(
              (r) => `<tr class="border-t border-slate-800/80 ${r.engine === 'flexipath' ? 'text-fp' : 'text-legacy'}">
              <td class="py-1.5 text-slate-300">${SCENARIOS[r.scenario]?.label ?? r.scenario}</td><td class="py-1.5 font-semibold">${r.engine === 'flexipath' ? 'FlexiPath' : 'Legacy OS'}</td>
              <td class="py-1.5 text-right text-slate-400">${r.runs}</td><td class="py-1.5 text-right">${r.stallTimeS.toFixed(2)}</td>
              <td class="py-1.5 text-right">${r.criticalLossPct.toFixed(2)}</td><td class="py-1.5 text-right">${r.meanMos.toFixed(3)}</td>
              <td class="py-1.5 text-right">${r.timeBelowMos36S.toFixed(1)}</td><td class="py-1.5 text-right">${r.tcpResets.toFixed(1)}</td></tr>`,
            )
            .join('')}</tbody>
        </table>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="btn" data-act="bjson"><i data-lucide="download"></i>Download JSON</button>
          <button type="button" class="btn btn-primary" data-act="bcsv"><i data-lucide="download"></i>Download CSV</button>
        </div>`;
      renderIcons(results);
      results.querySelector('[data-act="bjson"]').addEventListener('click', () =>
        downloadText(timestampedName('flexipath_benchmark', 'json'), toJSON(res), 'application/json'),
      );
      results.querySelector('[data-act="bcsv"]').addEventListener('click', () =>
        downloadText(timestampedName('flexipath_benchmark', 'csv'), ExperimentRunner.toCSV(res), 'text/csv'),
      );
    });
  }
}
