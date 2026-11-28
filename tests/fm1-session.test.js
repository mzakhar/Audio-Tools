import { describe, it, expect, vi } from 'vitest'
import { createFm1Sessions } from '../src/renderer/js/fm1/session-manager.js'
import { allNotesOffBytes } from '../src/renderer/js/fm1/host-core.js'

const flush = () => new Promise(r => setTimeout(r, 0))
const R = 44100

function fakeCtx({ worklet = false } = {}) {
  const node = () => ({ connected: [], connect(n) { this.connected.push(n) }, disconnect() { this.connected = [] } })
  const ctx = {
    currentTime: 1,
    sampleRate: 48000,
    sources: [],
    createGain: () => node(),
    createBuffer: (ch, n, rate) => {
      const data = Array.from({ length: ch }, () => new Float32Array(n))
      return { length: n, sampleRate: rate, getChannelData: i => data[i] }
    },
    createBufferSource() {
      const s = { ...node(), start(t) { this.startAt = t }, stop() { this.stopped = true } }
      ctx.sources.push(s)
      return s
    },
  }
  if (worklet) ctx.audioWorklet = { addModule: vi.fn(async () => {}) }
  return ctx
}

function fakeWorker() {
  return {
    sent: [], terminated: false,
    postMessage(m) { this.sent.push(m) },
    terminate() { this.terminated = true },
    emit(data) { this.onmessage({ data }) },
  }
}

function setup({ firmware = new ArrayBuffer(32), worklet = false, getWasmBytes, createWorker, createWorkletNode } = {}) {
  const ctx = fakeCtx({ worklet })
  const workers = []
  const nodes = []
  const module = { wasm: true }
  const sessions = createFm1Sessions({
    ctx,
    getModule: vi.fn(async () => module),
    getWasmBytes,
    readFirmware: vi.fn(async () => firmware),
    preferWorklet: () => worklet,
    workletUrl: 'worklets/fm1-worklet.js',
    createWorker: createWorker || (() => { const w = fakeWorker(); workers.push(w); return w }),
    createWorkletNode: createWorkletNode || (() => {
      const n = { port: fakeWorker(), connect() {}, disconnect() { this.gone = true } }
      n.port.emit = (data) => n.port.onmessage({ data })
      nodes.push(n)
      return n
    }),
    now: () => performance.now(),
  })
  return { ctx, sessions, workers, nodes, module }
}

const desc = { type: 'fm1', firmwareHash: 'sha256:aa', deviceChannel: 2, mhz: 120 }
const out = { name: 'mixer' }
const block = (frame, n = 1024) => ({ type: 'block', frame, l: new Float32Array(n).fill(0.1), r: new Float32Array(n).fill(0.2) })

async function readySession(opts) {
  const env = setup(opts)
  const s = env.sessions.acquire('t1', desc, out)
  await flush()
  env.workers[0]?.emit({ type: 'ready' })
  return { ...env, s, w: env.workers[0] }
}

