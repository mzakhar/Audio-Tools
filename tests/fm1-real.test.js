// @vitest-environment node
// Real emulator check, skipped unless FM1_FW_DIR names a folder holding felucca-1.8.4.fwsc
// (firmware is never committed):  FM1_FW_DIR=E:/tmp/fm1-firmware npx vitest run tests/fm1-real.test.js
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bootEmulator, createRunner, CHUNK } from '../src/renderer/js/fm1/emulator.js'
import { noteOnBytes, FM1_RATE } from '../src/renderer/js/fm1/host-core.js'

const fw = process.env.FM1_FW_DIR && join(process.env.FM1_FW_DIR, 'felucca-1.8.4.fwsc')
const run = fw && existsSync(fw) ? describe : describe.skip

function rms(run, seconds) {
  let s = 0, n = 0
  for (let i = 0; i < Math.round(seconds * FM1_RATE / CHUNK); i++) {
    const { l, r } = run.render()
    for (let k = 0; k < CHUNK; k++) s += l[k] * l[k] + r[k] * r[k]
    n += 2 * CHUNK
  }
  return Math.sqrt(s / n)
}

run('FM-1 real firmware (Felucca 1.8.4, 120 MHz)', () => {
  it('boots with the JIT and a timed note-on raises the output level', async () => {
    const wasm = readFileSync(resolve(process.cwd(), 'src/renderer/public/fm1/fm1_web.wasm'))
    const module = await WebAssembly.compile(wasm)
    const pkg = readFileSync(fw)
    const t0 = performance.now()
    const { x, jitStats } = await bootEmulator({ module, pkg: pkg.buffer.slice(pkg.byteOffset, pkg.byteOffset + pkg.byteLength), mhz: 120 })
    const r = createRunner(x, { mhz: 120 })
    while (!r.playing && x.fm1_ms() < 8000) r.render()
    expect(r.playing).toBe(true)
    const bootMs = performance.now() - t0
    rms(r, 1)                                   // let it settle
    const quiet = rms(r, 0.5)
    const t1 = performance.now()
    r.midi(noteOnBytes(0, 60, 110), r.frame + 4 * CHUNK)
    const loud = rms(r, 1)
    const wall = (performance.now() - t1) / 1000
    const s = r.stats()
    console.log(`fm1-real: boot ${bootMs.toFixed(0)} ms, rms quiet ${quiet.toExponential(2)} -> note ${loud.toExponential(2)}, ` +
      `1 s rendered in ${wall.toFixed(2)} s (rtf ${(1 / wall).toFixed(2)}), jit regions ${jitStats.regions} failed ${jitStats.failed}, ` +
      `late ${s.late}, halted ${s.halted}`)
    expect(s.halted).toBe(false)
    expect(s.late).toBe(0)
    expect(loud).toBeGreaterThan(quiet * 4 + 1e-4)
  }, 120000)
})
