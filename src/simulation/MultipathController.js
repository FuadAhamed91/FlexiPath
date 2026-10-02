/**
 * MultipathController.js — two existing seamless-connectivity mechanisms, modelled as comparison
 * baselines next to the legacy OS stack (see docs/existing-mechanisms.md).
 *
 *   Reactive multipath   MPTCP with a backup subflow (RFC 8684, "B" flag) / 3GPP ATSSS active-standby
 *                        steering (TS 23.501 §5.32). Sessions are anchored at a multipath proxy, so a path
 *                        change never resets a socket. The standby path is attached but its radio idles in
 *                        DRX. Traffic moves only after the active path has failed — measured loss above the
 *                        failure level for one retransmission timeout, or the link dropping (noticed by the
 *                        RTO; a dock's carrier loss by the interface-down event) — and the standby radio has
 *                        woken. No prediction, no duplication.
 *   Redundant multipath  MPTCP redundant scheduler / 3GPP PDCP packet duplication (URLLC, TS 38.323).
 *                        Every critical and real-time packet goes out on two paths all the time; bulk rides
 *                        the primary. A single-path failure costs no gap, but both radios transmit
 *                        continuously and protected bytes are doubled.
 *
 * Both see what the other controllers see (measured link values and the up flag) and use the legacy
 * stack's attach thresholds and interface preference (lowest RTT first: wired > Wi-Fi > 5G > LEO), so
 * differences in the results come from the mechanism, not from the path choice. Detection is modelled in
 * the baselines' favour: 10 Hz measurements and a 250 ms retransmission timeout (Linux-like; RFC 6298
 * recommends a 1 s minimum).
 */
import { EWMA } from '../utils/Metrics.js';
import { INTERFACE_IDS, INTERFACE_SPECS, SWITCH_LOSS } from './LinkModel.js';
import { LEGACY_PARAMS } from './LegacyController.js';
import { POWER_PARAMS } from './PowerModel.js';

export const MULTIPATH_PARAMS = {
  priority: [...LEGACY_PARAMS.priority], // lowest RTT first (MPTCP minRTT scheduler / ATSSS priority)
  joinThresholds: { ...LEGACY_PARAMS.joinThresholds }, // the same attach thresholds as the OS
  signalAlpha: LEGACY_PARAMS.signalAlpha,
  failLoss: SWITCH_LOSS, // a path in use counts as failed above 15 % measured loss …
  lossAlpha: 0.3, // … on an EWMA of the 10 Hz measurements …
  rtoS: 0.25, // … for one retransmission timeout; a dropped radio link is also noticed by the RTO
  wiredDetectS: 0.05, // dock carrier loss: the interface-down event closes the subflow at once
  wakeLatencyS: POWER_PARAMS.wakeLatencyS, // a standby radio leaving DRX before it can carry traffic
  switchBackDwellS: LEGACY_PARAMS.switchBackDwellS, // a preferred path must stay joinable this long
};

const isWired = (id) => INTERFACE_SPECS[id]?.tech === 'wired';
const ms = (s) => Math.round(s * 1000);

class MultipathBase {
  constructor({ params = {}, dt = 0.1 } = {}) {
    this.p = { ...MULTIPATH_PARAMS, ...params };
    this.dt = dt;
    this.reset();
  }

  reset() {
    this.sig = Object.fromEntries(INTERFACE_IDS.map((id) => [id, new EWMA(this.p.signalAlpha)]));
    this.loss = Object.fromEntries(INTERFACE_IDS.map((id) => [id, new EWMA(this.p.lossAlpha)]));
    this.overSince = Object.fromEntries(INTERFACE_IDS.map((id) => [id, null]));
    this.primary = null;
    this.state = 'INIT';
    this.awake = new Set(); // radios out of DRX
    this.blackoutUntil = 0;
    this.blackoutTotalMs = 0;
    this.wake = null; // { id, from, until }: a failover target waking after the detection delay
    this.prefTarget = null;
    this.prefTicks = 0;
    this.lastSwitch = null;
  }

  _rank(id) {
    return this.p.priority.indexOf(id);
  }