describe('fm1 session (Worker path)', () => {
  it('boots: posts module, a copy of the package and mhz, then becomes ready', async () => {
    const { sessions, workers, module } = setup()
    const s = sessions.acquire('t1', desc, out)
    expect(s.path).toBe('worker')
    expect(s.status().state).toBe('booting')
    await flush()
    const boot = workers[0].sent[0]
    expect(boot).toMatchObject({ type: 'boot', module, mhz: 120, sampleRate: 48000, blockFrames: 1024,
      leadFrames: Math.round((0.08 + 1024 / 48000) * R) })
    expect(boot.package.byteLength).toBe(32)
    const seen = []
    s.onStatus(st => seen.push(st.state))
    workers[0].emit({ type: 'ready' })
    await expect(s.ready).resolves.toBeUndefined()
    expect(seen).toEqual(['ready'])
    expect(s.status()).toMatchObject({ state: 'ready', path: 'worker', underruns: 0, late: 0, bootTimeout: false, leadMs: 131 })
    expect(s.leadSec).toBeCloseTo(0.08 + 1024 / 48000 + 0.03, 9)
  })

  it('missing firmware fails without starting a worker', async () => {
    const { sessions, workers } = setup({ firmware: null })
    const s = sessions.acquire('t1', desc, out)
    await expect(s.ready).rejects.toThrow('missing-firmware')
    expect(s.status()).toMatchObject({ state: 'failed', reason: 'missing-firmware' })
    expect(workers).toHaveLength(0)
  })

  it('a worker error fails the session and stops its sources', async () => {
    const { s, w, ctx } = await readySession()
    w.emit(block(0))
    w.emit({ type: 'error', reason: 'halted', message: 'x' })
    expect(s.status()).toMatchObject({ state: 'failed', reason: 'halted' })
    expect(w.terminated).toBe(true)
    expect(ctx.sources[0].stopped).toBe(true)
  })

  it('schedules context-rate blocks at exact, contiguous frames and counts an underrun', async () => {
    const { s, w, ctx } = await readySession()
    ctx.currentTime = 1.0000123                 // not on a frame boundary
    for (let i = 0; i < 50; i++) { w.emit(block(i * 1024)); ctx.currentTime += 0.004 }
    const frames = ctx.sources.map(src => src.startAt * 48000)
    expect(frames.every(f => Math.abs(f - Math.round(f)) < 1e-6)).toBe(true)
    expect(frames.every((f, i) => i === 0 || Math.round(f - frames[i - 1]) === 1024)).toBe(true)
    expect(Math.round(frames[0])).toBe(Math.ceil(1.0200123 * 48000))
    expect(ctx.sources[0].buffer).toMatchObject({ length: 1024, sampleRate: 48000 })
    expect(ctx.sources[0].buffer.getChannelData(1)[0]).toBeCloseTo(0.2)
    expect(w.sent.find(m => m.type === 'consumed').frame).toBe(-960)
    expect(s.status().underruns).toBe(0)
    ctx.currentTime = 10
    w.emit(block(50 * 1024))
    expect(s.status().underruns).toBe(1)
    expect(ctx.sources.at(-1).startAt).toBeCloseTo(10.02, 9)
  })

  it('a ready that came from the boot timeout is flagged in status', async () => {
    const { sessions, workers } = setup()
    const s = sessions.acquire('t1', desc, out)
    await flush()
    workers[0].emit({ type: 'ready', timedOut: true })
    expect(s.status()).toMatchObject({ state: 'ready', bootTimeout: true })
  })

  it('a throw while starting the Worker fails the session and settles ready', async () => {
    for (const createWorker of [
      () => { throw new Error('no workers') },
      () => ({ postMessage() { throw new Error('clone') }, terminate() {} }),
    ]) {
      const { sessions } = setup({ createWorker })
      const s = sessions.acquire('t1', desc, out)
      await expect(s.ready).rejects.toThrow('wasm-failed')
      expect(s.status()).toMatchObject({ state: 'failed', reason: 'wasm-failed' })
    }
  })

  it('stamps notes with the device channel and the frame of their audio time', async () => {
    const { s, w } = await readySession()
    w.emit(block(1024))
    s.noteOn(60, 100, 1.12)
    s.noteOff(60, 1.22)
    const midi = w.sent.filter(m => m.type === 'midi')
    expect(midi[0]).toEqual({ type: 'midi', bytes: [0x92, 60, 100], frame: 1024 + 4800, src: 'live' })
    expect(midi[1]).toEqual({ type: 'midi', bytes: [0x82, 60, 0], frame: 1024 + 9600, src: 'live' })
    s.sendMidi([0xB2, 1, 64])
    expect(w.sent.at(-1)).toEqual({ type: 'midi', bytes: [0xB2, 1, 64], frame: undefined, src: 'live' })
  })

  it('takes late / starved counts from worker status', async () => {
    const { s, w } = await readySession()
    w.emit({ type: 'status', rtf: 1.7, starved: 2, late: 3, dropped: 0 })
    expect(s.status()).toMatchObject({ rtf: 1.7, starved: 2, late: 3 })
  })

  it('drops note and panel input before ready', async () => {
    const { sessions, workers } = setup()
    const s = sessions.acquire('t1', desc, out)
    await flush()
    s.noteOn(60, 100, 1)
    s.key(3, true)
    s.enc(0, 1)
    s.pot(500)
    expect(workers[0].sent.map(m => m.type)).toEqual(['boot'])
  })

  it('forwards panel input', async () => {
    const { s, w } = await readySession()
    s.key(14, true); s.key(14, false); s.enc(6, -2); s.pot(900)
    expect(w.sent.slice(-4)).toEqual([
      { type: 'key', id: 14, down: true }, { type: 'key', id: 14, down: false },
      { type: 'enc', id: 6, clicks: -2 }, { type: 'pot', value: 900 },
    ])
  })

  it('panic sends all-notes-off plus offs for held notes and never disposes', async () => {
    const { s, w } = await readySession()
    s.noteOn(60, 100); s.noteOn(64, 100); s.noteOn(67, 100); s.noteOff(67)
    s.panic()
    expect(w.sent.at(-1)).toEqual({ type: 'panic', bytes: [...allNotesOffBytes(), 0x82, 60, 0, 0x82, 64, 0] })
    expect(s.status().state).toBe('ready')
    expect(w.terminated).toBe(false)
    s.panic()
    expect(w.sent.at(-1).bytes).toEqual(allNotesOffBytes())
  })

  it('LCD: subscribes while someone listens, converts RGB565', async () => {
    const { s, w } = await readySession()
    const frames = []
    const off = s.onLcd((rgba, leds) => frames.push([rgba.slice(0, 4), leds]))
    expect(w.sent.at(-1)).toEqual({ type: 'lcd', on: true })
    const lcd = new Uint16Array(57600); lcd[0] = 0xF800
    const leds = new Float32Array(41); leds[12] = 1
    w.emit({ type: 'lcd', lcd, leds })
    expect([...frames[0][0]]).toEqual([255, 0, 0, 255])
    expect(frames[0][1][12]).toBe(1)
    off()
    expect(w.sent.at(-1)).toEqual({ type: 'lcd', on: false })
  })

  it('subscribing before boot turns the LCD on after boot', async () => {
    const { sessions, workers } = setup()
    const s = sessions.acquire('t1', desc, out)
    s.onLcd(() => {})
    await flush()
    expect(workers[0].sent.map(m => m.type)).toEqual(['boot', 'lcd'])
  })

  it('dispose terminates, stops sources, disconnects and makes methods no-ops', async () => {
    const { s, w, ctx } = await readySession()
    w.emit(block(0)); w.emit(block(128))
    s.dispose()
    expect(w.terminated).toBe(true)
    expect(ctx.sources.every(src => src.stopped)).toBe(true)
    expect(s.status().state).toBe('disposed')
    const n = w.sent.length
    s.noteOn(60, 100); s.panic(); s.key(1, true)
    expect(w.sent.length).toBe(n)
  })

  it('dispose while booting rejects ready and never starts a worker', async () => {
    const { sessions, workers } = setup()
    const s = sessions.acquire('t1', desc, out)
    s.dispose()
    await expect(s.ready).rejects.toThrow('disposed')
    await flush()
    expect(workers).toHaveLength(0)
  })
})

