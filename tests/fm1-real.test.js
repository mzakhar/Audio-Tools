// @vitest-environment node
// Real emulator check, skipped unless FM1_FW_DIR names a folder holding felucca-1.8.4.fwsc
// (firmware is never committed):  FM1_FW_DIR=E:/tmp/fm1-firmware npx vitest run tests/fm1-real.test.js
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bootEmulator, bootToReady, createRunner, CHUNK } from '../src/renderer/js/fm1/emulator.js'
import { noteOnBytes, createBlockWriter, FM1_RATE } from '../src/renderer/js/fm1/host-core.js'

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
    const booted = bootToReady(r, x)            // both hosts' ready rule
    const readyMs = x.fm1_ms()
    expect(booted).toBe('up')
    expect(r.playing).toBe(true)
    const bootMs = performance.now() - t0
    rms(r, 1)                                   // let it settle
    const quiet = rms(r, 0.5)
    const t1 = performance.now()
    r.midi(noteOnBytes(0, 60, 110), r.frame + 4 * CHUNK)
    const loud = rms(r, 1)
    const wall = (performance.now() - t1) / 1000
    const s = r.stats()
    // the Worker's 48 kHz block path over real output: contiguous 1024-frame blocks
    const writer = createBlockWriter(FM1_RATE, 48000, 1024)
    let blocks = 0, outFrames = 0
    for (let i = 0; i < 345; i++) { const { l, r: rr } = r.render(); for (const b of writer.push(l, rr)) { expect(b.frame).toBe(blocks * 1024); blocks++; outFrames += 1024 } }
    expect(Math.abs(outFrames - 345 * CHUNK * 48000 / FM1_RATE)).toBeLessThan(1024 + 2)
    console.log(`fm1-real: ready rule '${booted}' at ${readyMs} ms emulated; ` +
      `${blocks} blocks @48k; boot ${bootMs.toFixed(0)} ms, rms quiet ${quiet.toExponential(2)} -> note ${loud.toExponential(2)}, ` +
      `1 s rendered in ${wall.toFixed(2)} s (rtf ${(1 / wall).toFixed(2)}), jit regions ${jitStats.regions} failed ${jitStats.failed}, ` +
      `late ${s.late}, halted ${s.halted}`)
    expect(s.halted).toBe(false)
    expect(s.late).toBe(0)
    expect(loud).toBeGreaterThan(quiet * 4 + 1e-4)
  }, 120000)
})

// The AudioWorklet host itself (the file as shipped, fake AudioWorkletGlobalScope) over the real
// wasm: the first note right after `ready` must sound, and panel buttons must reach the firmware
// (FX redraws Felucca's LCD and the worklet posts the new image).
run('FM-1 real firmware through the worklet host', () => {
  it('a note sent right after ready sounds; FX changes the LCD', async () => {
    const src = readFileSync(resolve(process.cwd(), 'src/renderer/public/worklets/fm1-worklet.js'), 'utf8')
    const saved = ['registerProcessor', 'AudioWorkletProcessor', 'sampleRate', 'currentFrame'].map(k => [k, globalThis[k]])
    let Processor
    globalThis.AudioWorkletProcessor = class { constructor() { this.port = { sent: [], postMessage(m) { this.sent.push(m) } } } }
    globalThis.registerProcessor = (_, cls) => { Processor = cls }
    globalThis.sampleRate = 48000
    globalThis.currentFrame = 0
    try {
      new Function(src)()
      const p = new Processor()
      const wasm = readFileSync(resolve(process.cwd(), 'src/renderer/public/fm1/fm1_web.wasm'))
      const pkg = readFileSync(fw)
      const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      p.port.onmessage({ data: { type: 'boot', wasm: ab(wasm), package: ab(pkg), mhz: 120 } })
      while (!p.x) await new Promise(r => setTimeout(r, 5))
      const send = data => p.port.onmessage({ data })
      const quanta = (n) => {
        let s = 0
        for (let i = 0; i < n; i++) {
          const o = [[new Float32Array(128), new Float32Array(128)]]
          expect(p.process([], o)).toBe(true)
          globalThis.currentFrame += 128
          for (const v of o[0][0]) s += v * v
        }
        return Math.sqrt(s / (n * 128))
      }
      while (!p.port.sent.some(m => m.type === 'ready')) quanta(1)
      const readyMs = p.x.fm1_ms()
      send({ type: 'midi', bytes: noteOnBytes(0, 60, 100) })
      const first = quanta(150)                       // 0.4 s
      send({ type: 'lcd', on: true })
      quanta(40)
      const rev = p.x.fm1_lcd_revision()
      const before = p.port.sent.length
      send({ type: 'key', id: 2, down: true })        // FX
      send({ type: 'key', id: 2, down: false })       // the host holds it 4410 frames
      quanta(225)                                     // 0.6 s
      const images = p.port.sent.slice(before).filter(m => m.type === 'lcd' && m.lcd)
      console.log(`fm1-real worklet: ready at ${readyMs} ms emulated, first-note rms ${first.toExponential(2)}, FX lcd rev ${rev} -> ${p.x.fm1_lcd_revision()}, ${images.length} images posted`)
      expect(p.port.sent.some(m => m.type === 'error')).toBe(false)
      expect(first).toBeGreaterThan(1e-3)
      expect(p.x.fm1_lcd_revision()).not.toBe(rev)
      expect(images.length).toBeGreaterThan(0)
    } finally {
      for (const [k, v] of saved) globalThis[k] = v
    }
  }, 120000)
})
