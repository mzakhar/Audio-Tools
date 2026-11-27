# FM-1 node bench

Env: AMD Ryzen 7 2700X Eight-Core Processor         , 16 threads, 63.9 GB, node v24.14.0
wasm: 3542489 B sha256 77bd2e2acb83d2a32bc92f7e44627db8b554d9abc340914bbed4941b77fd7f59
Thresholds: RTF>=1.5 PASS, 1.0-1.5 MARGINAL, <1.0 FAIL at 240 MHz; boot <3 s; 0 starved

Reproduce: `node spikes/fm1/bench.mjs` (firmware in E:/tmp/fm1-firmware) ; single job: `node spikes/fm1/bench.mjs --job '{"job":"rtf","o":{"fw":"felucca","jit":true,"mhz":240,"chunk":128,"seconds":30}}'`

## RTF (emulated audio s / wall s)

| fw | mode | MHz | chunk | RTF | verdict@240 | starved halves | short chunks | worst chunk ms | rss MB | halted | jit regions/failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| felucca | interp | 240 | 128 | 0.22 | FAIL | 0 | 0 | 28.9 | 144 | 0 | 0/0 |
| felucca | interp | 240 | 1024 | 0.23 | FAIL | 0 | 0 | 124.6 | 144 | 0 | 0/0 |
| felucca | interp | 100 | 128 | 0.53 | - | 0 | 0 | 20.7 | 143 | 0 | 0/0 |
| felucca | jit | 240 | 128 | 1.08 | MARGINAL | 0 | 0 | 31.6 | 169 | 0 | 1916/0 |
| felucca | jit idle(no notes) | 240 | 128 | 1.34 | MARGINAL | 0 | 0 | 23.3 | 152 | 0 | 1376/0 |
| felucca | jit | 240 | 1024 | 1.28 | MARGINAL | 0 | 0 | 91.9 | 166 | 0 | 1870/0 |
| felucca | jit | 100 | 128 | 2.00 | - | 0 | 0 | 33.2 | 182 | 0 | 2417/0 |
| sloop | interp | 240 | 128 | 0.22 | FAIL | 0 | 0 | 28.6 | 170 | 0 | 0/0 |
| sloop | interp | 240 | 1024 | 0.23 | FAIL | 0 | 0 | 135.2 | 172 | 0 | 0/0 |
| sloop | interp | 100 | 128 | 0.51 | - | 0 | 0 | 20.3 | 176 | 0 | 0/0 |
| sloop | jit | 240 | 128 | 1.06 | MARGINAL | 0 | 0 | 29.1 | 225 | 0 | 2658/0 |
| sloop | jit idle(no notes) | 240 | 128 | 1.16 | MARGINAL | 0 | 0 | 27.3 | 204 | 0 | 1780/0 |
| sloop | jit | 240 | 1024 | 1.13 | MARGINAL | 0 | 0 | 108.3 | 225 | 0 | 2609/0 |
| sloop | jit | 100 | 128 | 1.90 | - | 0 | 0 | 27.0 | 226 | 0 | 2687/0 |
| dock | interp | 240 | 128 | 0.14 | FAIL | 0 | 0 | 41.7 | 170 | 0 | 0/0 |
| dock | interp | 240 | 1024 | 0.14 | FAIL | 0 | 0 | 209.9 | 169 | 0 | 0/0 |
| dock | interp | 100 | 128 | 0.32 | - | 0 | 0 | 21.5 | 168 | 0 | 0/0 |
| dock | jit | 240 | 128 | 1.76 | PASS | 0 | 0 | 22.2 | 181 | 0 | 636/0 |
| dock | jit idle(no notes) | 240 | 128 | 1.76 | PASS | 0 | 0 | 19.0 | 183 | 0 | 608/0 |
| dock | jit | 240 | 1024 | 1.80 | PASS | 0 | 0 | 153.5 | 177 | 0 | 612/0 |
| dock | jit | 100 | 128 | 3.46 | - | 0 | 0 | 15.4 | 184 | 0 | 598/0 |
| v15 | interp | 240 | 128 | 0.35 | FAIL | 0 | 0 | 34.8 | 199 | 0 | 0/0 |
| v15 | interp | 240 | 1024 | 0.35 | FAIL | 0 | 0 | 144.6 | 196 | 0 | 0/0 |
| v15 | interp | 100 | 128 | 0.49 | - | 8 | 0 | 28.0 | 192 | 0 | 0/0 |
| v15 | jit | 240 | 128 | 0.72 | FAIL | 2 | 0 | 41.4 | 264 | 0 | 3739/0 |
| v15 | jit idle(no notes) | 240 | 128 | 1.34 | MARGINAL | 0 | 0 | 33.0 | 234 | 0 | 2652/0 |
| v15 | jit | 240 | 1024 | 0.73 | FAIL | 2 | 0 | 93.0 | 261 | 0 | 3648/0 |
| v15 | jit | 100 | 128 | 0.84 | - | 28 | 0 | 28.9 | 270 | 0 | 4078/0 |

