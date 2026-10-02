/**
 * RelayTunnelModel.js — carrier transparency and session persistence.
 *
 * FlexiPath carries every flow inside a userspace UDP tunnel to an anchor relay. The vehicle's
 * physical address changes with the network it uses (private Wi-Fi DHCP, carrier CGNAT, LEO CGNAT)
 * and carrier NATs rebind ports when a mapping idles out. The relay re-learns the outer address from
 * the authenticated tunnel packets themselves (no handshake), so remote services only ever see the
 * static relay address and no TCP socket is reset by a path change. UDP encapsulation also passes
 * carrier middleboxes that drop unknown transport protocols.
 *
 * The legacy stack binds its sockets to the physical address: every change of interface (or of
 * lease) changes the source IP that remote services see, which resets their TCP connections.
 */

export const RELAY_PARAMS = {
  anchorIp: '198.51.100.24',
  relayPort: 443,
  encapsulation: 'UDP (userspace) · 48-byte header: IPv6 + UDP + session ID',
  natIdleTimeoutS: 30, // carrier NAT mapping lifetime without traffic
};

const POOLS = {
  eth0: { label: 'depot LAN · DHCP', kind: 'private', make: (r) => `10.42.0.${r.int(10, 240)}` },
  wlan0: { label: 'Wi-Fi AP · private DHCP', kind: 'private', make: (r) => `192.168.1.${r.int(100, 199)}` },
  wwan0: { label: '5G carrier · CGNAT', kind: 'cgnat', make: (r) => `100.84.${r.int(1, 254)}.${r.int(2, 254)}` },
  sat0: { label: 'LEO operator · CGNAT', kind: 'cgnat', make: (r) => `100.112.${r.int(1, 254)}.${r.int(2, 254)}` },
};

// First lease of each interface, fixed per vehicle so the demo reads the same every run.
export const FIRST_LEASE = {
  flexipath: { eth0: '10.42.0.17', wlan0: '192.168.1.104', wwan0: '100.84.12.9', sat0: '100.112.47.3' },
  legacy: { eth0: '10.42.0.18', wlan0: '192.168.1.117', wwan0: '100.84.31.77', sat0: '100.112.9.201' },
};

const ACTIVE_RADIO = new Set(['ACTIVE', 'BURST', 'WARM', 'DUAL']);

export class RelayTunnelModel {
  /**
   * @param {{engineId: string, rng: import('../utils/Random.js').Random, tunnel: boolean}} opts
   */
  constructor({ engineId, rng, tunnel }) {
    this.engineId = engineId;
    this.rng = rng;
    this.tunnel = tunnel;
    this.sessionId = `0x${rng.int(0, 0xffffffff).toString(16).padStart(8, '0').toUpperCase()}`;
    this.reset();
  }

  reset() {
    this.leases = {};
    this.wasUp = {};
    this.lastTraffic = {};
    this.outer = null;
    this.outerAll = [];
    this.remoteIp = null;
    this.physicalIpChanges = 0;
    this.remoteIpChanges = 0;
    this.rebinds = 0;
    this.natRebinds = 0;
    this.history = [];
  }

  _newLease(id, t) {
    const prev = this.leases[id];
    const first = !prev;
    const ip = first ? FIRST_LEASE[this.engineId]?.[id] ?? POOLS[id].make(this.rng) : POOLS[id].make(this.rng);
    this.leases[id] = { ip, port: this.rng.int(20000, 60999), since: t, count: (prev?.count ?? 0) + 1, kind: POOLS[id].kind, label: POOLS[id].label };
    return this.leases[id];
  }

  _log(entry) {
    this.history.push(entry);
    if (this.history.length > 12) this.history.shift();
  }

