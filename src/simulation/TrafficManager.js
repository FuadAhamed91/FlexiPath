/**
 * TrafficManager.js — traffic classes, flow generator, packet-fate engine and receiver ordering.
 *
 * Not all traffic is treated the same. Every flow belongs to a class whose protection matches what
 * it actually needs:
 *
 *   CRITICAL  (P1)  emergency / control, medical telemetry
 *                   per-packet · replicated during the ~400 ms handoff burst
 *   REAL-TIME (P2)  VoIP, interactive sessions
 *                   per-packet · replicated in the burst only once its loss budget is exceeded or
 *                   failure is less than a second away (packet-loss concealment hides the rest)
 *   BULK      (P3+) video upload, file transfer
 *                   fluid · never replicated: carried by the active radio and moved to the new path
 *                   with delay-compensated pacing during the burst (reliable transport recovers losses)
 *
 * The controller decides *which classes* are replicated (decision.replicate); this module executes the
 * decision. Every packet carries a 32-bit sequence number. A replicated packet is sent on [primary,
 * replica]; the receiver (ReorderingBuffer) delivers the first copy to arrive and discards the later one.
 * Bulk flows run through a TCP-like in-order model that measures head-of-line blocking. Every duplicate
 * byte is counted, so replication overhead is measured, not assumed.
 */
import { clamp, WindowRatio, RunningStats } from '../utils/Metrics.js';
import { INTERFACE_IDS } from './LinkModel.js';
import { SequenceReorderBuffer, TcpHolModel, delayCompensatedPacing, seqAdd } from './ReorderingBuffer.js';

export const TRAFFIC_CLASSES = {
  CRITICAL: {
    id: 'CRITICAL',
    label: 'Critical',
    priority: 1,
    color: '#F8FAFC',
    examples: 'Emergency / control · medical telemetry · safety data',
    sensitivity: 'Loss + latency',
    policy: 'Replicated during the ~400 ms handoff burst; first copy delivered, late duplicate discarded',
  },
  REALTIME: {
    id: 'REALTIME',
    label: 'Real-time',
    priority: 2,
    color: '#7DD3FC',
    examples: 'VoIP · interactive sessions',
    sensitivity: 'Latency + jitter (MOS)',
    policy: 'Replicated in the burst only once loss exceeds its 2 % budget or failure is < 1 s away',
  },
  BULK: {
    id: 'BULK',
    label: 'Bulk',
    priority: 3,
    color: '#94A3B8',
    examples: 'Video upload · file transfer',
    sensitivity: 'Throughput',
    policy: 'Never replicated: moved to the new path with delay-compensated pacing (ΔRTT offset)',
  },
};

export const PACKET_CLASSES = ['CRITICAL', 'REALTIME'];

// Order matters for reproducibility: packet fates draw from one seeded stream in this order.
export const FLOW_DEFS = [
  {
    id: 'voip-01',
    label: 'VoIP call · G.711 20 ms',
    name: 'VoIP call',
    cls: 'REALTIME',
    priority: 2,
    mode: 'packet',
    pps: 50,
    payloadBytes: 160,
    voice: true,
  },
  {
    id: 'ems-tlm',
    label: 'EMS telemetry · ECG + CAN',
    name: 'Medical telemetry',
    cls: 'CRITICAL',
    priority: 1,
    mode: 'packet',
    pps: 100,
    payloadBytes: 320,
  },
  {
    id: 'cam-hd',
    label: 'HD dash-cam uplink',
    name: 'HD video uplink',
    cls: 'BULK',
    priority: 3,
    mode: 'fluid',
    demandMbps: 25,
  },
  {
    id: 'ota-sync',
    label: 'Bulk file sync · OTA / maps',
    name: 'File sync (OTA / maps)',
    cls: 'BULK',
    priority: 4,
    mode: 'fluid',
    demandMbps: 175,
    elastic: true,
  },
];

