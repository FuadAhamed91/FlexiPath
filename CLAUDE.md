# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FlexiPath is a **simulation prototype** of a predictive, traffic-aware multipath connectivity engine. A deterministic
10 Hz simulation flies two drones over the same seeded route, RF field and faults: **FlexiPath** (detect → predict →
prepare → replicate → switch → continue) and a **legacy break-before-make OS stack** as the baseline. The drones carry a
C2 link (critical), push-to-talk voice (real-time) and camera / survey uploads (bulk) from their dock through Wi-Fi, 5G
and LEO zones; the code still calls them vehicles (`agent.vehicle`, `VehicleManager`, `render.vehicles`). A Three.js digital
twin and an explainable HUD render it live; a headless runner produces paired experiments, by default also against two
baselines modelled on existing mechanisms (reactive multipath = MPTCP backup subflow / ATSSS active-standby; always
duplicate = MPTCP redundant scheduler / PDCP duplication) and three FlexiPath ablations (no trend prediction, no
duplication burst, no coverage map). FlexiPath also reads a coverage map of the flight plan (dead zones from earlier
survey flights); scenarios G and H put a radio shadow on the route. Plain ES modules, no framework, no TypeScript. `README.md`
documents the model rules, parameters and published results; `docs/existing-mechanisms.md` and
`docs/qos-qoe-guidelines.md` hold the references analysis, the four-stack comparison and the guidelines.

## Commands

```bash
npm run dev          # Vite dev server: landing page http://localhost:5173, simulator /simulator.html
npm run build        # production bundle → dist/ (base './', sourcemaps on)
npm run preview      # serve dist/ on :4173
npm run benchmark    # headless paired experiments in Node → results/benchmark_<stamp>.{json,csv} + _comparison / _mechanisms / _efficiency / _ablations / _prediction CSVs
npm run models       # regenerate public/models/*.glb (needs `blender` on PATH)
```

There is no test suite, linter or type checker. Verify changes with `npm run build` and the benchmark:

- Narrow runs: `npm run benchmark -- --quick` (3 seeds, 60 km/h), or e.g. `-- --seeds 1 --speeds 60 --scenarios A,D`;
  also `--no-failsafe`, `--out <dir>`, `--baselines mptcp,redundant` (default) or `none`, `--ablations
  fpNoPred,fpNoBurst,fpNoMap` (default) or `none`, and `--seed-block dev` (default: `1000 + 7919·i`, the block FlexiPath
  was tuned on) or `test` (held out: `900001 + 7919·i`), and `--failsafe-ms 1000` (the hover rule, default 300 ms =
  piloted flight; 1000 = waypoint flight, 3GPP TS 22.125) and `--wake-ms 260` (sensitivity: every multipath stack's
  modem wake, default 100 ms; it overrides `POWER_PARAMS` / `MULTIPATH_PARAMS` before the runs). Non-default runs get
  `_failsafe<ms>ms` / `_wake<ms>ms` file names. The default is scenarios A–H × 5 seeds × 30/60/90/120 km/h = 160
  paired runs.
- Runs are deterministic per seed. For a change that must not alter behaviour, benchmark into two `--out` dirs (before
  and after) and compare: both CSVs must be byte-identical; the JSON differs only in `meta` (timestamps, wall time).
  The baselines and ablations never change FlexiPath / Legacy values: a `--baselines none --ablations none` run
  reproduces the FP/LG-only CSVs exactly, and the `fp_` / `lg_` columns of a full run match them. When you add a
  metric, append it to `SUMMARY_METRICS` so earlier CSV columns keep their order, and compare old vs new by column name.
- The README's "Measured results" tables come from the default `npm run benchmark`; when model behaviour changes,
  re-run it and update them, the hover-rule table (re-run with `--failsafe-ms 1000`) and the trade-off chart:
  `node scripts/tradeoff-chart.js results/benchmark_mechanisms_<stamp>.csv` redraws `public/landing/tradeoff.svg`
  (README and landing page).
