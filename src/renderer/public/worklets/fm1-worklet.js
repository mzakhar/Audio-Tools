// FM-1 Path B host: the emulator in the audio thread (secure contexts, which have an
// AudioWorklet). Each quantum renders just enough 44.1 kHz frames for the resampler to fill the
// context's quantum, with timed MIDI applied at the first quantum whose start frame (context
// frames) >= the event's frame. ONE self-contained file: an AudioWorklet does not import modules
// everywhere, so the JIT host (fm1/jit.js, from fm1-emu web/jit.js, commit 69cb1ef, MIT,
// Copyright (c) 2026 Joakim Eriksson) and the queue, note counts, key hold and resampler
// (fm1/host-core.js) and createBootWatch (fm1/host-core.js) are inline copies. Keep them in step.
//
// Boot runs inside process() at real time (each quantum gets only its own share of emulated
// cycles), so a booting device never hogs the audio thread other nodes share. `ready` is posted
// once the firmware is up and taking input (createBootWatch: audio started, then the UI redrew the
// LCD) or after 8 s of
// emulated time, flagged timedOut — the same rule as the Worker path.
//
// in:  boot { wasm (bytes) | module, package, mhz }   midi { bytes, frame?, src? }   panic { bytes }   drop { frame }
//      key { id, down }   enc { id, clicks }   pot { value }   lcd { on }   capture { on, id }   dispose
// out: ready { timedOut }   error { reason, message }   lcd { lcd|null, leds }   status { rtf, starved, late, dropped }
//      cap { id, L, R, frame, last? } — copies of the output from context frame `frame`, contiguous
//      within a batch; `last` answers capture off (flushes what is left, possibly empty)

const FM1_RATE = 44100
const CAP_FRAMES = 4096   // capture batch, a multiple of the 128-frame quantum
const now = globalThis.performance?.now ? () => performance.now() : () => Date.now()

function jitImports(exports, stats) {
  let next
  return {
    fm1_jit_compile(ptr, len, hRead, hWrite, hOp) {
      const start = now()
      try {
        const x = exports()
        const bytes = new Uint8Array(x.memory.buffer, ptr, len).slice()
        const table = x.__indirect_function_table
        const env = { memory: x.memory, h_read: table.get(hRead), h_write: table.get(hWrite), h_op: table.get(hOp) }
        const run = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env }).exports.run
        if (next === undefined || next >= table.length) { next = table.length; table.grow(256) }
        const slot = next++
        table.set(slot, run)
        stats.regions++
        stats.bytes += len
        return slot
      } catch (e) {
        stats.failed++
        stats.error = String(e)
        return 0
      } finally {
        const elapsed = now() - start
        stats.compileMs += elapsed
        stats.compileMaxMs = Math.max(stats.compileMaxMs, elapsed)
      }
    },
  }
}

function createEventQueue(limit = 4096, notes = null) {
  const items = []
  return {
    push(ev) {
      if (items.length >= limit) return false
      let i = items.length
      while (i > 0 && items[i - 1].frame > ev.frame) i--
      items.splice(i, 0, ev)
      return true
    },
    takeUpTo(frame) {
      let n = 0
      while (n < items.length && items[n].frame <= frame) n++
      const out = []
      for (const e of items.splice(0, n)) {
        const bytes = notes && e.src ? notes.filter(e.bytes, e.src) : e.bytes
        if (bytes) out.push(bytes)
      }
      return out
    },
    dropFrom(frame) {
      for (let i = items.length - 1; i >= 0 && items[i].frame >= frame; i--) if (!isNoteOff(items[i].bytes)) items.splice(i, 1)
    },
    clear() { items.length = 0 },
    get size() { return items.length },
  }
}

const isNoteOff = (b) => b.length === 3 && ((b[0] & 0xF0) === 0x80 || ((b[0] & 0xF0) === 0x90 && b[2] === 0))

function createNoteCounts() {
  const holders = new Map()
  return {
    filter(bytes, src) {
      const kind = bytes[0] & 0xF0
      if (bytes.length !== 3 || (kind !== 0x80 && kind !== 0x90)) return bytes
      const key = (bytes[0] & 15) * 128 + (bytes[1] & 127)
      let set = holders.get(key)
      if (kind === 0x90 && bytes[2] > 0) {
        if (!set) holders.set(key, set = new Set())
        set.add(src)
        return bytes
      }
      set?.delete(src)
      if (set && !set.size) holders.delete(key)
      return set?.size ? null : bytes
    },
    reset() { holders.clear() },
  }
}

function createKeyHold(minFrames = 4410) {
  const downAt = new Map()
  const releases = new Map()
  return {
    down(id, frame) { releases.delete(id); downAt.set(id, frame) },
    up(id, frame) {
      const at = Math.max(frame, (downAt.get(id) ?? frame) + minFrames)
      downAt.delete(id)
      releases.set(id, at)
      return at
    },
    due(frame) {
      const ids = []
      for (const [id, at] of releases) if (at <= frame) { ids.push(id); releases.delete(id) }
      return ids
    },
  }
}