/** Traffic mixes used by the scenarios. */
export const TRAFFIC_PROFILES = {
  mixed: { id: 'mixed', label: 'Mixed: critical + real-time + bulk', flows: ['voip-01', 'ems-tlm', 'cam-hd', 'ota-sync'] },
  protected: { id: 'protected', label: 'Critical + real-time only', flows: ['voip-01', 'ems-tlm'] },
  bulk: { id: 'bulk', label: 'Bulk only (video + file sync)', flows: ['cam-hd', 'ota-sync'] },
};

export function flowsForProfile(profile = 'mixed') {
  const ids = (TRAFFIC_PROFILES[profile] ?? TRAFFIC_PROFILES.mixed).flows;
  return FLOW_DEFS.filter((f) => ids.includes(f.id));
}

const PROTOCOL_EFFICIENCY = 0.94; // headers, ACK clocking, FEC overhead
export const HEADER_BYTES = 48; // IPv6 + UDP + FlexiPath tunnel header

/** Proportional water-filling of `demand` across links with capacity caps. */
export function waterFill(demand, shares, caps) {
  const alloc = {};
  let remaining = demand;
  let open = Object.keys(shares).filter((id) => shares[id] > 0 && caps[id] > 0);
  for (const id of Object.keys(shares)) alloc[id] = 0;
  for (let iter = 0; iter < 4 && remaining > 1e-6 && open.length; iter++) {
    const wsum = open.reduce((a, id) => a + shares[id], 0);
    const next = [];
    let used = 0;
    for (const id of open) {
      const want = (remaining * shares[id]) / wsum;
      const room = caps[id] - alloc[id];
      const give = Math.min(want, room);
      alloc[id] += give;
      used += give;
      if (caps[id] - alloc[id] > 1e-6) next.push(id);
    }
    remaining -= used;
    open = next;
  }
  return alloc;
}

const tickAgg = () => ({ sent: 0, delivered: 0, dups: 0, lat: 0, latSq: 0, bytes: 0, dupBytes: 0 });

function summarize(a, window, dt) {
  const lost = a.sent - a.delivered;
  const meanLat = a.delivered ? a.lat / a.delivered : NaN;
  return {
    sent: a.sent,
    delivered: a.delivered,
    lost,
    dups: a.dups,
    lossRate: a.sent ? lost / a.sent : 0,
    windowLossRate: window.value,
    oneWayMs: meanLat,
    rttMs: Number.isFinite(meanLat) ? 2 * meanLat : NaN,
    jitterMs: a.delivered > 1 ? Math.sqrt(Math.max(0, a.latSq / a.delivered - meanLat * meanLat)) : 0,
    mbps: (a.bytes * 8) / dt / 1e6,
    dupBytes: a.dupBytes,
  };
}

export class TrafficManager {
  constructor({ rng, flows = FLOW_DEFS } = {}) {
    this.rng = rng;
    this.seqRng = rng.fork('seq');
    this.holRng = rng.fork('hol');
    this.pacingRng = rng.fork('pacing');
    this.flows = flows;
    this.hasClass = Object.fromEntries(Object.keys(TRAFFIC_CLASSES).map((c) => [c, flows.some((f) => f.cls === c)]));
    this.reset();
  }

