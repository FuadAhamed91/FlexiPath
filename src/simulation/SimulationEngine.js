/**
 * SimulationEngine.js — 10 Hz master clock and state coordinator.
 *
 * Runs two agents over the same seeded RF environment:
 *   • flexipath — FlexiPathController (predict → prepare → replicate → switch)
 *   • legacy    — LegacyController   (hard-threshold break-before-make)
 *
 * The engine is renderer-agnostic: the 3D layer and HUD subscribe to events
 * ('tick', 'event', 'decision', 'reset', 'complete') and read interpolated render state.
 * Identical seeds reproduce identical runs (all randomness comes from forked
 * Mulberry32 streams). A scenario (Scenarios.js) fixes the route segment, the
 * scheduled faults and the traffic mix — both agents always run it together.
 */
import { Random, normalizeSeed } from '../utils/Random.js';
import { RunningStats, round, mean } from '../utils/Metrics.js';
import { RoutePath, MobilityModel, ANTENNA_HEIGHT, METERS_PER_UNIT, MOBILITY_DEFAULTS } from './MobilityModel.js';
import { NetworkEnvironment, zoneAt, ZONES, NODE_LAYOUT, RF, FAULTS } from './NetworkEnvironment.js';
import { LinkModel, INTERFACE_IDS, INTERFACE_SPECS } from './LinkModel.js';
import { TrafficManager, FLOW_DEFS, TRAFFIC_CLASSES, TRAFFIC_PROFILES, flowsForProfile } from './TrafficManager.js';
import { FlexiPathController, FLEXIPATH_PARAMS } from './FlexiPathController.js';
import { LegacyController, LEGACY_PARAMS } from './LegacyController.js';
import { QoEModel } from './QoEModel.js';
import { FlexiPathTrace, LegacyTrace, TRACE_PARAMS } from './DecisionTrace.js';
import { resolveScenario } from './Scenarios.js';

export const VERSION = '1.1.0';
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
  scenario: 'mission',
  recordHistory: true,
  maxHistory: 36000,
  maxEvents: 5000,
  maxSimSeconds: Infinity, // the batch runner passes a finite cap
};

