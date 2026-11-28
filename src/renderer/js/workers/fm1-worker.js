// FM-1 Path A host: the emulator in a module Worker, for contexts without an AudioWorklet (the
// LAN http route). It renders 128-frame chunks at 44.1 kHz to stay `lead` frames ahead of what
// the main thread reports it has played, resamples them to the context rate (one continuous
// resampler) and posts blocks of `blockFrames` output frames (transferred L/R Float32Arrays +
// start frame in output frames, contiguous from 0) for the session to schedule frame-exactly.
//
// Frames on the wire (consumed, midi) are output frames at `sampleRate`; the worker maps them to
// emulator frames: output frame 0 is the emulator frame at which `ready` was posted.
//
// in:  boot { module, package, mhz, leadFrames, sampleRate, blockFrames, sectors? }   consumed { frame }
//      midi { bytes, frame?, src? }   panic { bytes }   drop { frame? }   key { id, down }   enc { id, clicks }
//      pot { value }   lcd { on }   snapshot { request, since }
// out: ready { timedOut, flashRevision }   error { reason, message }   block { l, r, frame }
//      lcd { lcd|null, leds }   status { rtf, starved, late, dropped, flashRevision }
//      snapshot { request, revision, changed, sectors } | { request, reason: 'busy-timeout' }
//
// boot sectors = saved flash in the fm1_flash_restore format, restored before the first render.
// A snapshot is answered once the flash is quiet (createFlashGate) with every sector that differs
// from the booted package image, packed the same way (transferred); changed=false while the
// revision is still `since` (the session's last saved revision).
import { bootEmulator, bootToReady, createRunner } from '../fm1/emulator.js'
import { FM1_RATE, createBlockWriter, createFlashGate } from '../fm1/host-core.js'
import { packRestore } from '../fm1/flash-asset.js'

const now = () => performance.now()
const post = (m, t) => self.postMessage(m, t || [])
let run = null, x = null, lead = 0, stopped = false, writer = null, outRate = FM1_RATE, startEmu = 0
let base = { frame: 0, wall: 0 }, lcdOn = false, lcdForce = false, lcdAt = 0, statusAt = 0, gate = null

const toEmu = (outFrame) => startEmu + Math.round(outFrame * FM1_RATE / outRate)

async function boot(m) {
  try {
    ({ x } = await bootEmulator({ module: m.module, pkg: m.package, mhz: m.mhz, sectors: m.sectors }))
  } catch (err) { return post({ type: 'error', reason: err.reason || 'wasm-failed', message: err.message }) }
  run = createRunner(x, { mhz: m.mhz })
  lead = m.leadFrames ?? Math.round(0.1 * FM1_RATE)
  outRate = m.sampleRate || FM1_RATE
  writer = createBlockWriter(FM1_RATE, outRate, m.blockFrames || 1024)
  let state
  try { state = bootToReady(run, x) } catch (err) { return post({ type: 'error', reason: 'halted', message: String(err) }) }
  if (state === 'halted') return post({ type: 'error', reason: 'halted', message: 'the firmware halted while booting' })
  startEmu = run.frame
  base = { frame: run.frame, wall: now() }
  gate = createFlashGate({ revision: run.flashRevision() })
  post({ type: 'ready', timedOut: state === 'timeout', flashRevision: gate.revision })
  pump()
}

function pump() {
  if (stopped || !run) return
  const t = now()
  const target = base.frame + (t - base.wall) * FM1_RATE / 1000 + lead
  try {
    while (run.frame < target && now() - t < 40) {
      const { l, r } = run.render()
      for (const b of writer.push(l, r)) post({ type: 'block', l: b.l, r: b.r, frame: b.frame }, [b.l.buffer, b.r.buffer])
    }
  } catch (err) { stopped = true; return post({ type: 'error', reason: 'halted', message: String(err) }) }
  gate.observe(run.flashRevision(), t)
  for (const a of gate.take(run.flashBusy(), t)) answerSnapshot(a)
  if (lcdOn && t - lcdAt >= 33) {
    lcdAt = t
    const { lcd, leds } = run.screen(lcdForce)
    lcdForce = false
    post({ type: 'lcd', lcd, leds }, lcd ? [lcd.buffer, leds.buffer] : [leds.buffer])
  }
  if (t - statusAt >= 500) {
    statusAt = t
    const s = run.stats()
    if (s.halted) { stopped = true; return post({ type: 'error', reason: 'halted', message: 'the firmware halted' }) }
    post({ type: 'status', ...s, flashRevision: gate.revision })
  }
  setTimeout(pump, 1)
}

function answerSnapshot({ request, since, ok }) {
  if (!ok) return post({ type: 'snapshot', request, reason: 'busy-timeout' })
  const revision = gate.revision
  const sectors = packRestore(run.changedSectors())
  post({ type: 'snapshot', request, revision, changed: revision !== since, sectors }, [sectors.buffer])
}

self.onmessage = (e) => {
  const m = e.data
  if (m.type === 'boot') { boot(m); return }
  if (!run) return
  if (m.type === 'consumed') base = { frame: toEmu(m.frame), wall: now() }
  else if (m.type === 'midi') run.midi(m.bytes, m.frame === undefined ? undefined : toEmu(m.frame), m.src)
  else if (m.type === 'panic') run.panic(m.bytes)
  else if (m.type === 'drop') run.drop(m.frame === undefined ? undefined : toEmu(m.frame))
  else if (m.type === 'key') run.key(m.id, m.down)
  else if (m.type === 'enc') run.enc(m.id, m.clicks)
  else if (m.type === 'pot') run.pot(m.value)
  else if (m.type === 'lcd') { lcdOn = !!m.on; lcdForce = lcdOn }
  else if (m.type === 'snapshot') gate.request({ request: m.request, since: m.since }, now())
}
