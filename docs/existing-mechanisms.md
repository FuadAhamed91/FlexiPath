# Existing seamless-connectivity mechanisms, and what FlexiPath adapts

This note covers success criteria 01, 02 and 04 of the EDGE challenge statement:

- **01**: investigate existing mechanisms.
- **02**: propose an improved or adapted mechanism.
- **04**: compare against the existing mechanisms.

It analyses two key references:

- **Multipath TCP**, with its published Wi-Fi/cellular handover study.
- **3GPP ATSSS**.

Each reference is modelled as a baseline in the simulator, and all four stacks are compared on identical runs. Every number below is a measured simulation result (model, not hardware). See the README section *Data provenance and claims*.

---

## Reference 1 · Multipath TCP (RFC 8684) and its handover modes

**What it is.** Multipath TCP lets one TCP connection use several paths at once.

- Each path is a *subflow* over a different interface, for example Wi-Fi and cellular.
- The application still sees an ordinary TCP socket.
- The first subflow negotiates `MP_CAPABLE`. Further subflows join with `MP_JOIN`, and addresses come and go with `ADD_ADDR` / `REMOVE_ADDR`.
- A subflow can be flagged as **backup** (the `B` bit, changeable with `MP_PRIO`). A backup subflow carries data only when no regular subflow is usable.
- A *scheduler* decides which subflow sends each segment. The common default picks the lowest-RTT subflow with room in its window. Research and out-of-tree schedulers include a **redundant** one that sends every segment on every subflow.
- Lost segments are recovered by TCP, and a dead subflow is noticed through retransmission timeouts (RFC 6298).
- MPTCP is deployed in the Linux kernel (since 5.6) and in Apple's iOS services.

**Handover study.** Paasch et al. (ACM SIGCOMM CellNet 2012) ran Wi-Fi/3G handovers over real networks with the Linux implementation. They compared three modes:

| Mode | How it works |
|---|---|
| **Full-MPTCP** | Subflows on every interface carry data. |
| **Backup** | Subflows are opened on every interface, but only some carry data. |
| **Single-Path** | One subflow at a time; a new one is opened only after the old path fails. |

Their findings:
- MPTCP gives smooth handovers, with reasonable performance even for VoIP.
- MPTCP draws more energy than plain TCP on a smartphone.
- Backup mode saves a little energy over Single-Path on long connections. Single-Path wins on connections shorter than about 10 s.

**Strengths for this challenge:**
- Sessions survive address changes, which removes the TCP resets that break a legacy OS stack.
- The socket API is standard.
- It is already deployed.

**Limitations for this challenge:**
1. **Reactive.** Traffic leaves a path only after the subflow has measurably failed (an RTO, or loss bad enough to stall the window). Nothing anticipates the failure.
2. **Not traffic-aware.** The scheduler duplicates all segments of a connection or none. There is no notion of "copy the critical telemetry, never the video".
3. **TCP only.** Real-time UDP traffic such as voice is outside it. Multipath QUIC addresses this later.
4. **Middleboxes.** Some networks strip MPTCP options, and the connection then falls back to single-path TCP. This is why FlexiPath encapsulates in UDP.
5. **Battery.** Keeping several subflows busy keeps several radios awake (Full-MPTCP). Keeping them idle (Backup) means a wake-up before they can carry traffic.

## Reference 2 · 3GPP ATSSS (TS 23.501 §5.32)

**What it is.** ATSSS stands for Access Traffic Steering, Switching and Splitting.

- It lets a 5G device use **3GPP access (cellular) and non-3GPP access (typically Wi-Fi) at the same time** through one **multi-access PDU session**.
- That session is anchored at a User Plane Function (UPF) in the 5G core. The device keeps one IP address, so sessions continue while traffic moves between accesses.
- Traffic is steered by two functions:
  - **MPTCP**, with a proxy in the UPF, for TCP traffic.
  - **ATSSS-LL**, a lower-layer function, for any traffic. Later phases study multipath QUIC.
- Release 16 defines four **steering modes**:

| Steering mode | Behaviour |
|---|---|
| **Active-Standby** | All traffic uses the active access; the standby access takes traffic only when the active one becomes unavailable. |
| **Smallest Delay** | Traffic goes to the access with the lowest measured RTT. |
| **Load-Balancing** | Traffic is split by configured weights (non-GBR flows only). |
| **Priority-based** | Traffic uses the high-priority access until it is congested or unavailable. |

