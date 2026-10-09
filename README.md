# FlexiPath — Predictive, Traffic-Aware Connectivity Engine

> **ATRC Advanced Technology Pioneers 2026 — EDGE Challenge**
> *"How might we keep a user's experience unbroken as they move between Wi-Fi, mobile, satellite and wired networks?"*

**Don't wait for failure.** FlexiPath predicts when the current path is degrading, prepares the next path before
it is needed, protects only the traffic that actually needs protection, and switches without breaking sessions.

This repository is a **simulation prototype**: a deterministic network simulation, a Three.js digital twin that runs
FlexiPath side by side with a **legacy break-before-make baseline** under identical conditions, an explainable
decision HUD, controlled experiments, and a Blender pipeline that generates every 3D asset. No real-world
measurements are included; every number below is a *measured simulation result* unless marked as a model parameter.

**The scenario.** Two identical drones fly the same low-altitude corridor on the same mission, for example an
inspection or emergency-response flight whose C2 link (flight commands + telemetry) must never drop. Each starts
plugged into its dock (wired Ethernet), takes off over the city on Wi-Fi, follows a 5G corridor and ends in a rural
zone covered only by LEO satellite. On the way it relays the ground team's push-to-talk voice and uploads HD camera
video and survey data. One drone runs FlexiPath, the other the legacy stack, under the same seeded radio field and
faults.

**Phase 2** answers the three engineering objections a multipath design usually meets: **battery drain** (a
three-tier radio sleep model), **packet reordering** (sequence-numbered replication, a TCP head-of-line model and
delay-compensated pacing) and **carrier middleboxes / IP changes** (a userspace UDP tunnel to a static anchor relay).
Each is modelled in the simulation, measured per run and shown in the HUD.

**Route foresight.** A drone flies a planned route, so FlexiPath also reads a **coverage map** of it: the dead zones
earlier survey flights recorded (an urban canyon, a ridge cut). A trend cannot warn of a shadow whose edge is abrupt,
and where Wi-Fi and 5G die at the same place the usual backup dies too. FlexiPath sees a mapped dead zone 8 s ahead,
wakes and validates a path the map says survives it (the satellite), and moves before the shadow. Scenario G tests
this; scenario H tests what an out-of-date map costs.

**Existing mechanisms.** FlexiPath is also compared with two existing seamless-connectivity designs:

- **Reactive multipath**: MPTCP with a backup subflow (RFC 8684), or 3GPP ATSSS active-standby.
- **Always duplicate**: the MPTCP redundant scheduler, or 3GPP PDCP duplication.

Both are modelled as baselines and run on the same seeds as FlexiPath and Legacy. The analysis of the references is in
[docs/existing-mechanisms.md](docs/existing-mechanisms.md), and the evidence-based guidelines in
[docs/qos-qoe-guidelines.md](docs/qos-qoe-guidelines.md).

**How the claims are tested.** Besides the baselines, every benchmark flies three **ablations** (FlexiPath with trend
prediction, the duplication burst or the coverage map switched off), reports **prediction precision and recall**, and
can be re-run once on a **held-out block of seeds** never used while building or tuning FlexiPath. The negative results
are reported too: in this model the 400 ms burst adds no measurable reliability, and a stale map costs throughput.

---

## What the demo shows

The site opens on a **landing page** that explains the solution (the problem, the decision loop, the six ideas, the results against existing mechanisms, the guidelines and the real-life plan). **Launch the simulator** opens `simulator.html` on the **Mission view**, kept to the story. The HUD is light (white panels) around the night-time 3D twin. The 3D twin takes most of the screen, with one short column beside it. The header and toolbar are one line each; the decision loop is a one-line stepper where only the active stage shows its text. Fault injection, reset, Experiments and "Why FlexiPath?" are icon buttons with tooltips. The beam legend sits behind a button in the playback bar.

| Area | What it answers |
| --- | --- |
| **Decision loop** — DETECT → PREDICT → PREPARE → REPLICATE → SWITCH → CONTINUE | Which stage the controller is in right now, when it reached each stage, which stages were skipped (e.g. an abrupt outage cannot be predicted), and the radio state each stage runs at (DRX standby, warm probe, burst). |
| **3D twin** | A moonlit night over a real city and desert (press `L` for the original neon digital twin). Two drones on the same corridor; the camera keeps both in frame and an edge marker points to the other drone if it falls out of view. The legacy drone's label shows the distance it has lost. Sleeping modems draw no probe beams (a faint blink marks each DRX signal sample); a warm modem shows dashed heartbeat beams; both beams pulse purple during the burst. |
| **Why did FlexiPath do that?** | The latest decision as a short card — headline, action and reason, beside the rule the legacy stack follows. **Show details** opens the full record (current path, status, alternate, traffic, **radio power tier**) and the decision history. |
| **At a glance** | Which traffic is protected right now (critical, voice, bulk), and FlexiPath vs Legacy on radio power, the longest data stall and client IP changes seen by remote services. **Details** opens the Advanced view. |
| **Legacy vs FlexiPath** | One line of headline numbers. **Show steps** opens both drones' latest transition step by step, timed relative to the moment the path *actually* failed, with the simulated interruption, critical packets lost and failures acted on before they happened. |

The header carries the status, the `SIMULATION` badge, the static **anchor relay** address and the clock.

The **Advanced view** (`M`) keeps the same one-line chrome and holds every panel in one column beside the twin. Tabs
pick one group at a time, and the page remembers the choice:

| Tab | Panels |
| --- | --- |
| **Decision** | The full decision record and its history |
| **Prediction** | Prediction · live (trend, time to failure, next path with its radio state, signal sparkline) and prediction internals (every trigger with its live value and threshold, including the radio wake triggers) |
| **Links** | Interface health (radio power and a radio badge per modem; a modem asleep in DRX shows signal only) |
| **Traffic** | Traffic-aware protection (per flow: class, path, backup, burst or pacing state, overhead) and the flow inspector (sequence numbers, per-flow HoL, pacing offset) |
| **Session** | Battery · ordering · session (radio badges, journey energy, HoL stalls, relay tunnel vs the legacy IP changes) and the relay tunnel (session ID, outer addresses, leases, rebinds) |
| **Controls** · **Log** | Simulation controls, fault injection and exports · the event log |

The **Charts** button opens six 60 s charts under the twin: throughput, latency, loss, MOS, **radio power** and **bulk
HoL stall**. They record the whole run while hidden. The **guided demo** (`D`, `?demo=1`) flies the full mission
(dock → Wi-Fi → 5G → LEO, three handovers) and pauses the simulation at each real moment — the prediction, the
replication burst, the switch, the legacy interruption and its recovery — with a short caption of what is happening,
built from the decision record and the measured values of that tick, and a ring on the dashboard panel where it
shows. Nothing resumes by itself: from a paused moment the visitor resumes the flight, or first walks through every
dashboard — the five Mission panels, then the Advanced view tab by tab, then the six charts — one card per panel,
each ringing that panel and reading its live numbers at that moment; the last card resumes the flight. Hold flight,
the play button and Space pause the running flight the same way. It ends with the result of the mission and a button
for 10 paired trials. **Experiments** (`X`) runs paired trials and shows the
existing-mechanisms comparison on the same runs.

## Measured results (simulation)

`npm run benchmark` runs scenarios A–H, 5 seeds × 4 speeds (30/60/90/120 km/h): 20 paired runs per scenario. In each run
FlexiPath and Legacy fly together on the same seed, route, RF field and fault timing, and by default the two
existing-mechanism baselines and the three FlexiPath ablations fly alongside them. Values are means over the 20 pairs.
The baselines have their own random streams and the ablations replay FlexiPath's, so the FlexiPath and Legacy values
below are identical with or without them (`--baselines none --ablations none`); A–F are unchanged from the release
before G and H were added.

**Continuity**

