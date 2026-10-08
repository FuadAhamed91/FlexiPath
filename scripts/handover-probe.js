#!/usr/bin/env node
/**
 * handover-probe.js — measure one real network change on your own laptop. No simulation is involved.
 *
 *   node scripts/handover-probe.js                     (runs 120 s, or until Ctrl+C)
 *   node scripts/handover-probe.js --duration 180 --interval 100 --host 1.1.1.1
 *
 * Start it on Wi-Fi, then change networks (README, "Real-world check"): for example, switch off the Wi-Fi router
 * and let the laptop fall back to a phone hotspot it already knows. That is the legacy break-before-make case.
 * Two probes run side by side:
 *   • a C2-like datagram flow: one small UDP DNS query to --host every --interval ms (10 Hz by default). The
 *     longest silence between two answers is the interruption, as the simulation measures it;
 *   • a long-lived session: an HTTPS keep-alive connection to https://<host>/cdn-cgi/trace, polled every second.
 *     It shows whether the connection survives the change and whether the address the far end sees changes.
 *
 * Writes results/probe_<stamp>.json. These are REAL-WORLD measurements of one laptop and one change; addresses are
 * masked (first two octets) and never printed in full.
 */
import dgram from 'node:dgram';
import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toJSON, timestampedName } from '../src/utils/Export.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const durationS = Number(opt('duration', 120));
const intervalMs = Number(opt('interval', 100));
const host = opt('host', '1.1.1.1');
const timeoutMs = 1000;
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', opt('out', 'results'));

const t0 = performance.now();
const now = () => performance.now() - t0;
const fmtS = (ms) => `${(ms / 1000).toFixed(2)} s`;
const stamp = () => `t=${(now() / 1000).toFixed(1).padStart(6)} s`;
const mask = (ip) => (ip ? ip.split(/[.:]/).slice(0, 2).join('.') + '.x.x' : null);

