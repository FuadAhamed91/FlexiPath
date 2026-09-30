/**
 * TrafficManager.js — flow generator and packet-fate engine.
 *
 * CRITICAL flows (VoIP, emergency telemetry) are simulated per packet. When the
 * controller replicates, every packet is mirrored onto both paths; the receiver
 * keeps the first copy to arrive and discards the rest (duplicate counter).
 *
 * BULK flows (dash-cam uplink, OTA/map sync) are fluid: demand is water-filled
 * across the controller's score-weighted link shares, capped by each link's
 * goodput.
 */
import { clamp, WindowRatio, RunningStats } from '../utils/Metrics.js';
import { INTERFACE_IDS } from './LinkModel.js';

export const FLOW_DEFS = [
  {
    id: 'voip-01',
    label: 'VoIP call · Opus 20 ms',
    cls: 'CRITICAL',
    pps: 50,
    payloadBytes: 160,
    voice: true,
  },
  {
    id: 'ems-tlm',
    label: 'EMS telemetry · ECG + CAN',
    cls: 'CRITICAL',
    pps: 100,
    payloadBytes: 320,
  },
  {
    id: 'cam-hd',
    label: 'HD dash-cam uplink',
    cls: 'BULK',
    demandMbps: 25,
  },
  {
    id: 'ota-sync',
    label: 'Bulk file sync · OTA / maps',
    cls: 'BULK',
    demandMbps: 175,
    elastic: true,
  },
];

const PROTOCOL_EFFICIENCY = 0.94; // headers, ACK clocking, FEC overhead
const HEADER_BYTES = 48; // IPv6 + UDP + FlexiPath tunnel header

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

export class TrafficManager {
  constructor({ rng, flows = FLOW_DEFS } = {}) {
    this.rng = rng;
    this.flows = flows;
    this.reset();
  }

  reset() {
    this.window = {};
    this.latencyStats = {};
    for (const f of this.flows) {
      this.window[f.id] = new WindowRatio(10); // 1 s loss window
      this.latencyStats[f.id] = new RunningStats();
    }
    this.criticalWindow = new WindowRatio(10);
    this.totals = {
      criticalSent: 0,
      criticalDelivered: 0,
      criticalLost: 0,
      duplicatesDiscarded: 0,
      duplicateBytes: 0,
      criticalBytes: 0,
      bulkMbit: 0,
      perFlow: Object.fromEntries(this.flows.map((f) => [f.id, { sent: 0, delivered: 0, lost: 0, dups: 0 }])),
    };
  }