| Scenario | Simulated interruption (s) LG / FP | Critical packets delivered (%) LG / FP | Voice MOS LG / FP | FP replication overhead: protected / all bytes | Action vs. path failure (s) LG / FP |
| --- | --- | --- | --- | --- | --- |
| A · Wi-Fi → 5G | 3.80 / 0.00 | 84.9 / 99.0 | 3.71 / 4.30 | 1.11 % / 0.005 % | +1.43 / −3.38 |
| B · Wi-Fi → 5G → LEO | 7.52 / 0.00 | 84.1 / 98.6 | 3.66 / 4.25 | 1.24 % / 0.007 % | +1.92 / −3.78 |
| C · 5G degradation → LEO | 3.73 / 0.00 | 82.8 / 98.2 | 3.59 / 4.22 | 1.36 % / 0.009 % | +2.27 / −4.60 |
| D · Multiple degradation | 16.37 / 0.16 | 77.3 / 98.2 | 3.38 / 4.19 | 0.90 % / 0.006 % | +1.00 / −1.25 |
| E · Critical traffic only | 3.80 / 0.00 | 84.9 / 99.0 | 3.71 / 4.30 | 1.11 % / 1.11 % | +1.43 / −3.38 |
| F · Bulk traffic only | 3.80 / 0.00 | — (no packet flows) | — (no voice) | 0 % / 0 % | +1.43 / −3.38 |
| G · Radio shadow on the route | 7.88 / 0.00 | 79.5 / 98.6 | 3.47 / 4.25 | 1.84 % / 0.010 % | +0.41 / −3.15 |
| H · Coverage map out of date | 8.26 / 0.10 | 77.8 / 98.2 | 3.40 / 4.18 | 2.62 % / 0.016 % | +0.58 / −3.47 |

**Battery · ordering · session (Phase 2)**

| Scenario | Mean radio power (W) LG / FP | Radio energy per journey (J) LG / FP | FP burst time (s) | Late duplicates discarded (FP) | Bulk HoL mean (ms) LG / FP | Bulk HoL peak (ms) LG / FP | TCP timeout stalls LG / FP | Client IP changes seen remotely LG / FP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1.216 / 1.315 | 42.8 / 39.0 | 0.40 | 43 | 7.6 / 1.2 | 390 / 102 | 15.0 / 0.5 | 1.00 / 0 |
| B | 1.216 / 1.315 | 88.1 / 81.7 | 0.84 | 102 | 7.8 / 2.5 | 411 / 133 | 27.4 / 0.6 | 1.95 / 0 |
| C | 1.217 / 1.316 | 43.4 / 40.8 | 0.40 | 54 | 8.3 / 3.2 | 394 / 65 | 12.3 / 0.0 | 0.95 / 0 |
| D | 1.221 / 1.254 | 113.6 / 90.7 | 1.00 | 111 | 6.4 / 3.9 | 421 / 257 | 25.8 / 2.2 | 5.20 / 0 |
| E | 1.216 / 1.315 | 42.8 / 39.0 | 0.40 | 43 | — (no bulk) | — | — | 1.00 / 0 |
| F | 1.221 / 1.315 | 36.3 / 39.0 | 0.40 | 0 | 9.1 / 1.1 | 390 / 102 | 15.0 / 0.5 | 1.00 / 0 |
| G | 1.218 / 1.346 | 54.7 / 43.7 | 0.80 | 97 | 4.4 / 2.5 | 267 / 93 | 9.3 / 0.2 | 2.60 / 0 |
| H | 1.220 / 1.388 | 54.6 / 44.8 | 1.18 | 133 | 6.2 / 3.4 | 390 / 197 | 12.3 / 0.7 | 2.70 / 0 |

How to read it:

- **Interruption** is the time every flow was cut off. Each legacy break lasts a model-defined time (3.8 s, see below),
  so this row measures how *often* each stack breaks the session. FlexiPath's 0.16 s in D is an abrupt cell outage that
  no trend predicted: 60 ms detection + 100 ms to wake the sleeping fallback modem from DRX.
- **Action vs. path failure** compares when each stack acted with the instant the path it was leaving actually failed
  (EWMA of the true loss > 15 % or link down). Negative = acted before the failure.
- **Overhead** is replicated bytes / original bytes. Replication is confined to the ~400 ms handoff burst, so it costs
  ≈ 1 % of protected-flow bytes (Phase 1 replicated for the whole risk window: 6–13 %). E (only protected traffic)
  shows the cost side; F shows that bulk traffic is never duplicated. E matches A in every C2 and voice number: in
  this model the uploads never take capacity from C2 or voice, so removing them changes only the bulk and all-traffic
  figures.
- **Radio power**: FlexiPath draws ≈ 8 % more radio power on average than the single-radio legacy stack (1.32 vs
  1.22 W in A–C) — the price of warm-probing the next modem (1.8 W) and of the 400 ms dual-radio burst (3.4 W). Keeping
  both radios on all the time would cost 3.4 W. **Radio energy per journey** is lower for FlexiPath in A–E only because
  the legacy drone stops and hovers (fail-safe) and arrives later; in F (no C2 telemetry, so no hover and identical
  journey times) FlexiPath uses 7 % more energy (39.0 vs 36.3 J). Both are reported.
- **Head-of-line**: the critical / real-time HoL stall is **0 ms in every run** — the receiver delivers the first copy
  of each sequence number and discards the late duplicate. Bulk HoL comes from the TCP model: a loss that fast
  retransmit cannot repair stalls the legacy stream for a retransmission timeout (200–500 ms); FlexiPath's bulk stays on
  a healthy path and is paced across the burst.
- **IP changes**: remote services only ever see FlexiPath's anchor relay; the legacy stack's source address changes at
  every reattach, and each change resets its TCP sessions (4 sockets per break).
- The CSV export adds per-metric standard deviations and the 95 % confidence interval of each paired difference.

### Comparison with existing mechanisms

Same benchmark and runs. The analysis and the full tables, with 95 % confidence intervals, are in
[docs/existing-mechanisms.md](docs/existing-mechanisms.md).

Each cell reads **Legacy · Reactive multipath · Always duplicate · FlexiPath**:
- **Reactive multipath**: MPTCP backup subflow / ATSSS active-standby.
- **Always duplicate**: redundant scheduler / PDCP duplication.

| Scenario | Flights that kept C2 (%) | Interruption (s) | Critical delivered (%) | Voice MOS | Duplicate bytes, protected flows (%) | Mean radio power (W) |
| --- | --- | --- | --- | --- | --- | --- |
| A · Wi-Fi → 5G | 0 · 100 · 100 · 100 | 3.80 · 0.00 · 0.00 · 0.00 | 84.9 · 98.3 · 100.0 · 99.0 | 3.71 · 4.23 · 4.38 · 4.30 | 0 · 0 · 99.7 · 1.1 | 1.22 · 1.20 · 3.39 · 1.31 |
| B · Wi-Fi → 5G → LEO | 0 · 100 · 100 · 100 | 7.52 · 0.00 · 0.00 · 0.00 | 84.1 · 97.8 · 99.5 · 98.6 | 3.66 · 4.16 · 4.33 · 4.25 | 0 · 0 · 73.4 · 1.2 | 1.22 · 1.20 · 3.13 · 1.31 |
| C · 5G degradation → LEO | 0 · 100 · 100 · 100 | 3.73 · 0.00 · 0.00 · 0.00 | 82.8 · 97.5 · 99.3 · 98.2 | 3.59 · 4.12 · 4.30 · 4.22 | 0 · 0 · 64.5 · 1.4 | 1.22 · 1.20 · 2.85 · 1.32 |
| D · Multiple degradation | 0 · 0 · 100 · 100 | 16.37 · 0.68 · 0.00 · 0.16 | 77.3 · 97.0 · 99.0 · 98.2 | 3.38 · 4.10 · 4.27 · 4.19 | 0 · 0 · 49.0 · 0.9 | 1.22 · 1.20 · 2.65 · 1.25 |
| E · Critical traffic only | 0 · 100 · 100 · 100 | 3.80 · 0.00 · 0.00 · 0.00 | 84.9 · 98.3 · 100.0 · 99.0 | 3.71 · 4.23 · 4.38 · 4.30 | 0 · 0 · 99.7 · 1.1 | 1.22 · 1.20 · 3.39 · 1.31 |
| F · Bulk traffic only | — (no C2) | 3.80 · 0.00 · 0.00 · 0.00 | — | — | 0 · 0 · 0 · 0 | 1.22 · 1.20 · 1.20 · 1.31 |
| G · Radio shadow on the route | 0 · 0 · 40 · 100 | 7.88 · 0.39 · 0.21 · 0.00 | 79.5 · 97.8 · 99.2 · 98.6 | 3.47 · 4.18 · 4.31 · 4.25 | 0 · 0 · 93.6 · 1.8 | 1.22 · 1.21 · 3.20 · 1.35 |
| H · Coverage map out of date | 0 · 0 · 100 · 100 | 8.26 · 0.35 · 0.00 · 0.10 | 77.8 · 97.5 · 99.8 · 98.2 | 3.40 · 4.14 · 4.37 · 4.18 | 0 · 0 · 93.7 · 2.6 | 1.22 · 1.21 · 3.21 · 1.39 |

