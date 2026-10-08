/**
 * NetworkEnvironment.js — spatial layout of the network nodes and the RF
 * propagation physics of the four coverage zones.
 *
 * All received-signal figures are mean (large-scale) values: deterministic path
 * loss plus a spatially correlated log-normal shadowing field. Small-scale fast
 * fading is added per drone in LinkModel.
 *
 *   Wi-Fi 6  : Friis R² free-space loss + linear clutter excess loss (dB/unit)
 *   5G SA    : log-distance (n = 3.8) + urban-canyon shadow near the dock
 *              + terrain diffraction loss behind the rural ridge (zone 4)
 *   LEO sat  : SNR driven by elevation angle to the serving satellite
 *   Wired    : carrier present only while the drone sits on its dock
 */
import { Random, ValueNoise1D } from '../utils/Random.js';
import { smoothstep } from '../utils/Metrics.js';
import { ROUTE_END_X } from './MobilityModel.js';

export const ZONES = [
  {
    id: 1,
    key: 'depot',
    name: 'Dock · Urban Wi-Fi',
    x0: 0,
    x1: 40,
    color: '#00F0FF',
    blurb: 'Wired dock releases; Wi-Fi 6 at peak (≈ −45 dBm).',
  },
  {
    id: 2,
    key: 'corridor',
    name: 'Handover Corridor',
    x0: 40,
    x1: 90,
    color: '#A855F7',
    blurb: 'Wi-Fi attenuates (R² + clutter), 5G rises — prediction & replication fire here.',
  },
  {
    id: 3,
    key: 'core5g',
    name: '5G SA Core',
    x0: 90,
    x1: 160,
    color: '#10B981',
    blurb: '5G dominant; high sustained throughput.',
  },
  {
    id: 4,
    key: 'rural',
    name: 'Rural Dead-Zone · LEO',
    x0: 160,
    x1: ROUTE_END_X,
    color: '#F59E0B',
    blurb: '5G fades behind the ridge; LEO satellite is the persistent fallback.',
  },
];

export function zoneAt(x) {
  if (x < ZONES[0].x0) return ZONES[0];
  for (const z of ZONES) if (x < z.x1) return z;
  return ZONES[ZONES.length - 1];
}

/** Where every node lives in the world (scene units, Y up). */
export const NODE_LAYOUT = {
  eth0: {
    id: 'eth0',
    kind: 'wired',
    model: 'wired_node.glb',
    position: { x: -3.4, y: 0, z: 0 },
    antenna: { x: -3.4, y: 1.7, z: 0 },
  },
  wlan0: {
    id: 'wlan0',
    kind: 'wifi',
    model: 'wifi_node.glb',
    position: { x: 22, y: 0, z: -14 },
    antenna: { x: 22, y: 8.4, z: -14 },
  },
  wwan0: {
    id: 'wwan0',
    kind: 'cellular',
    model: '5g_tower.glb',
    position: { x: 125, y: 0, z: -22 },
    antenna: { x: 125, y: 28.5, z: -22 },
  },
  sat0: {
    id: 'sat0',
    kind: 'satellite',
    model: 'leo_satellite.glb',
    // Two satellites of the constellation drift along +X; the terminal is
    // served by whichever has the higher elevation angle.
    orbit: { altitude: 46, z: -52, speed: 1.6, x0: -40, spacing: 210, wrapMin: -110, wrapMax: 330, count: 2 },
  },
};

export const RF = {
  dock: { releaseX: 2.7 }, // pogo-pin dock contact ends 1.2 units after the docking position
  wifi: { p1: -22.8, clutterDbPerUnit: 0.62, clutterFree: 25, noiseFloor: -95, shadowStd: 1.8, assocFloor: -92 },
  cell: {
    p1: -11.65,
    exponent: 3.8,
    urbanShadowDb: 14,
    terrainStartX: 165,
    terrainDbPerUnit: 0.62,
    terrainMaxDb: 60,
    sinrOffset: 122,
    shadowStd: 2.5,
    detachFloor: -128,
  },
  sat: { snrZenith: 13.5, elevationLossDb: 4.0, baseRtt: 62, rttElevation: 6 },
};