  /**
   * Execute one 100 ms tick of traffic under a routing decision.
   * @param {object} decision controller output
   * @param {Record<string, object>} links true link states
   * @param {number} dt tick length (s)
   */
  step(decision, links, dt) {
    const r = this.rng;
    const blackoutFrac = clamp((decision.blackoutMs || 0) / (dt * 1000), 0, 1);
    const paths = decision.criticalPaths || [];
    const perLink = Object.fromEntries(INTERFACE_IDS.map((id) => [id, { mbps: 0, share: 0, pkts: 0, dupPkts: 0 }]));

    const flowResults = [];
    let critSent = 0;
    let critDelivered = 0;
    let critDups = 0;
    let latSum = 0;
    let latSqSum = 0;
    let dupBytes = 0;
    let critBytes = 0;
    let voice = null;

    // ── CRITICAL flows: per-packet fate ────────────────────────────────────
    for (const f of this.flows) {
      if (f.cls !== 'CRITICAL') continue;
      const n = Math.round(f.pps * dt);
      let delivered = 0;
      let dups = 0;
      let fLat = 0;
      let fLatSq = 0;
      const blackoutPkts = Math.ceil(blackoutFrac * n);
      for (let i = 0; i < n; i++) {
        if (decision.stalled || !paths.length || i < blackoutPkts) continue;
        let first = Infinity;
        let copies = 0;
        for (let p = 0; p < paths.length; p++) {
          const L = links[paths[p]];
          if (!L || !L.up) continue;
          perLink[L.id].pkts++;
          if (p > 0) {
            perLink[L.id].dupPkts++;
            dupBytes += f.payloadBytes + HEADER_BYTES;
          }
          if (r.next() >= L.lossRate) {
            copies++;
            const lat = L.rttMs / 2 + Math.abs(r.gaussian(0, L.jitterMs));
            if (lat < first) first = lat;
          }
        }
        if (copies > 0) {
          delivered++;
          fLat += first;
          fLatSq += first * first;
          this.latencyStats[f.id].push(first);
          if (copies > 1) dups += copies - 1;
        }
      }
      const lost = n - delivered;
      this.window[f.id].push(lost, n);
      const meanLat = delivered ? fLat / delivered : NaN;
      const jitter = delivered > 1 ? Math.sqrt(Math.max(0, fLatSq / delivered - meanLat * meanLat)) : 0;
      const tot = this.totals.perFlow[f.id];
      tot.sent += n;
      tot.delivered += delivered;
      tot.lost += lost;
      tot.dups += dups;

      const res = {
        id: f.id,
        cls: f.cls,
        label: f.label,
        sent: n,
        delivered,
        lost,
        dups,
        lossRate: n ? lost / n : 0,
        windowLossRate: this.window[f.id].value,
        oneWayMs: meanLat,
        jitterMs: jitter,
        mbps: (delivered * (f.payloadBytes + HEADER_BYTES) * 8) / dt / 1e6,
        paths: decision.stalled ? [] : [...paths],
      };
      flowResults.push(res);
      if (f.voice) {
        voice = {
          sent: n,
          delivered,
          windowLossPct: this.window[f.id].value * 100,
          oneWayMs: Number.isFinite(meanLat) ? meanLat : 0,
          jitterMs: jitter,
        };
      }
      critSent += n;
      critDelivered += delivered;
      critDups += dups;
      latSum += fLat;
      latSqSum += fLatSq;
      critBytes += delivered * (f.payloadBytes + HEADER_BYTES);
    }

    // ── BULK flows: fluid water-filling over score-weighted shares ─────────
    const shares = decision.stalled ? {} : decision.bulkShares || {};
    const caps = {};
    for (const id of Object.keys(shares)) {
      const L = links[id];
      caps[id] = L && L.up ? Math.max(0, L.throughputMbps * PROTOCOL_EFFICIENCY) : 0;
    }
    let bulkMbps = 0;
    for (const f of this.flows) {
      if (f.cls !== 'BULK') continue;
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
      flowResults.push({
        id: f.id,
        cls: f.cls,
        label: f.label,
        demandMbps: f.demandMbps,
        mbps: got,
        lossRate: f.demandMbps ? 1 - got / f.demandMbps : 0,
        paths: flowPaths,
        alloc,
      });
    }
    const totalShare = Object.values(shares).reduce((a, b) => a + b, 0) || 1;
    for (const [id, w] of Object.entries(shares)) perLink[id].share = w / totalShare;

    // ── Aggregates ───────────────────────────────────────────────────────
    const critLost = critSent - critDelivered;
    this.criticalWindow.push(critLost, critSent);
    const meanLat = critDelivered ? latSum / critDelivered : NaN;
    const critJitter = critDelivered > 1 ? Math.sqrt(Math.max(0, latSqSum / critDelivered - meanLat * meanLat)) : 0;
    const criticalMbps = (critBytes * 8) / dt / 1e6;

    const T = this.totals;
    T.criticalSent += critSent;
    T.criticalDelivered += critDelivered;
    T.criticalLost += critLost;
    T.duplicatesDiscarded += critDups;
    T.duplicateBytes += dupBytes;
    T.criticalBytes += critBytes;
    T.bulkMbit += bulkMbps * dt;

    return {
      throughputMbps: bulkMbps + criticalMbps,
      bulkMbps,
      criticalMbps,
      critical: {
        sent: critSent,
        delivered: critDelivered,
        lost: critLost,
        dups: critDups,
        lossRate: critSent ? critLost / critSent : 0,
        windowLossRate: this.criticalWindow.value,
        oneWayMs: meanLat,
        rttMs: Number.isFinite(meanLat) ? 2 * meanLat : NaN,
        jitterMs: critJitter,
      },
      voice,
      perLink,
      flows: flowResults,
      duplicateBytes: dupBytes,
    };
  }
}
