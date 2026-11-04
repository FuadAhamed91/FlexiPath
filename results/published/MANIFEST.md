# Published benchmark data: manifest

These CSVs are the raw data behind the README's "Measured results" tables. They are **measured simulation results**
(MEASURED · SIM), not real-world measurements.

| Field | Value |
| --- | --- |
| Source commit | `8a3983ca71dbc368dff790c3971b24fa7947a479` (simulation code unchanged since; the commit that adds this folder changes only tests, CI and docs) |
| Date of the runs | 2026-11-04 (UTC 12:27–12:28) |
| Runtime | Node v24.21.0, Linux x86-64 |
| Runs per folder | 160 paired runs: scenarios A–H × 5 seeds × 30 / 60 / 90 / 120 km/h, every engine (Legacy, reactive multipath, always duplicate, FlexiPath, three ablations) |
| Wall time | about 13 s per folder |

## Folders, commands and seed blocks

| Folder | Command | Seed block | Seeds | README use |
| --- | --- | --- | --- | --- |
| `default/` | `npm run benchmark -- --out results/published/default` | `dev` (`1000 + 7919·i`, used while tuning) | 1000, 8919, 16838, 24757, 32676 | All "Measured results" tables, the ablation and prediction tables, the trade-off chart |
| `test/` | `npm run benchmark -- --seed-block test --out results/published/test` | `test` (`900001 + 7919·i`, held out) | 900001, 907920, 915839, 923758, 931677 | "Held-out seeds" |
| `failsafe1000/` | `npm run benchmark -- --failsafe-ms 1000 --out results/published/failsafe1000` | `dev` | as `default/` | Hover-rule table, waypoint rule (1 s) |
| `wake260/` | `npm run benchmark -- --wake-ms 260 --out results/published/wake260` | `dev` | as `default/` | "Sensitivity: a slower modem wake" |

Each folder holds the six CSVs the benchmark writes (per-run, `_comparison`, `_mechanisms`, `_efficiency`,
`_ablations`, `_prediction`) and `console.txt`, the console output of the run. The run JSON (about 3.4 MB per folder)
is not archived: it is reproduced by the same command, and differs between runs only in `meta` (timestamps, wall time).

## Reproduce

```bash
git checkout 8a3983ca71dbc368dff790c3971b24fa7947a479   # or any later commit that does not change src/simulation
npm ci
npm run benchmark -- --out /tmp/check                   # then: cmp each CSV against default/ (the file names differ only in the stamp)
npm run test:full                                       # does the same for default/ and test/ automatically
```

The runs are deterministic per seed: the CSVs must be byte-identical. They also match, byte for byte, the independent
runs made for the 2026-10-09 review (finding F-16).

## SHA-256

