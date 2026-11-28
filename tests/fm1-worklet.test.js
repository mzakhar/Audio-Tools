import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fakeFm1Exports } from './helpers/fm1-fake-exports.js'

// The worklet file is evaluated as-is with fake AudioWorkletGlobalScope globals.
const src = readFileSync(resolve(process.cwd(), 'src/renderer/public/worklets/fm1-worklet.js'), 'utf8')
let Processor
const saved = {}

beforeAll(() => {
  for (const k of ['registerProcessor', 'AudioWorkletProcessor', 'sampleRate', 'currentFrame']) saved[k] = globalThis[k]
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { sent: [], postMessage(m) { this.sent.push(m) } } } }
  globalThis.registerProcessor = (name, cls) => { expect(name).toBe('fm1'); Processor = cls }
  globalThis.sampleRate = 48000
  globalThis.currentFrame = 0
  new Function(src)()
})
afterAll(() => { for (const k of Object.keys(saved)) globalThis[k] = saved[k] })

async function booted(x = fakeFm1Exports()) {
  const spy = vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({ exports: x })
  const p = new Processor()
  p.port.onmessage({ data: { type: 'boot', module: {}, package: new ArrayBuffer(16), mhz: 120 } })
  await new Promise(r => setTimeout(r, 0))
  spy.mockRestore()
  return { p, x }
}
const out = () => [[new Float32Array(128), new Float32Array(128)]]
function quantum(p, frame) {
  globalThis.currentFrame = frame
  const o = out()
  expect(p.process([], o)).toBe(true)
  return o
}

