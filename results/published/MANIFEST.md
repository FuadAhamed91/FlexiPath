# Published benchmark data: manifest

These CSVs are the raw data behind the README's "Measured results" tables. They are **measured simulation results**
(MEASURED · SIM), not real-world measurements.

| Field | Value |
| --- | --- |
| Source commit | `ec5378940279eb494a9e7be1aacd020de39cf276` (simulation code unchanged since `1be4e8f`, the model/method review fixes; the commit that adds this data changes only `results/published/`, the README, the CI comment and docs) |
| Date of the runs | 2026-11-04 (UTC 13:22) |
| Runtime | Node v24.21.0, Linux x86-64 |
| Runs per folder | 160 paired runs: scenarios A–H × 5 seeds × 30 / 60 / 90 / 120 km/h, every engine (Legacy, reactive multipath, reactive multipath with 60 ms detection, always duplicate, FlexiPath, three ablations) |
| Hover rule | Speed-consistent unless the command sets `--failsafe-ms`: 300 ms of C2 silence at ≤ 60 km/h, 1 s above |
| Wall time | about 15 s per folder on one core (the ten runs took 32 s in parallel) |

## Folders, commands and seed blocks

Seed blocks: `dev` = `1000 + 7919·i` (1000, 8919, 16838, 24757, 32676; used while tuning) · `test` = `900001 + 7919·i`
(900001, 907920, 915839, 923758, 931677; held out).

| Folder | Command | Seed block | README use |
| --- | --- | --- | --- |
| `default/` | `npm run benchmark -- --out results/published/default` | `dev` | Continuity, Phase 2, reliability per extra watt, ablation and prediction tables; dev figures in the headline and "Held-out seeds"; the trade-off chart |
| `test/` | `npm run benchmark -- --seed-block test --out results/published/test` | `test` | Headline (`_headline.csv`), the five-stack comparison tables, "Held-out seeds", the default column of the hover-rule table |
| `failsafe300/` | `npm run benchmark -- --failsafe-ms 300 --out results/published/failsafe300` | `dev` | Hover-rule table, 300 ms at every speed (figures in brackets); the 35 % pooled figure |
| `failsafe300-test/` | `npm run benchmark -- --seed-block test --failsafe-ms 300 --out results/published/failsafe300-test` | `test` | Hover-rule table, 300 ms at every speed; the 28 % pooled figure |
| `failsafe1000/` | `npm run benchmark -- --failsafe-ms 1000 --out results/published/failsafe1000` | `dev` | Hover-rule table, 1 s at every speed (figures in brackets) |
| `failsafe1000-test/` | `npm run benchmark -- --seed-block test --failsafe-ms 1000 --out results/published/failsafe1000-test` | `test` | Hover-rule table, 1 s at every speed |
| `wake260/` | `npm run benchmark -- --wake-ms 260 --out results/published/wake260` | `dev` | "Sensitivity: a slower modem wake" (development-seed figures) |
| `wake260-test/` | `npm run benchmark -- --seed-block test --wake-ms 260 --out results/published/wake260-test` | `test` | "Sensitivity: a slower modem wake" table and pooled figures (42 %, 35.5 %) |
| `rto60/` | `npm run benchmark -- --rto-ms 60 --out results/published/rto60` | `dev` | "Sensitivity: reactive multipath with a 60 ms timeout" (21.5 %) |
| `rto60-test/` | `npm run benchmark -- --seed-block test --rto-ms 60 --out results/published/rto60-test` | `test` | "Sensitivity: reactive multipath with a 60 ms timeout" (23.0 %, kept C2, H delivery lead) |

Each folder holds the seven CSVs the benchmark writes (per-run, `_comparison`, `_mechanisms`, `_efficiency`,
`_headline`, `_ablations`, `_prediction`; non-default runs carry `_failsafe<ms>ms` / `_wake<ms>ms` / `_rto<ms>ms` in
the name) and `console.txt`, the console output of the run. The run JSON (about 3.5 MB per folder) is not archived: it
is reproduced by the same command, and differs between runs only in `meta` (timestamps, wall time).