"Kept C2" counts the flights in which the C2 link was never silent long enough (> 300 ms, the piloted-flight rule) to
force the fail-safe hover. [The hover rule](#the-hover-rule-piloted-vs-waypoint-flight) below adds the waypoint-flight
rule (1 s) from 3GPP TS 22.125.

- **Anchoring removes the interruption.** Every anchored stack removes the legacy interruption, all TCP resets and all
  remote-visible IP changes in the predictable handovers.
- **Prediction adds the remaining reliability** (the ablation below isolates it). Against reactive multipath, FlexiPath:
  - loses 25–40 % fewer critical packets (+0.6 to +1.2 pp delivery; 95 % CIs exclude zero);
  - raises MOS by 0.07–0.10;
  - halves the unpredictable outage's gap in D (0.16 vs 0.35 s, inside the 300 ms fail-safe budget);
  - acts 1.3–4.6 s before the failure instead of 0.3–0.5 s after.

  The cost is about 0.1 W (≈ 9 %) more radio power.
- **Permanent duplication is the most reliable but the most expensive.** It delivers 99–100 % of critical packets, but
  draws 2.65–3.39 W (2.1–2.6× FlexiPath) and duplicates 49–100 % of protected bytes, against FlexiPath's ~1 %.
- **A shared dead zone defeats the existing designs (G).** Wi-Fi and 5G die at the same place. Under the piloted rule,
  reactive multipath (a 0.35 s gap) hovers on all 20 flights, and always duplicate, whose two copies die together, on
  12 of 20. FlexiPath,
  warned by the coverage map, is on the satellite before the shadow: 0 s gap, C2 kept on all 20 flights. The cost is
  7.5 Mbps less mean throughput than flying without the map, from the extra time on the satellite.
- **An out-of-date map costs, and does not help (H).** FlexiPath moves needlessly at the remembered canyon (21.8 Mbps
  less mean throughput than without the map) and meets the new, unmapped shadow with an ordinary failover (0.10 s). It
  still keeps C2, as fast failover does without any map.

![Reliability vs radio power: critical packets delivered against mean radio power for always duplicate, FlexiPath and reactive multipath in scenarios A–D, G and H](public/landing/tradeoff.svg)

FlexiPath sits between the two existing designs. It delivers 0.6–1.2 points more critical packets than reactive
multipath for 0.05–0.18 W more, and 0.6–1.6 points fewer than always duplicate for 2.1–2.6× less power. The chart is drawn
from the benchmark's `_mechanisms.csv` by `node scripts/tradeoff-chart.js`. E is left out (its C2 numbers equal A's)
and so is F (no C2 traffic).

**Reliability per extra watt.** Divide what a stack gains in critical delivery by the radio power it adds over its
neighbour on the power axis. These are paired means; the benchmark writes them to `_efficiency.csv`.

| Scenario | FlexiPath over reactive multipath | Always duplicate over FlexiPath |
| --- | --- | --- |
| A | +0.64 pp for +0.11 W = **5.7 pp/W** | +1.00 pp for +2.08 W = **0.5 pp/W** |
| B | +0.79 pp for +0.11 W = **7.1 pp/W** | +0.83 pp for +1.81 W = **0.5 pp/W** |
| C | +0.70 pp for +0.11 W = **6.2 pp/W** | +1.03 pp for +1.54 W = **0.7 pp/W** |
| D | +1.22 pp for +0.05 W = **24.5 pp/W** | +0.77 pp for +1.39 W = **0.6 pp/W** |
| G | +0.87 pp for +0.14 W = **6.2 pp/W** | +0.55 pp for +1.86 W = **0.3 pp/W** |
| H | +0.73 pp for +0.18 W = **4.0 pp/W** | +1.62 pp for +1.82 W = **0.9 pp/W** |

Spent the FlexiPath way, an extra watt buys 4–7 points of critical delivery. In D it buys 24.5, because there FlexiPath
draws only 0.05 ± 0.02 W more than reactive multipath. Spent on permanent duplication, the same watt buys 0.3–0.9
points. That makes FlexiPath's watts 4.5 to 21 times more productive (44 times in D). A ratio is only as certain as its
two differences; their 95 % confidence intervals are in
[docs/existing-mechanisms.md](docs/existing-mechanisms.md).

### The hover rule: piloted vs waypoint flight