  reset() {
    this.window = {};
    this.latencyStats = {};
    this.seq = {};
    this.reorder = {};
    this.tcp = {};
    this.pacing = {};
    for (const f of this.flows) {
      this.window[f.id] = new WindowRatio(10); // 1 s loss window
      this.latencyStats[f.id] = new RunningStats();
      if (f.mode === 'packet') {
        this.seq[f.id] = Math.floor(this.seqRng.next() * 4294967296) >>> 0; // random 32-bit initial sequence number
        this.reorder[f.id] = new SequenceReorderBuffer();
      } else {
        this.tcp[f.id] = {};
        this.pacing[f.id] = { ticks: 0, pacedSumMs: 0, unpacedSumMs: 0, maxOffsetMs: 0 };
      }
    }
    this.classWindow = { CRITICAL: new WindowRatio(10), REALTIME: new WindowRatio(10) };
    this.packetWindow = new WindowRatio(10);
    this.timeMs = 0;
    this.totals = {
      packetSent: 0,
      packetDelivered: 0,
      packetLost: 0,
      packetBytes: 0, // original (first-copy) bytes offered by the packet flows
      criticalSent: 0,
      criticalDelivered: 0,
      criticalLost: 0,
      realtimeSent: 0,
      realtimeDelivered: 0,
      realtimeLost: 0,
      duplicatesDiscarded: 0, // late copies discarded by the receiver's sequence buffer
      duplicateBytes: 0, // extra copies actually transmitted on a second path
      duplicateBytesByClass: { CRITICAL: 0, REALTIME: 0 },
      bulkMbit: 0,
      perFlow: Object.fromEntries(
        this.flows.map((f) => [f.id, { sent: 0, delivered: 0, lost: 0, dups: 0, dupBytes: 0, mbit: 0 }]),
      ),
    };
  }

  _tcpModel(flowId, linkId) {
    const map = this.tcp[flowId];
    map[linkId] ??= new TcpHolModel(this.holRng.fork(`${flowId}:${linkId}`));
    return map[linkId];
  }

