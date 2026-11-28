// FM-1 Path A host: the emulator in a module Worker, for contexts without an AudioWorklet (the
// LAN http route). It renders 128-frame chunks to stay `lead` frames ahead of what the main
// thread reports it has played, and posts each chunk (transferred L/R Float32Arrays + start
// frame) for the session to queue as AudioBufferSourceNodes.
//
// in:  boot { module, package, mhz, leadFrames }   consumed { frame }   midi { bytes, frame? }
//      panic { bytes }   key { id, down }   enc { id, clicks }   pot { value }   lcd { on }
// out: ready   error { reason, message }   block { l, r, frame }   lcd { lcd|null, leds }
//      status { rtf, starved, late, dropped }
import { bootEmulator, createRunner } from '../fm1/emulator.js'
import { FM1_RATE } from '../fm1/host-core.js'

const now = () => performance.now()
const post = (m, t) => self.postMessage(m, t || [])
let run = null, x = null, lead = 0, stopped = false
let base = { frame: 0, wall: 0 }, lcdOn = false, lcdForce = false, lcdAt = 0, statusAt = 0

async function boot(m) {
  try {
    ({ x } = await bootEmulator({ module: m.module, pkg: m.package, mhz: m.mhz }))
  } catch (err) { return post({ type: 'error', reason: err.reason || 'wasm-failed', message: err.message }) }
  run = createRunner(x, { mhz: m.mhz })
  lead = m.leadFrames ?? Math.round(0.08 * FM1_RATE)
  // boot until the firmware's audio starts (or 8 s emulated): the first block is then real audio
  try {
    while (!run.playing && x.fm1_ms() < 8000 && !x.fm1_halted()) run.render()
  } catch (err) { return post({ type: 'error', reason: 'halted', message: String(err) }) }
  if (x.fm1_halted()) return post({ type: 'error', reason: 'halted', message: 'the firmware halted while booting' })
  base = { frame: run.frame, wall: now() }
  post({ type: 'ready', frame: run.frame })
  pump()
}

function pump() {
  if (stopped || !run) return
  const t = now()
  const target = base.frame + (t - base.wall) * FM1_RATE / 1000 + lead
  try {
    while (run.frame < target && now() - t < 40) {
      const { l, r, frame } = run.render()
      const L = l.slice(), R = r.slice()
      post({ type: 'block', l: L, r: R, frame }, [L.buffer, R.buffer])
    }
  } catch (err) { stopped = true; return post({ type: 'error', reason: 'halted', message: String(err) }) }
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
    post({ type: 'status', ...s })
  }
  setTimeout(pump, 1)
}

self.onmessage = (e) => {
  const m = e.data
  if (m.type === 'boot') { boot(m); return }
  if (!run) return
  if (m.type === 'consumed') base = { frame: m.frame, wall: now() }
  else if (m.type === 'midi') run.midi(m.bytes, m.frame)
  else if (m.type === 'panic') run.panic(m.bytes)
  else if (m.type === 'key') run.key(m.id, m.down)
  else if (m.type === 'enc') run.enc(m.id, m.clicks)
  else if (m.type === 'pot') run.pot(m.value)
  else if (m.type === 'lcd') { lcdOn = !!m.on; lcdForce = lcdOn }
}