Not archived: the README's prose figures for the 260 ms wake combined with a fixed hover rule ("With the 300 ms rule at
every speed it hovers on all 20 flights of D and 17 of 20 in H …"). They come from
`npm run benchmark -- [--seed-block test] --wake-ms 260 --failsafe-ms 300` (or `1000`).

## Reproduce

```bash
git checkout ec5378940279eb494a9e7be1aacd020de39cf276   # or any later commit that does not change src/simulation
npm ci
npm run benchmark -- --seed-block test --out /tmp/check   # then: cmp each CSV against test/ (the file names differ only in the stamp)
npm run test:full                                         # does the same for all ten folders automatically (about 2 min)
```

The runs are deterministic per seed: the CSVs must be byte-identical. They are stored with CRLF line ends (RFC 4180,
as the benchmark writes them); `.gitattributes` marks `results/published/**/*.csv` as `-text`, so git never converts
them.

## SHA-256

```
e30f9514a0c44ebbcc0f5475de95ee5d37dc99572b389079f18a0b400622c80c  default/benchmark_2026-11-04T13-22-40.csv
ad9e2f5e254e07a6df2e509799f82c6d481a67cb1367177a24c24539dcfd971c  default/benchmark_ablations_2026-11-04T13-22-40.csv
a728dd721e093542f83b463d4d99133cf1a9fe45a53e4802d9f912d6e9692fb0  default/benchmark_comparison_2026-11-04T13-22-40.csv
a4648bcee5c430cf8bfa32cd9309763119ebe10fad91d1b9be2a87a862d8658c  default/benchmark_efficiency_2026-11-04T13-22-40.csv
d1c4b0b8ed68f75f2e0d651b4d3e30fd2ef171af8dd734e7706dbcd4621a752c  default/benchmark_headline_2026-11-04T13-22-40.csv
eaab184dd000cd8dd940de1d6fc880efac539092cbb20a14f5c388d78aa79dc2  default/benchmark_mechanisms_2026-11-04T13-22-40.csv
a28b77a0a593f86b71ec25de67410a0dabab6b561da8225987d5c3d3430feb95  default/benchmark_prediction_2026-11-04T13-22-40.csv
9b1ca1c94e912d29bb54fb25dd34d916716c6c96668056c5371c2ff451792bd1  failsafe300/benchmark_failsafe300ms_2026-11-04T13-22-40.csv
aecca5b0f08c269d56d2dce75b6359e76a01673f26d750c4c535a824ea5428c1  failsafe300/benchmark_failsafe300ms_ablations_2026-11-04T13-22-40.csv
4e73204daaa6a3d87d6c63aee6adaf0177115fb253c8a0cf747a3f3f3cd2ea6d  failsafe300/benchmark_failsafe300ms_comparison_2026-11-04T13-22-40.csv
654b534e0fdc11a35cd2e355153ebeb56e862bbe0396f95fa7d7cb1642f8098f  failsafe300/benchmark_failsafe300ms_efficiency_2026-11-04T13-22-40.csv
0659f872168391704cb01b2dc2d81994efac4e42e7eae7832fcb3232e0519718  failsafe300/benchmark_failsafe300ms_headline_2026-11-04T13-22-40.csv
548d1ee64eba04f4c03167e8dbdc2cce9b44a8917af011669fc1cdca598ee8eb  failsafe300/benchmark_failsafe300ms_mechanisms_2026-11-04T13-22-40.csv
a28b77a0a593f86b71ec25de67410a0dabab6b561da8225987d5c3d3430feb95  failsafe300/benchmark_failsafe300ms_prediction_2026-11-04T13-22-40.csv
5de13067ca62cc50124ded918e359e71e5221fd08cac251135c675b1ab72b9db  failsafe300-test/benchmark_failsafe300ms_2026-11-04T13-22-40.csv
e6b0fc07ea33e7fd669e0295ab74f2ba2f6e923bb4b418ab68475eba6a7650f6  failsafe300-test/benchmark_failsafe300ms_ablations_2026-11-04T13-22-41.csv
bfcc9689bb89b2338cd44e3b174a29df74664964f6faff5d0ab455dadb50ae38  failsafe300-test/benchmark_failsafe300ms_comparison_2026-11-04T13-22-40.csv
42e6f5ea37939f6759cda8dc6e092118dc825d0bcf841fd40404acb7dcb15fd9  failsafe300-test/benchmark_failsafe300ms_efficiency_2026-11-04T13-22-41.csv
d9b566a44c4bf9e8e9e9dcacfe3567c108fd3ebb4a29e610f4ea9a41cc1b244b  failsafe300-test/benchmark_failsafe300ms_headline_2026-11-04T13-22-41.csv
dc6b9a0b5f0d40aa861421cad472d69d38ffbe05fe9f719287401546040a6347  failsafe300-test/benchmark_failsafe300ms_mechanisms_2026-11-04T13-22-41.csv
6b08d9de0a0b5a26097e24fa30120af388904e6031f99707e0127ed6b04fc930  failsafe300-test/benchmark_failsafe300ms_prediction_2026-11-04T13-22-40.csv
3b515b3c5810cf72216ac7164c3e562e7f18c25cb2030e8f9b184fff82162d40  failsafe1000/benchmark_failsafe1000ms_2026-11-04T13-22-39.csv
27384ed249c6a693a1cb8c9cf33b2da1ab13ab07d02b65c211946defa6244d51  failsafe1000/benchmark_failsafe1000ms_ablations_2026-11-04T13-22-39.csv
05d2ec256d285ba1d7ff3ac702f3084aa68115e004f32a24951422c4f405fcd1  failsafe1000/benchmark_failsafe1000ms_comparison_2026-11-04T13-22-39.csv
0e315669b8bb1ab4ea210aa4cf762e85d0f12a3d9d36fad6da952f6ddb92d677  failsafe1000/benchmark_failsafe1000ms_efficiency_2026-11-04T13-22-39.csv
e1e215b5ee42dc257b5fcdee762fc65b328ca1d03ef850d85ef22c00c8f12ac8  failsafe1000/benchmark_failsafe1000ms_headline_2026-11-04T13-22-39.csv
e58de6249b50885e88fcb2dcaa03a25be2cd2d1fa09389486227063e7a0cda28  failsafe1000/benchmark_failsafe1000ms_mechanisms_2026-11-04T13-22-39.csv
a28b77a0a593f86b71ec25de67410a0dabab6b561da8225987d5c3d3430feb95  failsafe1000/benchmark_failsafe1000ms_prediction_2026-11-04T13-22-39.csv
bda335d7c0ad6d5bf1cbd61040bf0aa374f3dc432f2fe21710bdf18838c82abf  failsafe1000-test/benchmark_failsafe1000ms_2026-11-04T13-22-37.csv
7b9f1be413ed68560fc8fdbf72bcf7c0effdf24bb14e1fbc2d37663910e40f80  failsafe1000-test/benchmark_failsafe1000ms_ablations_2026-11-04T13-22-38.csv
e0aad80776f173aaac5b222bfce28149d2cc3d52cdef3fbb2899ec1f33dbeff7  failsafe1000-test/benchmark_failsafe1000ms_comparison_2026-11-04T13-22-37.csv
ad851e53ed1939385da0801addec618d66e7f06308126e275bbc22c8633a994c  failsafe1000-test/benchmark_failsafe1000ms_efficiency_2026-11-04T13-22-37.csv
dc324edcf5602a251af3bb26ae9543fcceb4f71c521a21d922bdf9dda790abcd  failsafe1000-test/benchmark_failsafe1000ms_headline_2026-11-04T13-22-37.csv
a2ed67025a9fe5d1e8a4b70dad81caf8217598e1d4f7b08737550ac48d71f702  failsafe1000-test/benchmark_failsafe1000ms_mechanisms_2026-11-04T13-22-37.csv
6b08d9de0a0b5a26097e24fa30120af388904e6031f99707e0127ed6b04fc930  failsafe1000-test/benchmark_failsafe1000ms_prediction_2026-11-04T13-22-37.csv
854a3ae58f9c7f37a084130fc648e01ea905df7b6b85d3ec2f245c967102fed1  rto60/benchmark_rto60ms_2026-11-04T13-22-39.csv
ad9e2f5e254e07a6df2e509799f82c6d481a67cb1367177a24c24539dcfd971c  rto60/benchmark_rto60ms_ablations_2026-11-04T13-22-39.csv
a728dd721e093542f83b463d4d99133cf1a9fe45a53e4802d9f912d6e9692fb0  rto60/benchmark_rto60ms_comparison_2026-11-04T13-22-39.csv
519792d65638bc32f7903bdd3c2f18d78ee26a52c240bd7ee354a884c9db6d1a  rto60/benchmark_rto60ms_efficiency_2026-11-04T13-22-39.csv
64dc1f585589832cb78e3238ae6adc156176ff734ac5c4227fdc297f126dfebb  rto60/benchmark_rto60ms_headline_2026-11-04T13-22-39.csv
8b3970cdb60929e08248dbdb058d678755e633d6bc9fe4e802b63856f3ef2faf  rto60/benchmark_rto60ms_mechanisms_2026-11-04T13-22-39.csv
a28b77a0a593f86b71ec25de67410a0dabab6b561da8225987d5c3d3430feb95  rto60/benchmark_rto60ms_prediction_2026-11-04T13-22-39.csv
671e1a6fcf44175b60574b8fc83db0d3d8002a637c91f0e4a84b631187394380  rto60-test/benchmark_rto60ms_2026-11-04T13-22-38.csv
a2ae4d59dced081ce97e421c714aea0dfd2989696236fd0dea6e7f30936448ae  rto60-test/benchmark_rto60ms_ablations_2026-11-04T13-22-39.csv
e23bf8de3334ca8fce6bc74214cb351d42e685be9c67f6ce48bd2a12530373d1  rto60-test/benchmark_rto60ms_comparison_2026-11-04T13-22-38.csv
ced80b551c6680f229fa156df7a0b47daad034380a835dae1a00141f343ebd0a  rto60-test/benchmark_rto60ms_efficiency_2026-11-04T13-22-39.csv
4df9e62864fe750663e578c6cc304504fc311373ba230074148cbd4009e9fda8  rto60-test/benchmark_rto60ms_headline_2026-11-04T13-22-39.csv
cb5af0bcaf699aded8657cce69311338efca49c63ae745ea8c142ae283d23ab7  rto60-test/benchmark_rto60ms_mechanisms_2026-11-04T13-22-39.csv
6b08d9de0a0b5a26097e24fa30120af388904e6031f99707e0127ed6b04fc930  rto60-test/benchmark_rto60ms_prediction_2026-11-04T13-22-38.csv
fc8a2789bb8b5e67feeb638ca9771b6a8736c992bee3808674fe08355535baf8  test/benchmark_2026-11-04T13-22-39.csv
a2ae4d59dced081ce97e421c714aea0dfd2989696236fd0dea6e7f30936448ae  test/benchmark_ablations_2026-11-04T13-22-39.csv
e23bf8de3334ca8fce6bc74214cb351d42e685be9c67f6ce48bd2a12530373d1  test/benchmark_comparison_2026-11-04T13-22-39.csv
e3cc0cd5b918d76fcc11ed8fb33ff9f62c6fcfee6b36a99658bda9992b60c3d6  test/benchmark_efficiency_2026-11-04T13-22-39.csv
fce89208227d4554af76ccbc038d868a276c5c2d4046328e25ec5e57456d5228  test/benchmark_headline_2026-11-04T13-22-39.csv
8aab3504e9b0714f1ab46221c810f7c98ce125b422b742887bdbba4b25468db5  test/benchmark_mechanisms_2026-11-04T13-22-39.csv
6b08d9de0a0b5a26097e24fa30120af388904e6031f99707e0127ed6b04fc930  test/benchmark_prediction_2026-11-04T13-22-39.csv
6fa54685feb5d32c8d2fc916dd763df84e86b2ecc8ca816e8f11fe9cae81da2e  wake260/benchmark_wake260ms_2026-11-04T13-22-39.csv
5cb00d3f50545c41633a390a2b4955baf5ec5946252e895e7a517e10424861ee  wake260/benchmark_wake260ms_ablations_2026-11-04T13-22-39.csv
14c76137c80c9bc0d0767f457f084058d15ecdfaf4122e7b6a9ed464ae17da22  wake260/benchmark_wake260ms_comparison_2026-11-04T13-22-39.csv
fbd8c8d9f83b9156912ee3f5691c5ace714189e3cacb029b1ccaee303b7ac668  wake260/benchmark_wake260ms_efficiency_2026-11-04T13-22-39.csv
c805a054f8e43e459cf16ac815985e784775a5f9c660285acd416a4b80e4c0bf  wake260/benchmark_wake260ms_headline_2026-11-04T13-22-39.csv
04424d8378e2127d002d966b8672476ef46d0e7e3b30a0ba821808194633b80d  wake260/benchmark_wake260ms_mechanisms_2026-11-04T13-22-39.csv
552ad53b3dc5717ae14c2f068bd8a329b73d1bdb9e4a5647cb0d8ea2d0275eee  wake260/benchmark_wake260ms_prediction_2026-11-04T13-22-39.csv
85fcecb4d36adfbd98d0df49811ca15b57aac995665104e97aa8ae36608d52bf  wake260-test/benchmark_wake260ms_2026-11-04T13-22-39.csv
41ed3c339124d6b90d4d33beeb67997ef9c540a4eaed388aae0ae2ba3015abee  wake260-test/benchmark_wake260ms_ablations_2026-11-04T13-22-40.csv
4e266cbdb0d4ca0f33b49ade40f7c2cd34470307f3dca2b23252a0f7b5e4095b  wake260-test/benchmark_wake260ms_comparison_2026-11-04T13-22-39.csv
750b3565cbe078c96e891de6d6c4ea58c3d0f157dea16f8a6c2b6439e17639ad  wake260-test/benchmark_wake260ms_efficiency_2026-11-04T13-22-40.csv
b72bc8d9e36b84ee217cf38d658169c17998719824e7ca1c57a51652980d7ad8  wake260-test/benchmark_wake260ms_headline_2026-11-04T13-22-40.csv
65602639d830862211e5a8d28a7a1ec85f1fb6b634f15611bfcba5772f2b6910  wake260-test/benchmark_wake260ms_mechanisms_2026-11-04T13-22-40.csv
bfa15633a91a725b4a4d48871da2422d4a7affe1d87c3493389a9135892e9bae  wake260-test/benchmark_wake260ms_prediction_2026-11-04T13-22-39.csv
```

## Rounding

README values are the CSV means rounded half-up to the printed precision, once, from the full-precision value (never
from an already rounded value). Two double-rounding errors found in the 2026-10-09 review (C bulk HoL mean 3.148 ms
printed as 3.2; D lead 1.2455 s printed as 1.3) were corrected in commit `3f685b0`; the README now prints 3.1 ms and
1.2 s.

## When the model changes

Re-run the ten commands into this folder (delete the old CSVs first), update this manifest (commit, date, checksums:
`sha256sum */*.csv`), the README tables and `public/landing/tradeoff.svg`. `npm test` compares a quick benchmark with
the README's five-stack tables within stated tolerances; `npm run test:full` compares the full runs with these CSVs
exactly (`PUBLISHED_RUNS` in `tests/regression.test.js` lists the folders).
