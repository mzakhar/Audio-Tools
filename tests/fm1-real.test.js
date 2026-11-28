// @vitest-environment node
// Real emulator check, skipped unless FM1_FW_DIR names a folder holding felucca-1.8.4.fwsc
// (firmware is never committed):  FM1_FW_DIR=E:/tmp/fm1-firmware npx vitest run tests/fm1-real.test.js
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bootEmulator, bootToReady, createRunner, CHUNK } from '../src/renderer/js/fm1/emulator.js'
import { noteOnBytes, createBlockWriter, createTake, createFlashGate, FM1_RATE } from '../src/renderer/js/fm1/host-core.js'
import { encodeFlashAsset, decodeFlashAsset, packRestore, FLASH_SIZE, SECTOR } from '../src/renderer/js/fm1/flash-asset.js'
import { sha256Hex } from '../src/renderer/js/fm1/sha256.js'
import { createFm1Session } from '../src/renderer/js/fm1/session.js'

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
    // Worker-path runner: FX click (down, up 80 ms later, no further input) opens the page
    const shot = () => new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240).slice()
    const a = shot()
    r.key(2, true); rms(r, 0.08); r.key(2, false); rms(r, 1.5)
    const fx = shot().reduce((n, v, i) => n + (v !== a[i]), 0)
    console.log(`fm1-real runner: FX click ${fx} px changed`)
    expect(fx).toBeGreaterThan(1000)
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
      const shot = () => new Uint16Array(p.x.memory.buffer, p.x.fm1_lcd(), 240 * 240).slice()
      const changed = (a, b) => a.reduce((n, v, i) => n + (v !== b[i]), 0)
      quanta(375)
      // the UI's click: FX down, up 80 ms later (before the 100 ms hold expires), then no further
      // input. The pending release must still be applied by the render loop.
      const a = shot(), before = p.port.sent.length
      send({ type: 'key', id: 2, down: true })
      quanta(30)
      send({ type: 'key', id: 2, down: false })
      quanta(560)                                     // 1.5 s
      const fx = changed(a, shot())
      const images = p.port.sent.slice(before).filter(m => m.type === 'lcd' && m.lcd)
      // Felucca's page buttons are long-press aware: held ~0.4 s or more they do not open the page
      // (firmware behaviour, not the host) — so the panel must release a click promptly.
      send({ type: 'key', id: 8, down: true }); quanta(30); send({ type: 'key', id: 8, down: false }); quanta(560)   // HOME
      const b = shot()
      send({ type: 'key', id: 2, down: true }); quanta(560); send({ type: 'key', id: 2, down: false }); quanta(560)
      const held = changed(b, shot())
      console.log(`fm1-real worklet: ready at ${readyMs} ms emulated, first-note rms ${first.toExponential(2)}, FX click ${fx} px changed (${images.length} images posted), FX held 1.5 s ${held} px`)
      expect(p.port.sent.some(m => m.type === 'error')).toBe(false)
      expect(first).toBeGreaterThan(1e-3)
      expect(fx).toBeGreaterThan(1000)
      expect(images.length).toBeGreaterThan(0)
    } finally {
      for (const [k, v] of saved) globalThis[k] = v
    }
  }, 120000)
})

// Capture latency proof: what a take holds at index i is exactly what was audible at context time
// S + i / rate (latency compensation 0). Onset = first sample above a threshold set from the idle
// floor; the take's onset index must equal round((audibleOnset - S) * rate) within one frame.
const onsetOf = (a, from, thr) => { for (let i = Math.max(0, from); i < a.length; i++) if (Math.abs(a[i]) > thr) return i; return -1 }
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

