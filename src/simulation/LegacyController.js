/**
 * LegacyController.js — standard OS connection manager (break-before-make).
 *
 * Behaviour modelled on stock Windows / macOS / Android connectivity logic:
 *   • one active interface, chosen by static route metric: eth0 > wlan0 > wwan0 > sat0
 *   • stays "sticky" on the current link until a hard floor is crossed
 *     (Wi-Fi RSSI < −85 dBm, 5G RSRP < −122 dBm ≈ radio-link failure) or carrier drops
 *   • no prediction, no replication: the old link is torn down first, then the
 *     fallback is attached, DHCP runs, and every socket bound to the old source
 *     IP is reset (TCP RST) and must reconnect.
 *
 * Wireless handover stall = 1.0 (detect) + 0.8 (attach) + 0.5 (DHCP/route) + 1.5 (TCP/TLS re-establish) = 3.8 s
 */
import { EWMA } from '../utils/Metrics.js';
import { INTERFACE_IDS, INTERFACE_SPECS } from './LinkModel.js';

const RECONNECT = { key: 'reconnect', label: 'TCP RST → SYN · TLS 1.3 · app re-auth', duration: 1.5 };

export const LEGACY_PARAMS = {
  priority: ['eth0', 'wlan0', 'wwan0', 'sat0'],
  floors: { wlan0: -85, wwan0: -122, sat0: 2 },
  joinThresholds: { wlan0: -75, wwan0: -116, sat0: 4 },
  switchBackDwellS: 2.0,
  signalAlpha: 0.25,
  socketsReset: 4,
  stallPhases: {
    wireless: [
      { key: 'detect', label: 'Link-loss detection (beacon miss / RLF timer)', duration: 1.0 },
      { key: 'attach', label: 'Scan + attach on fallback interface', duration: 0.8 },
      { key: 'dhcp', label: 'DHCP lease + route-table rewrite', duration: 0.5 },
      RECONNECT,
    ],
    wired: [
      { key: 'detect', label: 'Carrier-loss debounce', duration: 0.2 },
      { key: 'dhcp', label: 'Default-route failover', duration: 0.3 },
      RECONNECT,
    ],
    reselect: [{ key: 'dhcp', label: 'Route-metric change (source IP changes)', duration: 0.3 }, RECONNECT],
  },
};

export const LEGACY_WIRELESS_STALL_S = LEGACY_PARAMS.stallPhases.wireless.reduce((a, p) => a + p.duration, 0);

const fmtSig = (id, v) => `${v.toFixed(1)} ${INTERFACE_SPECS[id].signalUnit}`;

export class LegacyController {
  constructor({ params = {}, dt = 0.1 } = {}) {
    this.p = { ...LEGACY_PARAMS, ...params };
    this.dt = dt;
    this.reset();
  }

  reset() {
    this.sig = Object.fromEntries(INTERFACE_IDS.map((id) => [id, new EWMA(this.p.signalAlpha)]));
    this.current = null;
    this.state = 'INIT';
    this.stall = null;
    this.lastStall = null;
    this.stallCount = 0;
    this.handovers = 0;
    this.switchBackTicks = 0;
    this.switchBackTarget = null;
  }

  _rank(id) {
    return this.p.priority.indexOf(id);
  }

  _joinable(id, links) {
    const L = links[id];
    if (!L.up) return false;
    const thr = this.p.joinThresholds[id];
    return thr === undefined || (this.sig[id].value ?? -Infinity) >= thr;
  }

  _pickTarget(links, exclude) {
    const order = this.p.priority.filter((id) => id !== exclude);
    return order.find((id) => this._joinable(id, links)) ?? order.find((id) => links[id].up) ?? null;
  }

  _beginStall(kind, from, reason, t, links, events, forcedTarget = null) {
    const phases = this.p.stallPhases[kind];
    const to = forcedTarget ?? this._pickTarget(links, from);
    this.stall = {
      kind,
      from,
      to,
      reason,
      start: t,
      elapsed: 0,
      phases,
      phaseIndex: 0,
      phaseElapsed: 0,
      total: phases.reduce((a, p) => a + p.duration, 0),
    };
    this.state = 'STALLED';
    this.current = null;
    this.stallCount++;
    this.switchBackTicks = 0;
    events.push({
      level: 'crit',
      code: 'LINK_LOST',
      message: `${reason} → break-before-make · all sockets stalled`,
      from,
      to,
    });
  }