  /**
   * Execute one 100 ms tick of traffic under a routing decision.
   * @param {object} decision controller output
   * @param {Record<string, object>} links true link states
   * @param {number} dt tick length (s)
   * @param {number} [t] simulation time at the start of the tick (s)
   */
  step(decision, links, dt, t = 0) {
    const r = this.rng;
    const blackoutFrac = clamp((decision.blackoutMs || 0) / (dt * 1000), 0, 1);
    const paths = decision.criticalPaths || [];
    const replicate = decision.replicate; // per-class map; undefined ⇒ every packet flow is mirrored
    const perLink = Object.fromEntries(INTERFACE_IDS.map((id) => [id, { mbps: 0, share: 0, pkts: 0, dupPkts: 0 }]));

    const flowResults = [];
    const agg = { packet: tickAgg(), CRITICAL: tickAgg(), REALTIME: tickAgg() };
    let voice = null;
    let inOrderTickMax = 0;
    let reorderedTick = 0;
    this.timeMs += dt * 1000;

    // ── Packet flows (CRITICAL, REAL-TIME): per-packet fate, sequence-numbered ─────
    for (const f of this.flows) {
      if (f.mode !== 'packet') continue;
      const n = Math.round(f.pps * dt);
      const size = f.payloadBytes + HEADER_BYTES;
      const mirror = paths.length > 1 && (replicate ? !!replicate[f.cls] : true);
      const fPaths = mirror ? paths : paths.slice(0, 1);
      const buf = this.reorder[f.id];
      let delivered = 0;
      let fLat = 0;
      let fLatSq = 0;
      let dupBytes = 0;
      const arrivals = [];
      const firsts = [];
      const blackoutPkts = Math.ceil(blackoutFrac * n);
      for (let i = 0; i < n; i++) {
        const seq = this.seq[f.id];
        this.seq[f.id] = seqAdd(seq, 1);
        if (decision.stalled || !fPaths.length || i < blackoutPkts) continue;
        const sendAt = t + ((i + 0.5) / n) * dt;
        let first = Infinity;
        for (let p = 0; p < fPaths.length; p++) {
          const L = links[fPaths[p]];
          if (!L || !L.up) continue;
          perLink[L.id].pkts++;
          if (p > 0) {
            perLink[L.id].dupPkts++;
            dupBytes += size;
          }
          if (r.next() >= L.lossRate) {
            const lat = L.rttMs / 2 + Math.abs(r.gaussian(0, L.jitterMs));
            arrivals.push({ seq, at: sendAt + lat / 1000 });
            if (lat < first) first = lat;
          }
        }
        if (first < Infinity) {
          delivered++;
          fLat += first;
          fLatSq += first * first;
          this.latencyStats[f.id].push(first);
          firsts.push(sendAt + first / 1000);
        }
      }
      // Receiver: copies in arrival order through the 32-bit sequence buffer — first copy delivered at
      // once, the late duplicate discarded. Nothing is held back, so the HoL wait is zero.
      arrivals.sort((a, b) => a.at - b.at);
      const dupBefore = buf.duplicates;
      const reBefore = buf.reordered;
      for (const a of arrivals) buf.arrive(a.seq);
      const dups = buf.duplicates - dupBefore;
      reorderedTick += buf.reordered - reBefore;
      // Counterfactual: what strict in-order delivery of the same arrivals would have added.
      let inOrderMax = 0;
      for (const at of firsts) inOrderMax = Math.max(inOrderMax, buf.inOrderSample(at));
      inOrderTickMax = Math.max(inOrderTickMax, inOrderMax);

      const lost = n - delivered;
      this.window[f.id].push(lost, n);
      const meanLat = delivered ? fLat / delivered : NaN;
      const jitter = delivered > 1 ? Math.sqrt(Math.max(0, fLatSq / delivered - meanLat * meanLat)) : 0;
      const tot = this.totals.perFlow[f.id];
      tot.sent += n;
      tot.delivered += delivered;
      tot.lost += lost;
      tot.dups += dups;
      tot.dupBytes += dupBytes;
      tot.mbit += (delivered * size * 8) / 1e6;

      flowResults.push({
        id: f.id,
        cls: f.cls,
        priority: f.priority,
        label: f.label,
        name: f.name,
        mode: 'packet',
        sent: n,
        delivered,
        lost,
        dups,
        lossRate: n ? lost / n : 0,
        windowLossRate: this.window[f.id].value,
        oneWayMs: meanLat,
        jitterMs: jitter,
        mbps: (delivered * size * 8) / dt / 1e6,
        paths: decision.stalled ? [] : [...fPaths],
        replicated: mirror && !decision.stalled && fPaths.length > 1,
        dupBytes,
        holStallMs: buf.holMaxMs,
        inOrderWaitMs: inOrderMax,
        seqNext: this.seq[f.id],
      });
      if (f.voice) {
        voice = {
          sent: n,
          delivered,
          windowLossPct: this.window[f.id].value * 100,
          oneWayMs: Number.isFinite(meanLat) ? meanLat : 0,
          jitterMs: jitter,
        };
      }
      for (const a of [agg.packet, agg[f.cls]]) {
        a.sent += n;
        a.delivered += delivered;
        a.dups += dups;
        a.lat += fLat;
        a.latSq += fLatSq;
        a.bytes += delivered * size;
        a.dupBytes += dupBytes;
      }
      this.totals.packetBytes += n * size;
    }

    // ── BULK flows: fluid goodput on the active radio(s), TCP-like in-order delivery ──
    const shares = decision.stalled ? {} : decision.bulkShares || {};
    const caps = {};
    for (const id of Object.keys(shares)) {
      const L = links[id];
      caps[id] = L && L.up ? Math.max(0, L.throughputMbps * PROTOCOL_EFFICIENCY) : 0;
    }
    // What replicating a bulk flow would cost on the backup path (measured capacity) — reported, never done.
    const backup = decision.backup ?? null;
    const backupCap = backup ? decision.scores?.[backup]?.metrics?.throughputMbps ?? links[backup]?.throughputMbps ?? 0 : 0;
    let bulkMbps = 0;
    let bulkBlocked = 0;
    let bulkStall = 0;
    let bulkRto = false;
    let pacingNow = null;
    for (const f of this.flows) {
      if (f.mode !== 'fluid') continue;
      const alloc = waterFill(f.demandMbps, shares, caps);
      let got = 0;
      const flowPaths = [];
      for (const [id, mbps] of Object.entries(alloc)) {
        if (mbps <= 0) continue;
        caps[id] -= mbps;
        perLink[id].mbps += mbps;
        got += mbps;
        flowPaths.push(id);
      }
      got *= 1 - blackoutFrac; // in-flight data lost while an abrupt failure is detected
      bulkMbps += got;
      this.totals.perFlow[f.id].mbit += got * dt;

      // Head-of-line blocking: loss recovery on each path the flow uses.
      let blocked = 0;
      let stall = 0;
      let rto = false;
      const used = new Set(flowPaths);
      for (const id of new Set([...flowPaths, ...Object.keys(this.tcp[f.id])])) {
        const L = links[id];
        const res = this._tcpModel(f.id, id).step(
          dt * 1000,
          used.has(id) && L?.up ? { rttMs: L.rttMs, jitterMs: L.jitterMs, lossRate: L.lossRate, mbps: alloc[id] * (1 - blackoutFrac) } : null,
        );
        blocked = Math.max(blocked, res.blockedMs);
        stall = Math.max(stall, res.stallMs);
        rto ||= res.rto;
      }
      // Multipath (only during a burst): delay-compensated pacing removes the reordering stall.
      let pacing = null;
      if (flowPaths.length > 1 && decision.pacing) {
        pacing = delayCompensatedPacing(
          flowPaths.map((id) => ({ id, rttMs: links[id].rttMs, jitterMs: links[id].jitterMs, mbps: alloc[id] })),
          this.pacingRng,
        );
        if (pacing) {
          const ps = this.pacing[f.id];
          ps.ticks++;
          ps.pacedSumMs += pacing.pacedHolMs * dt * 1000;
          ps.unpacedSumMs += pacing.unpacedHolMs * dt * 1000;
          ps.maxOffsetMs = Math.max(ps.maxOffsetMs, pacing.offsetMs);
          pacingNow ??= pacing;
        }
      }
      bulkBlocked = Math.max(bulkBlocked, blocked);
      bulkStall = Math.max(bulkStall, stall);
      bulkRto ||= rto;
      flowResults.push({
        id: f.id,
        cls: f.cls,
        priority: f.priority,
        label: f.label,
        name: f.name,
        mode: 'fluid',
        demandMbps: f.demandMbps,
        elastic: !!f.elastic,
        mbps: got,
        lossRate: f.demandMbps ? 1 - got / f.demandMbps : 0,
        paths: flowPaths,
        alloc,
        replicated: false,
        replicaCostPct: backup && backupCap > 0 ? (got / backupCap) * 100 : null,
        holBlockedMs: blocked,
        holStallMs: stall,
        rto,
        pacing,
      });
    }
    const totalShare = Object.values(shares).reduce((a, b) => a + b, 0) || 1;
    for (const [id, w] of Object.entries(shares)) perLink[id].share = w / totalShare;

    // ── Aggregates ───────────────────────────────────────────────────────
    this.packetWindow.push(agg.packet.sent - agg.packet.delivered, agg.packet.sent);
    for (const c of PACKET_CLASSES) this.classWindow[c].push(agg[c].sent - agg[c].delivered, agg[c].sent);
    const packet = summarize(agg.packet, this.packetWindow, dt);
    const critical = summarize(agg.CRITICAL, this.classWindow.CRITICAL, dt);
    const realtime = summarize(agg.REALTIME, this.classWindow.REALTIME, dt);

    const T = this.totals;
    T.packetSent += packet.sent;
    T.packetDelivered += packet.delivered;
    T.packetLost += packet.lost;
    T.criticalSent += critical.sent;
    T.criticalDelivered += critical.delivered;
    T.criticalLost += critical.lost;
    T.realtimeSent += realtime.sent;
    T.realtimeDelivered += realtime.delivered;
    T.realtimeLost += realtime.lost;
    T.duplicatesDiscarded += packet.dups;
    T.duplicateBytes += packet.dupBytes;
    T.duplicateBytesByClass.CRITICAL += critical.dupBytes;
    T.duplicateBytesByClass.REALTIME += realtime.dupBytes;
    T.bulkMbit += bulkMbps * dt;

    return {
      throughputMbps: bulkMbps + packet.mbps,
      bulkMbps,
      packetMbps: packet.mbps,
      packet,
      critical,
      realtime,
      voice,
      perLink,
      flows: flowResults,
      duplicateBytes: packet.dupBytes,
      replicatedClasses: PACKET_CLASSES.filter((c) => flowResults.some((fr) => fr.cls === c && fr.replicated)),
      hol: {
        packetStallMs: 0, // first-copy delivery: nothing waits behind a missing packet
        inOrderWaitMs: inOrderTickMax,
        reordered: reorderedTick,
        bulkBlockedMs: bulkBlocked,
        bulkStallMs: bulkStall,
        bulkRto,
        pacing: pacingNow,
      },
    };
  }