  /** Signal on every attached interface; measured loss only where traffic flows (a DRX modem reports signal only). */
  _measure(links, t, carrying) {
    for (const id of INTERFACE_IDS) {
      const L = links[id];
      if (!L.up) {
        this.sig[id].reset(null);
        this.loss[id].reset(null);
        this.overSince[id] = null;
        continue;
      }
      this.sig[id].update(L.meas.signal);
      if (carrying.has(id)) {
        const v = this.loss[id].update(L.meas.lossRate);
        if (v > this.p.failLoss) this.overSince[id] ??= t;
        else this.overSince[id] = null;
      } else {
        this.loss[id].reset(null);
        this.overSince[id] = null;
      }
    }
  }

  /** A path in use has failed: link down, or measured loss above the failure level for one RTO. */
  _failing(id, links, t) {
    if (!id) return false;
    if (!links[id].up) return true;
    const since = this.overSince[id];
    return since !== null && t - since >= this.p.rtoS - 1e-9;
  }

  _joinable(id, links) {
    if (!links[id].up) return false;
    const thr = this.p.joinThresholds[id];
    return thr === undefined || (this.sig[id].value ?? -Infinity) >= thr;
  }

  /** Best interface by preference: a joinable one first, otherwise anything with a carrier. */
  _pick(links, exclude = []) {
    const order = this.p.priority.filter((id) => !exclude.includes(id));
    return order.find((id) => this._joinable(id, links)) ?? order.find((id) => links[id].up) ?? null;
  }

  _detectS(id) {
    return isWired(id) ? this.p.wiredDetectS : this.p.rtoS;
  }

  /** Seconds before an interface can carry traffic: a sleeping modem needs its wake-up, a wired port none. */
  _wakeS(id) {
    return isWired(id) || this.awake.has(id) ? 0 : this.p.wakeLatencyS;
  }

  /** Switch-back dwell: returns a preferred interface once it has stayed joinable long enough. */
  _preferred(links, current) {
    const better = this.p.priority.find((id) => this._rank(id) < this._rank(current) && this._joinable(id, links)) ?? null;
    if (better && better === this.prefTarget) this.prefTicks++;
    else {
      this.prefTarget = better;
      this.prefTicks = better ? 1 : 0;
    }
    return better && this.prefTicks * this.dt >= this.p.switchBackDwellS - 1e-9 ? better : null;
  }

  /** Abrupt loss of the path in use: the gap is the detection delay plus the new radio's wake-up. */
  _failover(lost, to, t, events, label) {
    const detectS = this._detectS(lost);
    const wakeS = this._wakeS(to);
    this.blackoutUntil = t + detectS + wakeS;
    this.blackoutTotalMs = ms(detectS + wakeS);
    this.wake = wakeS > 0 ? { id: to, from: t + detectS, until: t + detectS + wakeS } : null;
    const how = isWired(lost) ? 'interface down' : 'retransmission timeout';
    const reason = `${lost} lost · detected after ${ms(detectS)} ms (${how})${wakeS > 0 ? ` + ${ms(wakeS)} ms waking ${to} from DRX` : ''}`;
    this.lastSwitch = { t, from: lost, to, seamless: false, reason, blackoutMs: this.blackoutTotalMs };
    events.push({ level: 'crit', code: 'FAILOVER', message: `FAILOVER ${lost} → ${to} · ${reason} · ${label}`, from: lost, to });
  }

  _blackoutMs(t) {
    return Math.max(0, Math.min(this.dt, this.blackoutUntil - t)) * 1000;
  }

  _waking(id, t) {
    return !!this.wake && this.wake.id === id && t >= this.wake.from - 1e-9 && t < this.wake.until - 1e-9;
  }

  _noPath(events) {
    this.primary = null;
    this.state = 'INIT';
    this.awake = new Set();
    events.push({ level: 'crit', code: 'NO_PATH', message: 'No usable interface' });
  }