  /**
   * One tick: leases, NAT idle rebinding, outer address of the session and what remote services see.
   * @returns {Array<{level:string, code:string, message:string}>}
   */
  update({ t, links, decision, radio }) {
    const events = [];
    const P = RELAY_PARAMS;

    // Leases: a new address whenever an interface (re)attaches.
    for (const id of Object.keys(POOLS)) {
      const up = !!links[id]?.up;
      if (up && !this.wasUp[id]) {
        const reattach = !!this.leases[id];
        const old = this.leases[id]?.ip;
        const lease = this._newLease(id, t);
        this.lastTraffic[id] = t;
        if (reattach) {
          events.push({ level: 'info', code: 'LEASE', message: `${id} re-attached · new address ${lease.ip} (was ${old}) · ${lease.label}` });
        }
      }
      this.wasUp[id] = up;
    }

    // Carrier NAT mappings expire on idle interfaces; using them again needs a new outer port.
    for (const id of Object.keys(POOLS)) {
      const lease = this.leases[id];
      if (!lease || !links[id]?.up) continue;
      const busy = decision?.primary === id || ACTIVE_RADIO.has(radio?.[id]);
      if (!busy) continue;
      if (t - (this.lastTraffic[id] ?? t) > P.natIdleTimeoutS && lease.kind === 'cgnat' && this.tunnel) {
        const oldPort = lease.port;
        lease.port = this.rng.int(20000, 60999);
        this.natRebinds++;
        events.push({ level: 'info', code: 'NAT_REBIND', message: `${id} NAT mapping expired after idle · outer port ${oldPort} → ${lease.port} · relay re-learned it from the next tunnel packet` });
      }
      this.lastTraffic[id] = t;
    }

    // Outer address(es) of the session: the primary, plus the replica during a burst.
    const prim = decision?.primary ?? null;
    const outer = prim && this.leases[prim] ? { iface: prim, ip: this.leases[prim].ip, port: this.leases[prim].port, kind: this.leases[prim].kind } : null;
    this.outerAll = [prim, decision?.replica].filter((id, i, a) => id && a.indexOf(id) === i && this.leases[id]).map((id) => ({ iface: id, ...this.leases[id] }));

    const prevOuter = this.outer;
    if (outer && prevOuter && (outer.ip !== prevOuter.ip || outer.port !== prevOuter.port)) {
      if (outer.ip !== prevOuter.ip) this.physicalIpChanges++;
      if (this.tunnel) {
        this.rebinds++;
        this._log({ t, from: `${prevOuter.ip}:${prevOuter.port}`, to: `${outer.ip}:${outer.port}`, iface: outer.iface, remote: P.anchorIp });
        events.push({
          level: 'ok',
          code: 'REBIND',
          message: `Tunnel rebound to ${outer.ip}:${outer.port} (${outer.iface}, ${this.leases[outer.iface].label}) · remote services still see ${P.anchorIp} · no socket reset`,
        });
      }
    }
    if (outer) this.outer = outer;

    // What remote services see as the client address.
    let remote;
    if (this.tunnel) remote = this.outer ? P.anchorIp : null;
    else remote = outer ? outer.ip : null; // legacy: sockets bound to the physical address; none while stalled
    if (remote && this.remoteIp && remote !== this.remoteIp) {
      this.remoteIpChanges++;
      this._log({ t, from: this.remoteIp, to: remote, iface: outer?.iface, remote });
      events.push({
        level: 'crit',
        code: 'SRC_IP',
        message: `Remote services now see ${remote} (was ${this.remoteIp}) · source IP changed, existing TCP sessions cannot survive it`,
      });
    }
    if (remote) this.remoteIp = remote;
    return events;
  }

  get state() {
    const o = this.outer;
    return {
      tunnel: this.tunnel,
      sessionId: this.tunnel ? this.sessionId : null,
      anchorIp: RELAY_PARAMS.anchorIp,
      clientIp: o?.ip ?? null,
      clientIface: o?.iface ?? null,
      clientPort: o?.port ?? null,
      clientKind: o?.kind ?? null,
      outer: this.outerAll.map((x) => ({ iface: x.iface, ip: x.ip, port: x.port, kind: x.kind })),
      remoteIp: this.remoteIp,
      leases: Object.fromEntries(Object.entries(this.leases).map(([id, l]) => [id, { ip: l.ip, port: l.port, kind: l.kind, label: l.label, count: l.count }])),
      physicalIpChanges: this.physicalIpChanges,
      remoteIpChanges: this.remoteIpChanges,
      rebinds: this.rebinds,
      natRebinds: this.natRebinds,
      history: this.history.map((h) => ({ ...h })),
    };
  }
}