- A **Performance Measurement Function (PMF)** measures RTT and access availability between the device and the UPF. Switching follows those measurements and their thresholds.

**Strengths for this challenge:**
- Continuity is anchored in the network.
- Rules are per flow (traffic descriptors).
- Operators control it.

**Limitations for this challenge:**
1. **Measurement- and threshold-driven.** It switches when the measured access is already poor or unavailable; nothing predicts the trajectory.
2. **Two access types, operator-bound.** It needs a 5G core and covers 3GPP plus Wi-Fi, not wired docks or LEO satellites in general.
3. **No time-boxed, class-selective duplication** in the Release-16 steering modes.
4. **Idle standby.** A standby access in idle mode must resume before it carries traffic.

## Related mechanisms (briefly)

- **3GPP PDCP packet duplication** (TS 38.323): sends URLLC packets over two radio legs all the time, for reliability. This is the "always duplicate" end of the design space.
- **QUIC connection migration** (RFC 9000 §9): connection IDs let a QUIC connection survive an address change. FlexiPath's anchor relay gives the same property to every flow at the network layer.
- **Prediction for MPTCP handovers**: *Learning Wi-Fi Connection Loss Predictions for Seamless Vertical Handovers Using Multipath TCP* (arXiv:1907.10493) predicts Wi-Fi loss to time an MPTCP handover. Predicting a handover is therefore not new in itself; what is new here is the combination below.

---

## What FlexiPath adapts (criterion 02)

FlexiPath is an adaptation of these mechanisms, not a new protocol:

| Taken from | Kept | Changed in FlexiPath |
|---|---|---|
| MPTCP / ATSSS anchoring | Sessions anchored away from the access network, so no socket resets | A userspace UDP tunnel to an anchor relay. It works across wired, Wi-Fi, 5G and LEO, passes middleboxes, and the relay re-learns the outer address from tunnel packets |
| MPTCP backup subflow / ATSSS Active-Standby | A second path held in reserve | The standby radio **sleeps in DRX** and is **woken only when degradation is predicted**, then validated with heartbeats before it is trusted |
| Redundant scheduler / PDCP duplication | Duplicate packets, first copy delivered, late copy discarded | Duplication is **time-boxed to a ~400 ms burst** around the handover and **class-selective**: critical always, voice only above its 2 % loss budget, bulk never |
| Handover prediction (e.g. arXiv:1907.10493) | Act on a forecast, not on the failure | A 3 s signal trend projects a time to failure. The forecast drives the whole loop (prepare → burst → switch), and every decision is explained |

## How the baselines are modelled

`src/simulation/MultipathController.js` (`MULTIPATH_PARAMS`) contains the two baselines:

- **Reactive multipath** models the MPTCP backup subflow and ATSSS Active-Standby:
  - Sessions are anchored.
  - The standby path is attached, with its radio in DRX.
  - Traffic moves once the active path has lost more than 15 % (EWMA) for one 250 ms retransmission timeout, or has dropped. A drop is detected by the RTO; a dock's carrier loss by the 50 ms interface-down event.
  - The standby radio then needs 100 ms to wake.
  - Traffic switches back after a preferred interface has been joinable for 2 s.
- **Always duplicate** models the MPTCP redundant scheduler and PDCP duplication:
  - Every critical and real-time packet is sent on two joinable paths. Both radios transmit, which is the 3.4 W tier.
  - Bulk rides the primary path.
  - When the primary drops, its twin takes over with no gap.
  - With no protected flows (scenario F) there is nothing to duplicate, so it behaves as reactive multipath.

Both baselines share the legacy stack's measurements, attach thresholds and interface preference (wired > Wi-Fi > 5G > LEO, lowest RTT first). Differences in the results therefore come from the mechanism, not the path choice.

**The parameters favour the baselines:**
- 10 Hz measurements (an ATSSS PMF typically reports less often).
- A Linux-like 250 ms RTO (RFC 6298 recommends a 1 s minimum).
- Perfect anchoring, with no MPTCP fallback and no `MP_JOIN` handshake time.

**Pairing.** All four stacks drive the same route, seed, RF field and fault timing in one engine. Each agent has its own random streams, so adding the baselines leaves the FlexiPath and Legacy results byte-identical.