run('FM-1 real firmware: capture lands at audible time (latency 0)', () => {
  it('worklet host: the take is the audible output from S on, note onset at round((t-S)*rate)', async () => {
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
      p.port.onmessage({ data: { type: 'boot', wasm: ab(wasm), package: ab(readFileSync(fw)), mhz: 120 } })
      while (!p.x) await new Promise(r => setTimeout(r, 5))
      const send = data => p.port.onmessage({ data })
      const audible = []                               // [frame, L] per quantum
      const quanta = (n) => {
        for (let i = 0; i < n; i++) {
          const o = [[new Float32Array(128), new Float32Array(128)]]
          p.process([], o)
          audible.push([globalThis.currentFrame, o[0][0]])
          globalThis.currentFrame += 128
        }
      }
      while (!p.port.sent.some(m => m.type === 'ready')) quanta(1)
      quanta(375)                                     // settle 1 s
      const rate = 48000
      const S = (globalThis.currentFrame + 2400) / rate + 0.37 / rate   // 50 ms ahead, off-grid
      const s0 = Math.round(S * rate)
      send({ type: 'capture', on: true, id: 1 })
      const idleFrom = audible.length
      quanta(40)
      const noteFrame = globalThis.currentFrame + 4800 // 100 ms later
      send({ type: 'midi', bytes: noteOnBytes(0, 60, 110), frame: noteFrame })
      quanta(300)
      send({ type: 'capture', on: false, id: 1 })
      const take = createTake({ rate, startTime: S, maxFrames: rate * 10 })
      for (const m of p.port.sent.filter(m => m.type === 'cap')) take.add(m.L, m.R, m.frame / rate)
      const { L } = take.finish()
      const first = audible[0][0], flat = new Float32Array(globalThis.currentFrame - first)
      for (const [f, l] of audible) flat.set(l, f - first)
      let floor = 0
      for (const [, l] of audible.slice(idleFrom, idleFrom + 35)) for (const v of l) floor = Math.max(floor, Math.abs(v))
      const thr = Math.max(1e-3, floor * 4)
      const heard = onsetOf(flat, noteFrame - first, thr) + first
      const got = onsetOf(L, noteFrame - s0, thr)
      expect(heard).toBeGreaterThan(noteFrame - 1)
      expect(Math.abs(got - (heard - s0))).toBeLessThanOrEqual(1)
      let mismatched = 0
      for (let i = 0; i < L.length; i++) if (L[i] !== flat[s0 + i - first]) mismatched++
      expect(mismatched).toBe(0)
      console.log(`fm1-real capture (worklet): take onset ${got} vs audible ${heard - s0} (delta ${got - (heard - s0)} frames); ` +
        `note->sound ${((heard - noteFrame) / rate * 1000).toFixed(1)} ms (firmware, not compensated); idle floor ${floor.toExponential(2)}, ${L.length} frames`)
    } finally {
      for (const [k, v] of saved) globalThis[k] = v
    }
  }, 120000)

  it('Worker path: the take is what the scheduled blocks play from S on, an underrun gap included', async () => {
    const wasm = readFileSync(resolve(process.cwd(), 'src/renderer/public/fm1/fm1_web.wasm'))
    const module = await WebAssembly.compile(wasm)
    const { x } = await bootEmulator({ module, pkg: ab(readFileSync(fw)), mhz: 120 })
    const r = createRunner(x, { mhz: 120 })
    expect(bootToReady(r, x)).toBe('up')
    for (let i = 0; i < 345; i++) r.render()
    const rate = 48000
    const node = () => ({ connect() {}, disconnect() {} })
    const ctx = { currentTime: 10, sampleRate: rate, sources: [], createGain: node,
      createBuffer: (ch, n) => { const d = [new Float32Array(n), new Float32Array(n)]; return { getChannelData: i => d[i] } },
      createBufferSource() { const s = { ...node(), start(t) { this.startAt = t } }; ctx.sources.push(s); return s } }
    let w
    const s = createFm1Session({ ctx, key: 'k', descriptor: { firmwareHash: 'h', deviceChannel: 0, mhz: 120 }, output: {},
      getModule: async () => ({}), readFirmware: async () => new ArrayBuffer(8),
      createWorker: () => (w = { postMessage() {}, terminate() {} }), now: () => 0 })
    await new Promise(res => setTimeout(res, 0))
    w.onmessage({ data: { type: 'ready' } })
    const writer = createBlockWriter(FM1_RATE, rate, 1024)
    const pump = (chunks) => { for (let i = 0; i < chunks; i++) { const { l, r: rr } = r.render(); for (const b of writer.push(l, rr)) w.onmessage({ data: { type: 'block', ...b } }) } }
    pump(40)                                          // ~0.1 s scheduled ahead
    const S = ctx.currentTime + 0.05 + 0.29 / rate     // a recording starts after play(), S ahead
    const cap = s.startCapture({ startTime: S })
    r.midi(noteOnBytes(0, 60, 110), r.frame + 2000)
    for (let k = 0; k < 20; k++) { ctx.currentTime += 0.02; pump(8) }
    ctx.currentTime += 0.5                             // the tab stalled: next block re-anchors later
    for (let k = 0; k < 10; k++) { pump(8); ctx.currentTime += 0.02 }
    expect(s.status().underruns).toBe(1)
    const { L } = await cap.finish()
    // audible timeline from what was scheduled
    const s0 = Math.round(S * rate)
    const last = ctx.sources.at(-1)
    const flat = new Float32Array(Math.round(last.startAt * rate) + 1024 - s0)
    for (const src of ctx.sources) {
      const at = Math.round(src.startAt * rate) - s0, d = src.buffer.getChannelData(0)
      for (let i = 0; i < d.length; i++) if (at + i >= 0) flat[at + i] = d[i]
    }
    expect(L.length).toBe(flat.length)
    let mismatched = 0
    for (let i = 0; i < L.length; i++) if (L[i] !== flat[i]) mismatched++
    expect(mismatched).toBe(0)
    let floor = 0
    for (let i = 0; i < 1000; i++) floor = Math.max(floor, Math.abs(L[i]))
    const thr = Math.max(1e-3, floor * 4), got = onsetOf(L, 0, thr), heard = onsetOf(flat, 0, thr)
    expect(got).toBeGreaterThan(0)
    expect(Math.abs(got - heard)).toBeLessThanOrEqual(1)
    console.log(`fm1-real capture (worker): take onset ${got} vs audible ${heard}; ${L.length} frames incl. underrun gap`)
    s.dispose()
  }, 120000)
})