describe('fm1 session (worklet path)', () => {
  it('posts wasm bytes and stamps events with context frames', async () => {
    const wasm = new ArrayBuffer(8)
    const { sessions, nodes, ctx } = setup({ worklet: true, getWasmBytes: async () => wasm })
    const s = sessions.acquire('t1', desc, out)
    expect(s.path).toBe('worklet')
    await flush()
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith('worklets/fm1-worklet.js')
    const port = nodes[0].port
    expect(port.sent[0]).toMatchObject({ type: 'boot', wasm, module: null, mhz: 120 })
    port.emit({ type: 'ready' })
    expect(s.leadSec).toBeCloseTo(0.02)
    s.noteOn(60, 100, 2)
    expect(port.sent.at(-1)).toEqual({ type: 'midi', bytes: [0x92, 60, 100], frame: 96000, src: 'live' })
    s.dropFrom(2.5)
    expect(port.sent.at(-1)).toEqual({ type: 'drop', frame: 120000 })
    s.dispose()
    expect(port.sent.at(-1)).toEqual({ type: 'dispose' })
    expect(nodes[0].gone).toBe(true)
  })

  it('falls back to the Worker path when the worklet cannot take the wasm', async () => {
    const { sessions, nodes, workers } = setup({ worklet: true })
    const s = sessions.acquire('t1', desc, out)
    await flush()
    expect(nodes[0].port.sent[0].module).toEqual({ wasm: true })
    nodes[0].port.emit({ type: 'error', reason: 'wasm-failed' })
    await flush()
    expect(s.path).toBe('worker')
    expect(workers[0].sent[0].type).toBe('boot')
    workers[0].emit({ type: 'ready' })
    expect(s.status().state).toBe('ready')
  })

  it('a throw constructing or connecting the node falls back to the Worker; a throw there too fails', async () => {
    const env = setup({ worklet: true, getWasmBytes: async () => new ArrayBuffer(8),
      createWorkletNode: () => ({ port: fakeWorker(), connect() { throw new Error('no') }, disconnect() {} }) })
    const s = env.sessions.acquire('t1', desc, out)
    await flush(); await flush()
    expect(s.path).toBe('worker')
    expect(env.workers).toHaveLength(1)

    const bad = setup({ worklet: true, getWasmBytes: async () => new ArrayBuffer(8),
      createWorkletNode: () => { throw new Error('no') }, createWorker: () => { throw new Error('no') } })
    const t = bad.sessions.acquire('t1', desc, out)
    await expect(t.ready).rejects.toThrow('wasm-failed')
  })

  // Two worklet devices on the one audio thread overloaded it in Electron (context clock at 65%,
  // both devices silent): only one device runs in the worklet, the others on Workers.
  it('runs ONE device in the worklet; a second runs on the Worker path, the worklet is reused once free', async () => {
    const { sessions, nodes, workers } = setup({ worklet: true, getWasmBytes: async () => new ArrayBuffer(8) })
    const a = sessions.acquire('t1', desc, out)
    const b = sessions.acquire('t2', desc, out)
    expect([a.path, b.path]).toEqual(['worklet', 'worker'])
    await flush()
    expect([nodes.length, workers.length]).toEqual([1, 1])
    expect(sessions.acquire('t1', { ...desc, mhz: 160 }, out).path).toBe('worklet')   // the replaced one freed it
    sessions.release('t1')
    expect(sessions.acquire('t3', desc, out).path).toBe('worklet')
  })

  it('falls back to the Worker path when addModule fails', async () => {
    const { sessions, workers, ctx } = setup({ worklet: true })
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error('no'))
    const s = sessions.acquire('t1', desc, out)
    await flush(); await flush()
    expect(s.path).toBe('worker')
    expect(workers).toHaveLength(1)
  })
})