  /** Replication overhead so far: duplicate bytes vs. original packet-flow bytes and vs. all traffic. */
  overhead() {
    const T = this.totals;
    const bulkBytes = (T.bulkMbit * 1e6) / 8;
    return {
      replicatedBytes: T.duplicateBytes,
      packetBytes: T.packetBytes,
      totalBytes: T.packetBytes + bulkBytes,
      packetPct: T.packetBytes ? (T.duplicateBytes / T.packetBytes) * 100 : 0,
      totalPct: T.packetBytes + bulkBytes > 0 ? (T.duplicateBytes / (T.packetBytes + bulkBytes)) * 100 : 0,
      byClassPct: Object.fromEntries(
        PACKET_CLASSES.map((c) => {
          const orig = this.flows
            .filter((f) => f.cls === c)
            .reduce((a, f) => a + this.totals.perFlow[f.id].sent * (f.payloadBytes + HEADER_BYTES), 0);
          return [c, orig ? (T.duplicateBytesByClass[c] / orig) * 100 : 0];
        }),
      ),
    };
  }

  /** Receiver ordering / head-of-line statistics so far. */
  holStats() {
    const packetFlows = this.flows.filter((f) => f.mode === 'packet');
    const bulkFlows = this.flows.filter((f) => f.mode === 'fluid');
    let inOrderSum = 0;
    let inOrderCount = 0;
    let inOrderMax = 0;
    let reordered = 0;
    let holMax = 0;
    for (const f of packetFlows) {
      const b = this.reorder[f.id];
      inOrderSum += b.inOrderSumMs;
      inOrderCount += b.inOrderCount;
      inOrderMax = Math.max(inOrderMax, b.inOrderMaxMs);
      reordered += b.reordered;
      holMax = Math.max(holMax, b.holMaxMs);
    }
    let bulkMean = 0;
    let bulkPeak = 0;
    let rtoEvents = 0;
    let fastRetx = 0;
    let unpacedMean = 0;
    let maxOffset = 0;
    const T = Math.max(1, this.timeMs);
    for (const f of bulkFlows) {
      let sumSq = 0;
      for (const m of Object.values(this.tcp[f.id])) {
        sumSq += m.sumSqMs2;
        bulkPeak = Math.max(bulkPeak, m.peakMs);
        rtoEvents += m.rtoEvents;
        fastRetx += m.fastRetx;
      }
      const ps = this.pacing[f.id];
      bulkMean += sumSq / (2 * T) + ps.pacedSumMs / T;
      unpacedMean += sumSq / (2 * T) + ps.unpacedSumMs / T;
      maxOffset = Math.max(maxOffset, ps.maxOffsetMs);
    }
    const nb = bulkFlows.length || 1;
    return {
      packetHolMaxMs: holMax,
      inOrderWaitMeanMs: inOrderCount ? inOrderSum / inOrderCount : 0,
      inOrderWaitMaxMs: inOrderMax,
      reordered,
      duplicatesDiscarded: this.totals.duplicatesDiscarded,
      bulkHolMeanMs: bulkFlows.length ? bulkMean / nb : null,
      bulkHolUnpacedMeanMs: bulkFlows.length ? unpacedMean / nb : null,
      bulkHolPeakMs: bulkFlows.length ? bulkPeak : null,
      bulkRtoEvents: rtoEvents,
      bulkFastRetransmits: fastRetx,
      pacingMaxOffsetMs: maxOffset,
    };
  }
}