## Boot (to first non-zero LCD frame / first non-silent audio)

| fw | mode | MHz | wasm compile ms | boot call ms | LCD wall ms | LCD emu ms | audio wall ms | audio emu ms |
|---|---|---|---|---|---|---|---|---|
| felucca | interp | 240 | 5 | 6 | 647 | 178 | 647 | 178 |
| felucca | interp | 100 | 5 | 5 | 638 | 379 | 638 | 379 |
| felucca | jit | 240 | 5 | 7 | 311 | 178 | 311 | 178 |
| felucca | jit | 100 | 5 | 6 | 217 | 379 | 217 | 379 |
| sloop | interp | 240 | 5 | 7 | 635 | 203 | 635 | 203 |
| sloop | interp | 100 | 5 | 6 | 580 | 340 | 580 | 340 |
| sloop | jit | 240 | 5 | 6 | 338 | 203 | 338 | 203 |
| sloop | jit | 100 | 7 | 6 | 289 | 340 | 289 | 340 |
| dock | interp | 240 | 5 | 6 | 1362 | 351 | 653 | 205 |
| dock | interp | 100 | 5 | 5 | 1347 | 644 | 581 | 346 |
| dock | jit | 240 | 5 | 6 | 492 | 351 | 296 | 205 |
| dock | jit | 100 | 5 | 6 | 454 | 644 | 236 | 346 |
| v15 | interp | 240 | 5 | 6 | 981 | 415 | 712 | 166 |
| v15 | interp | 100 | 5 | 5 | 1049 | 661 | 777 | 394 |
| v15 | jit | 240 | 6 | 6 | 773 | 415 | 485 | 166 |
| v15 | jit | 100 | 5 | 6 | 798 | 661 | 476 | 394 |

## MIDI proof (RMS; note 60 vel 110, 1 s on)

| fw | baseline | ch1 on | ch1 ratio | ch2 on | ch2 ratio | proof |
|---|---|---|---|---|---|---|
| felucca | 0.00000 | 0.03428 | baseline silent | 0.03286 | baseline silent | true |
| sloop | 0.00000 | 0.08037 | baseline silent | 0.09336 | baseline silent | true |
| dock | 0.00000 | 0.08162 | baseline silent | 0.08152 | baseline silent | true |
| v15 | 0.00000 | 0.04172 | baseline silent | 0.04172 | baseline silent | true |

## Determinism (10 s, MIDI at fixed chunk idx, fresh instances, sha256 of f32 output)

| fw | interp==interp | jit==jit | jit==interp | interp hash | jit hash |
|---|---|---|---|---|---|
| felucca | true | true | true | d7356ab47b540e1a | d7356ab47b540e1a |
| sloop | true | true | true | 498547e77aa8049b | 498547e77aa8049b |
| dock | true | true | true | 0764119337b4c756 | 0764119337b4c756 |
| v15 | true | true | true | 78aa641c63a74d0a | 78aa641c63a74d0a |

## Parallel instances (felucca, 240 MHz, worker_threads)

| mode | n | per-instance RTF | min | sum |
|---|---|---|---|---|
| interp | 2 | 0.16, 0.16 | 0.16 | 0.32 |
| interp | 4 | 0.16, 0.16, 0.16, 0.15 | 0.15 | 0.62 |
| jit | 2 | 0.71, 0.71 | 0.71 | 1.43 |
| jit | 4 | 0.75, 0.75, 0.75, 0.76 | 0.75 | 3.01 |