// A real firmware save through the panel (Felucca: SAVE opens the slot list, OCT+ opens naming,
// OCT+ again writes the patch), then snapshot -> asset -> a NEW machine restored from it.
run('FM-1 real firmware: a panel save survives snapshot, asset and restore', () => {
  it('saves a patch to flash and a fresh boot restores those sectors', async () => {
    const wasm = readFileSync(resolve(process.cwd(), 'src/renderer/public/fm1/fm1_web.wasm'))
    const module = await WebAssembly.compile(wasm)
    const buf = readFileSync(fw)
    const pkg = () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const firmwareHash = 'sha256:' + sha256Hex(new Uint8Array(pkg()))
    const { x } = await bootEmulator({ module, pkg: pkg(), mhz: 120 })
    const r = createRunner(x, { mhz: 120 })
    expect(bootToReady(r, x)).toBe('up')
    const secs = (s) => { for (let i = 0; i < Math.round(s * FM1_RATE / CHUNK); i++) r.render() }
    secs(1)
    const rev0 = r.flashRevision()
    expect(r.changedSectors()).toEqual([])
    const click = (id) => { r.key(id, true); secs(0.08); r.key(id, false); secs(1) }
    click(9); click(1); click(1)                          // SAVE, OCT+ (name), OCT+ (save)
    // the worker's rule: wait until not busy and quiet 250 ms
    const gate = createFlashGate({ revision: rev0 })
    let t = 0, answer = []
    gate.request({ request: 1 }, 0)
    while (!answer.length) { secs(0.01); t += 10; gate.observe(r.flashRevision(), t); answer = gate.take(r.flashBusy(), t) }
    expect(answer[0].ok).toBe(true)
    expect(gate.revision).not.toBe(rev0)
    const records = r.changedSectors()
    expect(records.length).toBeGreaterThan(0)
    const asset = encodeFlashAsset({ firmwareHash, records })
    console.log(`fm1-real flash: panel save -> ${records.length} sector(s) at ${records.map(s => '0x' + s.offset.toString(16)).join(', ')}, ` +
      `revision ${rev0} -> ${gate.revision}, asset ${asset.length} B`)
    const got = decodeFlashAsset(asset, { firmwareHash })
    expect(got.ok).toBe(true)

    const { x: y } = await bootEmulator({ module, pkg: pkg(), mhz: 120, sectors: packRestore(got.records) })
    const live = (z) => new Uint8Array(z.memory.buffer, z.fm1_flash(), FLASH_SIZE)
    for (const { offset } of records) expect(live(y).slice(offset, offset + SECTOR)).toEqual(live(x).slice(offset, offset + SECTOR))
    const r2 = createRunner(y, { mhz: 120 })
    expect(bootToReady(r2, y)).toBe('up')
    expect(r2.changedSectors().map(s => s.offset)).toEqual(records.map(s => s.offset))
    // a late restore (after the first render) is refused by the emulator
    const p = y.fm1_alloc(4100)
    expect(y.fm1_flash_restore(p, 4100)).not.toBe(0)
  }, 120000)
})

