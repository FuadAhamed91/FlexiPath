/**
 * SimulationEngine.js — 10 Hz master clock and state coordinator.
 *
 * Runs two agents over the same seeded RF environment:
 *   • flexipath — FlexiPathController (predictive replication, hot-swap)
 *   • legacy    — LegacyController   (hard-threshold break-before-make)
 *
 * The engine is renderer-agnostic: the 3D layer and HUD subscribe to events
 * ('tick', 'event', 'reset', 'complete') and read interpolated render state.
 * Identical seeds reproduce identical runs (all randomness comes from forked
 * Mulberry32 streams).
 */
import { Random, normalizeSeed } from '../utils/Random.js';
import { RunningStats, round } from '../utils/Metrics.js';
import { RoutePath, MobilityModel, ANTENNA_HEIGHT, METERS_PER_UNIT, ROUTE_END_X } from './MobilityModel.js';
import { NetworkEnvironment, zoneAt, ZONES, NODE_LAYOUT, RF, FAULTS } from './NetworkEnvironment.js';
import { LinkModel, INTERFACE_IDS, INTERFACE_SPECS } from './LinkModel.js';
import { TrafficManager, FLOW_DEFS } from './TrafficManager.js';
import { FlexiPathController } from './FlexiPathController.js';
import { LegacyController } from './LegacyController.js';
import { QoEModel } from './QoEModel.js';

export const VERSION = '1.0.0';
export const TICK_HZ = 10;
export const DT = 1 / TICK_HZ;
export const ANCHOR_IP = '198.51.100.24';
export const FAILSAFE_OUTAGE_S = 0.3; // teleop policy: brake if critical telemetry is silent > 300 ms
export const MOS_THRESHOLD = 3.6;

export const ENGINES = {
  flexipath: { id: 'flexipath', label: 'FlexiPath', short: 'FP', laneOffset: 3.2, color: '#00F0FF' },
  legacy: { id: 'legacy', label: 'Legacy OS', short: 'LG', laneOffset: -3.2, color: '#F43F5E' },
};

export const DEFAULT_CONFIG = {
  seed: 2026,
  speedKmh: 60,
  failSafe: true,
  simRate: 1,
  recordHistory: true,
  maxHistory: 36000,
  maxEvents: 5000,
  maxSimSeconds: Infinity, // the batch runner passes a finite cap
};

