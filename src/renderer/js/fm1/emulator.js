// One FM-1 machine around the raw wasm exports: boot from a .fwsc package, then render 128-frame
// chunks with timed MIDI and panel input applied at chunk boundaries. Used by the Path A Worker
// (workers/fm1-worker.js) and by the node integration test; the AudioWorklet carries its own copy
// of this logic (public/worklets/fm1-worklet.js).
import { jitImports, newJitStats } from './jit.js'
import { createEventQueue, createKeyHold, FM1_RATE } from './host-core.js'

export const CHUNK = 128
const LCD_PIXELS = 240 * 240
const now = globalThis.performance?.now ? () => performance.now() : () => Date.now()

const fail = (reason, message) => Object.assign(new Error(message || reason), { reason })

// -> exports of a booted machine. Throws an Error with .reason 'wasm-failed' | 'boot-failed'.
export async function bootEmulator({ module, pkg, mhz, jit = true }) {
  const stats = newJitStats()
  let x
  try {
    const env = jit ? jitImports(() => x, stats) : { fm1_jit_compile: () => 0 }
    x = (await WebAssembly.instantiate(module, { env })).exports
  } catch (err) { throw fail('wasm-failed', String(err)) }
  x.fm1_jit(jit ? 1 : 0, jit ? 16 : 0)
  x.fm1_flash_part?.(0)
  x.fm1_ahead(1024)
  const p = x.fm1_alloc(pkg.byteLength)
  new Uint8Array(x.memory.buffer, p, pkg.byteLength).set(new Uint8Array(pkg))
  if (x.fm1_boot_fwsc(p, pkg.byteLength, 0, 0, mhz) !== 0) throw fail('boot-failed', 'not an FM-1 update package')
  return { x, jitStats: stats }
}

// The render loop's state over booted exports. frame = start frame of the next chunk.
export function createRunner(x, { mhz, keyHoldFrames = 4410 } = {}) {
  const queue = createEventQueue()
  const keys = createKeyHold(keyHoldFrames)
  const bootBudget = mhz * 1e6 * 0.02
  const playBudget = mhz * 1e6 * 1.5 * CHUNK / FM1_RATE
  let frame = 0, playing = false, late = 0, dropped = 0, short = 0, busyMs = 0, rendered = 0
  let lcdRev = -1, views = null

  const midiNow = (bytes) => { for (const b of bytes) x.fm1_midi(b) }

  function readViews() {
    const buf = x.memory.buffer, lp = x.fm1_out_l(), rp = x.fm1_out_r()
    if (!views || views.l.buffer !== buf || views.l.byteOffset !== lp || views.r.byteOffset !== rp) {
      views = { l: new Float32Array(buf, lp, CHUNK), r: new Float32Array(buf, rp, CHUNK) }
    }
    return views
  }

  return {
    get frame() { return frame },
    get playing() { return playing },
    // Timed MIDI: applied at the first chunk whose start >= target; a past target applies at the
    // next chunk and counts as late. Returns false when the queue is full (event dropped).
    midi(bytes, target) {
      if (target === undefined || target < frame) { if (target !== undefined) late++; target = frame }
      if (!queue.push({ frame: target, bytes })) { dropped++; return false }
      return true
    },
    // Drop every queued event, then send these bytes at the next chunk.
    panic(bytes) { queue.clear(); queue.push({ frame, bytes }) },
    key(id, down) {
      if (down) { keys.down(id, frame); x.fm1_key(id, 1) } else keys.up(id, frame)
    },
    enc(id, clicks) { x.fm1_enc(id, clicks | 0) },
    pot(v) { x.fm1_pot(Math.max(0, Math.min(1023, Math.round(v)))) },
    // Render one chunk. Returns views onto wasm memory (copy before the next call) and `have`.
    render() {
      for (const bytes of queue.takeUpTo(frame)) midiNow(bytes)
      for (const id of keys.due(frame)) x.fm1_key(id, 0)
      const t = now()
      const have = x.fm1_render(CHUNK, playing ? playBudget : bootBudget)
      const d = now() - t
      if (have > 0 && !playing) playing = true
      if (playing) { busyMs += d; rendered += CHUNK; if (have < CHUNK) short++ }
      const start = frame
      frame += CHUNK
      const { l, r } = readViews()
      return { l, r, frame: start, have }
    },
    // LCD (Uint16Array copy, or null when unchanged unless force) and LEDs (41 floats).
    screen(force = false) {
      const rev = x.fm1_lcd_revision()
      const lcd = force || rev !== lcdRev ? new Uint16Array(x.memory.buffer, x.fm1_lcd(), LCD_PIXELS).slice() : null
      lcdRev = rev
      return { lcd, leds: new Float32Array(x.memory.buffer, x.fm1_leds(), 41).slice() }
    },
    // rtf over the frames rendered since the last call (null when none).
    stats() {
      const rtf = rendered && busyMs > 0 ? (rendered / FM1_RATE) / (busyMs / 1000) : null
      busyMs = 0; rendered = 0
      return { rtf, starved: x.fm1_starved?.() ?? short, short, late, dropped, halted: !!x.fm1_halted() }
    },
  }
}
