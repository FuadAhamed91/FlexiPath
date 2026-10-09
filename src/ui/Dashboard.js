/**
 * Dashboard.js — HUD layout and component orchestrator.
 *
 * Two views over the same simulation (progressive disclosure):
 *
 *   MISSION (default)  decision loop · live prediction · "why did FlexiPath do that?" · 3D twin ·
 *                      traffic-aware protection · Legacy vs FlexiPath lanes
 *   ADVANCED           decision loop · interface health · prediction internals · flow inspector ·
 *                      3D twin · controls · event log · 60 s charts (throughput, RTT, loss, MOS)
 *
 * Every panel reads the engine snapshot; nothing here holds simulation state of its own. The guided tour
 * (GuidedDemo.js) spotlights the panels through their `refs` and the tour layer at the end of the markup.
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
  Timer,
  Crosshair,
  Video,
  Map as MapIcon,
  X,
  Download,
  Repeat,
  Box,
  Building2,
  List,
  CircleHelp,
  Maximize2,
  Minimize2,
  LayoutDashboard,
  SlidersHorizontal,
  Presentation,
  Info,
  SkipForward,
  ChartLine,
  MousePointerClick,
  ChevronLeft,
  ChevronRight,
  Check,
} from 'lucide';
import { TelemetryPanel } from './TelemetryPanel.js';
import { FlowInspector } from './FlowInspector.js';
import { EventLog } from './EventLog.js';
import { Controls } from './Controls.js';
import { SystemLoop } from './SystemLoop.js';
import { PredictionPanel } from './PredictionPanel.js';
import { DecisionPanel } from './DecisionPanel.js';
import { TrafficPanel } from './TrafficPanel.js';
import { ComparisonLanes } from './ComparisonLanes.js';
import { EngineeringPanel } from './EngineeringPanel.js';
import { TunnelPanel } from './TunnelPanel.js';
import { GlancePanel } from './GlancePanel.js';
import { PredictionInternals } from './PredictionInternals.js';
import { GuidedDemo } from './GuidedDemo.js';
import { openExperiments } from './ExperimentPanel.js';
import { infoHTML } from './InfoContent.js';
import { esc, ink, tag } from './format.js';
import { ThroughputChart } from '../charts/ThroughputChart.js';
import { RTTChart } from '../charts/RTTChart.js';
import { PacketLossChart } from '../charts/PacketLossChart.js';
import { QoEChart } from '../charts/QoEChart.js';
import { PowerChart } from '../charts/PowerChart.js';
import { HolChart } from '../charts/HolChart.js';
import { SERIES_COLORS } from '../charts/BaseTimeSeriesChart.js';
import { ANCHOR_IP, DT, VERSION } from '../simulation/SimulationEngine.js';
import { ZONES } from '../simulation/NetworkEnvironment.js';
import { ROUTE_END_X } from '../simulation/MobilityModel.js';
import { INTERFACE_SPECS } from '../simulation/LinkModel.js';
import { LIVE_SCENARIOS, SCENARIOS } from '../simulation/Scenarios.js';
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
  Timer,
  Crosshair,
  Video,
  Map: MapIcon,
  X,
  Download,
  Repeat,
  Box,
  Building2,
  List,
  CircleHelp,
  Maximize2,
  Minimize2,
  LayoutDashboard,
  SlidersHorizontal,
  Presentation,
  Info,
  SkipForward,
  ChartLine,
  MousePointerClick,
  ChevronLeft,
  ChevronRight,
  Check,
};

export function renderIcons(root = document) {
  createIcons({ icons: ICONS, root, attrs: { 'stroke-width': '1.75' } });
}

const LOGO = `
  <svg viewBox="0 0 64 64" class="size-9 shrink-0" aria-hidden="true">
    <path d="M6 44 C 20 44, 22 18, 32 18 S 44 44, 58 44" fill="none" stroke="#0891B2" stroke-width="4" stroke-linecap="round"/>
    <path d="M6 44 C 20 44, 24 31, 32 31 S 44 44, 58 44" fill="none" stroke="#7C3AED" stroke-width="4" stroke-linecap="round"/>
    <circle cx="6" cy="44" r="4.5" fill="#0891B2"/><circle cx="58" cy="44" r="4.5" fill="#10B981"/>
  </svg>`;

const chartCard = (key, title, unit) => `
  <article class="hud-panel chart-card flex min-h-[148px] flex-col px-3 pt-2 pb-1">
    <header class="flex items-center justify-between gap-2">
      <h3 class="hud-title truncate">${title} <span class="font-mono text-[9px] tracking-normal text-slate-400 normal-case">${unit}</span></h3>
      <div class="num flex shrink-0 gap-2.5 text-[10.5px] font-semibold">
        <span class="text-fp" data-chart-fp="${key}">—</span><span class="text-legacy" data-chart-lg="${key}">—</span>
      </div>
    </header>
    <div class="relative mt-1 min-h-0 flex-1"><canvas data-chart="${key}" aria-label="${title} chart" role="img"></canvas></div>
  </article>`;

// Advanced view: the side column shows one group of panels at a time ([id, label, tooltip]).
const PANEL_TABS = [
  ['decision', 'Decision', 'Why did FlexiPath do that? The latest decision and its history'],
  ['prediction', 'Prediction', 'Prediction · live and its internals'],
  ['links', 'Links', 'Interface health: signal, loss, RTT and radio state per modem'],
  ['traffic', 'Traffic', 'Traffic-aware protection and the flow inspector'],
  ['session', 'Session', 'Battery, packet ordering and the relay tunnel'],
  ['controls', 'Controls', 'Simulation controls, fault injection and exports'],
  ['log', 'Log', 'Event log'],
];
const ADVANCED_KEY = 'flexipath.advanced';

const fmtClock = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `T+${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};

export class Dashboard {
  constructor(root, engine, { mode = 'mission' } = {}) {
    this.root = root;
    this.engine = engine;
    this.view = { focus: 'flexipath', showGhost: true, camera: 'chase', theatre: false, look: 'real', mode };
    this.hooks = {};
    this.replBands = [];
    this.stallBands = [];
    this.dirty = true;
    this._lastPanel = 0;
    this._lastChart = 0;
    this._build();

    this.loop = new SystemLoop(this.refs.loop);
    this.prediction = new PredictionPanel(this.refs.prediction);
    this.decision = new DecisionPanel(this.refs.decision, { onChange: () => (this.dirty = true) });
    this.traffic = new TrafficPanel(this.refs.traffic);
    this.lanes = new ComparisonLanes(this.refs.lanes);
    this.engineering = new EngineeringPanel(this.refs.engineering);
    this.glance = new GlancePanel(this.refs.glance, { onDetails: () => this.setMode('advanced') });
    this.tunnelPanel = new TunnelPanel(this.refs.tunnel);
    this.internals = new PredictionInternals(this.refs.internals);
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
      onBenchmark: () => this.openExperiments({ scenario: '__all__' }),
    });
    this.charts = {
      thr: new ThroughputChart(this.root.querySelector('[data-chart="thr"]')),
      rtt: new RTTChart(this.root.querySelector('[data-chart="rtt"]')),
      loss: new PacketLossChart(this.root.querySelector('[data-chart="loss"]')),
      qoe: new QoEChart(this.root.querySelector('[data-chart="qoe"]')),
      pwr: new PowerChart(this.root.querySelector('[data-chart="pwr"]')),
      hol: new HolChart(this.root.querySelector('[data-chart="hol"]')),
    };
    this.chartLegends = {};
    for (const key of Object.keys(this.charts)) {
      this.chartLegends[key] = {
        fp: this.root.querySelector(`[data-chart-fp="${key}"]`),
        lg: this.root.querySelector(`[data-chart-lg="${key}"]`),
      };
    }
    this.demo = new GuidedDemo(this);

    renderIcons(this.root);
    this._bindOverlay();
    this._bindPanelTabs();
    this._bindToolbar();
    this._bindKeyboard();
    this._subscribe();
    this.setMode(mode, { quiet: true });
    this._syncFromEngine();
  }

  renderIcons(root) {
    renderIcons(root);
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  _build() {
    const zones = ZONES.map((z) => {
      const w = ((z.x1 - z.x0) / ROUTE_END_X) * 100;
      return `<div class="relative" style="width:${w}%">
        <div class="mb-1 truncate pr-1 font-mono text-[8.5px] font-bold tracking-[0.12em]" style="color:${ink(z.color)}">Z${z.id} · ${z.name.toUpperCase()}</div>
        <div class="rounded-sm" style="height:6px;background:${z.color}"></div>
      </div>`;
    }).join('');
    const scenarioOptions = LIVE_SCENARIOS.map((id) => `<option value="${id}">${esc(id === 'mission' ? SCENARIOS[id].label : `${id} · ${SCENARIOS[id].label}`)}</option>`).join('');

    this.root.innerHTML = `
    <div class="fp-shell hud-scroll flex h-full flex-col overflow-y-auto" data-ref="shell" data-mode="mission">
      <header class="relative z-10 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-200 bg-white/90 px-4 py-1.5 backdrop-blur">
        <div class="flex min-w-0 shrink-0 items-center gap-3 max-sm:w-full max-sm:shrink">
          ${LOGO}
          <div class="min-w-0">
            <h1 class="font-display text-[12px] font-extrabold tracking-[0.12em] text-slate-900 sm:text-[14px] sm:tracking-[0.22em]">FLEXIPATH <span class="text-fp">CONNECTIVITY ENGINE</span></h1>
          </div>
        </div>
        <div class="flex min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden max-xl:order-last max-xl:basis-full max-xl:justify-start">
          <div class="state-pill min-w-0" data-ref="pill" aria-live="polite">
            <span class="dot shrink-0"></span><span class="shrink-0" data-ref="pillText">INITIALISING</span>
            <span class="truncate font-mono text-[10px] font-semibold tracking-[0.04em] opacity-75" data-ref="pillDetail"></span>
          </div>
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="chip sim-badge" title="Everything on this screen is produced by the FlexiPath simulation model (seeded, deterministic). No real-world measurements are shown."><span class="dot"></span>SIMULATION · v${VERSION}</span>
          <span class="chip border-fp/30!" data-view="advanced" title="Static anchor relay: FlexiPath tunnels every flow (userspace UDP) to this address, so remote services only ever see it and no socket is reset by a path change">
            <i data-lucide="lock" class="text-fp"></i>ANCHOR RELAY <b class="text-slate-900">${ANCHOR_IP}</b>
          </span>
          <span class="chip"><i data-lucide="timer"></i><span class="text-slate-900" data-ref="clock">T+00:00.0</span></span>
        </div>
      </header>

      <nav class="fp-toolbar flex shrink-0 flex-wrap items-center gap-2 px-2 pt-2" aria-label="Mission toolbar" data-ref="toolbar">
        <div class="seg p-[2px]!" role="group" aria-label="View">
          <button type="button" class="h-[26px]! px-3!" data-mode="mission" aria-pressed="true" title="Mission view (M)"><i data-lucide="layout-dashboard"></i>Mission</button>
          <button type="button" class="h-[26px]! px-3!" data-mode="advanced" aria-pressed="false" title="Advanced view (M)"><i data-lucide="sliders-horizontal"></i>Advanced</button>
        </div>
        <select class="toolbar-select" data-ref="scenario" aria-label="Scenario">${scenarioOptions}</select>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-icon btn-fault-sm" data-fault="wifi-fade" data-view="mission" title="Inject a rapid Wi-Fi fade (F)" aria-label="Inject a Wi-Fi fade"><i data-lucide="wifi-off"></i></button>
          <button type="button" class="btn btn-icon btn-fault-sm" data-fault="cell-outage" data-view="mission" title="Inject an abrupt 5G cell outage (G)" aria-label="Inject a 5G outage"><i data-lucide="tower-control"></i></button>
          <button type="button" class="btn btn-icon" data-ref="resetBtn" data-view="mission" title="Reset scenario, same seed (R)" aria-label="Reset the scenario"><i data-lucide="rotate-ccw"></i></button>
          <button type="button" class="btn" data-ref="chartsBtn" data-view="advanced" aria-pressed="false" title="Show or hide the six live charts"><i data-lucide="chart-line"></i>Charts</button>
          <button type="button" class="btn btn-demo" data-ref="demoBtn" title="Guided tour: the screen, a live flight, the Advanced view and the proof (D)"><i data-lucide="presentation"></i>Guided tour</button>
          <button type="button" class="btn btn-icon btn-primary" data-ref="expBtn" title="Paired experiments (X)" aria-label="Paired experiments"><i data-lucide="flask-conical"></i></button>
          <button type="button" class="btn btn-icon" data-ref="infoBtn" title="Why FlexiPath? (I)" aria-label="Why FlexiPath?"><i data-lucide="info"></i></button>
        </div>
      </nav>

      <section class="fp-loop hud-panel mx-2 mt-2 shrink-0 px-2 py-1.5" data-ref="loop" aria-label="Decision loop"></section>

      <div class="fp-main grid shrink-0 grid-cols-1 gap-2 p-2 xl:min-h-[500px] xl:flex-1" data-ref="mainGrid">
        <main class="viewport hud-panel relative order-first h-[62vh] min-h-[380px] overflow-hidden xl:order-none xl:h-auto" data-ref="viewport">
          <div class="absolute inset-0 isolate" data-ref="canvasHost"></div>
          <div class="viewport-vignette"></div>

          <div class="overlay-glass pointer-events-none absolute inset-x-3 top-3 px-3 pt-2 pb-2.5" data-ref="routeStrip">
            <div class="relative">
              <div class="flex">${zones}</div>
              <div class="absolute inset-x-0 bottom-0 h-[6px]" data-ref="shadowStrip"></div>
              <div class="zone-marker fp" data-ref="markFp" style="left:0%" title="FlexiPath drone"></div>
              <div class="zone-marker lg" data-ref="markLg" style="left:0%" title="Legacy drone"></div>
            </div>
          </div>

          <div class="fp-camctl absolute top-[62px] right-3 flex items-center gap-2" data-ref="camctl">
            <div class="seg overlay-glass" role="group" aria-label="Camera mode">
              <button type="button" class="px-2.5" data-cam="chase" aria-pressed="true"><i data-lucide="crosshair"></i>Chase</button>
              <button type="button" class="px-2.5" data-cam="cinematic" aria-pressed="false"><i data-lucide="video"></i>Cinematic</button>
              <button type="button" class="px-2.5" data-cam="overview" aria-pressed="false"><i data-lucide="map"></i>Overview</button>
            </div>
            <button type="button" class="btn overlay-glass h-[36px]!" data-ref="look" aria-label="Switch between the realistic and the neon digital-twin look (L)" title="Realistic night / neon digital twin (L)"></button>
            <button type="button" class="btn overlay-glass h-[36px]!" data-ref="theatre" aria-label="Theatre mode (T)" title="Theatre mode (T)"><i data-lucide="maximize-2"></i></button>
            <button type="button" class="btn overlay-glass h-[36px]!" data-ref="help" aria-label="Why FlexiPath, help and shortcuts" title="Why FlexiPath? · shortcuts (I)"><i data-lucide="circle-help"></i></button>
          </div>

          <div class="overlay-glass pointer-events-none absolute top-[62px] left-3 px-3 py-2" data-ref="kpi" hidden>
            <div class="hud-label">Simulated interruption (cumulative)</div>
            <div class="num mt-1.5 flex items-baseline gap-5">
              <span class="text-[10px] font-bold tracking-[0.16em] text-fp">FLEXIPATH <b class="text-[22px]" data-ref="kpiFp">0.00</b> s</span>
              <span class="text-[10px] font-bold tracking-[0.16em] text-legacy">LEGACY OS <b class="text-[22px]" data-ref="kpiLg">0.00</b> s</span>
            </div>
          </div>

          <div class="offscreen-chip" data-ref="offscreen" hidden aria-hidden="true"></div>

          <div class="intro-overlay" data-ref="intro" hidden>
            <div class="intro-card">
              <div class="hud-label">FLEXIPATH · SIMULATION PROTOTYPE</div>
              <h2 class="mt-3">Connectivity shouldn’t wait for failure.</h2>
              <p>Predict the degradation. Prepare the next path. Protect what matters. Continue without waiting for failure.</p>
              <p class="text-[12px]! text-slate-600!">A predictive, traffic-aware connectivity engine for heterogeneous networks, shown beside a legacy break-before-make stack under identical simulated conditions.</p>
              <div class="mt-5 flex flex-wrap justify-center gap-2">
                <button type="button" class="btn btn-demo h-[36px]! px-4!" data-intro="demo"><i data-lucide="presentation"></i>Start the guided tour</button>
                <button type="button" class="btn h-[36px]! px-4!" data-intro="explore"><i data-lucide="play"></i>Explore freely</button>
                <button type="button" class="btn h-[36px]! px-4!" data-intro="why"><i data-lucide="info"></i>Why FlexiPath?</button>
              </div>
            </div>
          </div>

          <div class="fp-legend overlay-glass pointer-events-none absolute bottom-3 left-3 hidden flex-col gap-1 px-2.5 py-2 md:flex" aria-label="Beam legend">
            ${[
              ['Wired', INTERFACE_SPECS.eth0.color],
              ['Wi-Fi 6', INTERFACE_SPECS.wlan0.color],
              ['5G SA', INTERFACE_SPECS.wwan0.color],
              ['LEO satellite', INTERFACE_SPECS.sat0.color],
              ['replication', '#A855F7'],
              ['warm probe / next path (dashed)', '#60A5FA'],
              ['failure', '#EF4444'],
            ]
              .map(([l, c]) => `<div class="flex items-center gap-2 font-mono text-[9.5px] text-slate-600"><span class="h-[3px] w-5 rounded-full" style="background:${c}"></span>${l}</div>`)
              .join('')}
          </div>

          <div class="overlay-glass absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 px-2 py-1.5" data-ref="playbar">
            <button type="button" class="btn btn-primary w-[34px] px-0!" data-ref="play" aria-label="Pause simulation"><i data-lucide="pause"></i></button>
            <div class="seg p-[2px]!" role="group" aria-label="Simulation rate">
              ${[0.5, 1, 2, 4].map((r) => `<button type="button" class="h-[24px]! px-2.5! font-mono" data-rate="${r}" aria-pressed="${r === 1}">${r}×</button>`).join('')}
            </div>
            <span class="num hidden px-1 text-[11px] text-slate-600 sm:inline" data-ref="simInfo">10 Hz</span>
            <button type="button" class="btn h-[26px]! w-[30px] justify-center px-0!" data-ref="legendBtn" aria-pressed="false" aria-label="Show the beam legend" title="Beam legend"><i data-lucide="list"></i></button>
          </div>
        </main>

        <aside class="fp-deck hud-scroll flex min-h-0 flex-col gap-2 xl:overflow-y-auto" aria-label="Panels" data-ref="deck">
          <div class="seg shrink-0 p-[2px]!" role="tablist" aria-label="Panels" data-view="advanced" data-ref="tabBar">
            ${PANEL_TABS.map(([id, label, title], i) => `<button type="button" role="tab" class="h-[26px]!" data-tab="${id}" aria-selected="${i === 0}" title="${title}">${label}</button>`).join('')}
          </div>
          <section class="hud-panel shrink-0" data-ref="decision" data-tab-panel="decision"></section>
          <section class="hud-panel shrink-0" data-ref="glance" data-view="mission"></section>
          <section class="hud-panel shrink-0" data-ref="prediction" data-view="advanced" data-tab-panel="prediction"></section>
          <section class="hud-panel shrink-0" data-ref="internals" data-view="advanced" data-tab-panel="prediction"></section>
          <section class="hud-panel shrink-0" data-ref="telemetry" data-view="advanced" data-tab-panel="links"></section>
          <section class="hud-panel shrink-0" data-ref="traffic" data-view="advanced" data-tab-panel="traffic"></section>
          <section class="hud-panel shrink-0" data-ref="flows" data-view="advanced" data-tab-panel="traffic"></section>
          <section class="hud-panel shrink-0" data-ref="engineering" data-view="advanced" data-tab-panel="session"></section>
          <section class="hud-panel shrink-0" data-ref="tunnel" data-view="advanced" data-tab-panel="session"></section>
          <section class="hud-panel shrink-0" data-ref="controls" data-view="advanced" data-tab-panel="controls"></section>
          <span class="chip shrink-0 self-start" data-ref="assets" data-view="advanced" data-tab-panel="controls" title="Where the 3D models came from"><i data-lucide="box"></i>MODELS · LOADING</span>
          <section class="hud-panel flex min-h-[230px] flex-1 flex-col" data-ref="log" data-view="advanced" data-tab-panel="log"></section>
        </aside>
      </div>

      <section class="fp-bottom hud-panel mx-2 mb-2 shrink-0" data-ref="lanes" data-view="mission" aria-label="Legacy vs FlexiPath"></section>
      <section class="fp-bottom grid shrink-0 grid-cols-1 gap-2 px-2 pb-2 sm:grid-cols-2 lg:grid-cols-3 xl:h-[164px] xl:grid-cols-6" aria-label="Real-time graphs" data-ref="chartsRow" data-view="advanced">
        ${chartCard('thr', 'Aggregated Throughput', 'Mbps')}
        ${chartCard('rtt', 'Critical-Flow Latency', 'ms · log')}
        ${chartCard('loss', 'Packet Loss', '% · crit + RT · 1 s')}
        ${chartCard('qoe', 'Voice QoE · MOS', 'ITU-T G.107')}
        ${chartCard('pwr', 'Radio Power', 'W · 3-tier')}
        ${chartCard('hol', 'Bulk HoL Stall', 'ms · TCP')}
      </section>
    </div>
    <div class="toast-stack" data-ref="toasts" aria-live="polite"></div>
    <div class="tour-layer" data-ref="tour"></div>
    <div class="modal-backdrop" hidden data-ref="modal" role="dialog" aria-modal="true">
      <div class="hud-panel hud-scroll max-h-[90vh] w-[min(900px,100%)] overflow-y-auto" data-ref="modalBody"></div>
    </div>`;

    this.refs = {};
    this.root.querySelectorAll('[data-ref]').forEach((n) => (this.refs[n.dataset.ref] = n));
    this.viewportEl = this.refs.canvasHost;
  }

  _bindPanelTabs() {
    this.tabButtons = [...this.refs.tabBar.querySelectorAll('[data-tab]')];
    for (const b of this.tabButtons) b.addEventListener('click', () => this.setPanelTab(b.dataset.tab));
    this.refs.chartsBtn.addEventListener('click', () => this.setCharts(!this.view.charts));
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(ADVANCED_KEY) ?? '{}') ?? {};
    } catch {}
    this.setPanelTab(saved.tab, { save: false });
    this.setCharts(saved.charts === true, { save: false });
  }

  /** Advanced view: show one group of panels in the side column. */
  setPanelTab(tab, { save = true } = {}) {
    if (!PANEL_TABS.some(([id]) => id === tab)) tab = PANEL_TABS[0][0];
    for (const b of this.tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const p of this.refs.deck.querySelectorAll('[data-tab-panel]')) p.classList.toggle('is-tab-off', p.dataset.tabPanel !== tab);
    this.refs.deck.scrollTop = 0;
    this.view.tab = tab;
    this.dirty = true;
    if (save) this._saveAdvanced();
  }

  /** Advanced view: the six live charts are shown on demand (they keep recording while hidden). */
  setCharts(on, { save = true } = {}) {
    this.view.charts = on;
    this.refs.shell.dataset.charts = on ? '1' : '0';
    this.refs.chartsBtn.setAttribute('aria-pressed', String(on));
    this._chartDirty = true;
    if (save) this._saveAdvanced();
  }

  _saveAdvanced() {
    try {
      localStorage.setItem(ADVANCED_KEY, JSON.stringify({ tab: this.view.tab, charts: this.view.charts }));
    } catch {}
  }

  _bindOverlay() {
    this.camButtons = [...this.root.querySelectorAll('[data-cam]')];
    for (const b of this.camButtons) b.addEventListener('click', () => this.setCamera(b.dataset.cam));
    this.rateButtons = [...this.root.querySelectorAll('[data-rate]')];
    for (const b of this.rateButtons) b.addEventListener('click', () => this.setRate(Number(b.dataset.rate)));
    this.refs.play.addEventListener('click', () => this.togglePause());
    this.refs.help.addEventListener('click', () => this.openInfo());
    this.refs.theatre.addEventListener('click', () => this.setTheatre(!this.view.theatre));
    this.refs.legendBtn.addEventListener('click', () => this.setLegend(this.refs.shell.dataset.legend !== '1'));
    this.refs.look.addEventListener('click', () => this.setLook(this.view.look === 'real' ? 'twin' : 'real'));
    this.refs.modal.addEventListener('click', (e) => {
      if (e.target === this.refs.modal) this.closeModal();
    });
    for (const b of this.root.querySelectorAll('[data-intro]')) {
      b.addEventListener('click', () => {
        const act = b.dataset.intro;
        if (act === 'demo') this.startDemo();
        else if (act === 'why') this.openInfo();
        else {
          this.hideIntro();
          this.togglePause(false);
        }
      });
    }
  }

  _bindToolbar() {
    this.modeButtons = [...this.root.querySelectorAll('[data-mode]')].filter((b) => b.tagName === 'BUTTON');
    for (const b of this.modeButtons) b.addEventListener('click', () => this.setMode(b.dataset.mode));
    this.refs.scenario.addEventListener('change', () => this.setScenario(this.refs.scenario.value));
    for (const b of this.refs.toolbar.querySelectorAll('[data-fault]')) b.addEventListener('click', () => this.injectFault(b.dataset.fault));
    this.refs.resetBtn.addEventListener('click', () => this.restart());
    this.refs.demoBtn.addEventListener('click', () => this.startDemo());
    this.refs.expBtn.addEventListener('click', () => this.openExperiments());
    this.refs.infoBtn.addEventListener('click', () => this.openInfo());
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        if (!this.refs.modal.hidden) return this.closeModal();
        if (this.demo.active) return this.demo.stop();
        return;
      }
      if (!this.refs.modal.hidden) return;
      if (this.demo.active && this.demo.onKey(key)) return e.preventDefault();
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
        l: () => this.setLook(this.view.look === 'real' ? 'twin' : 'real'),
        m: () => this.setMode(this.view.mode === 'mission' ? 'advanced' : 'mission'),
        d: () => this.startDemo(),
        x: () => this.openExperiments(),
        i: () => this.openInfo(),
        e: () => this.exportJSON(),
        '?': () => this.openInfo(),
        h: () => this.openInfo(),
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
    e.on('decision', (rec) => {
      this.decision.push(rec);
      this.dirty = true;
    });
    e.on('reset', () => this._syncFromEngine());
    e.on('complete', (summary) => {
      this.dirty = true;
      if (this.demo.active) return; // the guided demo shows its own experiment step
      setTimeout(() => {
        if (this.refs.modal.hidden) this.openSummary(summary);
      }, 900);
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
    this.decision.setRecords(e.decisions);
    this.prediction.reset();
    this.flows.setFlows(e.agents.flexipath.flows);
    this._syncScenario();
    this._onTick(e.snapshot);
    this._renderCharts(e.snapshot.t);
    this._updatePlay();
    this.dirty = true;
  }

  _syncScenario() {
    const sc = this.engine.scenario;
    const sel = this.refs.scenario;
    if (![...sel.options].some((o) => o.value === sc.id)) {
      const o = document.createElement('option');
      o.value = sc.id;
      o.textContent = `${sc.code} · ${sc.label}`;
      o.dataset.extra = '1';
      sel.append(o);
    }
    for (const o of [...sel.options]) if (o.dataset.extra && o.value !== sc.id) o.remove();
    sel.value = sc.id;
    sel.title = sc.description;
    this._renderShadows(sc);
  }

  /** Radio shadows on the route strip: hatched where links are really blocked, dashed where the coverage map says so. */
  _renderShadows(sc) {
    const pct = (x) => `${Math.min(100, Math.max(0, (x / ROUTE_END_X) * 100)).toFixed(2)}%`;
    const real = sc.shadows ?? [];
    const mapped = sc.mapShadows ?? real;
    const same = (a, b) => a.x0 === b.x0 && a.x1 === b.x1;
    const parts = [];
    for (const s of real) {
      const onMap = mapped.some((m) => same(m, s));
      parts.push(`<div class="shadow-zone" style="left:${pct(s.x0)};width:${pct(s.x1 - s.x0)}"></div>`);
      parts.push(`<div class="shadow-tag" style="left:${pct((s.x0 + s.x1) / 2)}">${onMap ? 'RADIO SHADOW · ON MAP' : 'RADIO SHADOW · NOT ON MAP'}</div>`);
    }
    for (const m of mapped) {
      const e = m.edge ?? 1;
      parts.push(`<div class="map-zone" style="left:${pct(m.x0 - e)};width:${pct(m.x1 - m.x0 + 2 * e)}"></div>`);
      if (!real.some((s) => same(m, s))) parts.push(`<div class="shadow-tag is-stale" style="left:${pct((m.x0 + m.x1) / 2)}">ON MAP · NO LONGER THERE</div>`);
    }
    this.refs.shadowStrip.innerHTML = parts.join('');
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
    this.prediction.sample(snap);
    this._trackBand(this.replBands, snap.agents.flexipath.decision?.replicationActive, snap.t, SERIES_COLORS.replication, 'rgba(124,58,237,0.55)');
    this._trackBand(this.stallBands, snap.agents.legacy.decision?.stalled, snap.t, SERIES_COLORS.stall, 'rgba(225,29,72,0.6)');
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
    const chartsVisible = this.view.mode === 'advanced' && !this.view.theatre && this.view.charts;
    if (chartsVisible && this._chartDirty && now - this._lastChart > 180) {
      this._lastChart = now;
      this._renderCharts(snap.t);
    }
  }

  _updatePanels(snap) {
    const focus = this.view.focus;
    const agent = snap.agents[focus];
    this.loop.update(snap);
    this._updateHeader(snap);
    this.decision.update(snap);
    if (this.view.mode === 'mission') {
      this.glance.update(snap);
      this.lanes.update(snap);
    } else {
      this.prediction.update(snap);
      this.traffic.update(snap);
      this.engineering.update(snap);
      this.telemetry.update(agent, focus);
      this.internals.update(snap);
      this.flows.update(agent, focus);
      this.tunnelPanel.update(snap);
      this.controls.update(snap);
      this._updateChartLegends(snap);
    }
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
  }

  _updateChartLegends(snap) {
    const na = (f) => (v) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : f(v));
    const fmt = {
      thr: na((v) => `${v.toFixed(0)}`),
      rtt: na((v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v.toFixed(0)}ms`)),
      loss: na((v) => `${v.toFixed(1)}%`),
      qoe: na((v) => v.toFixed(2)),
      pwr: na((v) => `${v.toFixed(1)}W`),
      hol: na((v) => `${v.toFixed(0)}ms`),
    };
    const m = { fp: snap.agents.flexipath.metrics, lg: snap.agents.legacy.metrics };
    const pick = { thr: 'throughputMbps', rtt: 'latencyMs', loss: 'lossPct', qoe: 'mos', pwr: 'powerW', hol: 'bulkHolMs' };
    for (const [key, legend] of Object.entries(this.chartLegends)) {
      legend.fp.textContent = `FP ${fmt[key](m.fp[pick[key]])}`;
      legend.lg.textContent = `LG ${fmt[key](m.lg[pick[key]])}`;
    }
  }

  _pillFor(agent, engine, t) {
    const d = agent.decision;
    if (engine === 'legacy') {
      if (d.stalled && d.stall) {
        return { text: 'SIMULATED INTERRUPTION · TCP RESET', detail: `${d.stall.remaining.toFixed(1)} s left`, color: '#DC2626', pulse: true };
      }
      const st = agent.trace.stage;
      if (st === 'FAILED') return { text: 'LEGACY OS · ON A FAILED LINK', detail: `route ${d.primary ?? '—'} · waiting for floor`, color: '#DC2626', pulse: true };
      if (st === 'DEGRADING') return { text: 'LEGACY OS · LINK DEGRADING', detail: `route ${d.primary ?? '—'} · no prediction`, color: '#B45309', pulse: false };
      return { text: 'LEGACY OS · BREAK-BEFORE-MAKE', detail: `route ${d.primary ?? '—'}`, color: '#E11D48', pulse: false };
    }
    if (!d.primary) return { text: 'NO USABLE PATH', detail: 'buffering at anchor', color: '#DC2626', pulse: true };
    if (d.replicationActive) {
      return { text: 'PREDICTIVE REPLICATION ACTIVE', detail: `${d.primary} ⇉ ${d.replica} · burst ${agent.power?.watts?.toFixed(1) ?? ''} W`, color: '#7C3AED', pulse: true };
    }
    if (d.protecting) return { text: 'PROTECTION WINDOW', detail: `bulk paced ${d.primary} → ${d.replica}`, color: '#2563EB', pulse: true };
    const ls = d.lastSwitch;
    if (ls && t - ls.t < 2.5) {
      return ls.seamless
        ? { text: 'SWITCHED · 0 MS GAP', detail: `${ls.from} → ${ls.to} · sessions kept`, color: '#15803D', pulse: false }
        : { text: 'UNPLANNED FAILOVER', detail: `${ls.from} → ${ls.to} · ${ls.blackoutMs} ms`, color: '#C2410C', pulse: true };
    }
    if (d.watching) {
      const next = d.prepared ?? d.warmTarget;
      return {
        text: 'DEGRADATION PREDICTED',
        detail: `${d.primary}${next ? ` · next ${next} ${d.prepared ? 'validated' : 'waking'} · ${agent.power?.watts?.toFixed(1) ?? ''} W` : ' · searching'}`,
        color: '#B45309',
        pulse: false,
      };
    }
    const warm = d.warmTarget && (d.radio?.[d.warmTarget] === 'WARM' || d.radio?.[d.warmTarget] === 'WAKING') ? d.warmTarget : null;
    if (warm) return { text: 'MONITORING · WARM PROBE', detail: `primary ${d.primary} · ${warm} awake · ${agent.power?.watts?.toFixed(1) ?? ''} W`, color: '#2563EB', pulse: false };
    return { text: 'MONITORING · DRX STANDBY', detail: `primary ${d.primary} · others asleep · ${agent.power?.watts?.toFixed(1) ?? ''} W`, color: '#0891B2', pulse: false };
  }

  _updateHeader(snap) {
    const focus = this.view.focus;
    const pill = this._pillFor(snap.agents[focus], focus, snap.t);
    const key = `${pill.text}|${pill.detail}`;
    if (this._pillKey !== key) {
      this._pillKey = key;
      this.refs.pillText.textContent = pill.text;
      this.refs.pillDetail.textContent = pill.detail;
      this.refs.pill.style.setProperty('--pill-c', pill.color);
      this.refs.pill.classList.toggle('is-pulsing', pill.pulse);
    }
    this.refs.clock.textContent = fmtClock(snap.t);
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  setMode(mode, { quiet = false } = {}) {
    this.view.mode = mode === 'advanced' ? 'advanced' : 'mission';
    this.refs.shell.dataset.mode = this.view.mode;
    for (const b of this.modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === this.view.mode));
    this.decision.setCompact(this.view.mode === 'mission');
    this.dirty = true;
    this._chartDirty = true;
    if (!quiet) this.toast(this.view.mode === 'mission' ? 'Mission view · the decision story' : 'Advanced view · every panel, charts and log');
  }

  setFocus(id, { quiet = false } = {}) {
    this.view.focus = id;
    this.controls.setEngine(id);
    this.dirty = true;
    if (!quiet) this.toast(id === 'legacy' ? 'Focus: Legacy OS (break-before-make)' : 'Focus: FlexiPath (predict · prepare · protect)');
  }

  setGhost(on) {
    this.view.showGhost = on;
    this.controls.setGhost(on);
    this.dirty = true;
  }

  /** Theatre mode: hide decks, toolbar and bottom row so the 3D twin fills the screen (demos / video capture). */
  setTheatre(on) {
    this.view.theatre = on;
    this.refs.shell.dataset.theatre = on ? '1' : '0';
    this.refs.kpi.hidden = !on;
    this.refs.theatre.innerHTML = `<i data-lucide="${on ? 'minimize-2' : 'maximize-2'}"></i>`;
    renderIcons(this.refs.theatre);
    this.dirty = true;
    if (!on) this._chartDirty = true;
  }

  /** World look: 'real' (night city and desert) or 'twin' (the neon digital twin). The network layer is the same in both. */
  setLook(look, { quiet = false } = {}) {
    this.view.look = look;
    const real = look === 'real';
    this.refs.look.innerHTML = `<i data-lucide="${real ? 'building-2' : 'box'}"></i>${real ? 'Real' : 'Twin'}`;
    renderIcons(this.refs.look);
    this.hooks.onLook?.(look);
    if (!quiet) this.toast(real ? 'Look: realistic night · L for the neon twin' : 'Look: neon digital twin · L for the realistic night');
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
    this.demo.onUserPause(paused);
  }

  /** The beam legend in the twin's corner (the list button in the playback bar). */
  setLegend(on) {
    this.refs.shell.dataset.legend = on ? '1' : '0';
    this.refs.legendBtn.setAttribute('aria-pressed', String(on));
  }

  _updatePlay() {
    const paused = this.engine.paused;
    this.refs.play.innerHTML = `<i data-lucide="${paused ? 'play' : 'pause'}"></i>`;
    this.refs.play.setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
    renderIcons(this.refs.play);
  }

  restart(overrides = {}, { quiet = false } = {}) {
    this.closeModal();
    this.hooks.onBeforeReset?.();
    this.engine.reset(overrides);
    this.engine.setPaused(false);
    this._updatePlay();
    if (!quiet) this.toast(`Scenario ${this.engine.scenario.code} · ${this.engine.scenario.label} · seed ${this.engine.config.seed}`);
  }

  setScenario(id) {
    if (this.demo.active) this.demo.stop();
    this.hideIntro();
    this.restart({ scenario: id });
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
    downloadText(timestampedName('flexipath_run', 'json', this.engine.config.seed), toJSON(data), 'application/json');
    this.toast(`Exported JSON · ${data.timeseries.length} samples · ${data.decisions.length} decisions`);
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

  /**
   * Edge marker for the comparison drone when the camera cannot see it.
   * @param {{visible:boolean, x?:number, y?:number, angle?:number, text?:string, legacy?:boolean}} info
   *   x / y in viewport pixels, angle = direction towards the drone (radians, screen space)
   */
  updateOffscreen(info) {
    const el = this.refs.offscreen;
    if (!info.visible) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    if (el.hidden) el.hidden = false;
    const html = `<span class="arr" style="transform:rotate(${info.angle.toFixed(2)}rad)">➤</span>${esc(info.text)}`;
    if (this._offHtml !== html) {
      this._offHtml = html;
      el.innerHTML = html;
      el.classList.toggle('is-fp', !info.legacy);
    }
    const host = this.refs.viewport;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = Math.min(host.clientWidth - w / 2 - 10, Math.max(w / 2 + 10, info.x));
    const y = Math.min(host.clientHeight - h / 2 - 54, Math.max(h / 2 + 64, info.y));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  // ── Intro and guided tour ────────────────────────────────────────────────
  showIntro() {
    this.refs.intro.hidden = false;
    this.engine.setPaused(true);
    this._updatePlay();
  }

  hideIntro() {
    this.refs.intro.hidden = true;
  }

  /** The guided tour (GuidedDemo.js): onboarding, the live flight, the Advanced view and the proof. */
  startDemo() {
    this.demo.start();
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
    return `<div class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 pt-4 pb-3">
      <div><h2 class="hud-title text-[11px]! text-slate-800!">${title}</h2>${sub ? `<p class="mt-1.5 font-mono text-[10.5px] text-slate-500">${sub}</p>` : ''}</div>
      <button type="button" class="btn w-[30px] px-0!" data-close aria-label="Close"><i data-lucide="x"></i></button>
    </div>`;
  }

  openSummary(summary) {
    const fp = summary.flexipath;
    const lg = summary.legacy;
    const sc = summary.meta.scenario;
    const rows = [
      ['Fail-safe hovers (C2 silent > 300 ms)', 'failSafeStops', '', 0],
      ['Simulated interruption (total)', 'interruptionS', 's', 2],
      ['Longest single interruption', 'longestInterruptionS', 's', 2],
      ['Packet delivery (critical + real-time)', 'packetDeliveryPct', '%', 2],
      ['Critical packet delivery', 'criticalDeliveryPct', '%', 2],
      ['Critical packets lost', 'criticalLost', '', 0],
      ['Mean throughput', 'meanThroughputMbps', 'Mbps', 1],
      ['Mean critical-flow RTT', 'meanLatencyMs', 'ms', 1],
      ['Voice QoE · mean MOS (G.107)', 'meanMos', '', 2],
      ['Time below MOS 3.6', 'timeBelowMos36S', 's', 1],
      ['Replication overhead · protected-flow bytes', 'replicationOverheadPct', '%', 2],
      ['Replication overhead · all traffic bytes', 'replicationOverheadTotalPct', '%', 3],
      ['Action time vs. path failure (mean)', 'actionVsFailureS', 's', 2],
      ['Path failures acted on before failing', null, '', 0],
      ['TCP connection resets', 'tcpResets', '', 0],
      ['Journey time', 'journeyTimeS', 's', 1],
    ];
    const f = (v, d, u) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(d).replace('-', '−')}${u ? ` ${u}` : ''}` : '—');
    const body = rows
      .map(([label, key, u, d]) => {
        if (!key) {
          return `<tr><td>${label}</td><td>${lg.predictedFailures}/${lg.pathFailures}</td><td>${fp.predictedFailures}/${fp.pathFailures}</td><td>—</td></tr>`;
        }
        const a = lg[key];
        const b = fp[key];
        const diff = typeof a === 'number' && typeof b === 'number' ? b - a : null;
        const ds = diff === null ? '—' : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff).toFixed(d)}${u ? ` ${u}` : ''}`;
        return `<tr><td>${label}</td><td>${f(a, d, u)}</td><td>${f(b, d, u)}</td><td class="font-semibold">${ds}</td></tr>`;
      })
      .join('');
    // The outcome in words (C2 kept or not), then the costs of acting early next to the wins.
    const times = (n) => `${n} time${n === 1 ? '' : 's'}`;
    const outcome =
      fp.c2KeptPct === null
        ? ''
        : `<p class="mb-3 text-[13px] font-semibold text-slate-800">${
            fp.failSafeStops === 0 ? 'FlexiPath kept the C2 link the whole flight.' : `FlexiPath lost the C2 link long enough to hover ${times(fp.failSafeStops)}.`
          } ${lg.failSafeStops === 0 ? 'The legacy drone kept it too.' : `The legacy drone lost it ${times(lg.failSafeStops)} and had to hover.`}</p>`;
    const cost = `
        <div class="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
          <b class="text-slate-800">What acting early cost.</b>
          Mean radio power ${f(fp.meanPowerW, 2, 'W')} vs ${f(lg.meanPowerW, 2, 'W')} (warm probe ${f(fp.warmTimeS, 1, 's')}, dual-radio burst ${f(fp.burstTimeS, 1, 's')}) ·
          path changes ${fp.seamlessHandovers + fp.unplannedFailovers} vs ${lg.breakBeforeMakeHandovers} ·
          duplicate bytes ${f(fp.replicationOverheadPct, 1, '%')} of protected traffic · mean throughput ${f(fp.meanThroughputMbps, 1, 'Mbps')} vs ${f(lg.meanThroughputMbps, 1, 'Mbps')}.
        </div>`;
    const html = `
      ${this._modalHeader(`Run complete · ${esc(sc.code)} · ${esc(sc.label)}`, `seed ${summary.meta.seed} · ${summary.meta.speedKmh} km/h · ${summary.meta.simTimeS} s simulated · ${summary.faults.length} fault(s) · one paired run`)}
      <div class="px-5 py-4">
        ${outcome}
        <div class="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">${tag('measured')}<span>One simulated run, both stacks on identical conditions. A single run is an example; use paired trials for evidence.</span></div>
        <div class="hud-scroll overflow-x-auto">
          <table class="exp-table">
            <thead><tr><th>Metric</th><th class="text-legacy!">Legacy</th><th class="text-fp!">FlexiPath</th><th>Difference (FP − LG)</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        ${cost}
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" class="btn" data-act="json"><i data-lucide="file-json"></i>Export JSON</button>
          <button type="button" class="btn" data-act="csv"><i data-lucide="file-spreadsheet"></i>Export CSV</button>
          <button type="button" class="btn" data-act="replay"><i data-lucide="repeat"></i>Replay seed ${summary.meta.seed}</button>
          <button type="button" class="btn btn-primary" data-act="trials"><i data-lucide="flask-conical"></i>Run 10 paired trials of this scenario</button>
        </div>
      </div>`;
    this.openModal(html);
    const b = this.refs.modalBody;
    b.querySelector('[data-act="json"]').addEventListener('click', () => this.exportJSON());
    b.querySelector('[data-act="csv"]').addEventListener('click', () => this.exportCSV());
    b.querySelector('[data-act="replay"]').addEventListener('click', () => this.restart());
    b.querySelector('[data-act="trials"]').addEventListener('click', () =>
      this.openExperiments({ scenario: sc.id === 'demo' ? 'A' : sc.id, trials: 10, autoRun: true }),
    );
  }

  openInfo() {
    this.openModal(`${this._modalHeader('Why FlexiPath?', 'What makes it different · how the loop decides · what the numbers are')}${infoHTML()}`);
  }

  openExperiments(opts = {}) {
    const sc = this.engine.scenario.id;
    const scenario = opts.scenario ?? (SCENARIOS[sc]?.hidden ? 'A' : sc);
    openExperiments(this, { ...opts, scenario });
  }
}