// ── C2-like datagram flow: a DNS query for example.com every intervalMs ────────────────────────────────────
const QNAME = Buffer.concat([...'example.com'.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const query = (id) => Buffer.concat([Buffer.from([id >> 8, id & 255, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), QNAME, Buffer.from([0, 1, 0, 1])]);

const probes = []; // { t, rttMs | null }
const pending = new Map(); // id → { t, timer }
const silences = []; // { fromS, toS, ms } between two answers, when longer than 3 intervals
let lastAnswerAt = null;
let longestGapMs = 0; // between any two consecutive answers (≈ the interval when nothing happens)
let quietSince = null;
let nextId = 1;
const udp = dgram.createSocket('udp4');
udp.on('error', () => {}); // a missing route shows up as unanswered probes
udp.on('message', (msg) => {
  if (msg.length < 2) return;
  const id = msg.readUInt16BE(0);
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  const at = now();
  probes.push({ t: Math.round(p.t), rttMs: Math.round((at - p.t) * 10) / 10 });
  if (lastAnswerAt !== null) longestGapMs = Math.max(longestGapMs, at - lastAnswerAt);
  if (lastAnswerAt !== null && at - lastAnswerAt > 3 * intervalMs) {
    silences.push({ fromS: lastAnswerAt / 1000, toS: at / 1000, ms: Math.round(at - lastAnswerAt) });
    console.log(`${stamp()}  C2 probe answered again after ${fmtS(at - lastAnswerAt)} of silence`);
  }
  lastAnswerAt = at;
  quietSince = null;
});
const sendProbe = () => {
  const id = nextId;
  nextId = (nextId % 65535) + 1;
  const t = now();
  const timer = setTimeout(() => {
    pending.delete(id);
    probes.push({ t: Math.round(t), rttMs: null });
    if (quietSince === null && lastAnswerAt !== null) {
      quietSince = lastAnswerAt;
      console.log(`${stamp()}  C2 probe: no answer since ${((lastAnswerAt) / 1000).toFixed(1)} s …`);
    }
  }, timeoutMs);
  pending.set(id, { t, timer });
  udp.send(query(id), 53, host, () => {});
};
const udpTimer = setInterval(sendProbe, intervalMs);

// ── Long-lived session: HTTPS keep-alive, one request a second ────────────────────────────────────────────
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const session = { requests: 0, ok: 0, failed: 0, connections: 0, brokenByError: 0, farEndIpChanges: 0, localAddressChanges: 0, events: [] };
let farEndIp = null;
let localAddress = null;
const sessionEvent = (kind, detail) => {
  session.events.push({ t: Math.round(now()) / 1000, kind, ...detail });
};
const poll = () => {
  session.requests++;
  const req = https.get({ host, path: '/cdn-cgi/trace', agent, timeout: 3000 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      session.ok++;
      const ip = /^ip=(.+)$/m.exec(body)?.[1]?.trim() ?? null;
      if (ip && farEndIp && ip !== farEndIp) {
        session.farEndIpChanges++;
        sessionEvent('far-end-ip-changed', { from: mask(farEndIp), to: mask(ip) });
        console.log(`${stamp()}  session: the far end now sees a different address (${mask(farEndIp)} → ${mask(ip)})`);
      }
      if (ip) farEndIp = ip;
    });
  });
  req.on('socket', (sock) => {
    if (req.reusedSocket) return;
    session.connections++;
    const onConnect = () => {
      const la = sock.localAddress;
      if (localAddress && la && la !== localAddress) {
        session.localAddressChanges++;
        sessionEvent('new-local-address', { from: mask(localAddress), to: mask(la) });
      }
      if (session.connections > 1) {
        sessionEvent('new-connection', { localAddress: mask(la) });
        console.log(`${stamp()}  session: opened a new connection (from ${mask(la)})`);
      }
      localAddress = la ?? localAddress;
    };
    if (sock.connecting) sock.once('connect', onConnect);
    else onConnect();
  });
  req.on('timeout', () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
  req.on('error', (err) => {
    session.failed++;
    const code = err.code ?? err.message;
    if (req.reusedSocket || ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'].includes(code)) {
      session.brokenByError++;
      sessionEvent('connection-broken', { code });
      console.log(`${stamp()}  session: connection broken (${code})`);
    } else {
      sessionEvent('request-failed', { code });
    }
  });
};
const httpTimer = setInterval(poll, 1000);
poll();

// ── Summary ───────────────────────────────────────────────────────────────────────────────────────────────
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearInterval(udpTimer);
  clearInterval(httpTimer);
  for (const p of pending.values()) clearTimeout(p.timer);
  agent.destroy();
  udp.close();
  const answered = probes.filter((p) => p.rttMs !== null);
  const summary = {
    durationS: Math.round(now()) / 1000,
    probeIntervalMs: intervalMs,
    probesSent: probes.length,
    probesAnswered: answered.length,
    medianRttMs: answered.length ? [...answered].sort((a, b) => a.rttMs - b.rttMs)[Math.floor(answered.length / 2)].rttMs : null,
    longestSilenceS: Math.round(longestGapMs) / 1000,
    silencesOver300ms: silences.filter((s) => s.ms > 300).length,
    silencesOver1s: silences.filter((s) => s.ms > 1000).length,
    sessionConnections: session.connections,
    sessionBrokenByError: session.brokenByError,
    farEndIpChanges: session.farEndIpChanges,
    localAddressChanges: session.localAddressChanges,
  };
  console.log('\nSummary (REAL-WORLD measurement, this laptop, this change):');
  console.log(`  longest C2-probe silence: ${summary.longestSilenceS.toFixed(2)} s · silences > 300 ms: ${summary.silencesOver300ms} · > 1 s: ${summary.silencesOver1s}`);
  console.log(`  session: ${summary.sessionConnections} connection(s), broken by an error ${summary.sessionBrokenByError}×, far-end address changed ${summary.farEndIpChanges}×`);
  console.log('  simulated legacy stack, for comparison: a 3.8 s break, its TCP sessions reset, a new remote-visible address');
  mkdirSync(outDir, { recursive: true });
  const file = resolve(outDir, timestampedName('probe', 'json'));
  writeFileSync(file, toJSON({ meta: { tool: 'handover-probe', dataSource: 'real-world', host, generatedAt: new Date().toISOString() }, summary, silences, session, probes }));
  console.log(`wrote ${file}`);
  process.exit(0);
}
console.log(`Probing ${host} every ${intervalMs} ms for ${durationS} s (Ctrl+C to stop early). Change networks now and then.`);
setTimeout(finish, durationS * 1000);
process.on('SIGINT', finish);
