// Main-thread side of one FM-1 device. Two hosts behind one interface:
//  - 'worklet' (Path B, secure contexts): an AudioWorkletNode running the emulator in the audio
//    thread; timed events carry a context frame.
//  - 'worker' (Path A, everywhere else): a module Worker posts 128-frame blocks which are queued
//    back to back as AudioBufferSourceNodes; timed events carry an emulator frame mapped from
//    AudioContext time through the anchor of the block schedule.
// Note and panel methods never throw; before ready they are dropped (no replay on ready).
import { framesAt, noteOnBytes, noteOffBytes, allNotesOffBytes, rgb565ToRgba, FM1_RATE } from './host-core.js'

const START_PAD = 0.02           // first block (and after an underrun) starts this far ahead
const REPORT_MS = 20             // how often the Worker hears how far playback has got

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
  const sources = new Set()
  const lcdCbs = new Set(), statusCbs = new Set()
  const rgba = new Uint8ClampedArray(240 * 240 * 4)
  let leds = new Float32Array(41)
  const gain = ctx.createGain()
  gain.connect(output)

  let resolveReady, rejectReady
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej })
  ready.catch(() => {})

  const leadSec = () => (path === 'worklet' ? 0.02 : leadMs / 1000 + 0.03)
  const status = () => ({ state, reason, path, ...counters, leadMs: Math.round(leadSec() * 1000) })
  const emit = () => { const s = status(); for (const cb of statusCbs) cb(s) }
  const post = (m, t) => { try { port?.postMessage(m, t) } catch {} }

  function teardownHost() {
    worker?.terminate()
    if (node) { post({ type: 'dispose' }); node.disconnect() }
    worker = node = port = null
    for (const src of sources) { try { src.stop() } catch {} src.disconnect() }
    sources.clear()
    anchor = null
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

  function onBlock({ l, r, frame }) {
    const t = ctx.currentTime
    let at = anchor ? anchor.time + (frame - anchor.frame) / FM1_RATE : -1
    if (at < t) {
      if (anchor) counters.underruns++
      anchor = { time: t + START_PAD, frame }
      at = anchor.time
    }
    const buf = ctx.createBuffer(2, l.length, FM1_RATE)
    buf.getChannelData(0).set(l)
    buf.getChannelData(1).set(r)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(gain)
    src.onended = () => { sources.delete(src); src.disconnect() }
    src.start(at)
    sources.add(src)
    const ms = now()
    if (ms - lastReport >= REPORT_MS) {
      lastReport = ms
      post({ type: 'consumed', frame: framesAt(t, anchor) })
    }
  }

  function onMessage(m) {
    if (state === 'disposed' || state === 'failed') return
    if (m.type === 'block') onBlock(m)
    else if (m.type === 'ready') {
      state = 'ready'
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

  async function startWorker() {
    let module
    try { module = await getModule() } catch { return fail('wasm-failed') }
    if (state !== 'booting') return
    worker = createWorker()
    port = worker
    worker.onmessage = (e) => onMessage(e.data)
    worker.onerror = () => fail('wasm-failed')
    const copy = pkg.slice(0)
    post({ type: 'boot', module, package: copy, mhz: descriptor.mhz, leadFrames: Math.round(leadMs / 1000 * FM1_RATE) }, [copy])
    if (lcdOn) post({ type: 'lcd', on: true })
  }

  async function startWorklet() {
    let wasm = null, module = null
    try {
      await loadWorklet()
      if (getWasmBytes) wasm = await getWasmBytes()
      else module = await getModule()
    } catch { return fail('wasm-failed') }
    if (state !== 'booting') return
    node = createWorkletNode(ctx)
    node.connect(gain)
    port = node.port
    port.onmessage = (e) => onMessage(e.data)
    const copy = pkg.slice(0)
    post({ type: 'boot', wasm, module, package: copy, mhz: descriptor.mhz }, [copy])
    if (lcdOn) post({ type: 'lcd', on: true })
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
      else if (anchor) frame = framesAt(time, anchor)
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
      send(noteOnBytes(ch(), pitch, vel), time)
    },
    noteOff(pitch, time) {
      if (state !== 'ready') return
      held.delete(pitch)
      send(noteOffBytes(ch(), pitch), time)
    },
    sendMidi(bytes, time) { send(bytes.slice(), time) },
    // all notes off on every channel plus offs for held notes; queued events are dropped
    panic() {
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