describe('fm1 session manager', () => {
  it('reuses the session for the same key and descriptor, re-pointing its output', async () => {
    const { sessions } = setup()
    const a = sessions.acquire('t1', desc, out)
    const other = { name: 'other' }
    const b = sessions.acquire('t1', { ...desc }, other)
    expect(b).toBe(a)
    expect(a.output).toBe(other)
    expect(sessions.get('t1')).toBe(a)
    expect(sessions.get('nope')).toBeNull()
  })

  it('fills descriptor defaults: channel 0, 120 MHz', () => {
    const { sessions } = setup()
    const a = sessions.acquire('t1', { type: 'fm1', firmwareHash: 'sha256:aa' }, out)
    expect(a.descriptor).toEqual({ type: 'fm1', firmwareHash: 'sha256:aa', deviceChannel: 0, mhz: 120 })
    expect(sessions.acquire('t1', { type: 'fm1', firmwareHash: 'sha256:aa', deviceChannel: 0, mhz: 120 }, out)).toBe(a)
  })

  it('a different descriptor disposes the old session and boots a new one', async () => {
    const { sessions } = setup()
    const a = sessions.acquire('t1', desc, out)
    for (const change of [{ mhz: 240 }, { firmwareHash: 'sha256:bb' }, { deviceChannel: 5 }]) {
      const prev = sessions.get('t1')
      const b = sessions.acquire('t1', { ...desc, ...change }, out)
      expect(b).not.toBe(prev)
      expect(prev.status().state).toBe('disposed')
    }
    expect(a.status().state).toBe('disposed')
  })

  it('use(): keeps a failed session (no reboot per note), replaces a disposed one, else acquires', async () => {
    const env = setup({ firmware: null })
    const a = env.sessions.acquire('t1', desc, out)
    await flush()
    expect(env.sessions.use('t1', desc, out)).toBe(a)
    expect(env.sessions.use('t1', { ...desc, mhz: 240 }, out)).not.toBe(a)
    const b = env.sessions.get('t1')
    b.dispose()
    const c = env.sessions.use('t1', { ...desc, mhz: 240 }, out)
    expect(c).not.toBe(b)
    expect(c.status().state).toBe('booting')
    expect(env.sessions.use('t1', { ...desc, mhz: 240 }, out)).toBe(c)
  })

  it('replaces a failed session on the next acquire', async () => {
    const env = setup({ firmware: null })
    const a = env.sessions.acquire('t1', desc, out)
    await flush()
    expect(a.status().state).toBe('failed')
    const b = env.sessions.acquire('t1', desc, out)
    expect(b).not.toBe(a)
  })

  it('keeps sessions per key apart; release, disposeAll, panicAll', async () => {
    const { sessions, workers } = setup()
    const a = sessions.acquire('t1', desc, out)
    const b = sessions.acquire('audition', desc, out)
    expect(a).not.toBe(b)
    await flush()
    for (const w of workers) w.emit({ type: 'ready' })
    sessions.panicAll()
    expect(workers.every(w => w.sent.at(-1).type === 'panic')).toBe(true)
    sessions.release('audition')
    expect(b.status().state).toBe('disposed')
    expect(sessions.get('audition')).toBeNull()
    expect(a.status().state).toBe('ready')
    sessions.disposeAll()
    expect(a.status().state).toBe('disposed')
    expect(sessions.get('t1')).toBeNull()
  })
})