const NO_QOE = Object.freeze({ r: null, mos: null, mosInstant: null });

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
    this.scenario = resolveScenario(this.config.scenario);
    this.config.scenario = this.scenario.id;
    const root = new Random(this.config.seed);
    this.env = new NetworkEnvironment({ rng: root.fork('environment') });
    this.tick = 0;
    this.t = 0;
    this.accumulator = 0;
    this.alpha = 0;
    this.completed = false;
    this.summary = null;
    this.events = [];
    this.decisions = [];
    this.history = [];
    this.faultLog = [];
    this.pendingFaults = this.scenario.faults.map((f) => ({ ...f }));
    this.agents = {};
    for (const id of Object.keys(ENGINES)) this.agents[id] = this._createAgent(id, root);
    this.snapshot = this._capture();

    // Prime tick 0 silently so every consumer starts from a fully populated snapshot.
    this._silent = true;
    const sc = this.scenario;
    this._log({
      engine: 'sys',
      level: 'info',
      code: 'ARMED',
      message: `Scenario ${sc.code} · ${sc.label} · seed ${this.config.seed} · ${this.config.speedKmh} km/h · ${TRAFFIC_PROFILES[sc.traffic].label} · anchor IP ${ANCHOR_IP}`,
    });
    this.step();
    this._silent = false;
    this.prevSnapshot = this.snapshot;
    this.emit('reset', { seed: this.config.seed, config: { ...this.config }, scenario: sc });
    return this;
  }

  _createAgent(id, root) {
    const meta = ENGINES[id];
    const sc = this.scenario;
    const rng = root.fork(`agent:${id}`);
    const mobility = new MobilityModel({
      path: this.path,
      laneOffset: meta.laneOffset,
      startX: sc.startX,
      endX: sc.endX,
      departureDelay: sc.rolling ? 0 : MOBILITY_DEFAULTS.departureDelay,
    });
    mobility.setTargetSpeedKmh(this.config.speedKmh);
    if (sc.rolling) {
      mobility.speed = mobility.targetMps; // the scenario starts in motion
      mobility.departed = mobility.speed > 0;
    }
    const links = {};
    for (const lid of INTERFACE_IDS) links[lid] = new LinkModel(INTERFACE_SPECS[lid], rng.fork(`link:${lid}`));
    const flows = flowsForProfile(sc.traffic);
    const classes = Object.fromEntries(Object.keys(TRAFFIC_CLASSES).map((c) => [c, flows.some((f) => f.cls === c)]));
    const controller = id === 'flexipath' ? new FlexiPathController({ dt: DT, classes }) : new LegacyController({ dt: DT });
    const hasVoice = flows.some((f) => f.voice);
    return {
      id,
      meta,
      mobility,
      links,
      controller,
      flows,
      hasVoice,
      hasCritical: flows.some((f) => f.cls === 'CRITICAL'),
      hasPacket: flows.some((f) => f.mode === 'packet'),
      traffic: new TrafficManager({ rng: rng.fork('traffic'), flows }),
      qoe: new QoEModel(),
      trace: id === 'flexipath' ? new FlexiPathTrace() : new LegacyTrace(),
      linkStates: null,
      decision: null,
      trafficResult: null,
      qoeResult: hasVoice ? { r: 93.2, mos: QoEModel.rToMos(93.2), mosInstant: QoEModel.rToMos(93.2) } : NO_QOE,
      latencyMs: 0,
      criticalOutage: 0,
      lastDeliveryT: 0,
      lastLatency: INTERFACE_SPECS.eth0.baseRtt,
      zoneId: zoneAt(mobility.state.cx).id,
      replLostMark: { critical: 0, realtime: 0 },
      stallRun: 0,
      lastT: 0,
      stats: {
        stallTime: 0,
        stallEvents: 0,
        longestInterruption: 0,
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

  injectFault(type, { scheduledAtX = null } = {}) {
    const f = this.env.injectFault(type, this.t);
    const fp = this.agents.flexipath.mobility.state;
    this.faultLog.push({ t: round(this.t, 2), type, xFlexiPath: round(fp.cx, 2), scheduled: scheduledAtX !== null });
    const detail =
      type === 'wifi-fade'
        ? `−${f.depthDb} dB over ${f.rampUp} s, hold ${f.hold} s`
        : `cell offline for ${f.duration} s (abrupt)`;
    const when = scheduledAtX !== null ? ` · scenario schedule X = ${scheduledAtX}` : '';
    this._log({ engine: 'env', level: 'crit', code: 'FAULT', message: `FAULT INJECTED · ${FAULTS[type].label} · ${detail}${when}` });
    return f;
  }

  // ── Clock ───────────────────────────────────────────────────────────────
  /** Advance by wall-clock seconds; runs fixed 100 ms ticks; returns interpolation alpha. */
  advance(realDt) {
    if (this.paused || this.completed) return this.alpha;
    this.accumulator += realDt * this.config.simRate;
    let steps = 0;
    const maxSteps = 40;
    while (this.accumulator >= DT && steps < maxSteps && !this.completed && !this.paused) {
      this.step();
      this.accumulator -= DT;
      steps++;
    }
    if (steps === maxSteps || this.paused) this.accumulator = 0;
    this.alpha = this.completed ? 1 : Math.min(1, this.accumulator / DT);
    return this.alpha;
  }

  step() {
    if (this.completed) return this.snapshot;
    const t = this.tick * DT;

    // Scenario-scheduled faults trigger on the FlexiPath vehicle's position (shared environment).
    if (this.pendingFaults.length) {
      const x = this.agents.flexipath.mobility.state.cx;
      for (let i = this.pendingFaults.length - 1; i >= 0; i--) {
        if (x >= this.pendingFaults[i].atX) {
          this.injectFault(this.pendingFaults[i].type, { scheduledAtX: this.pendingFaults[i].atX });
          this.pendingFaults.splice(i, 1);
        }
      }
    }

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
        message: `Run complete · simulated interruption FlexiPath ${this.summary.flexipath.interruptionS.toFixed(2)} s · Legacy ${this.summary.legacy.interruptionS.toFixed(2)} s`,
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
    const dockDistM = docked ? (RF.dock.releaseX - mob.cx) * METERS_PER_UNIT : null;
    return { x: mob.cx, speedMps: mob.speedMps, docked, dockRelease, dockTtf, dockDistM };
  }

  _stepAgent(agent, t, events) {
    const { mobility } = agent;
    const agentEvents = [];
    // Counters before this tick, so an episode that opens now also counts this tick's losses / gap.
    const T0 = agent.traffic.totals;
    const before = { critical: T0.criticalLost, realtime: T0.realtimeLost, dup: T0.duplicateBytes, stall: agent.stats.stallTime };
    mobility.setFailSafe(this.config.failSafe && agent.criticalOutage > FAILSAFE_OUTAGE_S);
    const wasFailSafe = agent.failSafeActive;
    const mob = mobility.update(DT, t);
    agent.failSafeActive = mob.failSafe;
    if (mob.failSafe && !wasFailSafe) {
      agentEvents.push({
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
    const qoe = traffic.voice ? agent.qoe.update(traffic.voice) : NO_QOE;

    const crit = traffic.critical;
    const delivered = crit.delivered > 0;
    if (delivered) {
      agent.criticalOutage = 0;
      agent.lastDeliveryT = t + DT;
      agent.lastLatency = crit.rttMs;
      agent.latencyMs = crit.rttMs;
    } else if (crit.sent > 0) {
      agent.criticalOutage += DT;
      // Application-visible latency grows while packets queue behind a dead socket.
      agent.latencyMs = agent.lastLatency + (t + DT - agent.lastDeliveryT) * 1000;
    }

    const S = agent.stats;
    const wasStalled = agent.decision?.stalled;
    if (decision.stalled) {
      S.stallTime += DT;
      if (!wasStalled) S.stallEvents++;
      agent.stallRun += DT;
      S.longestInterruption = Math.max(S.longestInterruption, agent.stallRun);
    } else {
      agent.stallRun = 0;
    }
    if (decision.blackoutMs) {
      S.stallTime += decision.blackoutMs / 1000;
      S.stallEvents++;
      S.longestInterruption = Math.max(S.longestInterruption, decision.blackoutMs / 1000);
    }
    if (decision.replicationActive) S.replicationTime += DT;
    if (qoe.mos !== null) {
      S.mos.push(qoe.mos);
      if (qoe.mos < MOS_THRESHOLD) S.timeBelowMos += DT;
    }
    if (delivered) S.latency.push(crit.rttMs);
    S.throughput.push(traffic.throughputMbps);

    const T = agent.traffic.totals;
    for (const e of decision.events) {
      const ev = { ...e };
      if (e.code === 'REPL_ON') agent.replLostMark = { critical: T.criticalLost, realtime: T.realtimeLost };
      if (e.code === 'HOT_SWAP') {
        S.seamlessHandovers++;
        const lc = T.criticalLost - agent.replLostMark.critical;
        const lr = T.realtimeLost - agent.replLostMark.realtime;
        ev.message += ` · lost ${lc} critical / ${lr} real-time pkt${lc + lr === 1 ? '' : 's'}`;
        agent.replLostMark = { critical: T.criticalLost, realtime: T.realtimeLost };
      }
      if (e.code === 'FAILOVER') S.unplannedFailovers++;
      if (e.code === 'RECONNECTED') S.breakHandovers++;
      if (e.code === 'TCP_RST') S.tcpResets += agent.controller.p.socketsReset ?? 0;
      agentEvents.push(ev);
    }

    agent.trace.update({ t, decision, events: agentEvents, links: linkStates, totals: T, stats: S, before });
    for (const rec of decision.records ?? []) {
      const r = { ...rec, engine: agent.id };
      this.decisions.push(r);
      if (this.decisions.length > 600) this.decisions.shift();
      if (!this._silent) this.emit('decision', r);
    }
    for (const e of agentEvents) events.push({ t, engine: agent.id, ...e });

    const zone = zoneAt(mob.cx);
    if (zone.id !== agent.zoneId) {
      agent.zoneId = zone.id;
      if (agent.id === 'flexipath') {
        events.push({ t, engine: 'env', level: 'info', code: 'ZONE', message: `Zone ${zone.id} · ${zone.name} — ${zone.blurb}` });
      }
    }

    agent.lastT = t;
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
    const ov = agent.traffic.overhead();
    return {
      id: agent.id,
      label: agent.meta.label,
      color: agent.meta.color,
      vehicle: { ...mob, zone: zoneAt(mob.cx).id },
      links: agent.linkStates,
      decision: agent.decision,
      traffic: tr,
      qoe: agent.qoeResult,
      trace: agent.trace.view(agent.lastT, agent.decision),
      flows: agent.flows,
      hasVoice: agent.hasVoice,
      hasCritical: agent.hasCritical,
      metrics: {
        throughputMbps: tr ? tr.throughputMbps : 0,
        latencyMs: agent.hasCritical ? agent.latencyMs : null,
        lossPct: agent.hasPacket ? (tr ? tr.packet.windowLossRate * 100 : 0) : null,
        mos: agent.qoeResult.mos,
      },
      stats: {
        stallTime: S.stallTime,
        stallEvents: S.stallEvents,
        longestInterruption: S.longestInterruption,
        seamlessHandovers: S.seamlessHandovers,
        breakHandovers: S.breakHandovers,
        unplannedFailovers: S.unplannedFailovers,
        replicationTime: S.replicationTime,
        tcpResets: S.tcpResets,
        packetSent: T.packetSent,
        packetLost: T.packetLost,
        criticalSent: T.criticalSent,
        criticalLost: T.criticalLost,
        realtimeSent: T.realtimeSent,
        realtimeLost: T.realtimeLost,
        duplicatesDiscarded: T.duplicatesDiscarded,
        duplicateBytes: T.duplicateBytes,
        overheadPct: ov.packetPct,
        overheadTotalPct: ov.totalPct,
        overheadByClassPct: ov.byClassPct,
        bulkMbit: T.bulkMbit,
        perFlow: T.perFlow,
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
      scenario: this.scenario,
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
        stage: a.trace.stage,
        thr: round(a.metrics.throughputMbps, 2),
        lat: a.metrics.latencyMs === null ? null : round(a.metrics.latencyMs, 2),
        loss: a.metrics.lossPct === null ? null : round(a.metrics.lossPct, 2),
        mos: a.metrics.mos === null ? null : round(a.metrics.mos, 3),
        primary: a.decision?.primary ?? '',
        replica: a.decision?.replica ?? '',
        prepared: a.decision?.prepared ?? '',
        state: a.decision?.state ?? '',
        repl: a.decision?.replicationActive ? 1 : 0,
        replRt: a.decision?.replicate?.REALTIME ? 1 : 0,
        stalled: a.decision?.stalled ? 1 : 0,
        rssi: L.wlan0.up ? round(L.wlan0.signal, 1) : null,
        rsrp: L.wwan0.up ? round(L.wwan0.signal, 1) : null,
        satSnr: L.sat0.up ? round(L.sat0.signal, 1) : null,
        stallTime: round(a.stats.stallTime, 2),
        overheadPct: round(a.stats.overheadPct, 3),
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
    const ov = agent.traffic.overhead();
    const avf = agent.trace.actionVsFailure();
    const counts = agent.trace.counts();
    const pctOf = (num, den, d = 4) => (den ? round((num / den) * 100, d) : null);
    return {
      engine: agent.id,
      finished: mob.finished,
      journeyTimeS: mob.finishTime !== null ? round(mob.finishTime, 2) : null,
      distanceM: round(mob.distanceM, 1),
      // Interruption (break in delivery of every flow)
      interruptionS: round(S.stallTime, 3),
      interruptionEvents: S.stallEvents,
      longestInterruptionS: round(S.longestInterruption, 3),
      meanRecoveryS: S.stallEvents ? round(S.stallTime / S.stallEvents, 3) : null,
      stallTimeS: round(S.stallTime, 3),
      stallEvents: S.stallEvents,
      seamlessHandovers: S.seamlessHandovers,
      breakBeforeMakeHandovers: S.breakHandovers,
      unplannedFailovers: S.unplannedFailovers,
      tcpResets: S.tcpResets,
      // Delivery
      packetSent: T.packetSent,
      packetLost: T.packetLost,
      packetDeliveryPct: pctOf(T.packetDelivered, T.packetSent),
      packetLossPct: pctOf(T.packetLost, T.packetSent),
      criticalSent: T.criticalSent,
      criticalLost: T.criticalLost,
      criticalDeliveryPct: pctOf(T.criticalDelivered, T.criticalSent),
      criticalLossPct: pctOf(T.criticalLost, T.criticalSent) ?? 0,
      realtimeSent: T.realtimeSent,
      realtimeLost: T.realtimeLost,
      realtimeDeliveryPct: pctOf(T.realtimeDelivered, T.realtimeSent),
      duplicatesDiscarded: T.duplicatesDiscarded,
      // Replication cost (measured)
      replicationTimeS: round(S.replicationTime, 2),
      replicatedBytes: ov.replicatedBytes,
      originalPacketBytes: ov.packetBytes,
      replicationOverheadPct: round(ov.packetPct, 3),
      replicationOverheadTotalPct: round(ov.totalPct, 4),
      replicationOverheadCriticalPct: round(ov.byClassPct.CRITICAL, 3),
      replicationOverheadRealtimePct: round(ov.byClassPct.REALTIME, 3),
      // Prediction vs. the true failure of the path being left (negative = acted before it failed)
      actionVsFailureS: avf.length ? round(mean(avf), 3) : null,
      pathFailures: counts.pathFailures,
      predictedFailures: counts.predictedFailures,
      abruptFailures: counts.abruptFailures,
      falseAlarms: counts.falseAlarms,
      // QoE, latency, throughput
      meanMos: S.mos.count ? round(S.mos.mean, 3) : null,
      minMos: S.mos.count ? round(S.mos.min, 3) : null,
      timeBelowMos36S: agent.hasVoice ? round(S.timeBelowMos, 2) : null,
      meanLatencyMs: S.latency.count ? round(S.latency.mean, 2) : null,
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
    const sc = this.scenario;
    return {
      project: 'FlexiPath',
      version: VERSION,
      dataSource: 'simulation',
      scenario: { id: sc.id, code: sc.code, label: sc.label, traffic: sc.traffic, startX: sc.startX, endX: sc.endX },
      seed: this.config.seed,
      speedKmh: this.config.speedKmh,
      failSafe: this.config.failSafe,
      tickHz: TICK_HZ,
      simTimeS: round(this.t, 2),
      ticks: this.tick,
      anchorIp: ANCHOR_IP,
      metersPerUnit: METERS_PER_UNIT,
      routeLengthM: round((sc.endX - sc.startX) * METERS_PER_UNIT, 1),
    };
  }

  /** Full experiment record for JSON export. */
  exportData() {
    return {
      meta: { ...this.meta(), generatedAt: new Date().toISOString() },
      model: {
        note: 'All values are produced by the FlexiPath simulation model; none are real-world measurements.',
        interfaces: INTERFACE_SPECS,
        zones: ZONES,
        nodes: NODE_LAYOUT,
        trafficClasses: TRAFFIC_CLASSES,
        flows: FLOW_DEFS,
        activeFlows: this.agents.flexipath.flows.map((f) => f.id),
        faults: FAULTS,
        flexipathParams: FLEXIPATH_PARAMS,
        legacyParams: LEGACY_PARAMS,
        traceParams: TRACE_PARAMS,
      },
      summary: this.getSummary(),
      decisions: this.decisions.map((d) => ({ ...d, t: round(d.t, 2) })),
      episodes: {
        flexipath: this.agents.flexipath.trace.history,
        legacy: this.agents.legacy.trace.history,
      },
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