  _decision(engine, t, links, fields) {
    return {
      engine,
      state: this.state,
      primary: this.primary,
      watching: false,
      prepared: null,
      rule: this._rule(),
      records: [],
      lastRecord: null,
      pacing: false,
      stalled: !this.primary,
      stall: null,
      scores: null,
      prediction: null,
      lastSwitch: this.lastSwitch,
      blackoutMs: this._blackoutMs(t),
      radio: this._radio(links, t),
      ...fields,
    };
  }
}

/** MPTCP backup subflow / ATSSS active-standby: anchored sessions, reactive switching. */
export class ReactiveMultipathController extends MultipathBase {
  reset() {
    super.reset();
    this.move = null; // { to, readyAt, reason, upgrade }: a planned switch waiting for the target radio
  }

  _rule() {
    if (!this.primary) return 'Waiting for any carrier';
    return `Stay on ${this.primary} until it fails (loss > ${(this.p.failLoss * 100).toFixed(0)} % for one RTO, or link down), then move to the standby subflow`;
  }

  _switch(to, t, events, { from, reason, upgrade = false }) {
    this.primary = to;
    this.awake = new Set([to]);
    this.loss[to].reset(null);
    this.overSince[to] = null;
    this.prefTarget = null;
    this.prefTicks = 0;
    this.lastSwitch = { t, from, to, seamless: true, reason, blackoutMs: 0, upgrade };
    events.push({
      level: upgrade ? 'info' : 'warn',
      code: 'HOT_SWAP',
      message: `${upgrade ? 'SWITCH-BACK' : 'REACTIVE SWITCH'} ${from} → ${to} · ${reason} · session kept on the multipath anchor`,
      from,
      to,
      upgrade,
    });
  }

  _beginMove(to, t, reason, upgrade) {
    this.move = { to, readyAt: t + this._wakeS(to), reason, upgrade };
    this.awake.add(to);
  }

  update({ t, links }) {
    const p = this.p;
    const events = [];
    let blackoutEvent = false;
    this._measure(links, t, new Set(this.primary ? [this.primary] : []));

    if (this.state === 'INIT') {
      const first = this._pick(links);
      if (first) {
        this.primary = first;
        this.state = 'STEADY';
        this.awake = new Set([first]);
        events.push({ level: 'info', code: 'ATTACH', message: `Multipath session on ${first} · standby subflows idle in DRX` });
      }
    } else if (!links[this.primary].up) {
      const lost = this.primary;
      const to = this._pick(links, [lost]);
      this.move = null;
      if (to) {
        this._failover(lost, to, t, events, 'session kept on the multipath anchor');
        blackoutEvent = true;
        this.primary = to;
        this.awake = new Set([to]);
        this.loss[to].reset(null);
        this.overSince[to] = null;
      } else this._noPath(events);
    } else {
      if (this.move && !links[this.move.to].up) this.move = null;
      if (!this.move) {
        if (this._failing(this.primary, links, t)) {
          const to = this._pick(links, [this.primary]);
          if (to) this._beginMove(to, t, `measured loss > ${(p.failLoss * 100).toFixed(0)} % for ${ms(p.rtoS)} ms (one RTO)`, false);
        } else {
          const better = this._preferred(links, this.primary);
          if (better) this._beginMove(better, t, `preferred ${better} joinable for ${p.switchBackDwellS.toFixed(1)} s`, true);
        }
      }
      if (this.move && t >= this.move.readyAt - 1e-9) {
        const m = this.move;
        this.move = null;
        this._switch(m.to, t, events, { from: this.primary, reason: m.reason, upgrade: m.upgrade });
      }
    }

    return this._decision('mptcp', t, links, {
      state: this.move ? 'MOVING' : this.state,
      replica: null,
      replicationActive: false,
      replicate: { CRITICAL: false, REALTIME: false, BULK: false },
      backup: this.move?.to ?? (this.primary ? this._pick(links, [this.primary]) : null),
      criticalPaths: this.primary ? [this.primary] : [],
      bulkShares: this.primary ? { [this.primary]: 1 } : {},
      blackoutEvent,
      blackoutTotalMs: blackoutEvent ? this.blackoutTotalMs : 0,
      events,
    });
  }