- `node scripts/handover-probe.js` measures one real network change on the laptop it runs on (README "Real-world
  check"). It is not part of the benchmark; its numbers are real-world and must never be mixed with the simulation's.

In the browser, URL parameters on `simulator.html` give reproducible states (`index.html` forwards any link that carries
one of them to the simulator): `?scenario=A&seed=2026&speed=90&mode=advanced&focus=legacy
&camera=overview&intro=0&paused=1` (`paused` only applies with `intro=0`); `demo=1` starts the guided demo,
`models=procedural` forces the primitive models and `look=twin` starts in the neon look. `window.flexipath` exposes `{ engine, dashboard, sceneManager,
vehicles, nodes, beams, particles }` in the console.

## Architecture

### Simulation (`src/simulation`, pure JS)

- It never imports `three`, `src/ui`, `src/charts` or the DOM: the same engine drives the 60 fps twin and runs headless
  in Node through `ExperimentRunner` / `scripts/benchmark.js`. Keep it that way (the one browser-only helper is
  `downloadText` in `src/utils/Export.js`).
- `SimulationEngine` is the hub. `advance(realDt)` accumulates wall time × `simRate` and runs whole fixed ticks
  (`DT = 0.1 s`, at most 40 per call), returning an interpolation `alpha`; `getRenderState()` interpolates vehicle arc
  length and satellites between `prevSnapshot` and `snapshot` for rendering.
- Agents: `flexipath` and `legacy` always; `config.agents` may add `mptcp` / `redundant` (`BASELINE_ENGINES`) and
  `fpNoPred` / `fpNoBurst` / `fpNoMap` (`ABLATION_ENGINES`: a `FlexiPathController` with `ENGINES[id].params`), which
  the benchmark CLI does by default (the in-app Experiments panel runs the baselines only). The live twin and HUD use
  only the first two; `_capture`, `getSummary` and the exports cover every agent present, and `getRenderState` iterates
  the snapshot's agents.
- One `step()`: scenario faults fire once the FlexiPath vehicle's X passes their `atX` → `env.update(t)` → for each
  agent (`flexipath`, `legacy`, then any baselines): fail-safe check → `MobilityModel.update` → `LinkModel.sample(env.signal(…))` for
  `eth0, wlan0, wwan0, sat0` → `controller.update({ t, links, ctx })` → `TrafficManager.step(decision, links)` →
  `QoEModel` → stats → `PowerTracker.update(decision.radio)` → `RelayTunnelModel.update` → `DecisionTrace.update` →
  decision records; then the snapshot, the history row and the events.
- Both agents share one `NetworkEnvironment` (identical large-scale channel, evaluated on the route centre-line at ground level); each
  has its own fast-fading, probe-noise, traffic and tunnel streams.
- Controllers act on measured values (`links[id].meas`) and the `up` flag; the true link state decides packet fate in
  `TrafficManager`. The `decision` object a controller returns (primary, replica, prepared, per-class `replicate`,
  `bulkShares`, `pacing`, `stalled`, `blackoutMs`, `radio`, `events`, `records`, …) is the contract read by traffic,
  power, tunnel, trace and the engine's stats.
- Engine events: `on('tick' | 'event' | 'decision' | 'reset' | 'complete', fn)`. Snapshot shape:
  `{ t, tick, completed, scenario, env, agents: { flexipath, legacy } }`. `reset()` primes tick 0 silently.
- `_summarizeAgent` defines the per-run metric keys. `SUMMARY_METRICS` / `COMPARISON_METRICS` in `ExperimentRunner`,
  the CSV exports, the Experiments panel (which reads some keys without null checks) and the README tables use them by
  name, so rename everywhere or not at all.
- Scenarios (`mission`, `A`–`H`, the hidden `demo`, and the original matrix `baseline` / `wifi-fade` / `cell-outage`)
  are defined once in `Scenarios.js` and shared by the live twin and the runner. Route X runs 0 → 240 scene units
  (1 unit = 5 m) across four zones; X must stay strictly increasing along the route (`sAtX`, X-triggered faults,
  `zoneAt` and the finish test rely on it).
- Radio shadows (G, H) are persistent geography: a scenario's `shadows` (what is really there; `NetworkEnvironment`
  subtracts `shadowDb` from Wi-Fi / 5G) and `mapShadows` (what the coverage map recorded; defaults to `shadows`).
  `coverageMapFor(scenario)` turns them into the map's dead zones, which the engine hands to every FlexiPath controller.
  Faults (`FAULTS`) are transient and never on the map.

### Controllers