## Results (criterion 04)

The figures are from `npm run benchmark`: scenarios A–F, 5 seeds × 4 speeds (30–120 km/h), 20 paired runs per scenario, means. Each cell reads **Legacy · Reactive multipath · Always duplicate · FlexiPath**.

| Scenario | Interruption (s) | Critical delivered (%) | Voice MOS | Duplicate bytes, protected flows (%) | Mean radio power (W) | Radio energy (J) |
|---|---|---|---|---|---|---|
| A · Wi-Fi → 5G | 3.80 · 0.00 · 0.00 · 0.00 | 84.9 · 98.3 · 100.0 · 99.0 | 3.71 · 4.23 · 4.38 · 4.30 | 0 · 0 · 99.7 · 1.1 | 1.22 · 1.20 · 3.39 · 1.31 | 42.8 · 35.9 · 101.3 · 38.9 |
| B · Wi-Fi → 5G → LEO | 7.52 · 0.00 · 0.00 · 0.00 | 84.1 · 97.8 · 99.5 · 98.6 | 3.66 · 4.16 · 4.33 · 4.25 | 0 · 0 · 73.4 · 1.2 | 1.22 · 1.20 · 3.13 · 1.31 | 88.1 · 75.4 · 196.0 · 81.7 |
| C · 5G → LEO | 3.73 · 0.00 · 0.00 · 0.00 | 82.8 · 97.5 · 99.3 · 98.2 | 3.59 · 4.12 · 4.30 · 4.22 | 0 · 0 · 64.5 · 1.4 | 1.22 · 1.20 · 2.85 · 1.32 | 43.4 · 37.7 · 89.0 · 40.8 |
| D · Multiple faults | 16.37 · 0.68 · 0.00 · 0.16 | 77.3 · 97.0 · 99.0 · 98.2 | 3.38 · 4.10 · 4.27 · 4.19 | 0 · 0 · 49.0 · 0.9 | 1.22 · 1.20 · 2.65 · 1.25 | 113.6 · 86.1 · 197.8 · 90.7 |
| E · Critical only | 3.80 · 0.00 · 0.00 · 0.00 | 84.9 · 98.3 · 100.0 · 99.0 | 3.71 · 4.23 · 4.38 · 4.30 | 0 · 0 · 99.7 · 1.1 | 1.22 · 1.20 · 3.39 · 1.31 | 42.8 · 35.9 · 101.3 · 38.9 |
| F · Bulk only | 3.80 · 0.00 · 0.00 · 0.00 | — | — | 0 · 0 · 0 · 0 | 1.22 · 1.20 · 1.20 · 1.31 | 36.3 · 35.9 · 35.9 · 38.9 |

| Scenario | Longest interruption (s) | Action vs path failure (s) | Time below MOS 3.6 (s) | Bulk HoL peak (ms) | Critical packets lost per run |
|---|---|---|---|---|---|
| A | 3.80 · 0.00 · 0.00 · 0.00 | +1.43 · +0.42 · +0.28 · −3.38 | 6.6 · 1.4 · 0.0 · 0.0 | 390 · 310 · 360 · 102 | 458 · 54 · 1 · 35 |
| B | 3.80 · 0.00 · 0.00 · 0.00 | +1.92 · +0.53 · +0.43 · −3.78 | 14.9 · 4.3 · 0.1 · 0.2 | 411 · 370 · 380 · 133 | 979 · 147 · 37 · 97 |
| C | 3.73 · 0.00 · 0.00 · 0.00 | +2.27 · +0.41 · +0.45 · −4.60 | 8.2 · 2.4 · 0.1 · 0.0 | 394 · 360 · 320 · 65 | 515 · 82 · 26 · 61 |
| D | 3.80 · 0.35 · 0.00 · 0.16 | +1.00 · +0.28 · +0.25 · −1.25 | 27.4 · 6.3 · 0.1 · 1.6 | 421 · 360 · 373 · 257 | 1892 · 265 · 89 · 160 |

Paired differences have 95 % confidence intervals, over 20 pairs per scenario:

- **FlexiPath − Reactive multipath:**
  - Critical delivery: +0.64 ± 0.17 pp (A), +0.79 ± 0.19 (B), +0.70 ± 0.21 (C), +1.22 ± 0.15 (D).
  - MOS: +0.07 to +0.10.
  - Radio power: +0.11 ± 0.01 W in A–C; +0.05 ± 0.02 W in D.
  - Interruption in D: −0.52 ± 0.04 s.