describe('fm1-worklet', () => {
  it('posts ready only once audio started and the UI then redrew the LCD, booting at real time per quantum', async () => {
    let ms = 0
    const { p, x } = await booted(fakeFm1Exports({ silentFor: 5, ms: () => ms }))
    const readies = () => p.port.sent.filter(m => m.type === 'ready')
    for (let q = 0; q < 5; q++) quantum(p, q * 128)
    const cap = 120e6 * 128 / 48000
    expect(x.budgets.every(b => b <= cap + 1e-6)).toBe(true)
    quantum(p, 5 * 128)                                 // audio starts at ms 0
    expect(readies()).toHaveLength(0)
    expect(x.budgets.at(-1)).toBeLessThanOrEqual(cap + 1e-6)
    quantum(p, 6 * 128)
    expect(x.budgets.at(-1)).toBeGreaterThan(cap)        // playing: catch-up budget
    ms = 50; x.lcdRev++                                 // a redraw too soon after audio: not yet
    quantum(p, 7 * 128)
    expect(readies()).toHaveLength(0)
    ms = 300; x.lcdRev++                                // the UI comes up
    quantum(p, 8 * 128)
    expect(readies()).toEqual([{ type: 'ready', timedOut: false }])
    x.lcdRev++
    quantum(p, 9 * 128)
    expect(readies()).toHaveLength(1)
  })

  it('a redrawn LCD before audio does not end boot; 8 s is ready anyway, flagged', async () => {
    let t = 0
    const lcd = await booted(fakeFm1Exports({ silentFor: 1e9, ms: () => t }))
    quantum(lcd.p, 0)
    t = 500; lcd.x.lcdRev++
    quantum(lcd.p, 128)
    expect(lcd.p.port.sent.some(m => m.type === 'ready')).toBe(false)

    let ms = 0
    const slow = await booted(fakeFm1Exports({ silentFor: 1e9, ms: () => ms }))
    quantum(slow.p, 0)
    ms = 8000
    quantum(slow.p, 128)
    expect(slow.p.port.sent.find(m => m.type === 'ready')).toEqual({ type: 'ready', timedOut: true })
  })

  it('a failed wasm compile is not cached: the next boot compiles again', async () => {
    const compile = vi.spyOn(WebAssembly, 'compile').mockRejectedValueOnce(new Error('bad')).mockResolvedValue({})
    const inst = vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({ exports: fakeFm1Exports() })
    const boot = { type: 'boot', wasm: new ArrayBuffer(8), package: new ArrayBuffer(16), mhz: 120 }
    const a = new Processor()
    a.port.onmessage({ data: boot })
    await new Promise(r => setTimeout(r, 0))
    expect(a.port.sent[0]).toMatchObject({ type: 'error', reason: 'wasm-failed' })
    const b = new Processor()
    b.port.onmessage({ data: boot })
    await new Promise(r => setTimeout(r, 0))
    expect(compile).toHaveBeenCalledTimes(2)
    expect(b.port.sent.some(m => m.type === 'error')).toBe(false)
    quantum(b, 0)
    expect(b.x).toBeTruthy()
    compile.mockRestore(); inst.mockRestore()
  })

  it('injects a timed event at the first quantum whose start >= its frame', async () => {
    const { p, x } = await booted()
    globalThis.currentFrame = 0
    p.port.onmessage({ data: { type: 'midi', bytes: [0x90, 60, 100], frame: 200 } })
    quantum(p, 0)
    quantum(p, 128)
    expect(x.midi).toEqual([])
    quantum(p, 256)
    expect(x.midi.map(m => m.b)).toEqual([0x90, 60, 100])
    expect(x.midi[0].at).toBe(2)
  })

  it('note gate (inline copy): a live release before a queued timeline note is not swallowed; panic resets', async () => {
    const { p, x } = await booted()
    globalThis.currentFrame = 0
    const send = (bytes, frame, src) => p.port.onmessage({ data: { type: 'midi', bytes, frame, src } })
    send([0x90, 60, 100], 0, 'live')
    send([0x90, 60, 90], 1000, 'timeline')
    send([0x80, 60, 0], 2000, 'timeline')
    send([0x80, 60, 0], 500, 'live')
    for (let q = 0; q < 20; q++) quantum(p, q * 128)
    const bytes = () => { const b = x.midi.map(m => m.b); const out = []; for (let i = 0; i < b.length; i += 3) out.push(b.slice(i, i + 3)); return out }
    expect(bytes()).toEqual([[0x90, 60, 100], [0x80, 60, 0], [0x90, 60, 90], [0x80, 60, 0]])
    x.midi.length = 0
    send([0x90, 62, 100], 2560, 'live')
    send([0x90, 62, 100], 2560, 'timeline')
    quantum(p, 2560)
    p.port.onmessage({ data: { type: 'panic', bytes: [0xB0, 123, 0] } })
    send([0x80, 62, 0], 2688, 'timeline')               // nobody holds it after the panic
    quantum(p, 2688)
    expect(bytes().slice(-2)).toEqual([[0xB0, 123, 0], [0x80, 62, 0]])
  })

  it('drop removes queued note-ons from its frame on and keeps the offs', async () => {
    const { p, x } = await booted()
    globalThis.currentFrame = 0
    const send = (bytes, frame) => p.port.onmessage({ data: { type: 'midi', bytes, frame, src: 'timeline' } })
    send([0x90, 60, 100], 100); send([0x80, 60, 0], 900); send([0x90, 64, 100], 700); send([0x80, 64, 0], 1000)
    p.port.onmessage({ data: { type: 'drop', frame: 500 } })
    for (let q = 0; q < 10; q++) quantum(p, q * 128)
    expect(x.midi.map(m => m.b)).toEqual([0x90, 60, 100, 0x80, 60, 0, 0x80, 64, 0])
  })

  it('renders need(128) frames at 44.1 kHz per 48 kHz quantum and fills the quantum', async () => {
    const { p, x } = await booted()
    let o
    for (let q = 0; q < 375; q++) o = quantum(p, q * 128)
    const total = x.rendered.reduce((a, b) => a + b, 0)
    expect(Math.abs(total - 375 * 128 * 44100 / 48000)).toBeLessThan(3)
    expect(x.rendered.every(n => n >= 117 && n <= 120)).toBe(true)
    expect(o[0][0].every(v => Math.abs(v - 0.5) < 1e-6)).toBe(true)
    expect(o[0][1].every(v => Math.abs(v + 0.5) < 1e-6)).toBe(true)
  })

  it('panic drops queued events and sends its bytes at the next quantum', async () => {
    const { p, x } = await booted()
    globalThis.currentFrame = 0
    p.port.onmessage({ data: { type: 'midi', bytes: [0x90, 60, 100], frame: 1000 } })
    p.port.onmessage({ data: { type: 'panic', bytes: [0xB0, 123, 0] } })
    for (let q = 0; q < 20; q++) quantum(p, q * 128)
    expect(x.midi.map(m => m.b)).toEqual([0xB0, 123, 0])
  })

  it('holds a panel key for 4410 emulated frames', async () => {
    const { p, x } = await booted()
    p.port.onmessage({ data: { type: 'key', id: 12, down: true } })
    p.port.onmessage({ data: { type: 'key', id: 12, down: false } })
    for (let q = 0; q < 60; q++) quantum(p, q * 128)
    expect(x.keys[0]).toEqual({ id: 12, down: 1, at: 0 })
    let emu = 0, at = 0
    while (emu < 4410) emu += x.rendered[at++]
    expect(x.keys[1]).toEqual({ id: 12, down: 0, at })
  })

  it('counts late events and reports status about twice a second', async () => {
    const { p } = await booted()
    globalThis.currentFrame = 1000
    p.port.onmessage({ data: { type: 'midi', bytes: [0x90, 1, 1], frame: 10 } })
    for (let q = 0; q < 200; q++) quantum(p, 1000 + q * 128)
    const status = p.port.sent.find(m => m.type === 'status')
    expect(status.late).toBe(1)
    expect(status.dropped).toBe(0)
  })

  it('posts LCD frames only while subscribed, the image only on change', async () => {
    const { p, x } = await booted()
    for (let q = 0; q < 40; q++) quantum(p, q * 128)
    expect(p.port.sent.some(m => m.type === 'lcd')).toBe(false)
    p.port.onmessage({ data: { type: 'lcd', on: true } })
    for (let q = 0; q < 40; q++) quantum(p, q * 128)
    const lcds = p.port.sent.filter(m => m.type === 'lcd')
    expect(lcds[0].lcd).toHaveLength(57600)
    expect(lcds[1].lcd).toBeNull()
    expect(lcds[1].leds).toHaveLength(41)
    x.lcdRev++
    for (let q = 0; q < 14; q++) quantum(p, q * 128)
    expect(p.port.sent.filter(m => m.type === 'lcd').at(-1).lcd).toHaveLength(57600)
  })

  it('dispose ends the processor', async () => {
    const { p } = await booted()
    p.port.onmessage({ data: { type: 'dispose' } })
    expect(p.process([], out())).toBe(false)
  })

  it('reports boot failure and a halted firmware', async () => {
    const bad = fakeFm1Exports()
    bad.fm1_boot_fwsc = () => 1
    const { p } = await booted(bad)
    expect(p.port.sent[0]).toMatchObject({ type: 'error', reason: 'boot-failed' })

    let halted = 0
    const { p: q } = await booted(fakeFm1Exports({ halted: () => halted }))
    halted = 1
    for (let i = 0; i < 200; i++) quantum(q, i * 128)
    expect(q.port.sent.find(m => m.type === 'error')).toMatchObject({ reason: 'halted' })
  })
})