// Two FM-1 tracks keep INDEPENDENT saved state through the whole project path: real emulators
// behind the session manager (an in-process Worker stand-in), saveProject, the store, flashReader,
// then a fresh manager re-opening both tracks from the written assets.
run('FM-1 real firmware: two tracks save and reopen their own state', () => {
  it('track A (one panel save) and track B (an edited patch, saved) each restore their own sectors', async () => {
    const { createFm1Sessions } = await import('../src/renderer/js/fm1/session-manager.js')
    const { saveProject, flashReader } = await import('../src/renderer/js/fm1/project-flash.js')
    const { fm1Descriptor } = await import('../src/renderer/js/fm1/descriptor.js')
    const { default: ProjectStore, AddTrack, SetTrackInstrument, SetTrackFlashAssets } = await import('../src/renderer/js/store/ProjectStore.js')
    const module = await WebAssembly.compile(readFileSync(resolve(process.cwd(), 'src/renderer/public/fm1/fm1_web.wasm')))
    const buf = readFileSync(fw)
    const firmwareHash = 'sha256:' + sha256Hex(new Uint8Array(ab(buf)))
    const node = () => ({ connect() {}, disconnect() {} })
    const ctx = { currentTime: 0, sampleRate: 48000, createGain: node }
    // the Worker protocol over a real machine, run synchronously by the test
    const machines = []
    const createWorker = () => {
      const w = { postMessage(m) { w.inbox(m) }, terminate() {} }
      w.inbox = async (m) => {
        if (m.type === 'boot') {
          const { x } = await bootEmulator({ module, pkg: m.package, mhz: m.mhz, sectors: m.sectors })
          w.run = createRunner(x, { mhz: m.mhz })
          expect(bootToReady(w.run, x)).toBe('up')
          machines.push(w)
          w.onmessage({ data: { type: 'ready', flashRevision: w.run.flashRevision() } })
        } else if (m.type === 'snapshot') {
          const revision = w.run.flashRevision()
          w.onmessage({ data: { type: 'snapshot', request: m.request, revision, changed: revision !== m.since, sectors: packRestore(w.run.changedSectors()) } })
        }
      }
      return w
    }
    const disk = new Map()
    let dir = '/proj'
    const manager = (readFlash) => createFm1Sessions({ ctx, getModule: async () => module, readFirmware: async () => ab(buf), readFlash, createWorker, now: () => 0 })
    const ready = async (s) => { for (let i = 0; i < 200 && s.status().state === 'booting'; i++) await new Promise(r => setTimeout(r, 5)); return s.status().state }

    ProjectStore.reset()
    ProjectStore.dispatch(AddTrack('midi', 'MIDI'))
    ProjectStore.dispatch(AddTrack('midi', 'MIDI'))
    const [a, b] = ProjectStore.getState().tracks.slice(-2).map(t => t.id)
    for (const id of [a, b]) ProjectStore.dispatch(SetTrackInstrument(id, { type: 'fm1', firmwareHash, deviceChannel: 0, mhz: 120 }))
    const reader = flashReader({ getDir: () => dir, readFm1Flash: async (d, name) => disk.get(`${d}/${name}`) ?? null })
    const first = manager(reader)
    const sa = first.acquire(a, fm1Descriptor(ProjectStore.getState().tracks.find(t => t.id === a).instrument), {})
    const sb = first.acquire(b, fm1Descriptor(ProjectStore.getState().tracks.find(t => t.id === b).instrument), {})
    expect(await ready(sa)).toBe('ready')
    expect(await ready(sb)).toBe('ready')
    const [ma, mb] = machines
    const play = (m, s) => { for (let i = 0; i < Math.round(s * FM1_RATE / CHUNK); i++) m.run.render() }
    const click = (m, id) => { m.run.key(id, true); play(m, 0.08); m.run.key(id, false); play(m, 1) }
    play(ma, 1); play(mb, 1)
    click(ma, 9); click(ma, 1); click(ma, 1)                              // A: SAVE, OCT+, OCT+
    mb.run.enc(1, 3); play(mb, 0.5); mb.run.enc(2, 10); play(mb, 1)        // B: another algorithm + KNOB 1, then
    click(mb, 9); click(mb, 1); click(mb, 1)                              //    the same SAVE, OCT+, OCT+
    play(ma, 0.5); play(mb, 0.5)
    const recA = ma.run.changedSectors(), recB = mb.run.changedSectors()
    expect(recA.length).toBeGreaterThan(0)
    expect(recB.length).toBeGreaterThan(0)
    const same = recA.length === recB.length && recA.every((r, i) => r.offset === recB[i].offset && r.bytes.every((v, k) => v === recB[i].bytes[k]))
    expect(same, 'the two devices must hold different saves for this check to mean anything').toBe(false)

    let n = 0, written = null
    const { messages } = await saveProject({
      getState: () => ProjectStore.getState(),
      snapshotAll: () => first.snapshotAll(),
      writeFlash: async (name, bytes) => { disk.set(`${dir}/${name}`, bytes) },
      commit: list => ProjectStore.dispatch(SetTrackFlashAssets(list)),
      writeProject: async state => { written = JSON.parse(JSON.stringify(state)) },
      getSession: id => first.get(id),
      newId: () => `asset-${++n}`
    })
    expect(messages).toEqual([])
    expect(disk.size).toBe(2)
    const idA = written.tracks.find(t => t.id === a).instrument.flashAssetId
    const idB = written.tracks.find(t => t.id === b).instrument.flashAssetId
    expect(idA).toBeTruthy(); expect(idB).toBeTruthy(); expect(idA).not.toBe(idB)
    first.disposeAll()

    // reopen: a fresh manager, the saved project
    ProjectStore.load(written)
    machines.length = 0
    const second = manager(reader)
    const track = id => ProjectStore.getState().tracks.find(t => t.id === id)
    const ra = second.acquire(a, fm1Descriptor(track(a).instrument), {})
    expect(await ready(ra)).toBe('ready')
    const rb = second.acquire(b, fm1Descriptor(track(b).instrument), {})
    expect(await ready(rb)).toBe('ready')
    const snapA = await ra.snapshotFlash(), snapB = await rb.snapshotFlash()
    const plain = recs => recs.map(r => ({ offset: r.offset, bytes: [...r.bytes] }))
    expect(plain(snapA.records)).toEqual(plain(recA))
    expect(plain(snapB.records)).toEqual(plain(recB))
    expect(snapA.changed).toBe(false)
    console.log(`fm1-real two tracks: A ${recA.length} sector(s) ${recA.map(r => '0x' + r.offset.toString(16))}, B ${recB.length} sector(s) ${recB.map(r => '0x' + r.offset.toString(16))}; reopened independently`)
    second.disposeAll()
  }, 180000)
})