- `FlexiPathController.update()` is order-sensitive: measure → score → attach / abrupt-loss handling → `_predict`
  (once per tick; it advances the time-to-failure confirmation counter, so any extra call must pass `peek: true`) →
  `_watch` (before `_radioPlan`, so a predicted degradation wakes a modem on the onset tick) → `_radioPlan` → burst /
  upgrade logic → `_radioStates` (writes the radio states, so it runs after any switch).
- Time comparisons subtract `1e-9` because `t = tick × 0.1` is inexact; do the same for new timers.
- Coverage map: `_mapZoneAhead(id, ctx)` finds a mapped dead zone within `mapHorizonS` (8 s at the current speed);
  `_predict` adds the `map` trigger (watch from 8 s, act < 3 s) and `_bestCandidate({ ctx })` skips paths the map says
  are about to die (`anyIfUnsafe` only for failover). With no mapped zones every code path must stay exactly as it was,
  so A–F results stay byte-identical. The ablation switches `trendPrediction`, `burst` and `useMap` are in
  `FLEXIPATH_PARAMS`.
- `decision.replicate` must be an explicit per-class map: `TrafficManager` mirrors every packet flow when it is
  undefined.
- `MultipathController.js`: `ReactiveMultipathController` (anchored session, standby radio in DRX, moves after loss >
  15 % for one 250 ms RTO or a drop, + 100 ms wake) and `RedundantMultipathController` (critical + real-time on two
  joinable paths, radio state `DUAL` = tier 2; with no protected classes it delegates to a reactive instance). Both
  share the legacy priority and join thresholds (`MULTIPATH_PARAMS`) and use `MultipathTrace`; they emit `HOT_SWAP` /
  `FAILOVER` (with `upgrade` on switch-backs), never `TCP_RST`.
- Event codes and record kinds are an API. The engine's stats (`REPL_ON`, `HOT_SWAP`, `FAILOVER`, `RECONNECTED`,
  `TCP_RST`), the `DecisionTrace` episodes and the `GuidedDemo` captions all match on them by name.
- The UI shows the exported default parameters (`FLEXIPATH_PARAMS`, `LEGACY_PARAMS`, `POWER_PARAMS`), not a controller
  instance's merged `p`, and `params` merges shallowly (overriding `floors` replaces the whole object).

### Determinism

- All randomness comes from `Random` (Mulberry32) seeded by `config.seed` (`'2026'` and `2026` are the same seed).
  Subsystems get independent streams from `rng.fork(label)`: `environment` → `shadow:<if>`; `agent:<id>` →
  `link:<if>`, `traffic` (→ `seq`, `hol` → `<flow>:<link>`, `pacing`) and `tunnel`. A fork depends only on seed + label.
  Ablations fork `agent:flexipath` (`rngOf` in `ENGINES`): common random numbers, so their differences from FlexiPath
  come only from the switched-off part. Don't give them their own streams.
- Within a stream the draw order is part of the result (flows iterate in `FLOW_DEFS` order; `gaussian()` caches a
  spare value; a link draws more when it is up). Adding or removing a draw, or changing a threshold that gates draws,
  shifts every later value in that stream. Give a new random consumer its own `fork('<label>')`, and never use
  `Math.random()` or the clock in `src/simulation` (`Math.random` is fine for visual-only effects in `src/three`).
- Several values assume `TICK_HZ = 10`: 1 s `WindowRatio(10)` windows, per-tick EWMA alphas, `round(pps · dt)`
  packets per tick.

### Parameters and claims

- Tunables live in exported UPPER_CASE objects per module (`FLEXIPATH_PARAMS`, `LEGACY_PARAMS`, `TRACE_PARAMS`,
  `POWER_PARAMS`, `HOL_PARAMS`, `RELAY_PARAMS`, `INTERFACE_SPECS`, `RF`, `FAULTS`, `ZONES`, `NODE_LAYOUT`,
  `FLOW_DEFS`, …); `exportData()` writes them into the run JSON, so new tunables belong there. A few values are
  duplicated by hand and must change together: `RF.wifi.noiseFloor` / `wlan0.noiseFloor`, `RF.cell.sinrOffset` /
  `wwan0.sinrOffset`, `SWITCH_LOSS` / `FLEXIPATH_PARAMS.switchLoss`, the scenarios' `endX: 240` / `ROUTE_END_X`.