- **FlexiPath − Always duplicate:**
  - Critical delivery: −0.77 ± 0.10 pp (D) to −1.03 ± 0.13 pp (C).
  - MOS: −0.08.
  - Radio power: −2.08 ± 0.01 W (A) to −1.39 ± 0.10 W (D), a reduction of 52–61 %.

**What the comparison shows:**
1. **Anchoring the session matters most.** Every anchored stack (reactive multipath, always duplicate, FlexiPath) removes the legacy interruption in the predictable handovers (A, B, C, E, F). Each also removes all TCP resets and remote-visible IP changes.
2. **Prediction plus a short burst buys the remaining reliability cheaply.** Against reactive multipath, FlexiPath:
   - loses 25–40 % fewer critical packets;
   - keeps voice above MOS 3.6 almost all the time;
   - cuts bulk head-of-line peaks 3–5× in A–C and 1.4× in D;
   - acts 1.3–4.6 s **before** the failure instead of 0.3–0.5 s after.

   It also shrinks the gap of the one unpredictable outage in D from 0.35 s to 0.16 s. That is inside the 300 ms fail-safe budget; the reactive stack's gap exceeds it, which triggers braking. The price is about 0.1 W (≈ 9 %) more radio power, for the warm probe and the 400 ms burst.
3. **Permanent duplication is the most reliable, and the most expensive.** Always duplicate delivers 99.0–100 % with no gaps. It costs 2.65–3.39 W (2.1–2.6× FlexiPath) and duplicates 49–100 % of protected bytes, against FlexiPath's 0.9–1.4 %. FlexiPath keeps 98–99 % of protected packets at less than half of that power.

FlexiPath sits between the two existing designs: near-redundant reliability at near-reactive cost.

## Limits of this comparison

- The baselines are behavioural models of the mechanisms, not the protocols themselves. There is no packet-level MPTCP, PMF or UPF.
- Their detection times are favourable assumptions.
- Power is the same three-tier system model for every stack. It is not per-technology and not measured.
- A measurement with real equipment (e.g. a laptop with Wi-Fi and a 5G dongle running Linux MPTCP) would validate the baseline parameters. The challenge welcomes this but does not require it.

## References

1. A. Ford, C. Raiciu, M. Handley, O. Bonaventure, C. Paasch. *TCP Extensions for Multipath Operation with Multiple Addresses.* RFC 8684, 2020. <https://www.rfc-editor.org/rfc/rfc8684>
2. C. Paasch, G. Detal, F. Duchene, C. Raiciu, O. Bonaventure. *Exploring Mobile/WiFi Handover with Multipath TCP.* ACM SIGCOMM CellNet workshop, 2012. <http://conferences.sigcomm.org/sigcomm/2012/paper/cellnet/p31.pdf>
3. 3GPP TS 23.501, *System architecture for the 5G System*, clause 5.32 (ATSSS). <https://www.3gpp.org/DynaReport/23501.htm>
4. M. Boucadair, O. Bonaventure, M. Piraux et al. *3GPP Access Traffic Steering Switching and Splitting (ATSSS) — Overview for IETF Participants.* draft-bonaventure-quic-atsss-overview-00, 2020. <https://datatracker.ietf.org/doc/html/draft-bonaventure-quic-atsss-overview-00>
5. 3GPP TS 38.323, *NR; Packet Data Convergence Protocol (PDCP) specification* (packet duplication). <https://www.3gpp.org/DynaReport/38323.htm>
6. J. Iyengar, M. Thomson (eds.). *QUIC: A UDP-Based Multiplexed and Secure Transport.* RFC 9000, 2021, §9 Connection Migration. <https://www.rfc-editor.org/rfc/rfc9000#section-9>
7. V. Paxson, M. Allman, J. Chu, M. Sargent. *Computing TCP's Retransmission Timer.* RFC 6298, 2011. <https://www.rfc-editor.org/rfc/rfc6298>
8. *Learning Wi-Fi Connection Loss Predictions for Seamless Vertical Handovers Using Multipath TCP.* arXiv:1907.10493, 2019. <https://arxiv.org/abs/1907.10493>