export const FAULTS = {
  'wifi-fade': { label: 'Rapid Wi-Fi fade', rampUp: 1.5, hold: 6.0, rampDown: 2.5, depthDb: 46 },
  'cell-outage': { label: '5G cell outage', duration: 12.0, recover: 1.0 },
};

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class NetworkEnvironment {
  /**
   * @param {{rng?: Random, shadows?: Array<{x0:number, x1:number, edge?:number, links:string[], depthDb:number, label?:string}>}} opts
   *   `shadows` — persistent radio shadows on the route (buildings, terrain), from the scenario.
   */
  constructor({ rng = new Random(1), shadows = [] } = {}) {
    this.rng = rng;
    this.shadow = {
      wlan0: new ValueNoise1D(rng.fork('shadow:wlan0'), { spacing: 7 }),
      wwan0: new ValueNoise1D(rng.fork('shadow:wwan0'), { spacing: 9 }),
    };
    this.radioShadows = shadows.map((s) => ({ edge: 1, ...s }));
    this.reset();
  }

  /** Extra loss (dB) on one link inside a radio shadow: full depth over [x0, x1], ramps of `edge` units. */
  shadowDb(id, x) {
    let db = 0;
    for (const s of this.radioShadows) {
      if (!s.links.includes(id)) continue;
      db += s.depthDb * smoothstep(s.x0 - s.edge, s.x0, x) * (1 - smoothstep(s.x1, s.x1 + s.edge, x));
    }
    return db;
  }

  reset() {
    this.t = 0;
    this.faults = { 'wifi-fade': null, 'cell-outage': null };
    this.satellites = [];
    this._updateSatellites(0);
  }

  /** Advance time-varying state (satellite ephemeris, fault envelopes). */
  update(t) {
    this.t = t;
    this._updateSatellites(t);
    for (const [type, f] of Object.entries(this.faults)) {
      if (f && t > f.end) this.faults[type] = null;
    }
  }

  _updateSatellites(t) {
    const o = NODE_LAYOUT.sat0.orbit;
    const span = o.wrapMax - o.wrapMin;
    this.satellites.length = 0;
    for (let k = 0; k < o.count; k++) {
      const raw = o.x0 + o.speed * t + k * o.spacing;
      const x = ((((raw - o.wrapMin) % span) + span) % span) + o.wrapMin;
      this.satellites.push({ id: `LEO-${k + 1}`, x, y: o.altitude, z: o.z });
    }
  }

  injectFault(type, t) {
    const spec = FAULTS[type];
    if (!spec) throw new Error(`Unknown fault: ${type}`);
    const end = type === 'wifi-fade' ? t + spec.rampUp + spec.hold + spec.rampDown : t + spec.duration + spec.recover;
    this.faults[type] = { type, start: t, end, ...spec };
    return this.faults[type];
  }

  /** Extra attenuation (dB) applied to Wi-Fi by an injected fade. */
  wifiFadeDb(t = this.t) {
    const f = this.faults['wifi-fade'];
    if (!f) return 0;
    const u = t - f.start;
    if (u < 0) return 0;
    if (u < f.rampUp) return f.depthDb * smoothstep(0, f.rampUp, u);
    if (u < f.rampUp + f.hold) return f.depthDb;
    return f.depthDb * (1 - smoothstep(f.rampUp + f.hold, f.rampUp + f.hold + f.rampDown, u));
  }

  /** 0 = cell fully down, 1 = healthy. Abrupt failure, soft restart. */
  cellHealth(t = this.t) {
    const f = this.faults['cell-outage'];
    if (!f) return 1;
    const u = t - f.start;
    if (u < 0) return 1;
    if (u < f.duration) return 0;
    return smoothstep(f.duration, f.duration + f.recover, u);
  }

  /** Mean Wi-Fi RSSI (dBm) at an antenna position. */
  wifiRssi(pos) {
    const c = RF.wifi;
    const d = Math.max(1, dist3(NODE_LAYOUT.wlan0.antenna, pos));
    const friis = c.p1 - 20 * Math.log10(d);
    const clutter = c.clutterDbPerUnit * Math.max(0, d - c.clutterFree);
    const rssi = friis - clutter + c.shadowStd * this.shadow.wlan0.sample(pos.x) - this.wifiFadeDb();
    return this.radioShadows.length ? rssi - this.shadowDb('wlan0', pos.x) : rssi;
  }

  /** Mean 5G RSRP (dBm) at an antenna position. */
  cellRsrp(pos) {
    const c = RF.cell;
    const d = Math.max(1, dist3(NODE_LAYOUT.wwan0.antenna, pos));
    const pathLoss = c.exponent * 10 * Math.log10(d);
    const urban = c.urbanShadowDb * (1 - smoothstep(8, 78, pos.x));
    const over = pos.x - c.terrainStartX;
    const terrain = over > 0 ? Math.min(c.terrainMaxDb, c.terrainDbPerUnit * over * smoothstep(0, 6, over)) : 0;
    const rsrp = c.p1 - pathLoss - urban - terrain + c.shadowStd * this.shadow.wwan0.sample(pos.x);
    return this.radioShadows.length ? rsrp - this.shadowDb('wwan0', pos.x) : rsrp;
  }

  /** Serving LEO satellite (highest elevation) and link geometry. */
  satelliteLink(pos) {
    let best = null;
    for (const sat of this.satellites) {
      const horiz = Math.hypot(sat.x - pos.x, sat.z - pos.z);
      const elev = Math.atan2(sat.y - pos.y, horiz);
      if (!best || elev > best.elevation) best = { sat, elevation: elev };
    }
    const sinEl = Math.sin(best.elevation);
    const snr = RF.sat.snrZenith - RF.sat.elevationLossDb * (1 - sinEl);
    const rtt = RF.sat.baseRtt + RF.sat.rttElevation * (1 - sinEl);
    return { ...best, snr, rtt };
  }

  /**
   * Large-scale signal for one interface at the drone antenna.
   * @param {string} id interface id
   * @param {{x:number,y:number,z:number}} pos centre-line antenna position
   * @param {{docked?: boolean}} vehicle kinematic context
   */
  signal(id, pos, vehicle = {}) {
    switch (id) {
      case 'eth0': {
        const onDock = pos.x < RF.dock.releaseX && !vehicle.finished;
        return { available: onDock, value: onDock ? 1 : 0 };
      }
      case 'wlan0': {
        const dbm = this.wifiRssi(pos);
        return { available: dbm > RF.wifi.assocFloor, value: dbm };
      }
      case 'wwan0': {
        const health = this.cellHealth();
        if (health <= 0) return { available: false, value: -140, outage: true };
        const dbm = this.cellRsrp(pos) - (1 - health) * 30;
        return { available: dbm > RF.cell.detachFloor, value: dbm };
      }
      case 'sat0': {
        const link = this.satelliteLink(pos);
        return {
          available: true,
          value: link.snr,
          rtt: link.rtt,
          elevationDeg: (link.elevation * 180) / Math.PI,
          servingSat: link.sat.id,
        };
      }
      default:
        return { available: false, value: 0 };
    }
  }

  /** Serializable dynamic state for the renderer / UI. */
  get state() {
    return {
      t: this.t,
      satellites: this.satellites.map((s) => ({ ...s })),
      wifiFadeDb: this.wifiFadeDb(),
      cellHealth: this.cellHealth(),
      faults: Object.fromEntries(
        Object.entries(this.faults).map(([k, f]) => [k, f ? { start: f.start, end: f.end } : null]),
      ),
    };
  }

  /** Static description consumed by the 3D layer. */
  static describe() {
    return { zones: ZONES, nodes: NODE_LAYOUT, rf: RF, routeEndX: ROUTE_END_X };
  }
}