function createResampler(inRate, outRate) {
  const step = inRate / outRate
  let t = 0
  let prevL = 0, prevR = 0
  return {
    need(nOut) {
      if (nOut <= 0) return 0
      let p = t
      for (let k = 1; k < nOut; k++) p += step
      return Math.max(0, Math.floor(p) + 2)
    },
    process(inL, inR, outL, outR) {
      const m = inL.length
      let o = 0
      while (o < outL.length) {
        const i = Math.floor(t)
        if (i + 1 > m - 1) break
        const f = t - i
        const l0 = i < 0 ? prevL : inL[i], r0 = i < 0 ? prevR : inR[i]
        outL[o] = l0 + (inL[i + 1] - l0) * f
        outR[o] = r0 + (inR[i + 1] - r0) * f
        o++
        t += step
      }
      if (m > 0) { prevL = inL[m - 1]; prevR = inR[m - 1]; t -= m }
      return o
    },
  }
}

function createBootWatch({ timeoutMs = 8000, settleMs = 100 } = {}) {
  let audioAt = -1, rev = null
  return function step({ have = 0, lcdRev, ms = 0 }) {
    if (audioAt < 0 && have > 0) { audioAt = ms; rev = lcdRev }
    else if (audioAt >= 0 && lcdRev !== rev) {
      rev = lcdRev
      if (ms - audioAt >= settleMs) return 'up'
    }
    return ms >= timeoutMs ? 'timeout' : null
  }
}

// compiled once per worklet scope, shared by every FM-1 node on the context
let modulePromise = null

