# FM-1 phase 0 spike (disposable)

Evidence for `specs/fm1-emulator.md` phase 0. Not production code; nothing in `src/` imports it.
Results: `results/node-bench.md`, `results/browser.md`.

## Rebuild the wasm (not committed)

fm1-emu pinned at `69cb1ef46d86a2776112cc9279773ded3ffa293b`, rustc 1.100.1 (stable, 2026-11-25), target
`wasm32-unknown-unknown`. Expected output: 3,542,489 B, sha256
`77bd2e2acb83d2a32bc92f7e44627db8b554d9abc340914bbed4941b77fd7f59`.

```sh
git clone https://github.com/joakimeriksson/fm1-emu && cd fm1-emu && git checkout 69cb1ef46d86a2776112cc9279773ded3ffa293b
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export RUSTFLAGS=" -Cllvm-args=-inline-threshold=2000 -Clink-arg=--export-table -Clink-arg=--growable-table"
cargo build --release -p fm1-web --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/fm1_web.wasm <repo>/spikes/fm1/vendor/
```

## Firmware (test data, never committed)

Put `.fwsc` files in a folder and pass `--fw-dir`: Felucca 1.8.4, SLOOP 2.8.5, FM1-Dock 1.0.1-digital (GitHub
releases, sha256 match published), stock V15 `FM-1_015.fwsc` (sha256 `db1642b2…edb8a`).

## Run

- `node bench.mjs --fw-dir <dir>`: node RTF / boot / determinism matrix.
- `node serve.mjs --csp current|wasm|none --base /synth/ --fw-dir <dir>` then open `live.html`: Path A (Worker) and
  Path B (AudioWorklet) live hosts.
- `node_modules/.bin/electron drive.cjs`: Electron driver for the browser matrix and the file:// probe.
- `node offline.mjs`: reboot-and-replay bounce determinism.
