# FlexiPath — Zero-Disruption Heterogeneous Network Mobility

> ATRC Advanced Technology Pioneers 2026 — EDGE Challenge
> *"How might we keep a user's experience unbroken as they move between Wi-Fi, mobile, satellite and wired networks?"*

FlexiPath is an adaptive client-side transport proxy that treats wired, Wi-Fi 6, 5G SA and LEO satellite links as one
score-weighted pipe: it **detects** link health at 10 Hz, **predicts** failure from loss/RTT/signal trends,
**replicates** critical packets over two paths before the old one dies, and **hot-swaps** the primary route behind a
persistent anchor IP (`198.51.100.24`) so no socket is ever reset.

🚧 **Work in progress** — the full README (architecture, maths, run instructions, benchmark results) lands with the
first complete build.