export class SimulationEngine {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.listeners = new Map();
    this.path = new RoutePath();
    this.paused = false;
    this.reset();
  }

  // ── Event emitter ───────────────────────────────────────────────────────
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────
  reset(overrides = {}) {
    Object.assign(this.config, overrides);
    this.config.seed = normalizeSeed(this.config.seed);
    const root = new Random(this.config.seed);
    this.env = new NetworkEnvironment({ rng: root.fork('environment') });
    this.tick = 0;
    this.t = 0;
    this.accumulator = 0;
    this.alpha = 0;
    this.completed = false;
    this.summary = null;
    this.events = [];
    this.history = [];
    this.faultLog = [];
    this.agents = {};
    for (const id of Object.keys(ENGINES)) this.agents[id] = this._createAgent(id, root);
    this.snapshot = this._capture();

    // Prime tick 0 silently so every consumer starts from a fully populated snapshot.
    this._silent = true;
    this._log({
      engine: 'sys',
      level: 'info',
      code: 'ARMED',
      message: `Scenario armed · seed ${this.config.seed} · ${this.config.speedKmh} km/h · anchor IP ${ANCHOR_IP}`,
    });
    this.step();
    this._silent = false;
    this.prevSnapshot = this.snapshot;
    this.emit('reset', { seed: this.config.seed, config: { ...this.config } });
    return this;
  }

  _createAgent(id, root) {
    const meta = ENGINES[id];
    const rng = root.fork(`agent:${id}`);
    const mobility = new MobilityModel({ path: this.path, laneOffset: meta.laneOffset });
    mobility.setTargetSpeedKmh(this.config.speedKmh);
    const links = {};
    for (const lid of INTERFACE_IDS) links[lid] = new LinkModel(INTERFACE_SPECS[lid], rng.fork(`link:${lid}`));
    const controller = id === 'flexipath' ? new FlexiPathController({ dt: DT }) : new LegacyController({ dt: DT });
    return {
      id,
      meta,
      mobility,
      links,
      controller,
      traffic: new TrafficManager({ rng: rng.fork('traffic') }),
      qoe: new QoEModel(),
      linkStates: null,
      decision: null,
      trafficResult: null,
      qoeResult: { r: 93.2, mos: QoEModel.rToMos(93.2), mosInstant: QoEModel.rToMos(93.2) },
      latencyMs: 0,
      criticalOutage: 0,
      lastDeliveryT: 0,
      lastLatency: INTERFACE_SPECS.eth0.baseRtt,
      zoneId: zoneAt(mobility.state.cx).id,
      replLostMark: 0,
      stats: {
        stallTime: 0,
        stallEvents: 0,
        seamlessHandovers: 0,
        breakHandovers: 0,
        unplannedFailovers: 0,
        replicationTime: 0,
        tcpResets: 0,
        timeBelowMos: 0,
        mos: new RunningStats(),
        latency: new RunningStats(),
        throughput: new RunningStats(),
      },
    };
  }

  setPaused(paused) {
    this.paused = !!paused;
  }

  setSimRate(rate) {
    this.config.simRate = Math.max(0.25, Math.min(8, rate));
  }

  setSpeedKmh(kmh, { log = false } = {}) {
    this.config.speedKmh = kmh;
    for (const a of Object.values(this.agents)) a.mobility.setTargetSpeedKmh(kmh);
    if (log) this._log({ engine: 'sys', level: 'info', code: 'SPEED', message: `Target speed set to ${Math.round(kmh)} km/h` });
  }

  setFailSafe(on) {
    this.config.failSafe = !!on;
    this._log({
      engine: 'sys',
      level: 'info',
      code: 'POLICY',
      message: `Fail-safe braking on critical-link loss ${on ? 'ENABLED' : 'DISABLED'}`,
    });
  }

  injectFault(type) {
    const f = this.env.injectFault(type, this.t);
    const fp = this.agents.flexipath.mobility.state;
    this.faultLog.push({ t: round(this.t, 2), type, xFlexiPath: round(fp.cx, 2) });
    const detail =
      type === 'wifi-fade'
        ? `−${f.depthDb} dB over ${f.rampUp} s, hold ${f.hold} s`
        : `cell offline for ${f.duration} s (abrupt)`;
    this._log({ engine: 'env', level: 'crit', code: 'FAULT', message: `FAULT INJECTED · ${FAULTS[type].label} · ${detail}` });
    return f;
  }

  // ── Clock ───────────────────────────────────────────────────────────────
  /** Advance by wall-clock seconds; runs fixed 100 ms ticks; returns interpolation alpha. */
  advance(realDt) {
    if (this.paused || this.completed) return this.alpha;
    this.accumulator += realDt * this.config.simRate;
    let steps = 0;
    const maxSteps = 40;
    while (this.accumulator >= DT && steps < maxSteps && !this.completed) {
      this.step();
      this.accumulator -= DT;
      steps++;
    }
    if (steps === maxSteps) this.accumulator = 0;
    this.alpha = this.completed ? 1 : Math.min(1, this.accumulator / DT);
    return this.alpha;
  }

  step() {
    if (this.completed) return this.snapshot;
    const t = this.tick * DT;
    this.env.update(t);
    const tickEvents = [];
    for (const agent of Object.values(this.agents)) this._stepAgent(agent, t, tickEvents);

    this.tick++;
    this.t = this.tick * DT;
    this.prevSnapshot = this.snapshot;
    this.snapshot = this._capture();
    if (this.config.recordHistory) this._record();
    for (const e of tickEvents) this._log(e);

    const allDone = Object.values(this.agents).every((a) => a.mobility.finished);
    if (allDone || this.t >= this.config.maxSimSeconds) {
      this.completed = true;
      this.snapshot.completed = true;
      this.summary = this.getSummary();
      this._log({
        engine: 'sys',
        level: 'ok',
        code: 'COMPLETE',
        message: `Run complete · FlexiPath stall ${this.summary.flexipath.stallTimeS.toFixed(2)} s vs Legacy ${this.summary.legacy.stallTimeS.toFixed(2)} s`,
      });
      if (!this._silent) this.emit('complete', this.summary);
    }
    if (!this._silent) this.emit('tick', this.snapshot);
    return this.snapshot;
  }

  _context(mob) {
    const docked = mob.cx < RF.dock.releaseX;
    const dockRelease = docked && mob.speedMps > 0.15;
    const dockTtf = dockRelease
      ? Math.max(0, ((RF.dock.releaseX - mob.cx) * METERS_PER_UNIT) / Math.max(0.1, mob.speedMps))
      : Infinity;
    return { x: mob.cx, speedMps: mob.speedMps, docked, dockRelease, dockTtf };
  }

  _stepAgent(agent, t, events) {
    const { mobility } = agent;
    mobility.setFailSafe(this.config.failSafe && agent.criticalOutage > FAILSAFE_OUTAGE_S);
    const wasFailSafe = agent.failSafeActive;
    const mob = mobility.update(DT, t);
    agent.failSafeActive = mob.failSafe;
    if (mob.failSafe && !wasFailSafe) {
      events.push({
        t,
        engine: agent.id,
        level: 'crit',
        code: 'FAILSAFE',
        message: `Critical telemetry silent > ${FAILSAFE_OUTAGE_S * 1000} ms → minimal-risk manoeuvre (braking)`,
      });
    }

    const pos = { x: mob.cx, y: ANTENNA_HEIGHT, z: mob.cz };
    const linkStates = {};
    for (const id of INTERFACE_IDS) linkStates[id] = agent.links[id].sample(this.env.signal(id, pos, mob), t);

    const decision = agent.controller.update({ t, links: linkStates, ctx: this._context(mob) });
    const traffic = agent.traffic.step(decision, linkStates, DT);
    const qoe = agent.qoe.update(traffic.voice);

    const delivered = traffic.critical.delivered > 0;
    if (delivered) {
      agent.criticalOutage = 0;
      agent.lastDeliveryT = t + DT;
      agent.lastLatency = traffic.critical.rttMs;
      agent.latencyMs = traffic.critical.rttMs;
    } else if (traffic.critical.sent > 0) {
      agent.criticalOutage += DT;
      // Application-visible latency grows while packets queue behind a dead socket.
      agent.latencyMs = agent.lastLatency + (t + DT - agent.lastDeliveryT) * 1000;
    }

    const S = agent.stats;
    const wasStalled = agent.decision?.stalled;
    if (decision.stalled) {
      S.stallTime += DT;
      if (!wasStalled) S.stallEvents++;
    }
    if (decision.blackoutMs) {
      S.stallTime += decision.blackoutMs / 1000;
      S.stallEvents++;
    }
    if (decision.replicationActive) S.replicationTime += DT;
    S.mos.push(qoe.mos);
    if (qoe.mos < MOS_THRESHOLD) S.timeBelowMos += DT;
    if (delivered) S.latency.push(traffic.critical.rttMs);
    S.throughput.push(traffic.throughputMbps);

    for (const e of decision.events) {
      const ev = { t, engine: agent.id, ...e };
      if (e.code === 'REPL_ON') agent.replLostMark = agent.traffic.totals.criticalLost;
      if (e.code === 'HOT_SWAP') {
        S.seamlessHandovers++;
        const lost = agent.traffic.totals.criticalLost - agent.replLostMark;
        ev.message += ` · ${lost} critical pkt${lost === 1 ? '' : 's'} lost`;
        agent.replLostMark = agent.traffic.totals.criticalLost;
      }
      if (e.code === 'FAILOVER') S.unplannedFailovers++;
      if (e.code === 'RECONNECTED') S.breakHandovers++;
      if (e.code === 'TCP_RST') S.tcpResets += agent.controller.p.socketsReset ?? 0;
      events.push(ev);
    }

    const zone = zoneAt(mob.cx);
    if (zone.id !== agent.zoneId) {
      agent.zoneId = zone.id;
      if (agent.id === 'flexipath') {
        events.push({ t, engine: 'env', level: 'info', code: 'ZONE', message: `Zone ${zone.id} · ${zone.name} — ${zone.blurb}` });
      }
    }

    agent.linkStates = linkStates;
    agent.decision = decision;
    agent.trafficResult = traffic;
    agent.qoeResult = qoe;
  }

  // ── Snapshots ───────────────────────────────────────────────────────────
  _captureAgent(agent) {
    const mob = agent.mobility.state;
    const tr = agent.trafficResult;
    const T = agent.traffic.totals;
    const S = agent.stats;
    return {
      id: agent.id,
      label: agent.meta.label,
      color: agent.meta.color,
      vehicle: { ...mob, zone: zoneAt(mob.cx).id },
      links: agent.linkStates,
      decision: agent.decision,
      traffic: tr,
      qoe: agent.qoeResult,
      metrics: {
        throughputMbps: tr ? tr.throughputMbps : 0,
        latencyMs: agent.latencyMs,
        lossPct: tr ? tr.critical.windowLossRate * 100 : 0,
        mos: agent.qoeResult.mos,
      },
      stats: {
        stallTime: S.stallTime,
        stallEvents: S.stallEvents,
        seamlessHandovers: S.seamlessHandovers,
        breakHandovers: S.breakHandovers,
        unplannedFailovers: S.unplannedFailovers,
        replicationTime: S.replicationTime,
        tcpResets: S.tcpResets,
        criticalSent: T.criticalSent,
        criticalLost: T.criticalLost,
        duplicatesDiscarded: T.duplicatesDiscarded,
        duplicateBytes: T.duplicateBytes,
        meanMos: S.mos.count ? S.mos.mean : agent.qoeResult.mos,
        timeBelowMos: S.timeBelowMos,
      },
    };
  }

  _capture() {
    return {
      t: this.t,
      tick: this.tick,
      completed: this.completed,
      env: this.env.state,
      agents: {
        flexipath: this._captureAgent(this.agents.flexipath),
        legacy: this._captureAgent(this.agents.legacy),
      },
    };
  }

  _record() {
    const row = { t: round(this.t, 2) };
    for (const [key, id] of [
      ['fp', 'flexipath'],
      ['lg', 'legacy'],
    ]) {
      const a = this.snapshot.agents[id];
      const L = a.links;
      row[key] = {
        x: round(a.vehicle.cx, 2),
        kmh: round(a.vehicle.speedKmh, 1),
        zone: a.vehicle.zone,
        thr: round(a.metrics.throughputMbps, 2),
        lat: round(a.metrics.latencyMs, 2),
        loss: round(a.metrics.lossPct, 2),
        mos: round(a.metrics.mos, 3),
        primary: a.decision?.primary ?? '',
        replica: a.decision?.replica ?? '',
        state: a.decision?.state ?? '',
        repl: a.decision?.replicationActive ? 1 : 0,
        stalled: a.decision?.stalled ? 1 : 0,
        rssi: L.wlan0.up ? round(L.wlan0.signal, 1) : null,
        rsrp: L.wwan0.up ? round(L.wwan0.signal, 1) : null,
        satSnr: L.sat0.up ? round(L.sat0.signal, 1) : null,
        stallTime: round(a.stats.stallTime, 2),
      };
    }
    this.history.push(row);
    if (this.history.length > this.config.maxHistory) this.history.shift();
  }

  _log(e) {
    const ev = { t: e.t ?? this.t, ...e };
    this.events.push(ev);
    if (this.events.length > this.config.maxEvents) this.events.shift();
    if (!this._silent) this.emit('event', ev);
  }

  /** Interpolated state for 60 fps rendering between 10 Hz ticks. */
  getRenderState(alpha = this.alpha) {
    const cur = this.snapshot;
    const prev = this.prevSnapshot ?? cur;
    const vehicles = {};
    for (const id of Object.keys(ENGINES)) {
      const a = prev.agents[id].vehicle;
      const b = cur.agents[id].vehicle;
      const s = a.s + (b.s - a.s) * alpha;
      const frame = this.path.frameAt(s, ENGINES[id].laneOffset);
      vehicles[id] = { ...frame, s, speedKmh: a.speedKmh + (b.speedKmh - a.speedKmh) * alpha };
    }
    const satellites = cur.env.satellites.map((sb, i) => {
      const sa = prev.env.satellites[i] ?? sb;
      const jump = Math.abs(sb.x - sa.x) > 50;
      return { ...sb, x: jump ? sb.x : sa.x + (sb.x - sa.x) * alpha };
    });
    return { t: prev.t + (cur.t - prev.t) * alpha, alpha, vehicles, satellites, snapshot: cur };
  }

  // ── Results ─────────────────────────────────────────────────────────────
  _summarizeAgent(agent) {
    const S = agent.stats;
    const T = agent.traffic.totals;
    const mob = agent.mobility.state;
    return {
      engine: agent.id,
      finished: mob.finished,
      journeyTimeS: mob.finishTime !== null ? round(mob.finishTime, 2) : null,
      distanceM: round(mob.distanceM, 1),
      stallTimeS: round(S.stallTime, 3),
      stallEvents: S.stallEvents,
      seamlessHandovers: S.seamlessHandovers,
      breakBeforeMakeHandovers: S.breakHandovers,
      unplannedFailovers: S.unplannedFailovers,
      tcpResets: S.tcpResets,
      criticalSent: T.criticalSent,
      criticalLost: T.criticalLost,
      criticalLossPct: T.criticalSent ? round((T.criticalLost / T.criticalSent) * 100, 4) : 0,
      duplicatesDiscarded: T.duplicatesDiscarded,
      replicationTimeS: round(S.replicationTime, 2),
      replicationOverheadPct: T.criticalBytes ? round((T.duplicateBytes / T.criticalBytes) * 100, 2) : 0,
      meanMos: round(S.mos.mean, 3),
      minMos: S.mos.count ? round(S.mos.min, 3) : null,
      timeBelowMos36S: round(S.timeBelowMos, 2),
      meanLatencyMs: round(S.latency.mean, 2),
      maxLatencyMs: S.latency.count ? round(S.latency.max, 2) : null,
      meanThroughputMbps: round(S.throughput.mean, 2),
      bulkDeliveredGB: round(T.bulkMbit / 8000, 3),
    };
  }

  getSummary() {
    return {
      meta: this.meta(),
      flexipath: this._summarizeAgent(this.agents.flexipath),
      legacy: this._summarizeAgent(this.agents.legacy),
      faults: [...this.faultLog],
    };
  }

  meta() {
    return {
      project: 'FlexiPath',
      version: VERSION,
      seed: this.config.seed,
      speedKmh: this.config.speedKmh,
      failSafe: this.config.failSafe,
      tickHz: TICK_HZ,
      simTimeS: round(this.t, 2),
      ticks: this.tick,
      anchorIp: ANCHOR_IP,
      metersPerUnit: METERS_PER_UNIT,
      routeLengthM: ROUTE_END_X * METERS_PER_UNIT,
    };
  }

  /** Full experiment record for JSON export. */
  exportData() {
    return {
      meta: { ...this.meta(), generatedAt: new Date().toISOString() },
      model: {
        interfaces: INTERFACE_SPECS,
        zones: ZONES,
        nodes: NODE_LAYOUT,
        flows: FLOW_DEFS,
        faults: FAULTS,
      },
      summary: this.getSummary(),
      events: this.events.map((e) => ({ t: round(e.t, 2), engine: e.engine, level: e.level, code: e.code, message: e.message })),
      timeseries: this.history,
    };
  }

  /** Flat per-tick rows for CSV export. */
  exportRows() {
    return this.history.map((h) => {
      const row = { t: h.t };
      for (const key of ['fp', 'lg']) for (const [k, v] of Object.entries(h[key])) row[`${key}_${k}`] = v;
      return row;
    });
  }

  /** Static world description for the renderer. */
  get world() {
    return { ...NetworkEnvironment.describe(), path: this.path, engines: ENGINES };
  }
}