  _radio(links, t) {
    const out = {};
    for (const id of INTERFACE_IDS) {
      let s;
      if (!links[id].up) s = 'OFF';
      else if (isWired(id)) s = id === this.primary ? 'ACTIVE' : 'IDLE';
      else if (this.move?.to === id && t < this.move.readyAt - 1e-9) s = 'WAKING';
      else if (id === this.primary) s = this._waking(id, t) ? 'WAKING' : 'ACTIVE';
      else s = 'DRX';
      out[id] = s;
    }
    return out;
  }
}

/** MPTCP redundant scheduler / PDCP duplication: protected traffic always on two paths. */
export class RedundantMultipathController extends MultipathBase {
  /**
   * @param {{params?: object, dt?: number, classes?: {CRITICAL:boolean, REALTIME:boolean, BULK:boolean}}} opts
   */
  constructor({ params = {}, dt = 0.1, classes = { CRITICAL: true, REALTIME: true, BULK: true } } = {}) {
    super({ params, dt });
    // With no critical or real-time flows there is nothing to duplicate: the second radio has no reason to
    // stay awake, so the mechanism reduces to a standby subflow (reactive multipath).
    this.standby = !classes.CRITICAL && !classes.REALTIME ? new ReactiveMultipathController({ params, dt }) : null;
  }

  reset() {
    super.reset();
    this.secondary = null;
    this.readyAt = {}; // interface → time its radio can carry duplicates
    this.benchUntil = {}; // interface → time a path dropped for failing may carry duplicates again
    this.bulkResumeAt = 0;
  }

  /** Second path: a joinable interface that has not just failed (no fallback to a merely-up link). */
  _pickSecond(links, t, exclude) {
    return this.p.priority.find((id) => !exclude.includes(id) && this._joinable(id, links) && !(t < (this.benchUntil[id] ?? -Infinity) - 1e-9)) ?? null;
  }

  _bench(id, t) {
    this.benchUntil[id] = t + this.p.switchBackDwellS;
  }

  _rule() {
    if (!this.primary) return 'Waiting for any carrier';
    return `Send every critical and real-time packet on ${this.primary}${this.secondary ? ` and ${this.secondary}` : ''} at all times; bulk on ${this.primary}`;
  }

  _ready(id, t) {
    return !!id && (this.readyAt[id] ?? Infinity) <= t + 1e-9;
  }

  _promote(to, t, events, { from, reason, upgrade = false }) {
    this.primary = to;
    this.prefTarget = null;
    this.prefTicks = 0;
    this.lastSwitch = { t, from, to, seamless: true, reason, blackoutMs: 0, upgrade };
    events.push({
      level: upgrade ? 'info' : 'warn',
      code: 'HOT_SWAP',
      message: `${upgrade ? 'SWITCH-BACK' : 'PRIMARY SWAP'} ${from} → ${to} · ${reason}`,
      from,
      to,
      upgrade,
    });
  }

  _setSecondary(id, t) {
    if (this.secondary && this.secondary !== id && this.secondary !== this.primary) this.awake.delete(this.secondary);
    this.secondary = id;
    if (!id) return;
    if (!this._ready(id, t) || !this.awake.has(id)) this.readyAt[id] = t + this._wakeS(id);
    this.awake.add(id);
  }

