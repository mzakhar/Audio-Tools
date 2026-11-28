// Main-thread side of one FM-1 device. Two hosts behind one interface:
//  - 'worklet' (Path B, secure contexts): an AudioWorkletNode running the emulator in the audio
//    thread; timed events carry a context frame.
//  - 'worker' (Path A, everywhere else): a module Worker resamples to the context rate and posts
//    BLOCK_FRAMES blocks, each started as an AudioBufferSourceNode at an exact context frame
//    (anchor frame + block frame, so no drift); timed events carry an output frame mapped from
//    AudioContext time through the same anchor.
// Note and panel methods never throw; before ready they are dropped (no replay on ready).
//
// Flash: a descriptor with flashAssetId boots from readFlash(descriptor) (an asset file, see
// flash-asset.js); a missing / corrupt / other-firmware asset fails the session rather than
// booting clean. Only the Worker path keeps flash (snapshot / restore); the worklet does not.
import { framesAt, noteOnBytes, noteOffBytes, allNotesOffBytes, rgb565ToRgba, FM1_RATE, createTake } from './host-core.js'
import { decodeFlashAsset, packRestore, unpackRestore } from './flash-asset.js'

const START_PAD = 0.02           // first block (and after an underrun) starts this far ahead
const REPORT_MS = 20             // how often the Worker hears how far playback has got
const CAP_FLUSH_MS = 1000        // finish() stops waiting for the worklet's last capture batch
const SNAPSHOT_MS = 3000         // snapshotFlash gives up on a silent Worker (it answers by 1.5 s)
export const BLOCK_FRAMES = 1024 // Worker path block, in output (context-rate) frames