"Kept C2" depends on how long a drone tolerates C2 silence before it hovers. 3GPP TS 22.125 (§7.2, Table 7.2-1, "KPIs
for command and control of UAV operation") sets the requirement per control mode:

| Control mode (3GPP TS 22.125) | C2 message interval | End-to-end latency | Max ground speed | Hover rule used here |
| --- | --- | --- | --- | --- |
| Direct stick steering (piloted, with video) | 40 ms | 40 ms | 60 km/h | 300 ms (default): about 7 missed commands, so more lenient than the standard |
| Steer to waypoints | ≥ 1 s | 1 s | 300 km/h | 1 s (`npm run benchmark -- --failsafe-ms 1000`) |

Flights that kept C2 (%), **Legacy · Reactive multipath · Always duplicate · FlexiPath**, on the same seeds. The 90
and 120 km/h runs are above the stick-steering speed limit, so they belong under the waypoint rule.

| Scenario | Piloted rule (300 ms) | Waypoint rule (1 s) |
| --- | --- | --- |
| A, B, C, E | 0 · 100 · 100 · 100 | 0 · 100 · 100 · 100 |
| D · Multiple degradation | 0 · 0 · 100 · 100 | 0 · 100 · 100 · 100 |
| G · Radio shadow on the route | 0 · 0 · 40 · 100 | 0 · 100 · 100 · 100 |
| H · Coverage map out of date | 0 · 0 · 100 · 100 | 0 · 100 · 100 · 100 |

- **Piloted flight:** FlexiPath is the only stack that keeps C2 on every flight of every scenario. Reactive multipath's
  0.35 s gap (a 250 ms retransmission timeout plus a 100 ms modem wake) makes it hover in D, G and H.
- **Waypoint flight:** every multipath stack keeps C2 everywhere; only the legacy stack's 3.6–3.8 s breaks force a
  hover. FlexiPath's advantage is then the rest of the comparison: the shortest gaps of the low-power stacks (0–0.16 s
  against reactive multipath's 0.35 s in D, G and H), more critical packets delivered than reactive multipath, and
  2.1–2.6× less power than always duplicate.
- **The standard is stricter than both rules.** Its 40 ms stick-steering budget would also catch FlexiPath's 0.16 s gap
  in the abrupt outages of D and H. Only always duplicate rides through an unpredictable outage without a gap, at
  2.1–2.6× the power. The standard also asks for 99.9 % C2 reliability within the latency; in this model, which never
  retransmits a lost C2 datagram, only always duplicate comes close (99.0–100 %).
- Under the waypoint rule the multipath stacks' delivery and voice numbers move by at most 0.3 points and their power
  by at most 0.01 W: a run ends when the last drone arrives, and the legacy drone now hovers for shorter stretches.

### Ablation: what each part contributes

The same runs fly FlexiPath three more times with one part switched off. The ablations replay FlexiPath's own random
streams (common random numbers), so the radio conditions are identical and any difference comes from the part that was
switched off. Each cell is the change in critical packets lost per flight when the part is off (mean ± 95 % CI over the
20 pairs; + = worse without it).

| Scenario | No trend prediction | No 400 ms burst | No coverage map |
| --- | --- | --- | --- |
| A · Wi-Fi → 5G | +10.2 ± 4.6 | −2.3 ± 2.0 | identical (nothing on the map) |
| B · Wi-Fi → 5G → LEO | +30.1 ± 8.5 | −1.6 ± 3.1 | identical |
| C · 5G → LEO | +16.9 ± 6.5 | +0.5 ± 1.5 | identical |
| D · Multiple faults | +19.9 ± 14.3 | 0.0 ± 5.8 | identical |
| E · Critical only | +10.2 ± 4.6 | −2.3 ± 2.0 | identical |
| G · Radio shadow | 0.0 ± 0.3 | +0.4 ± 3.2 | +14.9 ± 4.5, and a 0.20 s gap; 1 flight hovers |
| H · Stale map | +2.6 ± 4.2 | +3.1 ± 3.9 | −15.8 ± 6.8 (the stale map hurts) |

- **Trend prediction does the work in A–E.** Without it FlexiPath reacts to measured trouble only: it acts on 13–40 %
  of the failures before they happen instead of 62–100 %, loses 0.16–0.46 pp more critical packets and 0.01–0.05 MOS,
  and draws slightly *more* power (+0.004 to +0.040 W), because it reacts later and less cleanly.
- **The coverage map does the work in G** (0.20 s → 0 s gap, 15 fewer critical packets lost, +0.05 MOS) at 7.5 Mbps of
  throughput, and costs 21.8 Mbps for nothing when it is out of date (H).
- **The 400 ms burst adds no measurable reliability in this model** (within ±0.1 pp in A–E) and costs 0.02–0.04 W. The
  model has no switch-over transient on the new path (route convergence, NAT binding, a congestion window restarting),
  which is what the burst insures against; it is kept as cheap insurance, and the claim is made no stronger than that.

### Prediction quality

Pooled over all 20 runs of a scenario. **Recall** = path failures FlexiPath acted on before they happened / all path
failures (abrupt ones included). **Precision** = early moves that a real failure of the path followed (within 12 s) /
all early moves. **Lead** = mean time from the action to the failure.

| Scenario | Recall | Recall without trend | Recall without map | Precision | Lead |
| --- | --- | --- | --- | --- | --- |
| A | 100 % | 40 % | 100 % | 100 % | 3.4 s |
| B | 100 % | 25 % | 100 % | 98 % | 3.8 s |
| C | 100 % | 35 % | 100 % | 100 % | 4.6 s |
| D | 62 % | 13 % | 62 % | 97 % | 1.3 s |
| E | 100 % | 40 % | 100 % | 100 % | 3.4 s |
| F | 100 % | 40 % | 100 % | 100 % | 3.4 s |
| G | 100 % | 100 % | 0 % | 100 % | 3.2 s |
| H | 45 % | 44 % | 50 % | 70 % | 3.5 s |

D's recall is 62 % because each flight has one abrupt cell outage that nothing predicts; FlexiPath acts early on 34 of
the 35 predictable failures. In H the stale map's needless move lowers precision to 70 %.

### Held-out seeds

Every number above uses the development seeds (`1000 + 7919·i`), the block FlexiPath was built and tuned on. The whole
benchmark was re-run once on a held-out block (`npm run benchmark -- --seed-block test`: seeds `900001 + 7919·i`, never
used before). The conclusions hold:

| Scenario | FlexiPath − reactive multipath, critical delivery (pp) · dev → test | FlexiPath − always duplicate (pp) · dev → test | Flights FlexiPath kept C2 · dev → test |
| --- | --- | --- | --- |
| A | +0.64 ± 0.17 → +0.76 ± 0.23 | −1.00 ± 0.09 → −0.90 ± 0.09 | 100 % → 100 % |
| B | +0.79 ± 0.18 → +0.75 ± 0.16 | −0.83 ± 0.13 → −0.75 ± 0.06 | 100 % → 100 % |
| C | +0.70 ± 0.21 → +0.58 ± 0.20 | −1.03 ± 0.13 → −0.81 ± 0.16 | 100 % → 100 % |
| D | +1.22 ± 0.15 → +1.09 ± 0.12 | −0.77 ± 0.10 → −0.75 ± 0.07 | 100 % → 100 % |
| G | +0.87 ± 0.15 → +0.84 ± 0.18 | −0.55 ± 0.22 → −0.47 ± 0.23 | 100 % → 100 % |
| H | +0.73 ± 0.23 → +0.76 ± 0.24 | −1.62 ± 0.20 → −1.57 ± 0.14 | 100 % → 100 % |

The ablation and prediction results also carry over (trend prediction: +11 to +25 lost packets per flight when off in
A–E; map: 0.18 s gap when off in G; recall and precision within a few points).

### Checked against published measurements

The challenge welcomes real-world measurements but does not require them. Instead of one laptop test, the model's key
parameters are compared here with published measurements, Linux defaults and 3GPP requirements. The last column says
which way the model leans. Where it leans towards the multipath stacks, the benchmark was re-run with the measured value
(next section).

| What | In the model | Published real-world value | Source | Which way the model leans |
| --- | --- | --- | --- | --- |
| Wi-Fi loss detection (legacy) | 1.0 s | Linux declares a beacon loss after 7 missed beacons (≈ 0.72 s at the usual 102.4 ms interval), then waits 500 ms per probe of the access point before it disconnects | [Linux mac80211][linux-mlme] | Shorter than Linux: generous to the legacy stack |
| Wi-Fi scan + re-association | 0.8 s (scan and attach to the fallback network) | 399.8 ms on average for one card, access point to access point, link layer only; scanning is over 90 % of it | [Mishra et al., 2003][mishra] | Same order; the measured figure leaves out DHCP and the IP layer |
| TCP retransmission timeout (how reactive multipath notices loss) | 250 ms | Linux minimum 200 ms; RFC 6298 recommends at least 1 s | [Linux `tcp.h`][linux-tcp], [RFC 6298][rfc6298] | Between the two |
| Cell-to-cell handover | Not modelled | 76 ms (LTE), 110 ms (5G standalone), 167 ms (5G non-standalone) on average, on US commercial networks; data stops for 59 % of a non-standalone handover | [Hassan et al., SIGCOMM 2022][hassan] | Real flights add ≈ 0.1 s handovers for every stack. FlexiPath's 0.16 s abrupt-outage gap is the size of one such handover |
| Waking a sleeping modem | 100 ms | 260 ms for an LTE phone leaving RRC_IDLE (2012); 3GPP's 5G target from a battery-saving state is 10 ms | [Huang et al., MobiSys 2012][huang], [3GPP TR 38.913 §7.4][tr38913] | Optimistic for an idle LTE modem: re-run with 260 ms below |
| Modem sleep cycle | 1.28 s | 1.28 s (LTE RRC_IDLE DRX cycle) | [Huang et al., 2012][huang] | Matches |
| Cellular radio power | 1.2 W one radio · 1.8 W warm probe · 3.4 W burst (system draw) | 1.06 W (LTE tail), 1.21 W (promotion), up to 3.3 W (fast uplink) | [Huang et al., 2012][huang] | Same order |
| LEO round trip | 65 ms base | Starlink median ≈ 40–50 ms (M-Lab speed tests); ≈ 40 ms from the dish to Starlink's point of presence (RIPE Atlas) | [Mohan et al., WWW 2024][mohan] | Slower than Starlink: conservative for any stack on the satellite |
| LEO path stability | Steady | Network-wide reconfiguration every 15 s, with brief sub-second disruptions | [Mohan et al., 2024][mohan] | Not modelled: real time on the satellite is bumpier |
| LEO terminal power | The same three tiers as the other modems | Starlink Mini: 20–40 W on average, 15 W idle | [Starlink Help Centre][starlink-mini] | Not modelled: time on (or warm on) the satellite costs far more power in reality |
| C2 timing | Hover after 300 ms (piloted) or 1 s (waypoints) | 40 ms per command (stick steering, ≤ 60 km/h); 1 s (waypoints, ≤ 300 km/h) | [3GPP TS 22.125 §7.2][ts22125] | See [The hover rule](#the-hover-rule-piloted-vs-waypoint-flight) |

### Sensitivity: a slower modem wake

`npm run benchmark -- --wake-ms 260` re-runs the benchmark with the measured LTE wake for every multipath stack (260 ms
instead of 100 ms). The legacy stack has no sleeping spare, so its numbers do not change.

| Scenario | Kept C2, piloted rule: 100 → 260 ms wake (LG · MP · RD · FP, %) | Longest gap, FlexiPath / reactive multipath (s) | FlexiPath − reactive multipath, critical delivery (pp, 95 % CI) |
| --- | --- | --- | --- |
| A | unchanged: 0 · 100 · 100 · 100 | 0 / 0 → 0 / 0 | +0.64 ± 0.17 → +0.91 ± 0.27 |
| B | unchanged: 0 · 100 · 100 · 100 | 0 / 0 → 0 / 0 | +0.79 ± 0.18 → +1.08 ± 0.24 |
| C | unchanged: 0 · 100 · 100 · 100 | 0 / 0 → 0 / 0 | +0.70 ± 0.21 → +0.97 ± 0.27 |
| D | 0 · 0 · 100 · 100 → 0 · 0 · 100 · 0 | 0.16 / 0.35 → 0.32 / 0.51 | +1.22 ± 0.15 → +1.47 ± 0.16 |
| G | unchanged: 0 · 0 · 40 · 100 | 0 / 0.35 → 0 / 0.51 | +0.87 ± 0.15 → +1.33 ± 0.18 |
| H | 0 · 0 · 100 · 100 → 0 · 0 · 100 · 20 | 0.10 / 0.35 → 0.26 / 0.51 | +0.73 ± 0.23 → +1.00 ± 0.37 |

- **Predicted failures do not pay the wake.** In A–C and G FlexiPath wakes the next modem seconds before it needs it,
  so nothing changes for it. Reactive multipath pays the full wake on every move: its gaps grow to 0.51 s, and
  FlexiPath's delivery lead grows by a third to a half.
- **Unpredicted failures do.** D's cell outage and H's unmapped shadow cost FlexiPath detection plus the wake, 0.26–0.32
  s. Under the piloted rule it then hovers on all 20 flights of D and 16 of 20 in H; only always duplicate, which never
  waits for a modem, keeps C2 there. Under the waypoint rule (1 s) every multipath stack still keeps C2 in every
  scenario (`--wake-ms 260 --failsafe-ms 1000`).
- **What it means for a design:** a drone flown by stick needs its spare modem in a state that resumes well inside the
  budget (5G RRC_INACTIVE or connected-mode DRX), or permanent duplication of its C2. The model's 100 ms assumes the
  former. This is guideline 6 in [docs/qos-qoe-guidelines.md](docs/qos-qoe-guidelines.md).

[linux-mlme]: https://github.com/torvalds/linux/blob/master/net/mac80211/mlme.c
[linux-tcp]: https://github.com/torvalds/linux/blob/master/include/net/tcp.h
[rfc6298]: https://www.rfc-editor.org/rfc/rfc6298
[mishra]: https://drum.lib.umd.edu/items/05f9c530-8b14-4514-b530-229e1318b219
[hassan]: https://www-users.cse.umn.edu/~fengqian/paper/5g_mobility_sigcomm22.pdf
[huang]: https://doi.org/10.1145/2307636.2307658
[tr38913]: https://www.3gpp.org/DynaReport/38913.htm
[mohan]: https://arxiv.org/abs/2310.09242
[starlink-mini]: https://www.starlink.com/support/article/a7fe6525-5356-a837-48e6-33df176cdbc5
[ts22125]: https://www.3gpp.org/DynaReport/22125.htm

### Guidelines for QoS / QoE

The full guidelines, each with its evidence, are in [docs/qos-qoe-guidelines.md](docs/qos-qoe-guidelines.md):

1. Anchor the session, not the interface.
2. Act on the trend, not on the failure.
3. Prepare the next path just in time, and only then (spare radios in DRX).
4. Duplicate only what needs it, only around the handover.
5. Deliver the first copy; never make real-time traffic wait in order.
6. Detect a dead path faster than the application can tolerate (detection + wake < deadline).
7. Hold still unless moving clearly pays (hysteresis and dwell).
8. Measure what users feel, on matched pairs.
9. Use what you know about the route: prepare before known dead zones, and keep the map current.

---

## How FlexiPath decides

```mermaid
flowchart LR
  D[DETECT<br/>primary at 10 Hz · others in DRX] --> P[PREDICT<br/>3 s trend → time to failure]
  P --> R[PREPARE<br/>wake → warm probe → validate]
  R --> X[REPLICATE<br/>400 ms burst · critical · RT on need · bulk paced]
  X --> S[SWITCH<br/>end of burst · old radio to DRX]
  S --> C[CONTINUE<br/>relay tunnel keeps sessions]
  C --> D
```

| Stage | Rule in the controller (`FlexiPathController.js`) | Model parameters |
| --- | --- | --- |
| Detect | The primary carries all traffic and is measured at 10 Hz (EWMA of loss, RTT, throughput, signal; the controller never sees the true channel). Every other modem sleeps in 3GPP DRX and reports its signal once per DRX cycle — no RTT or loss, so its score is an estimate. | 10 Hz, α ≈ 0.3, DRX cycle 1.28 s |
| Predict | Early warning: a 3 s regression of the primary's signal projects the 15 %-loss level within 8 s (only within 20 dB of it), or a loss / RTT trigger is already true, or the coverage map shows the primary entering a dead zone within 8 s. | horizon 8 s, margin 20 dB, release 1 s, map look-ahead 8 s |
| Prepare | A secondary is woken when degradation is predicted, the primary's loss rises > 2 % in 1 s, or its health score (critical utility as % of nominal) falls to ≤ 75. After 0.1 s wake-up it sends 64-byte heartbeats every 100 ms; after 0.3 s of heartbeats with loss ≤ 12 % and the best critical score it is the validated next path. | wake 0.1 s, validate 0.3 s, back to DRX after 2 s without a reason |
| Replicate | Act when ΔLoss > 3 %/s, loss > 5 %, RTT drift, time-to-failure (1 s trend, within 10 dB, confirmed 2 ticks) < 3 s, a rapid fade (< −12 dB/s) or dock release — and the validated path beats the primary's predicted score or failure is imminent. Both radios then transmit for the handoff burst. If failure is imminent and the woken modem is not yet validated, it is used anyway (shown as an emergency). | TTF < 3.0 s, burst 400 ms |
| Switch | At the end of the burst the validated path becomes primary and the old radio returns to DRX; 3 s hold-down. Upgrades to a much better path need 1.5× the score, 20 dB inside coverage and 1.5 s of dwell. | 400 ms, 1.5×, 20 dB |
| Continue | Flows ride the relay tunnel to the anchor relay `198.51.100.24`, so no socket is reset; abrupt outages are caught by 3 missed probes (+ a DRX wake if the fallback was asleep). | 60 ms (+ 100 ms) |

Link utility: `W = T^a / (RTT^b · (1 + 12·L²))` — critical `a = 0.4, b = 1.2`, bulk `a = 1.5, b = 0.5`.

### Coverage map (route foresight)

A drone flies a planned route, so FlexiPath also gets a coverage map of it: the stretches where earlier survey flights
lost a link (a radio shadow and its edges, `coverageMapFor` in `Scenarios.js`). It holds persistent geography only;
transient faults such as the Wi-Fi fade or the cell outage are never on it.

- **Look-ahead.** Each tick, FlexiPath checks the map 8 s ahead along the route at its current speed. If the primary
  enters a mapped dead zone, the path is watched (PREDICT), and a path the map says is *not* blocked there is woken and
  validated (PREPARE). That is the satellite when Wi-Fi and 5G are blocked together.
- **Action.** When the zone is less than 3 s away, the map trigger fires like a predicted failure: a protective burst
  onto the survivor, then the switch, before the shadow.
- **Guard rails.** Wake-up, validation, upgrades and failovers never pick a path the map expects to die within the
  look-ahead (a failover may, when nothing else is up). After the zone, the normal upgrade rule brings FlexiPath back.
- **Without a map** nothing changes: scenarios A–F have no mapped zones, so FlexiPath's results there are identical
  with and without it.

### Traffic classes and selective replication

| Class | Flows | Protection | Why |
| --- | --- | --- | --- |
| **CRITICAL** (P1) | C2 link (flight commands + telemetry) | Replicated on both paths during the ~400 ms handoff burst | Loss- and latency-sensitive; small (≈ 0.3 Mbit/s) |
| **REAL-TIME** (P2) | Push-to-talk voice (G.711, 20 ms) | Joins the burst only once its measured loss exceeds 2 % or failure is < 1 s away | Packet-loss concealment hides ≤ 2 % loss (< 0.2 MOS); copying earlier is overhead |
| **BULK** (P3+) | HD camera uplink, survey imagery / map sync | Never replicated: carried on the primary (one radio awake) and moved to the next path within the burst with delay-compensated pacing | A copy would add tens of Mbit/s; reliable transport recovers bulk losses |

Every packet of a critical or real-time flow carries a 32-bit sequence number. The receiver delivers the first copy
and discards the late duplicate, so replication never adds head-of-line delay. Overhead is counted per byte:
`replicated bytes / original packet-flow bytes` and `replicated bytes / all bytes`.

### Explainable decisions

Each important decision produces a record (`decision.records`, exported in the JSON): `ATTACH`, `PREDICT`, `PREPARE`,
`PROTECT`, `PROTECT_RT`, `UPGRADE`, `SWITCH`, `FAILOVER`, `NO_PATH`. A record holds the current path and its measured
status, the alternate with its score (marked as an estimate while that modem sleeps), the traffic treatment, the radio
power tier the decision puts the system in, the action and the reason with the thresholds it crossed. Example action:
*"5G modem primed to Warm Probe state (1.8 W): 64-byte heartbeats validate it; replicate critical traffic in a 400 ms
burst if time-to-failure < 3.0 s"*. The predictor computes no confidence score, so none is shown.

### The legacy baseline

Stock OS behaviour: static metric order `eth0 > wlan0 > wwan0 > sat0`, sticky until a hard floor (Wi-Fi **−85 dBm**,
5G RSRP −122 dBm), then break-before-make:

| Phase (model parameter) | Wireless | Wired undock |
| --- | --- | --- |
| Link-loss detection (beacon miss / RLF timer) | 1.0 s | 0.2 s |
| Scan + attach fallback | 0.8 s | — |
| DHCP lease + route rewrite | 0.5 s | 0.3 s |
| TCP RST → SYN · TLS 1.3 · app re-auth | 1.5 s | 1.5 s |
| **Simulated interruption** | **3.8 s** | **2.0 s** |

A preferred interface coming back (e.g. Wi-Fi after a fade) triggers a voluntary switch-back with a 1.8 s interruption.
With the default fail-safe policy, a drone whose C2 telemetry is silent for > 300 ms stops and hovers in place
(simulated lost-link policy, the piloted-flight rule; `--failsafe-ms 1000` gives the waypoint rule, see
[The hover rule](#the-hover-rule-piloted-vs-waypoint-flight)). The legacy stack uses one radio at a time (the others idle in DRX, the scan / attach
phase counts as a second awake radio), binds its sockets to its physical address and runs single-path TCP.

---

## Phase 2 — battery, ordering and carrier transparency

### Battery drain: three-tier radio sleep model (`PowerModel.js`)

| Tier | System draw (model parameter) | When |
| --- | --- | --- |
| 0 · DRX standby | 1.2 W | One radio carries the traffic; every other modem sleeps in 3GPP DRX while the primary's health is > 75. A sleeping modem wakes once per 1.28 s DRX cycle to sample signal only. |
| 1 · Warm probing | 1.8 W | One secondary is awake: woken by a predicted degradation, a > 2 % rise of the primary's loss within 1 s, or primary health ≤ 75. It sends 64-byte heartbeats every 100 ms. |
| 2 · Burst replication | 3.4 W | Both radios transmit — only during the ~400 ms handoff window. |

Power is integrated per tick into energy (J) for each drone until it completes its route. The HUD shows the live
watts and tier, each interface's radio state, journey energy, mean power, time per tier, bursts, wakes and heartbeat
bytes.

### Packet reordering and head-of-line blocking (`ReorderingBuffer.js`)

- **Critical / real-time** — `SequenceReorderBuffer`: 32-bit sequence numbers with RFC 1982 serial arithmetic and a
  4096-sequence duplicate window. First arrival delivered, late duplicate discarded, so the HoL stall is 0 ms by
  construction. As a counterfactual, the buffer also measures how long strict in-order delivery *would* have waited.
- **Bulk (legacy and FlexiPath)** — `TcpHolModel`: a single TCP stream per flow with an RFC 6298 RTT estimator and a
  Mathis-model congestion window (`1.22 / √p`, capped by the bandwidth-delay product). A lost segment is repaired by
  fast retransmit (≈ 1 RTT stall) when the window can produce 3 duplicate ACKs, otherwise by a retransmission timeout
  `max(200 ms, SRTT + 4·RTTVAR)` with at most one back-off — a 200–500 ms stall of the whole byte stream. The mean
  delay added to a byte is `Σ stall² / (2·T)`.
- **Delay-compensated pacing** — while bulk spans two paths during a burst, segments on the slower path are sent ahead
  by the one-way delay difference (ΔRTT / 2); the residual misalignment is the paths' jitter.

### Carrier middleboxes and IP changes (`RelayTunnelModel.js`)

FlexiPath carries every flow in a **userspace UDP tunnel** (48-byte header: IPv6 + UDP + session ID) to an **anchor
relay** at `198.51.100.24:443`. Each interface gets its own address from its network — dock LAN DHCP, Wi-Fi private
DHCP (e.g. `192.168.1.104`), 5G carrier CGNAT (e.g. `100.84.12.9`), LEO operator CGNAT — with a new lease on every
reattach, and carrier NATs rebind the outer port after 30 s idle. The relay re-learns the outer address from the
tunnel packets themselves, so a path change or NAT rebinding is a `REBIND` event and remote services keep seeing the
relay's static address: no TCP reset. UDP encapsulation also passes middleboxes that drop unknown transport protocols.
The legacy stack's sockets are bound to its physical address, so every reattach is a remote-visible source IP change
(`SRC_IP`) and resets its TCP sessions.

---

### Scenarios

| | Scenario | Route X | Faults | Traffic |
| --- | --- | --- | --- | --- |
| · | Full mission (default live view) | 1.5 → 240 | manual | mixed |
| A | Wi-Fi → 5G | 40 → 135 | — | mixed |
| B | Wi-Fi → 5G → LEO | 40 → 240 | — | mixed |
| C | 5G degradation → LEO | 140 → 240 | — | mixed |
| D | Multiple network degradation | 12 → 240 | Wi-Fi fade at X = 30, 5G cell outage at X = 130 | mixed |
| E | Critical traffic during handover | as A | — | critical + real-time |
| F | Bulk traffic during handover | as A | — | bulk only |
| G | Radio shadow on the route | 30 → 135 | urban canyon X = 58–66 blocks Wi-Fi + 5G (on the map) | mixed |
| H | Coverage map out of date | 30 → 135 | the mapped canyon is gone; a new shadow X = 100–108 is not on the map | mixed |

A radio shadow is persistent geography: 60 dB of extra loss on the blocked links with 1-unit (5 m) edges, so Wi-Fi and
5G drop out abruptly while the LEO satellite keeps open sky. The 3D twin draws it as a red volume over the corridor (a
stale map zone as a dashed outline), and the route strip marks both.

Every flight is outbound, from the dock towards the LEO zone. A return flight would cross the same zones in the
opposite order, which turns most handovers into switches back to a better network. That move is already exercised
when 5G comes back after the shadows in G and H (an `UPGRADE`, then a hot-swap off the satellite).

The original benchmark matrix (`baseline`, `wifi-fade`, `cell-outage`) is still available to the CLI and the
experiment panel. Scenarios are defined once in `src/simulation/Scenarios.js` and used by the live twin and the batch
runner alike.

---

## Quick start

```bash
npm install
npm run dev          # landing page http://localhost:5173 · simulator http://localhost:5173/simulator.html
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with the full HUD |
| `npm run build` / `npm run preview` | Production bundle in `dist/` |
| `npm run benchmark` | Paired experiments → `results/benchmark_*.json`, per-run `.csv`, `_comparison.csv`, `_mechanisms.csv`, `_efficiency.csv` (critical delivery per extra watt), `_ablations.csv` and `_prediction.csv` (`--quick`, `--seeds 10`, `--speeds 60`, `--scenarios A,D`, `--no-failsafe`, `--baselines mptcp,redundant` or `none`, `--ablations fpNoPred,fpNoBurst,fpNoMap` or `none`, `--seed-block dev` or `test`, `--failsafe-ms 1000` for the waypoint-flight hover rule) |
| `node scripts/tradeoff-chart.js <_mechanisms.csv>` | Redraw `public/landing/tradeoff.svg` (reliability vs radio power) from a default benchmark |
| `node scripts/handover-probe.js` | Measure one real network change on your own laptop ([Real-world check](#real-world-check-one-network-change-on-your-own-laptop)) |
| `npm run models` | Regenerate the six GLB assets with headless Blender (`blender` on `PATH`) |

Simulator URL parameters (on `simulator.html`; a link to the site root that carries any of them is forwarded to the
simulator): `?scenario=A&seed=2026&speed=90&mode=advanced&focus=legacy&camera=overview&paused=1`, `intro=0` skips
the intro screen, `demo=1` starts the guided demo, `models=procedural` forces the built-in primitive models, `look=twin` starts in the neon digital-twin look.

Keys: `Space` pause · `M` mission / advanced · `D` guided demo (`→` next, `←` back) · `X` experiments · `I` why FlexiPath? · `F` Wi-Fi fade ·
`G` 5G outage · `R` reset · `1`/`2` focus · `C` camera · `V` ghost drone · `T` theatre · `L` real / twin look · `E` export JSON.

### Exports

- **Run JSON** — meta (scenario, seed, data source, anchor relay), model parameters (incl. power, HoL and relay
  parameters), per-engine summary, decision records, episodes, event log and the 10 Hz time series.
- **Run CSV** — one row per tick with both engines side by side (`fp_*`, `lg_*`), including loop stage, primary,
  replica, prepared path, replication flags, cumulative overhead, radio power (W), tier, energy (J), per-interface radio
  states, client and remote-visible IPs, HoL stall, in-order wait and duplicates discarded.
- **Experiments** — per-run rows (mean / peak power in W, energy in J, burst and warm time, duplicates discarded,
  critical and bulk HoL latency, TCP timeout stalls, physical and remote-visible IP changes, tunnel and NAT rebinds,
  next to every continuity metric) and the paired comparison (means, SDs, mean difference, 95 % CI, pairs).

---

## Data provenance and claims

| Label | Meaning |
| --- | --- |
| `MODEL PARAMETER` | Set in the model: thresholds, link capacities, RF constants, legacy recovery phases, radio tier draws (1.2 / 1.8 / 3.4 W), DRX cycle and wake latency, TCP timer bounds, NAT idle timeout, addresses. |
| `MEASURED · SIM` | Measured from simulated runs: interruptions, delivery, MOS, overhead, action-vs-failure times, energy and mean power, HoL stalls, duplicates discarded, IP changes. |
| `REAL-WORLD MEASUREMENT` | None of our own: this is a simulation prototype. The model's key parameters are compared with published measurements ([Checked against published measurements](#checked-against-published-measurements)), and `scripts/handover-probe.js` measures one network change on your own laptop ([below](#real-world-check-one-network-change-on-your-own-laptop)). Report such numbers as real-world, apart from the simulation. |

The HUD labels interruptions as *simulated*, shows a `SIMULATION` badge, and reports differences without a score or
"winner". FlexiPath does not claim zero loss, universal handover or real satellite performance: packets are still lost
(≈ 1–2 % of critical packets in the runs above), an abrupt outage still costs a detection gap (plus a DRX wake), the
radio power is higher than a single-radio stack's, and the RF, satellite and power models are stylised.

### Real-world check: one network change on your own laptop

The challenge welcomes measurements taken with your own equipment. `scripts/handover-probe.js` measures what the legacy
model stands for, an operating system changing networks break-before-make, on a real laptop:

1. Connect the laptop to Wi-Fi. Turn on a phone hotspot, connect to it once so the laptop remembers it, then go back to
   the Wi-Fi.
2. Run `node scripts/handover-probe.js --duration 120`.
3. After about 20 s, switch the Wi-Fi router off or walk out of its range. The laptop falls back to the hotspot on its
   own.
4. Read the summary:
   - the longest silence of a 10 Hz C2-like probe (one small UDP DNS query every 100 ms, to `1.1.1.1` unless `--host`
     says otherwise);
   - whether a long-lived HTTPS session survived;
   - whether the address the far end sees changed.

   The full log goes to `results/probe_<stamp>.json`, with addresses masked.

The simulated legacy stack breaks for 3.8 s, resets its TCP sessions and shows remote services a new address; the probe
shows how a real operating system compares. Its numbers describe one laptop and one network change, not a benchmark.

---

## Architecture

```mermaid
flowchart LR
  subgraph SIM["src/simulation — pure JS, 10 Hz fixed step"]
    SC[Scenarios] --> ENG[SimulationEngine]
    ENV[NetworkEnvironment<br/>4-zone RF + faults] --> LM[LinkModel ×4<br/>per drone]
    MOB[MobilityModel] --> LM
    LM --> FP[FlexiPathController<br/>predict · wake · burst · switch]
    LM --> LG[LegacyController]
    FP --> TM1[TrafficManager<br/>classes · replication · ReorderingBuffer]
    LG --> TM2[TrafficManager]
    FP --> PW1[PowerModel<br/>radio tiers · energy]
    LG --> PW2[PowerModel]
    FP --> RT1[RelayTunnelModel<br/>leases · rebinds]
    LG --> RT2[RelayTunnelModel<br/>no tunnel]
    FP --> DT1[DecisionTrace<br/>loop stages · episodes]
    LG --> DT2[DecisionTrace]
    ENG --> RUN[ExperimentRunner<br/>paired trials]
  end
  SIM -- snapshots / events / decisions --> HUD[src/ui + src/charts]
  SIM -- interpolated render state --> TWIN[src/three digital twin]
```

The simulation never imports the renderer, and the HUD holds no simulation state of its own: the loop stages,
decision records, episodes, radio states, HoL statistics and tunnel addresses are computed in the engine and read from
its snapshots. The same engine drives the 60 fps twin and the headless experiments in Node.

## 3D assets (Blender)

`blender/generate_all_models.py` models, materials and exports all six assets with `bpy` + `bmesh`:

| File | Asset |
| --- | --- |
| `flexipath_drone.glb` | X-frame quadcopter: carbon hull, glowing cyan canopy and prop guards, camera gimbal, multi-link antenna (`AntennaAnchor`), `Rotor_*` pivots |
| `legacy_drone.glb` | the same airframe in crimson / burgundy |
| `wired_node.glb` | pedestal dock terminal, emissive slate terminal ring, `BeamAnchor` |
| `wifi_node.glb` | utility pole with dual-antenna Wi-Fi 6 box (neon cyan) |
| `5g_tower.glb` | hexagonal lattice tower, three down-tilted panel antennas (emerald) |
| `leo_satellite.glb` | CubeSat: gold-foil core, PV wings, downward transponder dish (amber) |

```bash
blender -b -P blender/generate_all_models.py                        # → public/models/
blender -b -P blender/generate_all_models.py -- --out D:/models     # custom output
blender -b -P blender/generate_all_models.py -- --showcase          # also lay them out in a scene
```

Through **Blender MCP** (or the Text Editor) in a running session:

```python
import runpy
runpy.run_path(r"<repo>/blender/generate_all_models.py", run_name="__main__")
```

Each asset is built in its own temporary scene and removed after export. If a GLB is missing, an equivalent procedural
model is built from Three.js primitives, so the twin never fails on assets. Tested with Blender 5.2 LTS.

In the twin, the drones wait on their dock pads, climb out on departure and fly the corridor at a fixed height (about
25 m); the height is visual only (see *Modelling notes and limitations*). A ring on the ground under each drone
carries its state colour (cyan, purple during the burst, red during an interruption) and a faint line joins it to the
drone.

**Two looks** (`L`, the **Real / Twin** button, or `?look=twin`). Both show the same network layer: drones, beams,
packets, coverage rings and labels. The world around it changes.
- **Real** (default) is a moonlit night (`RealWorld.js`):
  - a city on the twin's plots and its own infill (`RealCity.js`), rising to a downtown skyline behind zone 2:
    - towers in blue, bronze, teal or silver glass or stone on stone podiums: round, twin, stepped and classic shafts,
      with LED crowns, spires or pyramid caps, and soft coloured crown lighting on about a third of them;
    - office slabs in concrete, granite or limestone with ribbon windows;
    - residential blocks in sand, white or terracotta render with balconies: plain, L-shaped, terraced or paired;
    - every building with its own wall tint and window light level, from dark to brightly lit;
    - lit shopfronts along the street;
    - low-rise blocks on the camera side, and a city edge behind the dock;
    - red aviation lights on the tall towers and lit helipads on a few roofs;
  - the city beyond the city (`RealSkyline.js`): a distant skyline with lit windows, street lights on the far ground
    and a warm light-pollution glow over the horizon, none over the desert;
  - windows lit floor by floor, with dim night lighting behind the rest so every facade shows its grid;
  - a tarmac road with lane markings, pavements, street lights and date palms through zones 1–3: curved, ringed
    trunks, a crown of feathery fronds in three tiers, and a warm ground uplight under each boulevard palm;
  - ground that turns to desert sand in zone 4, with dunes, the ridge that shadows 5G, date palms and rocks;
  - road-sign gantries at the zone borders, and a concrete dock apron with painted landing pads.

  The network gear is drawn in steel, with its glow cut to status-light level. The drones are painted like
  enterprise drones, each with LED lights under its motors:
  - FlexiPath: white with cyan accents;
  - Legacy: graphite with red.
- **Twin** is the original neon digital twin: grid floor, wireframe city, neon zone gates and neon drones.

Everything in both looks is built procedurally in code, with no image files.

Colours: Wi-Fi `#00F0FF` · 5G `#10B981` · LEO `#F59E0B` · wired `#64748B` · replication `#A855F7` · failure `#EF4444` ·
healthy `#22C55E`.

## Project structure

```
FlexiPath/
├── index.html                          landing page (static; its numbers are copied from the tables above)
├── simulator.html · package.json · vite.config.js
├── blender/generate_all_models.py      procedural asset generator (headless or MCP)
├── docs/                               existing mechanisms (references + comparison) · QoS / QoE guidelines
├── public/models/                      generated GLBs + manifest.json
├── public/landing/                     simulator screenshots for the landing page (WebP, 1200 / 2400 px)
├── scripts/benchmark.js                Node CLI for paired experiments
└── src/
    ├── main.js · styles.css            simulator entry point, Tailwind v4 theme + light HUD components
    ├── landing/                        landing.js · landing.css (the landing page)
    ├── simulation/                     SimulationEngine, Scenarios, NetworkEnvironment, LinkModel, MobilityModel,
    │                                   TrafficManager, FlexiPathController, LegacyController, MultipathController
    │                                   (existing-mechanism baselines), DecisionTrace,
    │                                   PowerModel, ReorderingBuffer, RelayTunnelModel, QoEModel, ExperimentRunner
    ├── three/                          SceneManager, VehicleManager, NetworkNodeManager, BeamManager,
    │                                   PacketParticleManager, EnvironmentManager, RealWorld + RealCity + RealSkyline (realistic look)
    ├── ui/                             Dashboard, SystemLoop, PredictionPanel, DecisionPanel, TrafficPanel,
    │                                   EngineeringPanel, ComparisonLanes, PredictionInternals, TunnelPanel,
    │                                   ExperimentPanel, GuidedDemo, InfoContent, TelemetryPanel, FlowInspector,
    │                                   EventLog, Controls, format
    ├── charts/                         BaseTimeSeriesChart + Throughput / RTT / PacketLoss / QoE / Power / HoL charts
    └── utils/                          Metrics (EWMA, trends), Random (Mulberry32), Export (CSV/JSON)
```

Stack: Vite 8 · Three.js r186 · Chart.js 4 · Tailwind CSS 4 · Lucide.

## Modelling notes and limitations

- **Simulation only.** RF is a calibrated stylised model (path loss + correlated shadowing + AR(1) fast fading), not
  ray-traced; LEO SNR and RTT come from a two-satellite elevation model, not a real constellation.
- Both drones are evaluated on the corridor centre-line, so their large-scale channels are identical; each has its own
  fast-fading and probe-noise streams.
- Legacy recovery durations are model parameters, so interruption totals scale with the number of legacy breaks.
- Packet fate is Bernoulli per packet for critical and real-time flows; bulk flows are fluid (water-filled goodput).
- **Traffic classes do not share capacity**: each flow sees its link's loss and delay on its own, so the uploads never
  slow C2 or voice (which is why E matches A). On a real uplink, bulk traffic queues in front of C2 unless it is
  prioritised.
- **The hover rule** is a model parameter: 300 ms by default (piloted flight), 1 s with `--failsafe-ms 1000` (waypoint
  flight). Which stacks keep C2 depends on it ([The hover rule](#the-hover-rule-piloted-vs-waypoint-flight)).
- **Modem wake** is 100 ms, which assumes a spare modem kept in a fast-resume state; an idle LTE modem measured 260 ms.
  `--wake-ms 260` shows the effect ([Sensitivity](#sensitivity-a-slower-modem-wake)).
- **Not modelled, though measured in the real world** ([Checked against published
  measurements](#checked-against-published-measurements)):
  - cell-to-cell handovers within one technology (76–167 ms on commercial networks);
  - Starlink's 15 s reconfigurations;
  - a LEO terminal's much higher power draw (a Starlink Mini uses 20–40 W).
- The "failure" instant used for action-vs-failure times is a definition (EWMA of true loss > 15 % or link down),
  applied identically to both engines.
- Prediction is a linear trend extrapolation. It cannot foresee abrupt outages (scenario D shows the resulting
  failover gap) and it can release a prediction when a trend reverses — both are shown, not hidden.
- **Power** is three system-level tiers of the radio subsystem (assumptions for an onboard multi-modem radio unit, not
  measurements; propulsion is not modelled): no per-bit transmit-power scaling, no per-technology difference between
  Wi-Fi and cellular modems, no RRC tail states beyond the tiers. A DRX modem's score is estimated from its signal with
  the same PHY curves as the link model, without fading.
- **Head-of-line**: critical and real-time flows are packet-level; bulk TCP is an analytical per-tick model (loss
  repair by fast retransmit or RTO), not a packet-level TCP implementation.
- **Tunnel**: the relay is assumed close to the drone's networks (no extra relay latency); addresses are illustrative
  (`198.51.100.0/24` is RFC 5737 documentation space, `100.64.0.0/10` is RFC 6598 CGNAT space).
- **Drone altitude**: the drones fly a low-altitude corridor above the route, and the radio model is the ground-level
  model evaluated on the corridor centre-line; altitude effects (cell antennas tilted down, line-of-sight interference
  from many cells, air-to-ground fading) are not modelled. The altitude shown in the 3D twin is visual only.
- **Coverage map and shadows**: a shadow is a stylised 60 dB attenuation band, not ray-traced buildings, and the map is a
  list of the dead zones earlier surveys recorded (the scenario decides whether it is current). The map knows only
  persistent geography; it cannot help with a passing fault, and an out-of-date map costs a needless move (H).
- **The duplication burst**: the ablation finds no measurable reliability gain from it in this model, because the model
  has no switch-over transient on the new path. Claims about it are limited to its cost (≈ 1 % of protected bytes,
  0.02–0.04 W).
- **Upgrades** consider only the best-scoring alternative: if it is not deep inside coverage, a deeper but lower-scoring
  path waits (after the canyon in G, FlexiPath returns to 5G only once the fading Wi-Fi drops below it).
- Everything is deterministic per seed: the same seed and inputs reproduce the same run.

## License

Private prototype — no license granted yet (`"license": "UNLICENSED"`). Choose one before publishing.