```
79f1d6c920d7e7a0217ebd4ccfe78f4ec4a5ac2692fced3db66f6b944d18de1b  default/benchmark_2026-11-04T12-27-44.csv
2f7973f1a5b8c389d1e9afe76b29abc2f2d27c66fef91408fde624d0ed2bd863  default/benchmark_ablations_2026-11-04T12-27-44.csv
c4661df6407ff97fcd6d0a1e1bbd18a216e0298f0419271a4e98f59eb3f29122  default/benchmark_comparison_2026-11-04T12-27-44.csv
b32cf093b5b5b83e74004a269ad442e6f0a845ce7e2cf7cb49335b411d679d7a  default/benchmark_efficiency_2026-11-04T12-27-44.csv
5d46705cda4296800d8ad259e12500e26ffb92f6eece4458b81ff2f1ebc80a93  default/benchmark_mechanisms_2026-11-04T12-27-44.csv
a28b77a0a593f86b71ec25de67410a0dabab6b561da8225987d5c3d3430feb95  default/benchmark_prediction_2026-11-04T12-27-44.csv
7e0102dbaf3fd2c93efa4e410b4ccd87ef356b992f256106d8448e882e8ab52b  test/benchmark_2026-11-04T12-27-57.csv
03297678b7411964a1c34aa1934467a8e84f769475ce9e8c4d6ed42b479ca007  test/benchmark_ablations_2026-11-04T12-27-57.csv
3d3ed8e9c581db7d82e1827cc1165d1ca170fe991370b0503921da01d9834e82  test/benchmark_comparison_2026-11-04T12-27-57.csv
00c82b82552b38ff080cb3792d09d6428e3f7a47254a43bbe13c66ba52e00b43  test/benchmark_efficiency_2026-11-04T12-27-57.csv
751babfb25f4b2d484c88120e073c5136fefc0a019671847cbce9114350f78c3  test/benchmark_mechanisms_2026-11-04T12-27-57.csv
6b08d9de0a0b5a26097e24fa30120af388904e6031f99707e0127ed6b04fc930  test/benchmark_prediction_2026-11-04T12-27-57.csv
9f8dc5be158760ffe75718824a3ea1b7d20f091459bd3aaa7041d36fed1d405b  failsafe1000/benchmark_failsafe1000ms_2026-11-04T12-28-08.csv
4251c5d02a6c47f2db11510998c700f7c5c3eaa975aa837f504efc262ebb559a  failsafe1000/benchmark_failsafe1000ms_ablations_2026-11-04T12-28-08.csv
90e953b5a7ec8cad8970bddef29e5f1a4312b8fcf6c0be757ff959bd1837f1b3  failsafe1000/benchmark_failsafe1000ms_comparison_2026-11-04T12-28-08.csv
82473716d65422647fa9b91585e36dc8da578a581e8b927b68c2d1cbc8662abe  failsafe1000/benchmark_failsafe1000ms_efficiency_2026-11-04T12-28-08.csv
a731867b077cee53972a5b2b82dbd8dedfcb4fa6fad824d5708d0d3d3fd2a834  failsafe1000/benchmark_failsafe1000ms_mechanisms_2026-11-04T12-28-08.csv
a28b77a0a593f86b71ec25de67410a0dabab6b561da8225987d5c3d3430feb95  failsafe1000/benchmark_failsafe1000ms_prediction_2026-11-04T12-28-08.csv
68d50ba20e6713d6e2fda5cf95ad0f47bebb7b7a0f1f97d9d4b4a33ecef2feec  wake260/benchmark_wake260ms_2026-11-04T12-28-20.csv
371957b02729b6c6cdd782a564a2fc2d23e69e75ca0dc8af65eca529716ee27b  wake260/benchmark_wake260ms_ablations_2026-11-04T12-28-20.csv
10c186cf206291fac52945a29a93d667122f5a1f82fb55b7694580b1402651b8  wake260/benchmark_wake260ms_comparison_2026-11-04T12-28-20.csv
45020427ac7e9105c39a3f20b916429bdfbc1fc92a39b2cfe2702abdfc54be65  wake260/benchmark_wake260ms_efficiency_2026-11-04T12-28-20.csv
a7e5157f746cfa05fc264295617f2cfa7f809de155f5392e75d31d4414fcdb68  wake260/benchmark_wake260ms_mechanisms_2026-11-04T12-28-20.csv
552ad53b3dc5717ae14c2f068bd8a329b73d1bdb9e4a5647cb0d8ea2d0275eee  wake260/benchmark_wake260ms_prediction_2026-11-04T12-28-20.csv
```

## Rounding

README values are the CSV means rounded half-up to the printed precision, once, from the full-precision value (never
from an already rounded value). Two double-rounding errors found in the 2026-10-09 review (C bulk HoL mean 3.148 ms
printed as 3.2; D lead 1.2455 s printed as 1.3) were corrected in commit `3f685b0`; the README now prints 3.1 ms and
1.2 s.

## When the model changes

Re-run the four commands into this folder (delete the old CSVs first), update this manifest (commit, date, checksums:
`sha256sum */*.csv`), the README tables and `public/landing/tradeoff.svg`. `npm test` compares a quick benchmark with
the README table within stated tolerances; `npm run test:full` compares the full runs with these CSVs exactly.
