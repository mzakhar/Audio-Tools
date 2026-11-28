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

function setup({ firmware = new ArrayBuffer(32), worklet = false, getWasmBytes } = {}) {
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
    createWorker: () => { const w = fakeWorker(); workers.push(w); return w },
    createWorkletNode: () => {
      const n = { port: fakeWorker(), connect() {}, disconnect() { this.gone = true } }
      n.port.emit = (data) => n.port.onmessage({ data })
      nodes.push(n)
      return n
    },
    now: () => performance.now(),
  })
  return { ctx, sessions, workers, nodes, module }
}

const desc = { type: 'fm1', firmwareHash: 'sha256:aa', deviceChannel: 2, mhz: 120 }
const out = { name: 'mixer' }
const block = (frame, n = 128) => ({ type: 'block', frame, l: new Float32Array(n).fill(0.1), r: new Float32Array(n).fill(0.2) })

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
    expect(boot).toMatchObject({ type: 'boot', module, mhz: 120, leadFrames: Math.round(0.08 * R) })
    expect(boot.package.byteLength).toBe(32)
    const seen = []
    s.onStatus(st => seen.push(st.state))
    workers[0].emit({ type: 'ready' })
    await expect(s.ready).resolves.toBeUndefined()
    expect(seen).toEqual(['ready'])
    expect(s.status()).toMatchObject({ state: 'ready', path: 'worker', underruns: 0, late: 0, leadMs: 110 })
    expect(s.leadSec).toBeCloseTo(0.11)
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

  it('schedules blocks back to back and counts an underrun', async () => {
    const { s, w, ctx } = await readySession()
    w.emit(block(1000))
    w.emit(block(1128))
    expect(ctx.sources[0].startAt).toBeCloseTo(1.02, 9)
    expect(ctx.sources[1].startAt).toBeCloseTo(1.02 + 128 / R, 9)
    expect(ctx.sources[0].buffer.getChannelData(1)[0]).toBeCloseTo(0.2)
    expect(w.sent.find(m => m.type === 'consumed').frame).toBe(1000 - Math.round(0.02 * R))
    ctx.currentTime = 2
    w.emit(block(1256))
    expect(s.status().underruns).toBe(1)
    expect(ctx.sources[2].startAt).toBeCloseTo(2.02, 9)
  })

  it('stamps notes with the device channel and the frame of their audio time', async () => {
    const { s, w } = await readySession()
    w.emit(block(1000))
    s.noteOn(60, 100, 1.12)
    s.noteOff(60, 1.22)
    const midi = w.sent.filter(m => m.type === 'midi')
    expect(midi[0]).toEqual({ type: 'midi', bytes: [0x92, 60, 100], frame: 1000 + Math.round(0.1 * R) })
    expect(midi[1]).toEqual({ type: 'midi', bytes: [0x82, 60, 0], frame: 1000 + Math.round(0.2 * R) })
    s.sendMidi([0xB2, 1, 64])
    expect(w.sent.at(-1)).toEqual({ type: 'midi', bytes: [0xB2, 1, 64], frame: undefined })
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
    expect(port.sent.at(-1)).toEqual({ type: 'midi', bytes: [0x92, 60, 100], frame: 96000 })
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