  _advanceStall(links, events) {
    const st = this.stall;
    if (!st.to || !links[st.to].up) {
      const next = this._pickTarget(links, st.from);
      if (!next) {
        if (!st.waiting) events.push({ level: 'crit', code: 'NO_CARRIER', message: 'No carrier on any interface — waiting' });
        st.waiting = true;
        return;
      }
      if (st.to && next !== st.to) {
        events.push({ level: 'warn', code: 'RETRY', message: `${st.to} unavailable during attach → retrying on ${next}` });
      }
      st.to = next;
      st.waiting = false;
    }

    st.elapsed += this.dt;
    st.phaseElapsed += this.dt;
    while (st.phaseIndex < st.phases.length && st.phaseElapsed >= st.phases[st.phaseIndex].duration - 1e-9) {
      const done = st.phases[st.phaseIndex];
      st.phaseElapsed -= done.duration;
      st.phaseIndex++;
      if (done.key === 'detect') {
        events.push({ level: 'warn', code: 'DETECT', message: `Loss confirmed after ${done.duration.toFixed(1)} s · scanning → ${st.to}` });
      } else if (done.key === 'attach') {
        events.push({ level: 'warn', code: 'ATTACH', message: `${st.to} attached · requesting DHCP lease` });
      } else if (done.key === 'dhcp') {
        events.push({
          level: 'crit',
          code: 'TCP_RST',
          message: `Route → ${st.to} (metric ${INTERFACE_SPECS[st.to].legacyMetric}) · source IP changed · TCP RST ×${this.p.socketsReset} sockets`,
        });
      }
    }

    if (st.phaseIndex >= st.phases.length) {
      this.current = st.to;
      this.state = 'CONNECTED';
      this.handovers++;
      this.lastStall = { ...st, end: st.start + st.elapsed };
      events.push({
        level: 'info',
        code: 'RECONNECTED',
        message: `Sessions re-established on ${st.to} · stall ${st.elapsed.toFixed(2)} s`,
        from: st.from,
        to: st.to,
      });
      this.stall = null;
    }
  }

  /** The static rule the legacy stack is following right now (shown next to FlexiPath's decisions). */
  _rule() {
    const cur = this.current;
    if (this.state === 'STALLED' && this.stall) return `Break-before-make: ${this.stall.phases[Math.min(this.stall.phaseIndex, this.stall.phases.length - 1)].label}`;
    if (!cur) return 'Waiting for any carrier';
    const floor = this.p.floors[cur];
    const s = INTERFACE_SPECS[cur];
    return floor !== undefined
      ? `Stay on ${cur} until ${s.signalLabel} < ${floor} ${s.signalUnit} (static floor, no prediction)`
      : `Stay on ${cur} until the carrier is lost (static route metric)`;
  }

  update({ t, links }) {
    const events = [];
    for (const id of INTERFACE_IDS) {
      if (links[id].up) this.sig[id].update(links[id].meas.signal);
      else this.sig[id].reset(null);
    }

    if (this.state === 'INIT') {
      const first = this._pickTarget(links, null);
      if (first) {
        this.current = first;
        this.state = 'CONNECTED';
        events.push({ level: 'info', code: 'ATTACH', message: `Default route via ${first} (metric ${INTERFACE_SPECS[first].legacyMetric})` });
      }
    } else if (this.state === 'CONNECTED') {
      const cur = this.current;
      const L = links[cur];
      const floor = this.p.floors[cur];
      const level = this.sig[cur].value;
      if (!L.up) {
        const reason = cur === 'eth0' ? 'eth0 carrier lost (undocked)' : `${cur} link down`;
        this._beginStall(cur === 'eth0' ? 'wired' : 'wireless', cur, reason, t, links, events);
      } else if (floor !== undefined && level !== null && level < floor) {
        const reason = `${cur} ${INTERFACE_SPECS[cur].signalLabel} ${fmtSig(cur, level)} < ${fmtSig(cur, floor)} floor`;
        this._beginStall('wireless', cur, reason, t, links, events);
      } else {
        // Priority switch-back (e.g. Wi-Fi returns after a fade): also a hard reset.
        const better = this.p.priority.find((id) => this._rank(id) < this._rank(cur) && this._joinable(id, links));
        if (better && better === this.switchBackTarget) this.switchBackTicks++;
        else {
          this.switchBackTarget = better ?? null;
          this.switchBackTicks = better ? 1 : 0;
        }
        if (better && this.switchBackTicks * this.dt >= this.p.switchBackDwellS - 1e-9) {
          this._beginStall('reselect', cur, `Preferred interface ${better} available (metric ${INTERFACE_SPECS[better].legacyMetric})`, t, links, events, better);
        }
      }
    } else if (this.state === 'STALLED') {
      this._advanceStall(links, events);
    }

    const stalled = this.state === 'STALLED';
    const st = this.stall;
    return {
      engine: 'legacy',
      state: this.state,
      primary: this.current,
      replica: null,
      replicationActive: false,
      replicate: { CRITICAL: false, REALTIME: false, BULK: false },
      backup: null, // no alternate is prepared: the fallback is only discovered after the failure
      watching: false,
      prepared: null,
      rule: this._rule(),
      records: [],
      lastRecord: null,
      criticalPaths: this.current && !stalled ? [this.current] : [],
      bulkShares: this.current && !stalled ? { [this.current]: 1 } : {},
      blackoutMs: 0,
      stalled,
      stall: st
        ? {
            kind: st.kind,
            from: st.from,
            to: st.to,
            reason: st.reason,
            elapsed: st.elapsed,
            total: st.total,
            remaining: Math.max(0, st.total - st.elapsed),
            phase: st.phases[Math.min(st.phaseIndex, st.phases.length - 1)].key,
            phaseLabel: st.phases[Math.min(st.phaseIndex, st.phases.length - 1)].label,
            waiting: !!st.waiting,
          }
        : null,
      lastStall: this.lastStall,
      scores: null,
      prediction: null,
      events,
    };
  }
}