describe('fm1 session: one device, live and timeline notes', () => {
  // The session forwards everything, tagged by source; the host decides at the frame the off is
  // due (createNoteCounts in the queue), so call order cannot release another source's note.
  it('tags every note with its source and forwards all of them; panic offs the held notes', async () => {
    const { s, w } = await readySession()
    w.emit(block(0))
    const midi = () => w.sent.filter(m => m.type === 'midi').map(m => [m.bytes, m.src])
    s.noteOn(60, 100)                       // live
    s.noteOn(60, 90, 1.1, 'timeline')
    s.noteOff(60, 1.2, 'timeline')
    s.noteOff(60)
    expect(midi()).toEqual([[[0x92, 60, 100], 'live'], [[0x92, 60, 90], 'timeline'], [[0x82, 60, 0], 'timeline'], [[0x82, 60, 0], 'live']])
    s.noteOn(62, 100)
    s.panic()
    expect(w.sent.at(-1)).toEqual({ type: 'panic', bytes: [...allNotesOffBytes(), 0x82, 62, 0] })
  })
})

describe('fm1 session capture', () => {
  const ramp = (n, from) => Float32Array.from({ length: n }, (_, i) => (from + i) / 1e5)
  const blk = (frame, from) => ({ type: 'block', frame, l: ramp(1024, from), r: ramp(1024, from).map(v => -v) })

  it('Worker path: places blocks at their audible time, keeps the underrun gap, drops before start', async () => {
    const { s, w, ctx } = await readySession()
    ctx.currentTime = 1
    w.emit(blk(0, 0))                                 // anchored at ceil(1.02 * 48000) = 48960
    const S = 48960 / 48000 + 512 / 48000             // start mid-way through the first block
    const cap = s.startCapture({ startTime: S })
    w.emit(blk(0, 0))                                 // (re-sent first block: audible before S partly)
    expect(() => s.startCapture({ startTime: 2 })).toThrow('already')
    ctx.currentTime = 1.01
    w.emit(blk(1024, 1024))
    ctx.currentTime = 1.5                             // late: re-anchors at ceil(1.52 * 48000)
    w.emit(blk(2048, 2048))
    expect(s.status().underruns).toBe(1)
    const at3 = ctx.sources.at(-1).startAt
    expect(cap.peak()).toBeCloseTo(3071 / 1e5)
    const take = await cap.finish()
    expect(take.rate).toBe(48000)
    // the frame audible at S is block 0 sample 512
    expect(take.L[0]).toBeCloseTo(512 / 1e5, 7)
    expect(take.R[511 + 1024]).toBeCloseTo(-2047 / 1e5, 7)
    const gapAt = Math.round((at3 - S) * 48000)
    expect(gapAt).toBe(Math.ceil(1.52 * 48000 - 1e-6) - 49472)
    expect([...take.L.subarray(1536, gapAt)].every(v => v === 0)).toBe(true)
    expect(take.L[gapAt]).toBeCloseTo(2048 / 1e5, 7)
    expect(take.frames).toBe(gapAt + 1024)
    // capture is over: a new one may start, later blocks do not reach the old take
    w.emit(blk(3072, 0))
    expect(take.frames).toBe(gapAt + 1024)
    s.startCapture({ startTime: 0 }).cancel()
  })

  it('Worker path: finish(endTime) trims; cancel drops the take; maxSeconds sets full', async () => {
    const { s, w, ctx } = await readySession()
    ctx.currentTime = 1
    w.emit(blk(0, 0))
    const S = 48960 / 48000
    const a = s.startCapture({ startTime: S })
    w.emit(blk(0, 0))
    expect((await a.finish(S + 100 / 48000)).frames).toBe(100)
    const b = s.startCapture({ startTime: S, maxSeconds: 1000 / 48000 })
    w.emit(blk(0, 0))
    expect(b.full()).toBe(true)
    expect(b.frames()).toBe(1000)
    b.cancel()
    expect(() => s.startCapture({ startTime: S }).cancel()).not.toThrow()
  })

  it('worklet path: capture on/off messages, batches placed by context frame, finish waits for the last batch', async () => {
    const { sessions, nodes } = setup({ worklet: true, getWasmBytes: async () => new ArrayBuffer(8) })
    const s = sessions.acquire('t1', desc, out)
    const early = s.startCapture({ startTime: 2 })    // before the node exists: sent once it does
    await flush(); await flush()
    const port = nodes[0].port
    expect(port.sent.find(m => m.type === 'capture')).toEqual({ type: 'capture', on: true, id: 1 })
    port.emit({ type: 'ready' })
    early.cancel()
    expect(port.sent.at(-1)).toEqual({ type: 'capture', on: false, id: 1 })
    port.emit({ type: 'cap', id: 1, L: new Float32Array(4).fill(1), R: new Float32Array(4), frame: 96000, last: true })

    const cap = s.startCapture({ startTime: 2 })
    expect(port.sent.at(-1)).toEqual({ type: 'capture', on: true, id: 2 })
    port.emit({ type: 'cap', id: 2, L: new Float32Array(256).fill(0.25), R: new Float32Array(256).fill(-0.25), frame: 96000 - 128 })
    port.emit({ type: 'cap', id: 2, L: new Float32Array(128).fill(0.5), R: new Float32Array(128), frame: 96000 + 512 })
    expect(cap.frames()).toBe(640)
    let done = null
    const p = cap.finish().then(t => { done = t })
    await flush()
    expect(done).toBeNull()                           // waiting for the flush
    expect(port.sent.at(-1)).toEqual({ type: 'capture', on: false, id: 2 })
    port.emit({ type: 'cap', id: 2, L: new Float32Array(128).fill(0.75), R: new Float32Array(128), frame: 96000 + 640, last: true })
    await p
    expect(done.frames).toBe(768)
    expect(done.L[0]).toBe(0.25)                      // frame 96000 = time 2
    expect(done.L[127]).toBe(0.25)
    expect(done.L[128]).toBe(0)                       // gap
    expect(done.L[512]).toBe(0.5)
    expect(done.L[767]).toBe(0.75)
    expect(done.R[0]).toBe(-0.25)
  })

  it('worklet path: finish still resolves if the device goes away', async () => {
    const { sessions, nodes } = setup({ worklet: true, getWasmBytes: async () => new ArrayBuffer(8) })
    const s = sessions.acquire('t1', desc, out)
    await flush(); await flush()
    nodes[0].port.emit({ type: 'ready' })
    const cap = s.startCapture({ startTime: 0 })
    const p = cap.finish()
    s.dispose()
    await expect(p).resolves.toMatchObject({ frames: 0 })
  })
})

describe('fm1 session capture started after play()', () => {
  it('Worker path: blocks scheduled before startCapture that reach past a future startTime are in the take', async () => {
    const { s, w, ctx } = await readySession()
    ctx.currentTime = 1
    const fill = (frame, v) => ({ type: 'block', frame, l: new Float32Array(1024).fill(v), r: new Float32Array(1024).fill(-v) })
    w.emit(fill(0, 0.1)); w.emit(fill(1024, 0.2)); w.emit(fill(2048, 0.3))   // at 1.02 ... ahead of time
    const S = (48960 + 1500) / 48000                                          // play() just returned S
    const cap = s.startCapture({ startTime: S })
    w.emit(fill(3072, 0.4))
    const take = await cap.finish()
    expect(take.frames).toBe(4096 - 1500)
    expect(take.L[0]).toBeCloseTo(0.2)
    expect(take.L[2048 - 1500]).toBeCloseTo(0.3)
    expect(take.R[3072 - 1500]).toBeCloseTo(-0.4)
  })
})
