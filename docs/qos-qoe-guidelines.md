# Guidelines for QoS and QoE across heterogeneous networks

This note covers success criterion 05 of the EDGE challenge statement: "create guidelines for improving the quality of service and the quality of experience for the users of the networks".

Each guideline gives:
- **the rule**;
- **the evidence**: measured simulation results from `npm run benchmark`, scenarios A–F, 20 paired runs each. Stacks are compared as in [existing-mechanisms.md](existing-mechanisms.md): Legacy OS, Reactive multipath (MPTCP backup / ATSSS active-standby), Always duplicate (redundant / PDCP duplication) and FlexiPath;
- **how to apply it**;
- **where FlexiPath implements it**.

Every number is a simulation result, not a field measurement.

## How QoS turns into QoE

| What users feel (QoE) | Network causes (QoS) | Metric reported by FlexiPath |
|---|---|---|
| Call drops, frozen apps, re-login | Session reset when the address changes; time with no usable path | Simulated interruption, TCP resets, remote-visible IP changes |
| Choppy voice | Packet loss above the concealment budget, jitter, latency | Voice MOS (ITU-T G.107 E-model), time below MOS 3.6 |
| Lost or late telemetry, safety reactions | Critical packet loss; silence longer than the safety budget | Critical delivery, longest interruption, fail-safe events |
| Video or file stalls | Retransmission timeouts, head-of-line blocking | Bulk HoL stall (TCP model) |
| Battery drain | Radios kept awake or transmitting | Mean radio power, energy per journey |

---

### 1. Anchor the session, not the interface

**Rule.** Keep the identity of every session independent of the access network, so a path change never resets a connection.

**Evidence:**
- Every anchored stack (reactive multipath, always duplicate, FlexiPath) recorded **0 TCP resets** and **0 remote-visible IP changes**.
- Over the same runs the legacy stack recorded **4–21 resets** and **0.9–5.2 IP changes** per journey.
- Anchoring alone removes the legacy interruption (3.7–7.5 s per journey) in every predictable handover (A, B, C, E, F).

**How.** Use any of:
- a tunnel to a static anchor relay (UDP passes middleboxes);
- an MPTCP proxy;
- an ATSSS UPF anchor.

The relay should learn the outer address from the authenticated tunnel packets themselves, so a NAT rebinding or a new lease is not an event the remote side ever sees.

**In FlexiPath:** `RelayTunnelModel.js` (anchor 198.51.100.24).

### 2. Act on the trend, not on the failure

**Rule.** Forecast when the current path will cross its failure level, and start the transition before it does.

**Evidence:**
- FlexiPath acts **1.3–4.6 s before** the path fails.
- Reactive multipath acts 0.3–0.5 s after, and the legacy stack 1.0–2.3 s after.
- Against reactive multipath on the same runs, FlexiPath loses **25–40 % fewer critical packets** (A: 35 vs 54 per journey; D: 160 vs 265). It also lifts voice MOS by 0.07–0.10 (95 % CIs exclude zero).

**How:**
- Regress the primary's signal over ~3 s.
- Project the failure level, here 15 % loss mapped to dBm or dB through the link's PHY curve.
- Trigger at a time to failure under 3 s, confirmed for 200 ms.
- Only extrapolate within ~10–20 dB of the failure level, so probe noise far from the edge is ignored.
- Release the forecast if the trend reverses for 1 s.

**In FlexiPath:** `FlexiPathController._predict` / `_watch`.

### 3. Prepare the next path just in time, and only then

**Rule.** Let spare radios sleep. Wake one when degradation is predicted, and validate it before trusting it.

**Evidence:**
- FlexiPath's mean radio power is **1.25–1.32 W**.
- A design that keeps two radios transmitting (always duplicate) draws **2.65–3.39 W**, 2.1–2.6× as much.
- The price of preparing is about **+0.1 W (≈ 9 %)** over a reactive standby that sleeps until the failure.

**How:**
- Sleep in DRX (signal sampled every 1.28 s) while the primary's health is good.
- Wake a secondary on a predicted degradation, a loss rise above 2 % in 1 s, or health ≤ 75.
- Send 64-byte heartbeats every 100 ms.
- Trust the path after ~0.3 s of measured RTT and loss.
- Return it to DRX after 2 s without a reason.

**In FlexiPath:** `FlexiPathController._radioPlan`, `PowerModel.js`.

### 4. Duplicate only what needs it, only around the handover

**Rule.** Protection is per traffic class and time-boxed. It is neither all-or-nothing nor permanent.

**Evidence:**
- FlexiPath duplicates **0.9–1.4 %** of protected-flow bytes, under 0.01 % of all bytes. Always duplicate duplicates **49–100 %** of protected-flow bytes.
- FlexiPath still delivers **98.2–99.0 %** of critical packets, against 99.0–100 % for always duplicate.
- Bulk is never copied: 0 % overhead in the bulk-only scenario F.