describe('fm1-worklet capture', () => {
  const caps = p => p.port.sent.filter(m => m.type === 'cap')

  it('posts 4096-frame batches of its output stamped with the first context frame, flushes on off', async () => {
    const { p } = await booted()
    quantum(p, 0)
    expect(caps(p)).toHaveLength(0)
    p.port.onmessage({ data: { type: 'capture', on: true, id: 7 } })
    const outs = []
    for (let q = 0; q < 40; q++) outs.push(quantum(p, 1280 + q * 128))
    const sent = caps(p)
    expect(sent.map(m => [m.frame, m.L.length])).toEqual([[1280, 4096]])
    expect(sent[0].id).toBe(7)
    expect(sent[0].last).toBeUndefined()
    expect(sent[0].L.every(v => Math.abs(v - 0.5) < 1e-6)).toBe(true)
    expect(sent[0].R.every(v => Math.abs(v + 0.5) < 1e-6)).toBe(true)
    expect(sent[0].L.subarray(128, 256)).toEqual(outs[1][0][0])
    p.port.onmessage({ data: { type: 'capture', on: false, id: 7 } })
    const last = caps(p).at(-1)
    expect(last).toMatchObject({ id: 7, frame: 1280 + 4096, last: true })
    expect(last.L).toHaveLength(8 * 128)
    quantum(p, 1280 + 40 * 128)
    expect(caps(p)).toHaveLength(2)
  })

  it('a gap in context frames starts a new batch; off with nothing captured answers empty', async () => {
    const { p } = await booted()
    p.port.onmessage({ data: { type: 'capture', on: true, id: 1 } })
    quantum(p, 0); quantum(p, 128)
    quantum(p, 1024)                                  // frames 256..1023 never rendered
    p.port.onmessage({ data: { type: 'capture', on: false, id: 1 } })
    expect(caps(p).map(m => [m.frame, m.L.length, !!m.last])).toEqual([[0, 256, false], [1024, 128, true]])
    p.port.onmessage({ data: { type: 'capture', on: false, id: 2 } })
    expect(caps(p).at(-1)).toMatchObject({ id: 2, last: true })
    expect(caps(p).at(-1).L).toHaveLength(0)
  })
})