export function createFm1Session({
  ctx, key, descriptor, output, getModule, getWasmBytes, readFirmware, readFlash = async () => null,
  useWorklet = false, loadWorklet, createWorker, createWorkletNode, leadMs = 80,
  now = () => performance.now(),
}) {
  let path = useWorklet ? 'worklet' : 'worker'
  let state = 'booting', reason
  let port = null, worker = null, node = null, pkg = null
  let sectors = null                 // packed restore records for the next boot (Worker path)
  const flash = { revision: null, savedRevision: null }
  let importing = false              // the boot in progress restores imported records: dirty once ready
  const snaps = new Map()            // request id -> resolve
  let snapSeq = 0, bootGen = 0      // bootGen: a re-boot (importFlash) orphans an older boot still loading
  let trial = null                   // { worker, reject }: an import booting beside the running device
  let anchor = null, lastReport = -Infinity, lcdOn = false
  const counters = { rtf: null, underruns: 0, late: 0, starved: 0, dropped: 0 }
  const held = new Set()
  let capture = null, capSeq = 0     // { id, take, done?() }
  const sources = new Set()
  const lcdCbs = new Set(), statusCbs = new Set()
  const rgba = new Uint8ClampedArray(240 * 240 * 4)
  let leds = new Float32Array(41)
  const gain = ctx.createGain()
  gain.connect(output)

  let resolveReady, rejectReady, ready
  const newReady = () => {
    ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej })
    ready.catch(() => {})
  }
  newReady()

  // Worker path: the Worker renders leadMs plus one block ahead (a partly filled block is
  // already rendered but not yet posted), and events need 30 ms of slack on top of that.
  const horizonSec = () => leadMs / 1000 + BLOCK_FRAMES / ctx.sampleRate
  const leadSec = () => (path === 'worklet' ? 0.02 : horizonSec() + 0.03)
  let bootTimeout = false
  const flashStatus = () => ({ ...flash, dirty: flash.revision !== flash.savedRevision })
  const status = () => ({ state, reason, path, ...counters, bootTimeout, leadMs: Math.round(leadSec() * 1000), flash: flashStatus() })
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
    for (const res of snaps.values()) res({ ok: false, reason: 'not-ready' })
    snaps.clear()
  }

  function killTrial(why) {
    if (!trial) return
    const t = trial
    trial = null
    t.worker?.terminate()
    t.reject(new Error(why))
  }

  function fail(why) {
    if (state === 'disposed' || state === 'failed') return
    killTrial('not-ready')
    if (path === 'worklet' && state === 'booting' && why === 'wasm-failed') {
      teardownHost()
      path = 'worker'
      startWorker()
      return
    }
    teardownHost()
    state = 'failed'
    reason = why
    pkg = sectors = null
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
      pkg = sectors = null
      flash.revision = m.flashRevision ?? null
      // booted from the project's asset (or clean): nothing to save yet; imported records are
      // not in the project, so they are dirty until saved
      flash.savedRevision = importing ? null : flash.revision
      importing = false
      resolveReady()
      emit()
    } else if (m.type === 'error') fail(m.reason || 'boot-failed')
    else if (m.type === 'snapshot') {
      const res = snaps.get(m.request)
      snaps.delete(m.request)
      if (m.revision !== undefined) flash.revision = m.revision
      if (!res) return
      if (m.reason) res({ ok: false, reason: m.reason })
      else res({ ok: true, changed: !!m.changed, records: m.sectors ? unpackRestore(m.sectors) : [], revision: m.revision })
    } else if (m.type === 'status') {
      if (m.flashRevision !== undefined) flash.revision = m.flashRevision
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
  async function startWorker(gen = bootGen) {
    try {
      const module = await getModule()
      if (state !== 'booting' || gen !== bootGen) return
      worker = createWorker()
      port = worker
      worker.onmessage = (e) => onMessage(e.data)
      worker.onerror = () => fail('wasm-failed')
      const copy = pkg.slice(0)
      const restore = sectors?.length ? sectors.slice() : undefined
      port.postMessage({ type: 'boot', module, package: copy, mhz: descriptor.mhz, sampleRate: ctx.sampleRate,
        blockFrames: BLOCK_FRAMES, leadFrames: Math.round(horizonSec() * FM1_RATE), sectors: restore },
      restore ? [copy, restore.buffer] : [copy])
      if (lcdOn) port.postMessage({ type: 'lcd', on: true })
    } catch { fail('wasm-failed') }
  }

  async function startWorklet(gen = bootGen) {
    try {
      let wasm = null, module = null
      await loadWorklet()
      if (getWasmBytes) wasm = await getWasmBytes()
      else module = await getModule()
      if (state !== 'booting' || gen !== bootGen) return
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

  // -> packed restore records, or a failure reason. Never boots clean over a referenced asset.
  async function loadFlash() {
    const id = descriptor.flashAssetId
    if (id == null) return { sectors: null }
    // an id that cannot name a file is a damaged project, not "no saved state"
    if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return { reason: 'flash-corrupt' }
    // readFlash throws Error('flash-…') to name its reason (missing file, no project folder)
    let bytes = null
    try { bytes = await readFlash(descriptor) } catch (err) {
      return { reason: /^flash-[\w-]+$/.test(err?.message) ? err.message : 'flash-missing' }
    }
    if (!bytes) return { reason: 'flash-missing' }
    const got = decodeFlashAsset(bytes, { firmwareHash: descriptor.firmwareHash })
    if (!got.ok) return { reason: got.reason === 'wrong-firmware' ? 'flash-wrong-firmware' : 'flash-corrupt' }
    return { sectors: packRestore(got.records) }
  }

  // records: imported flash (importFlash) instead of the descriptor's asset
  async function boot(records) {
    const gen = ++bootGen
    let fw, restore
    try {
      ;[fw, restore] = await Promise.all([
        Promise.resolve().then(() => readFirmware(descriptor.firmwareHash)).catch(() => null),
        records ? { sectors: packRestore(records) } : loadFlash(),
      ])
    } catch { fw = null; restore = { reason: 'flash-corrupt' } }
    if (state !== 'booting' || gen !== bootGen) return
    if (!fw) return fail('missing-firmware')
    if (restore.reason) return fail(restore.reason)
    pkg = fw
    sectors = restore.sectors
    // the worklet keeps no flash: a device with saves always runs on the Worker
    if (path === 'worklet' && !sectors?.length) startWorklet()
    else { path = 'worker'; startWorker() }
  }
  boot()

  // Import over a running device: the imported state boots on a second Worker and is swapped in
  // only once it is ready, so a failed import leaves the running device (and `ready`) untouched.
  async function trialImport(restore) {
    if (trial) throw new Error('busy')
    const t = trial = { worker: null, reject: null }
    const settled = new Promise((res, rej) => { t.resolve = res; t.reject = rej })
    try {
      const [fw, module] = await Promise.all([Promise.resolve().then(() => readFirmware(descriptor.firmwareHash)), getModule()])
      if (trial !== t) return settled
      if (!fw) throw new Error('missing-firmware')
      const w = t.worker = createWorker()
      w.onerror = () => { if (trial === t) killTrial('wasm-failed') }
      w.onmessage = (e) => {
        const m = e.data
        if (trial !== t) return
        if (m.type === 'error') return killTrial(m.reason || 'boot-failed')
        if (m.type !== 'ready') return
        // swap, synchronously, so the new Worker's first block already lands on the session
        trial = null
        teardownHost()
        held.clear()
        path = 'worker'
        worker = port = w
        w.onmessage = (ev) => onMessage(ev.data)
        w.onerror = () => fail('wasm-failed')
        if (lcdOn) post({ type: 'lcd', on: true })
        importing = true
        onMessage(m)
        t.resolve(ready)
      }
      const copy = fw.slice(0)
      w.postMessage({ type: 'boot', module, package: copy, mhz: descriptor.mhz, sampleRate: ctx.sampleRate,
        blockFrames: BLOCK_FRAMES, leadFrames: Math.round(horizonSec() * FM1_RATE), sectors: restore },
      [copy, restore.buffer])
    } catch (err) {
      if (trial === t) killTrial(/^[\w-]+$/.test(err?.message) ? err.message : 'wasm-failed')
    }
    return settled
  }

  const ch = () => descriptor.deviceChannel & 15
  // src tags the sender ('live' | 'timeline'): the host drops a note-off only while the other
  // source still holds that note when the off is due (createNoteCounts).
  const frameOf = (time) => {
    if (time == null || !Number.isFinite(time)) return undefined
    if (path === 'worklet') return Math.round(time * ctx.sampleRate)
    return anchor ? framesAt(time, anchor, ctx.sampleRate) : undefined
  }
  function send(bytes, time, src) {
    if (state !== 'ready') return
    post({ type: 'midi', bytes, frame: frameOf(time), src })
  }

  return {
    key,
    descriptor,
    get path() { return path },
    get output() { return output },
    get leadSec() { return leadSec() },
    get ready() { return ready },
    status,
    // Every flash sector that differs from the booted package (always the full set, for Export),
    // once the device is quiet. changed is false while the revision has not moved since the last
    // markFlashSaved (or boot).
    // -> { ok:true, changed, records, revision } | { ok:false, reason:'busy-timeout'|'not-ready'|'unsupported' }
    snapshotFlash({ timeoutMs = SNAPSHOT_MS } = {}) {
      if (path === 'worklet') return Promise.resolve({ ok: false, reason: 'unsupported' })
      if (state !== 'ready') return Promise.resolve({ ok: false, reason: 'not-ready' })
      const request = ++snapSeq
      return new Promise((res) => {
        const t = setTimeout(() => { snaps.delete(request); res({ ok: false, reason: 'busy-timeout' }) }, timeoutMs)
        snaps.set(request, (r) => { clearTimeout(t); res(r) })
        post({ type: 'snapshot', request, since: flash.savedRevision })
      })
    },
    markFlashSaved(revision) {
      flash.savedRevision = revision
      emit()
    },
    // Re-boots this device from imported records (Import device state). Resolves when ready.
    // A running device keeps running until the imported state has booted (trialImport); a
    // failed or booting one is simply re-booted.
    importFlash(records) {
      if (state === 'disposed') return Promise.reject(new Error('disposed'))
      const restore = packRestore(records)   // throws on invalid records, before tearing anything down
      if (state === 'ready') return trialImport(restore)
      killTrial('re-booting')
      teardownHost()
      if (state !== 'failed') rejectReady(new Error('re-booting'))
      newReady()
      state = 'booting'
      reason = undefined
      bootTimeout = false
      importing = true
      flash.revision = flash.savedRevision = null
      emit()
      boot(records)
      return ready
    },
    noteOn(pitch, vel, time, src = 'live') {
      if (state !== 'ready') return
      held.add(pitch)
      send(noteOnBytes(ch(), pitch, vel), time, src)
    },
    noteOff(pitch, time, src = 'live') {
      if (state !== 'ready') return
      held.delete(pitch)
      send(noteOffBytes(ch(), pitch), time, src)
    },
    sendMidi(bytes, time, src = 'live') { send(bytes.slice(), time, src) },
    // all notes off on every channel plus offs for held notes; queued events are dropped and the
    // hosts forget who held what
    panic() {
      if (state !== 'ready') { held.clear(); return }
      const bytes = allNotesOffBytes()
      for (const p of held) bytes.push(...noteOffBytes(ch(), p))
      held.clear()
      post({ type: 'panic', bytes })
    },
    // Transport stop without panic: events queued for `time` on are dropped, except note-offs, so
    // what sounds rings out and nothing new starts.
    dropFrom(time) { if (state === 'ready') post({ type: 'drop', frame: frameOf(time) }) },
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
        peak: () => cap.take.takeRecentPeak(),   // since the previous call: a meter window
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
      killTrial('disposed')
      teardownHost()
      gain.disconnect()
      state = 'disposed'
      pkg = sectors = null
      held.clear()
      if (!wasFailed) rejectReady(new Error('disposed'))
      emit()
      lcdCbs.clear()
      statusCbs.clear()
    },
  }
}