**How:**
- Critical telemetry is copied on both paths for a ~400 ms burst around the switch.
- Voice joins the burst only when its measured loss exceeds its 2 % concealment budget, or failure is under 1 s away.
- Bulk is moved to the new path with delay-compensated pacing instead of being copied. A copy would cost tens of Mbit/s.

**In FlexiPath:** `FlexiPathController` burst logic, `TrafficManager.js`.

### 5. Deliver the first copy; never make real-time traffic wait in order

**Rule.**
- Sequence-number duplicated datagrams. Deliver the first arrival and discard the late copy.
- Keep bulk streams on one healthy path at a time, and pace them across the switch.

**Evidence:**
- The critical and real-time head-of-line stall is **0 ms in every run** (first-copy delivery).
- FlexiPath's bulk HoL peak is **65–257 ms**, against **310–421 ms** for the other three stacks, whose TCP streams sit through retransmission timeouts on a failing path.

**How:**
- Use a 32-bit sequence number with RFC 1982 serial arithmetic and a duplicate window of a few thousand sequence numbers.
- When bulk spans two paths during a burst, send the slower path's segments early by ΔRTT/2.

**In FlexiPath:** `ReorderingBuffer.js`.

### 6. Detect a dead path faster than the application can tolerate

**Rule.** Some failures cannot be predicted, such as an abrupt cell outage. For those, the gap is detection plus waking the fallback, and that sum must stay inside the application's deadline.

**Evidence:** in scenario D's unpredictable 5G outage:
- FlexiPath's gap is **160 ms** (3 missed 20 ms probes = 60 ms, plus a 100 ms DRX wake). That is inside the 300 ms telemetry fail-safe budget.
- A retransmission-timeout detector (250 ms + 100 ms = **350 ms**) exceeds the budget, and the reactive drone hovers.
- The legacy stack is offline for 3.8 s.

**How:**
- Probe the active path at a rate that matches the most demanding flow's deadline.
- Budget explicitly: detection + wake + one RTT < deadline.
- For the strictest flows, accept a warm spare (+0.6 W while warm) or permanent duplication where a 160 ms gap is still too long.

**In FlexiPath:** `failoverDetectMs`, `wakeLatencyS`.

### 7. Hold still unless moving clearly pays

**Rule.** Use hysteresis and dwell times, so a path that briefly looks better does not cause ping-pong handovers.

**Evidence:**
- In scenario D, FlexiPath changes path **3.5 times per journey**, against 4.5 (reactive multipath), 4.7 (always duplicate) and 5.2 (legacy).
- The baselines switch back to Wi-Fi as soon as it is joinable again, then pay for it when it degrades a second time.

**How:**
- Hold down for 3 s after a switch.
- Upgrade to a better path only for a large margin (1.5× its score), well inside coverage (20 dB from the failure level) and after a dwell (1.5 s).

**In FlexiPath:** `holdDownS`, `upgradeRatio`, `upgradeMinMarginDb`, `upgradeDwellS`.

### 8. Measure what users feel, on matched pairs

**Rule.** Judge a mechanism on the experience it produces and on what it costs, not on throughput alone. Compare it on identical conditions.

**Evidence.** In the predictable scenarios, the anchored stacks look alike on interruption: all score 0.00 s. They differ clearly on:
- critical loss: 1–54 packets per journey in A;
- MOS: 4.23–4.38;
- radio power: 1.20–3.39 W.

The difference only shows when all of these are reported together.

**How:**
- Report interruption, critical delivery, voice MOS and time below MOS 3.6, HoL stalls, overhead bytes, radio power and energy.
- Run every stack on the same seeds, route, RF field and fault timing.
- Give paired differences with 95 % confidence intervals instead of a single score or a "winner".

**In FlexiPath:** `ExperimentRunner.js`, `npm run benchmark`, the in-app Experiments panel.

---

## Choosing a design: the trade-off in one table

These are means over scenarios A–D, read from the results table in [existing-mechanisms.md](existing-mechanisms.md).

| | Legacy OS | Reactive multipath | Always duplicate | FlexiPath |
|---|---|---|---|---|
| Interruption per journey | 3.7–16.4 s | 0–0.7 s | 0 s | 0–0.16 s |
| Critical delivered | 77–85 % | 97.0–98.3 % | 99.0–100 % | 98.2–99.0 % |
| Duplicate bytes · protected flows | 0 % | 0 % | 49–100 % | 0.9–1.4 % |
| Mean radio power | 1.22 W | 1.20 W | 2.65–3.39 W | 1.25–1.32 W |
| Use it when… | (baseline) | power matters most and a few lost packets are acceptable | every packet matters and power is no object | critical traffic must survive without paying for two radios all the time |