  update(input) {
    if (this.standby) {
      const d = this.standby.update(input);
      return { ...d, engine: 'redundant', rule: 'No critical or real-time flows to duplicate: one radio carries bulk, the standby subflow sleeps in DRX' };
    }
    const { t, links } = input;
    const events = [];
    let blackoutEvent = false;
    this._measure(links, t, new Set([this.primary, this.secondary].filter(Boolean)));

    if (this.state === 'INIT') {
      const first = this._pick(links);
      if (first) {
        this.primary = first;
        this.state = 'STEADY';
        this.awake = new Set([first]);
        this.readyAt = { [first]: t };
        // Boot scan: every radio has just been measured, so the second path starts ready.
        const second = this._pickSecond(links, t, [first]);
        this.secondary = second;
        if (second) {
          this.awake.add(second);
          this.readyAt[second] = t;
        }
        events.push({ level: 'info', code: 'ATTACH', message: `Redundant session on ${first}${second ? ` + ${second}` : ''} · every protected packet sent twice` });
      }
    } else {
      const sec = this.secondary;
      const secReady = !!sec && links[sec].up && this._ready(sec, t) && !this._failing(sec, links, t);
      if (!links[this.primary].up) {
        const lost = this.primary;
        if (secReady) {
          // Every protected packet was already on the second path: promote it with no gap. Bulk rode the
          // lost path and resumes once its subflow's timeout has fired.
          this.bulkResumeAt = t + this._detectS(lost);
          this.awake.delete(lost);
          this._promote(sec, t, events, { from: lost, reason: 'duplicates kept every protected packet flowing' });
          this.secondary = null;
        } else {
          const to = this._pick(links, [lost]);
          if (to) {
            this._failover(lost, to, t, events, 'no second path was ready');
            blackoutEvent = true;
            this.primary = to;
            this.awake = new Set([to]);
            this.readyAt[to] = this.blackoutUntil;
            this.secondary = null;
            this.bulkResumeAt = t;
          } else {
            this._noPath(events);
            this.secondary = null;
          }
        }
      } else if (this._failing(this.primary, links, t) && secReady) {
        const from = this.primary;
        this._promote(sec, t, events, { from, reason: `${from} loss > ${(this.p.failLoss * 100).toFixed(0)} % · the second path already carried every protected packet` });
        this.secondary = null;
        this.awake.delete(from);
        this._bench(from, t);
        this.bulkResumeAt = t;
      }

      if (this.primary) {
        // A second path that dropped or failed is replaced.
        if (this.secondary && (!links[this.secondary].up || this._failing(this.secondary, links, t))) {
          if (links[this.secondary].up) this._bench(this.secondary, t);
          this.awake.delete(this.secondary);
          this.secondary = null;
        }
        // Switch-back: a preferred interface first joins as the second path, then takes over once awake.
        const better = this._preferred(links, this.primary);
        if (better) {
          if (better !== this.secondary) this._setSecondary(better, t);
          else if (this._ready(better, t)) {
            const from = this.primary;
            this._promote(better, t, events, { from, reason: `preferred ${better} joinable for ${this.p.switchBackDwellS.toFixed(1)} s`, upgrade: true });
            this.secondary = null;
            if (links[from].up && !this._failing(from, links, t)) this._setSecondary(from, t);
            else this.awake.delete(from);
          }
        }
        if (!this.secondary) this._setSecondary(this._pickSecond(links, t, [this.primary]), t);
      }
    }

    const second = this.secondary && links[this.secondary].up && this._ready(this.secondary, t) ? this.secondary : null;
    const dup = !!this.primary && !!second;
    return this._decision('redundant', t, links, {
      replica: second,
      replicationActive: dup,
      replicate: { CRITICAL: dup, REALTIME: dup, BULK: false },
      backup: second,
      criticalPaths: this.primary ? (second ? [this.primary, second] : [this.primary]) : [],
      bulkShares: this.primary && t >= this.bulkResumeAt - 1e-9 ? { [this.primary]: 1 } : {},
      blackoutEvent,
      blackoutTotalMs: blackoutEvent ? this.blackoutTotalMs : 0,
      events,
    });
  }

  _radio(links, t) {
    const out = {};
    const wirelessPrimary = !!this.primary && !isWired(this.primary);
    for (const id of INTERFACE_IDS) {
      let s;
      if (!links[id].up) s = 'OFF';
      else if (isWired(id)) s = id === this.primary || id === this.secondary ? 'ACTIVE' : 'IDLE';
      else if (id === this.primary) s = this._waking(id, t) ? 'WAKING' : 'ACTIVE';
      else if (id === this.secondary) s = !this._ready(id, t) ? 'WAKING' : wirelessPrimary ? 'DUAL' : 'ACTIVE';
      else s = 'DRX';
      out[id] = s;
    }
    return out;
  }
}