class Fm1Processor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.x = null
    this.done = false
    this.notes = createNoteCounts()
    this.queue = createEventQueue(4096, this.notes)
    this.keys = createKeyHold()
    this.rs = createResampler(FM1_RATE, sampleRate)
    this.emu = 0                     // emulator frames rendered
    this.late = 0
    this.dropped = 0
    this.lcdOn = false
    this.lcdForce = false
    this.lcdRev = -1
    this.sinceLcd = 0
    this.sinceStatus = 0
    this.busy = 0
    this.rendered = 0
    this.short = 0
    this.cap = null                  // { id, L, R, fill, frame } while capturing
    this.port.onmessage = (e) => this.onMessage(e.data)
    // a compiled Module does not cross into a worklet scope everywhere (Chrome: messageerror);
    // the session then falls back to the Worker path
    this.port.onmessageerror = () => this.port.postMessage({ type: 'error', reason: 'wasm-failed', message: 'message could not be read' })
  }

  async boot(m) {
    let x
    try {
      const module = m.module || await (modulePromise ||= WebAssembly.compile(m.wasm).catch((e) => { modulePromise = null; throw e }))
      const stats = { regions: 0, failed: 0, bytes: 0, compileMs: 0, compileMaxMs: 0, error: '' }
      x = (await WebAssembly.instantiate(module, { env: jitImports(() => x, stats) })).exports
    } catch (err) { return this.port.postMessage({ type: 'error', reason: 'wasm-failed', message: String(err) }) }
    if (this.done) return
    x.fm1_jit(1, 16)
    x.fm1_flash_part?.(0)
    x.fm1_ahead(1024)
    const p = x.fm1_alloc(m.package.byteLength)
    new Uint8Array(x.memory.buffer, p, m.package.byteLength).set(new Uint8Array(m.package))
    if (x.fm1_boot_fwsc(p, m.package.byteLength, 0, 0, m.mhz) !== 0) {
      return this.port.postMessage({ type: 'error', reason: 'boot-failed', message: 'not an FM-1 update package' })
    }
    this.mhz = m.mhz
    this.playing = false
    this.booting = true
    this.bootWatch = createBootWatch()
    this.x = x
  }

  onMessage(m) {
    if (m.type === 'boot') { this.boot(m); return }
    if (m.type === 'dispose') { this.done = true; this.x = null; this.queue.clear(); return }
    if (m.type === 'lcd') { this.lcdOn = !!m.on; this.lcdForce = this.lcdOn; return }
    if (m.type === 'capture') {
      const had = !!this.cap
      if (had) this.flushCap(!m.on)
      this.cap = m.on ? { id: m.id, L: new Float32Array(CAP_FRAMES), R: new Float32Array(CAP_FRAMES), fill: 0, frame: 0 } : null
      if (!m.on && !had) this.port.postMessage({ type: 'cap', id: m.id, L: new Float32Array(0), R: new Float32Array(0), frame: currentFrame, last: true })
      return
    }
    const x = this.x
    if (!x) return
    if (m.type === 'midi') {
      let frame = m.frame
      if (frame === undefined || frame < currentFrame) { if (frame !== undefined) this.late++; frame = currentFrame }
      if (!this.queue.push({ frame, bytes: m.bytes, src: m.src })) this.dropped++
    } else if (m.type === 'panic') { this.queue.clear(); this.notes.reset(); this.queue.push({ frame: currentFrame, bytes: m.bytes }) }
    else if (m.type === 'drop') this.queue.dropFrom(Math.max(m.frame ?? currentFrame, currentFrame))
    else if (m.type === 'key') {
      if (m.down) { this.keys.down(m.id, this.emu); x.fm1_key(m.id, 1) } else this.keys.up(m.id, this.emu)
    } else if (m.type === 'enc') x.fm1_enc(m.id, m.clicks | 0)
    else if (m.type === 'pot') x.fm1_pot(Math.max(0, Math.min(1023, Math.round(m.value))))
  }

  flushCap(last) {
    const c = this.cap
    if (!c.fill && !last) return
    const full = c.fill === CAP_FRAMES
    const L = full ? c.L : c.L.slice(0, c.fill), R = full ? c.R : c.R.slice(0, c.fill)
    this.port.postMessage({ type: 'cap', id: c.id, L, R, frame: c.frame, ...(last ? { last: true } : {}) }, [L.buffer, R.buffer])
    if (full) { c.L = new Float32Array(CAP_FRAMES); c.R = new Float32Array(CAP_FRAMES) }
    c.fill = 0
  }

  capture(l, r) {
    const c = this.cap
    if (c.fill && c.frame + c.fill !== currentFrame) this.flushCap(false)   // a gap: new batch
    if (!c.fill) c.frame = currentFrame
    c.L.set(l, c.fill)
    c.R.set(r, c.fill)
    c.fill += l.length
    if (c.fill + l.length > CAP_FRAMES) this.flushCap(false)
  }

  process(_inputs, outputs) {
    if (this.done) return false
    const x = this.x
    if (!x) return true
    const out = outputs[0]
    const n = out[0].length
    for (const bytes of this.queue.takeUpTo(currentFrame)) for (const b of bytes) x.fm1_midi(b)
    for (const id of this.keys.due(this.emu)) x.fm1_key(id, 0)
    const need = Math.min(1024, this.rs.need(n))
    // playing: up to 1.5x real time to catch up; boot: this quantum's real-time share only
    const budget = this.playing ? this.mhz * 1e6 * 1.5 * need / FM1_RATE : this.mhz * 1e6 * n / sampleRate
    const t0 = now()
    let have
    try {
      have = x.fm1_render(need, budget)
    } catch (err) {
      this.x = null
      this.port.postMessage({ type: 'error', reason: 'halted', message: `render: ${err}` })
      return true
    }
    const took = now() - t0
    if (have > 0 && !this.playing) this.playing = true
    if (this.playing) { this.busy += took; this.rendered += need; if (have < need) this.short++ }
    this.emu += need
    const buf = x.memory.buffer
    const l = new Float32Array(buf, x.fm1_out_l(), need), r = new Float32Array(buf, x.fm1_out_r(), need)
    const outR = out[1] || new Float32Array(n)
    this.rs.process(l, r, out[0], outR)
    if (this.cap) this.capture(out[0], outR)
    if (this.booting) {
      const up = this.bootWatch({ have, lcdRev: x.fm1_lcd_revision(), ms: x.fm1_ms?.() ?? 0 })
      if (up) { this.booting = false; this.port.postMessage({ type: 'ready', timedOut: up === 'timeout' }) }
    }

    this.sinceLcd += n
    this.sinceStatus += n
    if (this.lcdOn && this.sinceLcd >= sampleRate / 30) {
      this.sinceLcd = 0
      const rev = x.fm1_lcd_revision()
      const lcd = this.lcdForce || rev !== this.lcdRev ? new Uint16Array(buf, x.fm1_lcd(), 240 * 240).slice() : null
      this.lcdRev = rev
      this.lcdForce = false
      const leds = new Float32Array(buf, x.fm1_leds(), 41).slice()
      this.port.postMessage({ type: 'lcd', lcd, leds }, lcd ? [lcd.buffer, leds.buffer] : [leds.buffer])
    }
    if (this.sinceStatus >= sampleRate / 2) {
      this.sinceStatus = 0
      if (x.fm1_halted()) {
        this.x = null
        this.port.postMessage({ type: 'error', reason: 'halted', message: 'the firmware halted' })
        return true
      }
      const rtf = this.rendered && this.busy > 0 ? (this.rendered / FM1_RATE) / (this.busy / 1000) : null
      this.busy = 0
      this.rendered = 0
      this.port.postMessage({ type: 'status', rtf, starved: x.fm1_starved?.() ?? this.short, short: this.short,
        late: this.late, dropped: this.dropped })
    }
    return true
  }
}

registerProcessor('fm1', Fm1Processor)
