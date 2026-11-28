// Main-thread side of one FM-1 device. Two hosts behind one interface:
//  - 'worklet' (Path B, secure contexts): an AudioWorkletNode running the emulator in the audio
//    thread; timed events carry a context frame.
//  - 'worker' (Path A, everywhere else): a module Worker resamples to the context rate and posts
//    BLOCK_FRAMES blocks, each started as an AudioBufferSourceNode at an exact context frame
//    (anchor frame + block frame, so no drift); timed events carry an output frame mapped from
//    AudioContext time through the same anchor.
// Note and panel methods never throw; before ready they are dropped (no replay on ready).
import { framesAt, noteOnBytes, noteOffBytes, allNotesOffBytes, rgb565ToRgba, FM1_RATE, createNoteCounts, createTake } from './host-core.js'

const START_PAD = 0.02           // first block (and after an underrun) starts this far ahead
const REPORT_MS = 20             // how often the Worker hears how far playback has got
const CAP_FLUSH_MS = 1000        // finish() stops waiting for the worklet's last capture batch
export const BLOCK_FRAMES = 1024 // Worker path block, in output (context-rate) frames

export function createFm1Session({
  ctx, key, descriptor, output, getModule, getWasmBytes, readFirmware,
  useWorklet = false, loadWorklet, createWorker, createWorkletNode, leadMs = 80,
  now = () => performance.now(),
}) {
  let path = useWorklet ? 'worklet' : 'worker'
  let state = 'booting', reason
  let port = null, worker = null, node = null, pkg = null
  let anchor = null, lastReport = -Infinity, lcdOn = false
  const counters = { rtf: null, underruns: 0, late: 0, starved: 0, dropped: 0 }
  const held = new Set()
  const counts = createNoteCounts()  // live + timeline on one device: offs only when the last holder lets go
  let capture = null, capSeq = 0     // { id, take, done?() }
  const sources = new Set()
  const lcdCbs = new Set(), statusCbs = new Set()
  const rgba = new Uint8ClampedArray(240 * 240 * 4)
  let leds = new Float32Array(41)
  const gain = ctx.createGain()
  gain.connect(output)

  let resolveReady, rejectReady
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej })
  ready.catch(() => {})

  // Worker path: the Worker renders leadMs plus one block ahead (a partly filled block is
  // already rendered but not yet posted), and events need 30 ms of slack on top of that.
  const horizonSec = () => leadMs / 1000 + BLOCK_FRAMES / ctx.sampleRate
  const leadSec = () => (path === 'worklet' ? 0.02 : horizonSec() + 0.03)
  let bootTimeout = false
  const status = () => ({ state, reason, path, ...counters, bootTimeout, leadMs: Math.round(leadSec() * 1000) })
  const emit = () => { const s = status(); for (const cb of statusCbs) cb(s) }
  const post = (m, t) => { try { port?.postMessage(m, t) } catch {} }

  function teardownHost() {
    worker?.terminate()
    if (node) { post({ type: 'dispose' }); node.disconnect() }
    worker = node = port = null
    for (const src of sources) { try { src.stop() } catch {} src.disconnect() }
    sources.clear()
    anchor = null
    capture?.done?.()
  }

  function fail(why) {
    if (state === 'disposed' || state === 'failed') return
    if (path === 'worklet' && state === 'booting' && why === 'wasm-failed') {
      teardownHost()
      path = 'worker'
      startWorker()
      return
    }
    teardownHost()
    state = 'failed'
    reason = why
    pkg = null
    rejectReady(new Error(why))
    emit()
  }

  // Blocks are output frames at ctx.sampleRate; each starts at an integer context frame.
  function onBlock({ l, r, frame }) {
    const t = ctx.currentTime, rate = ctx.sampleRate
    let at = anchor ? (anchor.ctxFrame + frame - anchor.frame) / rate : -1
    if (at < t) {
      if (anchor) counters.underruns++
      const ctxFrame = Math.ceil((t + START_PAD) * rate - 1e-6)
      anchor = { ctxFrame, time: ctxFrame / rate, frame }
      at = anchor.time
    }
    const buf = ctx.createBuffer(2, l.length, rate)
    buf.getChannelData(0).set(l)
    buf.getChannelData(1).set(r)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(gain)
    src.onended = () => { sources.delete(src); src.disconnect() }
    src.start(at)
    src.fm1At = at
    sources.add(src)
    capture?.take.add(l, r, at)  // placed by audible time, so an underrun gap is in the take too
    const ms = now()
    if (ms - lastReport >= REPORT_MS) {
      lastReport = ms
      post({ type: 'consumed', frame: framesAt(t, anchor, rate) })
    }
  }

  function onMessage(m) {
    if (state === 'disposed' || state === 'failed') return
    if (m.type === 'block') onBlock(m)
    else if (m.type === 'cap') {
      // worklet path: a context frame is its audible time
      if (capture && m.id === capture.id) {
        capture.take.add(m.L, m.R, m.frame / ctx.sampleRate)
        if (m.last) capture.done?.()
      }
    } else if (m.type === 'ready') {
      state = 'ready'
      bootTimeout = !!m.timedOut
      pkg = null
      resolveReady()
      emit()
    } else if (m.type === 'error') fail(m.reason || 'boot-failed')
    else if (m.type === 'status') {
      counters.rtf = m.rtf ?? counters.rtf
      counters.starved = m.starved ?? counters.starved
      counters.late = m.late ?? counters.late
      counters.dropped = m.dropped ?? counters.dropped
      emit()
    } else if (m.type === 'lcd') {
      if (m.lcd) rgb565ToRgba(m.lcd, rgba)
      leds = m.leds
      for (const cb of lcdCbs) cb(rgba, leds)
    }
  }

  // Both starters catch everything (fetch, compile, constructing the host, connecting, posting):
  // they run un-awaited, so a throw must become a failure or `ready` would never settle.
  async function startWorker() {
    try {
      const module = await getModule()
      if (state !== 'booting') return
      worker = createWorker()
      port = worker
      worker.onmessage = (e) => onMessage(e.data)
      worker.onerror = () => fail('wasm-failed')
      const copy = pkg.slice(0)
      port.postMessage({ type: 'boot', module, package: copy, mhz: descriptor.mhz, sampleRate: ctx.sampleRate,
        blockFrames: BLOCK_FRAMES, leadFrames: Math.round(horizonSec() * FM1_RATE) }, [copy])
      if (lcdOn) port.postMessage({ type: 'lcd', on: true })
    } catch { fail('wasm-failed') }
  }

  async function startWorklet() {
    try {
      let wasm = null, module = null
      await loadWorklet()
      if (getWasmBytes) wasm = await getWasmBytes()
      else module = await getModule()
      if (state !== 'booting') return
      node = createWorkletNode(ctx)
      node.connect(gain)
      port = node.port
      port.onmessage = (e) => onMessage(e.data)
      const copy = pkg.slice(0)
      port.postMessage({ type: 'boot', wasm, module, package: copy, mhz: descriptor.mhz }, [copy])
      if (lcdOn) port.postMessage({ type: 'lcd', on: true })
      if (capture) port.postMessage({ type: 'capture', on: true, id: capture.id })
    } catch { fail('wasm-failed') }
  }

  ;(async () => {
    try { pkg = await readFirmware(descriptor.firmwareHash) } catch { pkg = null }
    if (state !== 'booting') return
    if (!pkg) return fail('missing-firmware')
    if (path === 'worklet') startWorklet()
    else startWorker()
  })()

  const ch = () => descriptor.deviceChannel & 15
  function send(bytes, time) {
    if (state !== 'ready') return
    let frame
    if (time != null && Number.isFinite(time)) {
      if (path === 'worklet') frame = Math.round(time * ctx.sampleRate)
      else if (anchor) frame = framesAt(time, anchor, ctx.sampleRate)
    }
    post({ type: 'midi', bytes, frame })
  }

  return {
    key,
    descriptor,
    get path() { return path },
    get output() { return output },
    get leadSec() { return leadSec() },
    ready,
    status,
    noteOn(pitch, vel, time) {
      if (state !== 'ready') return
      held.add(pitch)
      counts.on(ch(), pitch)
      send(noteOnBytes(ch(), pitch, vel), time)
    },
    noteOff(pitch, time) {
      if (state !== 'ready') return
      if (!counts.off(ch(), pitch)) return
      held.delete(pitch)
      send(noteOffBytes(ch(), pitch), time)
    },
    sendMidi(bytes, time) { send(bytes.slice(), time) },
    // all notes off on every channel plus offs for held notes; queued events are dropped
    panic() {
      counts.reset()
      if (state !== 'ready') { held.clear(); return }
      const bytes = allNotesOffBytes()
      for (const p of held) bytes.push(...noteOffBytes(ch(), p))
      held.clear()
      post({ type: 'panic', bytes })
    },
    key(id, down) { if (state === 'ready') post({ type: 'key', id, down: !!down }) },
    enc(id, clicks) { if (state === 'ready') post({ type: 'enc', id, clicks }) },
    pot(value) { if (state === 'ready') post({ type: 'pot', value }) },
    // cb(rgba, leds): rgba is one reused buffer, draw it before returning
    onLcd(cb) {
      lcdCbs.add(cb)
      if (!lcdOn) { lcdOn = true; post({ type: 'lcd', on: true }) }
      return () => {
        lcdCbs.delete(cb)
        if (!lcdCbs.size && lcdOn) { lcdOn = false; post({ type: 'lcd', on: false }) }
      }
    },
    // Records this device's output from audible time startTime on, at ctx.sampleRate, before the
    // session gain (so pre-fader). Path A takes the blocks as they are scheduled; Path B streams
    // batches from the worklet. One capture at a time.
    startCapture({ startTime, maxSeconds = 600 }) {
      if (capture) throw new Error('fm1: a capture is already running')
      const rate = ctx.sampleRate
      const cap = { id: ++capSeq, take: createTake({ rate, startTime, maxFrames: Math.round(maxSeconds * rate) }) }
      capture = cap
      if (node) post({ type: 'capture', on: true, id: cap.id })
      // Worker blocks arrive ahead of time: those already scheduled may reach past startTime
      // (a recording usually starts in the same tick as play(), S a little in the future)
      for (const src of sources) cap.take.add(src.buffer.getChannelData(0), src.buffer.getChannelData(1), src.fm1At)
      const end = () => { if (capture === cap) capture = null }
      return {
        peak: () => cap.take.peak,
        frames: () => cap.take.frames(),
        full: () => cap.take.full,
        // Worker blocks arrive ~leadSec ahead of audible time, so once currentTime passes the
        // end nothing is outstanding; the worklet is asked to flush its last batch.
        async finish(endTime) {
          if (capture === cap && node) {
            await new Promise((res) => {
              const t = setTimeout(res, CAP_FLUSH_MS)
              cap.done = () => { clearTimeout(t); res() }
              post({ type: 'capture', on: false, id: cap.id })
            })
          }
          end()
          return cap.take.finish(endTime)
        },
        cancel() {
          if (capture === cap && node) post({ type: 'capture', on: false, id: cap.id })
          end()
        },
      }
    },
    onStatus(cb) { statusCbs.add(cb); return () => statusCbs.delete(cb) },
    connect(out) {
      gain.disconnect()
      gain.connect(out)
      output = out
    },
    dispose() {
      if (state === 'disposed') return
      const wasFailed = state === 'failed'
      teardownHost()
      gain.disconnect()
      state = 'disposed'
      pkg = null
      held.clear()
      if (!wasFailed) rejectReady(new Error('disposed'))
      emit()
      lcdCbs.clear()
      statusCbs.clear()
    },
  }
}