- Provenance (README "Data provenance and claims"): every published number is a MODEL PARAMETER or MEASURED · SIM;
  nothing is a real-world measurement (the probe script's output, if ever quoted, is labelled real-world). The HUD labels interruptions as simulated, shows a `SIMULATION` badge and reports
  differences without a score or "winner". Use `tag('param' | 'measured' | 'sim')` from `src/ui/format.js` for
  provenance chips, and keep README and UI copy within these claims.

### Front end (`src/main.js`, `src/ui`, `src/charts`, `src/three`)

- Two pages (`vite.config.js` lists both): `index.html` is the static landing page (`src/landing/landing.{js,css}`,
  screenshots in `public/landing/`); `simulator.html` loads `src/main.js`. The landing page copies its numbers from the
  README tables and keeps the same provenance labels, so update it when the results change.
- `main.js` creates the engine paused → `Dashboard` → `SceneManager` and the environment / node / vehicle managers →
  awaits the GLB loads → beams and particles. Each animation frame: `engine.advance(dt)` → each manager's
  `update(render, snapshot, …)` → camera → render → `dashboard.frame(now)`. Visual animation runs on wall-clock time
  (it keeps moving while paused); HUD values come from the latest 10 Hz snapshot.
- The HUD and the twin hold no simulation state. Anything derived belongs in the engine and its snapshot, not in UI
  code.
- Radio shadows are drawn per scenario: `EnvironmentManager.setScenario()` (called from `main.js` at start and on every
  engine `reset`) rebuilds a red volume per real shadow and a dashed outline per stale map zone, in both looks;
  `Dashboard._renderShadows()` marks them on the route strip.
- `Dashboard.js` builds the DOM from template strings and collects `[data-ref]` into `this.refs` before the child
  panels render, so each panel scopes its own lookups. Panels refresh at most every 90 ms when dirty; charts every
  180 ms and only while the Advanced view shows them. `makeSetter` (`format.js`) skips unchanged DOM writes; pass dynamic text
  through `esc()`.
- Views: `data-mode="mission|advanced"` on `.fp-shell`, elements tagged `data-view`; theatre mode (`data-theatre`)
  hides `.fp-deck`, `.fp-bottom` and `.fp-toolbar`. These rules sit at the end of `styles.css`, outside `@layer`,
  with `!important`.
- Both views are deliberately compact:
  - The header, toolbar and decision loop are one line each.
  - The loop is a stepper where only the active stage shows its caption and time. Every stage keeps its caption as a
    tooltip.
  - Toolbar actions are icon buttons (`btn-icon`) with a `title` and `aria-label`.
  - The beam legend (`.fp-legend`) stays hidden until the legend button sets `data-legend="1"`.
- The Mission view also hides, near the end of `styles.css`:
  - the decision card's `.dp-sub` / `.dp-legacy` lines;
  - `.glance-note`;
  - the lanes body (until **Show steps** adds `is-open`).

  Put new detail in the Advanced view rather than growing the Mission view.
- The Advanced view puts every panel in one column beside the twin, behind tabs (`PANEL_TABS` in `Dashboard.js`):
  - each panel carries `data-tab-panel="<tab>"`;
  - `setPanelTab()` gives the others `is-tab-off`, a rule that applies only in the Advanced view, so the Mission view
    always keeps its decision card;
  - the charts row shows only while `setCharts(true)` sets `data-charts="1"` (the **Charts** button), and charts
    render only then, but they keep recording;
  - the tab and the charts toggle are remembered in `localStorage`;
  - hidden panels keep updating, so a tab shows current values the moment it opens.

  A new Advanced panel needs a tab.
- Lucide: an `<i data-lucide="name">` renders only if the icon is imported and added to `ICONS` in `Dashboard.js`,
  and `renderIcons(subtree)` runs after the HTML is injected.
- Chart.js is tree-shaken: `BaseTimeSeriesChart.js` registers only the components it uses; register any new
  controller, scale or plugin there.
- Tailwind v4 via `@tailwindcss/vite`: theme tokens (`fp`, `legacy`, `repl`, fonts) are in the `@theme` block
  of `src/styles.css`, HUD component classes in `@layer components`. Utility classes must appear as complete literal
  strings; composed names such as `lvl-${level}` or `cls-${cls}` must be component classes in `styles.css`.
- The HUD is light: white panels (`--ui-*` tokens on `:root` in `styles.css`) around the dark 3D viewport, which keeps
  its neon world colours. Status colours in UI code (loop stages, decision kinds, lanes, pills, charts) use the deep
  palette that reads on white (e.g. `#0891B2`, `#B45309`, `#7C3AED`, `#15803D`, `#DC2626`). A world colour shown as
  text (link, zone or radio-tier colours from the simulation) is deepened with `ink()` / `inkHex()` from `format.js`,
  or `color-mix(in srgb, var(--c) 52%, var(--ink))` in CSS; scene labels (`.node-label`, `.veh-label`) are light chips.

### 3D assets

- `public/models/*.glb` are generated by `blender/generate_all_models.py` (`npm run models`; `-- --out <dir>`,
  `-- --showcase`). The Three.js code relies on the conventions recorded in `manifest.json`: +Y up, drones face +X,
  `AntennaAnchor` on drones, `BeamAnchor` on nodes, `Rotor_FL/FR/RL/RR` pivots spinning about +Y.
  `npm run models` needs `blender` on PATH; otherwise call `blender.exe -b -P blender/generate_all_models.py` directly.
- Every asset has a procedural Three.js fallback (`build*` in `NetworkNodeManager.js` / `VehicleManager.js`), used when
  a GLB fails to load or with `?models=procedural`. Keep its anchor names and positions in step with the Blender script
  (the drone airframe constants are duplicated in both).
- Drone altitude is visual only (`VehicleManager`: on the dock pad, a climb-out over the first route units, then a
  fixed corridor height); the simulation and its radio model stay at ground level, and the README states that limit.
  `getPosition()` returns the drone at altitude (the cameras follow it); the halo ring stays on the ground.

### Looks (`real` / `twin`)

- Two worlds around the same network layer (drones, beams, packets, coverage rings, labels): `real` (default, a
  moonlit city and desert) and `twin` (the original neon digital twin). `L`, the Real / Twin button and `?look=twin`
  switch them; `Dashboard.setLook` → `hooks.onLook` (wired in `main.js`) → `setLook` on `SceneManager` (lights, fog,
  bloom), `EnvironmentManager` (sky colours; shows `this.real` or `this.twin`), `NetworkNodeManager` (steel colours
  and `REAL_EMISSIVE` glow, both kept per material so switching back is exact) and `VehicleManager`:
  - painted drones: FlexiPath white with cyan, Legacy graphite with red;
  - motor LEDs;
  - pale rotor discs.

  The paint is picked per mesh by part name (`PAINT_PARTS`). Keep the Blender object names and the procedural
  `buildDrone()` mesh names in step.
- `RealWorld.js` builds the realistic world once, procedurally (canvas textures, merged or instanced geometry, no
  image files), from the route, the twin city's plots (`EnvironmentManager.cityBoxes`) and the dock pad frames. It
  uses its own `Random('flexipath-real')`. `RealCity.js` turns the plots into buildings. On top of the twin's plots it
  adds low-rise plots on the camera side and its own infill (`infillPlots`): rows 1–6 behind the street, a downtown
  skyline in zone 2, low-rise rows on the camera side, and a city edge behind the dock. The infill has its own random
  stream (`flexipath-real-city-infill`) so the twin's buildings keep their look. Each building gets:
  - one canvas-painted facade tile per style (`STYLES`: four glass curtain walls, three stone ribbon finishes, three
    renders, each with its own window pattern) with colour, emissive and roughness / metalness maps;
  - per building, a wall tint (vertex colour), a window light level and colour (`aGlow`) and, on about a third of the
    towers, a coloured crown wash (`aAccent`), all read by the uplight shader;
  - varied forms: round, twin, stepped and classic towers with crowns, spires or pyramid caps; L-shaped and terraced
    mid-rises; paired low-rises (never taller on the camera side);
  - world-scale UVs with a whole-storey offset per building;
  - one merged mesh per material;
  - a night environment map for the glass;
  - an `onBeforeCompile` uplight (street-light spill fading with height).

  Aviation lights and helipads come from the recorded tower tops, without random draws. `RealSkyline.js` adds the
  distant skyline, the far street-light points and the horizon glow band, on its own stream
  (`flexipath-real-skyline`). New random consumers in the realistic world get their own `Random` label, so existing
  objects keep their look. Keep tall buildings off the camera side (+Z): the chase and cinematic cameras look across it. Anything that belongs only to the neon world goes into
  `EnvironmentManager.twin`; labels and the sky dome are shared.
- The drones' corridor passes under the gantries' signs (`GANTRY_Y`); keep that clearance if either height changes.
