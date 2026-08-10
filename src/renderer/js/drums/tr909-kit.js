const INSTRUMENTS = [
  { id: 'bd', label: 'BD', name: 'Bass Drum', color: '#ff5a3d', params: { level: 0.9, tune: 0.45, decay: 0.55, attack: 0.55 } },
  { id: 'sd', label: 'SD', name: 'Snare Drum', color: '#ffb238', params: { level: 0.78, tune: 0.48, tone: 0.62, snappy: 0.7 } },
  { id: 'lt', label: 'LT', name: 'Low Tom', color: '#d7c45a', params: { level: 0.68, tune: 0.34, decay: 0.48 } },
  { id: 'mt', label: 'MT', name: 'Mid Tom', color: '#aee36a', params: { level: 0.64, tune: 0.5, decay: 0.42 } },
  { id: 'ht', label: 'HT', name: 'High Tom', color: '#63d878', params: { level: 0.62, tune: 0.66, decay: 0.34 } },
  { id: 'rs', label: 'RS', name: 'Rim Shot', color: '#4ed6b5', params: { level: 0.68, tone: 0.58 } },
  { id: 'cp', label: 'CP', name: 'Hand Clap', color: '#45caff', params: { level: 0.72, decay: 0.34, tone: 0.58 } },
  { id: 'ch', label: 'CH', name: 'Closed Hat', color: '#69a8ff', params: { level: 0.6, tune: 0.62, decay: 0.12 } },
  { id: 'oh', label: 'OH', name: 'Open Hat', color: '#9d8cff', params: { level: 0.58, tune: 0.6, decay: 0.6 } },
  { id: 'cr', label: 'CR', name: 'Crash', color: '#d676ff', params: { level: 0.54, tune: 0.54, decay: 1.25 } },
  { id: 'rd', label: 'RD', name: 'Ride', color: '#ff6fc7', params: { level: 0.52, tune: 0.56, decay: 1.0 } },
]

const PARAM_DEFS = {
  level: { label: 'LEVEL', min: 0, max: 1, step: 0.01 },
  tune: { label: 'TUNE', min: 0, max: 1, step: 0.01 },
  decay: { label: 'DECAY', min: 0.03, max: 1.8, step: 0.01 },
  attack: { label: 'ATTACK', min: 0, max: 1, step: 0.01 },
  tone: { label: 'TONE', min: 0, max: 1, step: 0.01 },
  snappy: { label: 'SNAPPY', min: 0, max: 1, step: 0.01 },
}

let activeOpenHat = null

// ---------------------------------------------------------------------------
// Per-context buffer/curve cache. Keyed by context so the offline bounce
// context builds its own set at its own sample rate.
// ---------------------------------------------------------------------------
const CACHE = new WeakMap()

function cached(ctx, key, make) {
  let map = CACHE.get(ctx)
  if (!map) { map = new Map(); CACHE.set(ctx, map) }
  if (!map.has(key)) map.set(key, make())
  return map.get(key)
}

const NOISE_DUR = 2

function noiseBuffer(ctx) {
  return cached(ctx, 'noise', () => {
    const len = Math.max(1, Math.ceil(ctx.sampleRate * NOISE_DUR))
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    return buffer
  })
}

// One looping white-noise source read from a random offset, so successive hits
// do not phase-lock onto the same noise the way a per-hit buffer would.
function noiseSource(ctx) {
  const node = ctx.createBufferSource()
  node.buffer = noiseBuffer(ctx)
  node.loop = true
  return node
}

function driveCurve(ctx, amount) {
  return cached(ctx, `drive:${amount}`, () => {
    const n = 1024
    const curve = new Float32Array(n)
    const norm = Math.tanh(amount)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.tanh(x * amount) / norm
    }
    return curve
  })
}

// ---------------------------------------------------------------------------
// Metallic ROM voices (CH / OH / CR / RD).
//
// The 909's cymbals are not analog: a counter clocks 6-bit PCM out of ROM into
// a DAC, then a VCA shapes it and a lowpass strips the sample clock. TUNE
// changes the clock rate. We reproduce that: render a gritty inharmonic source
// once per context, quantize it to 6 bits, sample-and-hold it down to the ROM
// clock rate, and play it back through a VCA with playbackRate as TUNE.
// ---------------------------------------------------------------------------
const ROM_RATE = 32000
const ROM_LEVELS = (1 << 6) - 1

const METAL = {
  hat:   { dur: 1.4, base: 318, ratios: [1, 1.5, 2.08, 2.715, 3.395, 4.105], metal: 0.62, ring: 0.34, noise: 0.5,  romDecay: 0.9 },
  crash: { dur: 3.4, base: 246, ratios: [1, 1.41, 1.87, 2.63, 3.31, 4.42],   metal: 0.5,  ring: 0.3,  noise: 0.78, romDecay: 2.6 },
  ride:  { dur: 2.8, base: 292, ratios: [1, 1.35, 1.72, 2.24, 2.91, 3.62],   metal: 0.72, ring: 0.42, noise: 0.28, romDecay: 2.0 },
}

function metalBuffer(ctx, kind) {
  return cached(ctx, `metal:${kind}`, () => {
    const spec = METAL[kind]
    const len = Math.max(1, Math.ceil(ctx.sampleRate * spec.dur))
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    const dt = 1 / ROM_RATE
    const quant = 2 / ROM_LEVELS
    const inc = spec.ratios.map(r => spec.base * r * dt)
    const phase = spec.ratios.map(() => Math.random())
    const decayK = Math.exp(-dt / spec.romDecay)
    const clockInc = ROM_RATE / ctx.sampleRate
    let clock = 1
    let env = 1
    let held = 0
    let seed = 987654321
    for (let i = 0; i < len; i++) {
      clock += clockInc
      if (clock >= 1) {
        clock -= 1
        let square = 0
        for (let k = 0; k < phase.length; k++) {
          phase[k] += inc[k]
          if (phase[k] >= 1) phase[k] -= 1
          square += phase[k] < 0.5 ? 1 : -1
        }
        square /= phase.length
        // Ring-modulating two of the partials fills the gaps between the square
        // stack's harmonics — that is what stops it sounding like an 808 hat.
        const ring = (phase[0] < 0.5 ? 1 : -1) * (phase[3] < 0.5 ? 1 : -1)
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        const white = seed / 0x40000000 - 1
        const raw = square * spec.metal + ring * spec.ring + white * spec.noise
        held = Math.round(Math.tanh(raw * 2.1) * env / quant) * quant
        env *= decayK
      }
      data[i] = held
    }
    return buffer
  })
}

function safeExp(param, value, time) {
  param.exponentialRampToValueAtTime(Math.max(0.0001, value), time)
}

function cleanup(nodes) {
  nodes.forEach(node => {
    try { node.disconnect() } catch (e) {}
  })
}

function voiceStop(nodes, gain, stopTime, release = 0.025) {
  try {
    gain.gain.cancelScheduledValues(stopTime)
    gain.gain.setTargetAtTime(0.0001, stopTime, release)
  } catch (e) {}
  nodes.forEach(node => {
    if (typeof node.stop === 'function') {
      try { node.stop(stopTime + release * 4) } catch (e) {}
    }
  })
}

function makeKitParams() {
  return Object.fromEntries(INSTRUMENTS.map(inst => [inst.id, { ...inst.params }]))
}

function baseVelocity(params, event = {}) {
  const accentBoost = event.accent ? 1.3 : 1
  return Math.min(1.65, (event.velocity ?? 0.85) * (params.level ?? 0.75) * accentBoost * 1.2)
}

// ---------------------------------------------------------------------------
// Analog voices
// ---------------------------------------------------------------------------

function kick(ctx, output, params, event, t) {
  const v = baseVelocity(params, event)
  const decay = 0.11 + params.decay * 0.85
  const f0 = 38 + params.tune * 34
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const drive = ctx.createWaveShaper()
  drive.curve = driveCurve(ctx, 1.9)
  osc.type = 'sine'
  // The 909's pitch envelope is over in ~50 ms — that snap is the whole sound.
  osc.frequency.setValueAtTime(f0 * 4.6, t)
  safeExp(osc.frequency, f0 * 1.35, t + 0.011)
  safeExp(osc.frequency, f0, t + 0.055)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.linearRampToValueAtTime(v, t + 0.002)
  safeExp(gain.gain, 0.0001, t + decay)
  osc.connect(gain); gain.connect(drive); drive.connect(output)

  // ATTACK sets the level of a filtered noise burst, not a pitched click.
  const click = noiseSource(ctx)
  const hp = ctx.createBiquadFilter()
  const clickGain = ctx.createGain()
  hp.type = 'highpass'
  hp.frequency.value = 1400
  clickGain.gain.setValueAtTime(v * (0.08 + params.attack * 0.5), t)
  safeExp(clickGain.gain, 0.0001, t + 0.0045)
  click.connect(hp); hp.connect(clickGain); clickGain.connect(output)

  osc.start(t)
  click.start(t, Math.random() * NOISE_DUR)
  osc.stop(t + decay + 0.05)
  click.stop(t + 0.03)
  osc.onended = () => cleanup([osc, gain, drive, click, hp, clickGain])
  return { stop(time = ctx.currentTime) { voiceStop([osc, click], gain, time) } }
}

// Stock 909 snare oscillators sit at 238 Hz and 476 Hz (Roland service notes).
const SNARE_OSCS = [[238, 0.5, 0.105], [476, 0.3, 0.062]]

function snare(ctx, output, params, event, t) {
  const v = baseVelocity(params, event)
  const scale = 0.72 + params.tune * 0.62
  const noiseDur = 0.055 + params.snappy * 0.2
  const out = ctx.createGain()
  out.gain.value = 1
  out.connect(output)
  const oscNodes = SNARE_OSCS.map(([freq, amp, dec]) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq * scale * 1.18, t)
    safeExp(osc.frequency, freq * scale, t + 0.022)
    gain.gain.setValueAtTime(v * amp, t)
    safeExp(gain.gain, 0.0001, t + dec)
    osc.connect(gain); gain.connect(out)
    osc.start(t); osc.stop(t + dec + 0.03)
    return [osc, gain]
  }).flat()
  // Snare cable noise: highpass (TONE) into a fixed lowpass, per the circuit.
  const noise = noiseSource(ctx)
  const hp = ctx.createBiquadFilter()
  const lp = ctx.createBiquadFilter()
  const noiseGain = ctx.createGain()
  hp.type = 'highpass'; hp.frequency.value = 900 + params.tone * 5400; hp.Q.value = 0.8
  lp.type = 'lowpass'; lp.frequency.value = 7800
  noiseGain.gain.setValueAtTime(v * (0.26 + params.snappy * 0.6), t)
  safeExp(noiseGain.gain, 0.0001, t + noiseDur)
  noise.connect(hp); hp.connect(lp); lp.connect(noiseGain); noiseGain.connect(out)
  noise.start(t, Math.random() * NOISE_DUR)
  noise.stop(t + noiseDur + 0.05)
  noise.onended = () => cleanup([...oscNodes, noise, hp, lp, noiseGain, out])
  return { stop(time = ctx.currentTime) { voiceStop([...oscNodes, noise], out, time) } }
}

// The 909 tom stacks three oscillators at 1 : 1.5 : 2.77 plus a noise attack.
const TOM_RATIOS = [[1, 1, 1], [1.5, 0.26, 0.5], [2.77, 0.13, 0.32]]

function tom(ctx, output, params, event, t, baseFreq) {
  const v = baseVelocity(params, event)
  const decay = 0.12 + params.decay * 0.72
  const freq = baseFreq * (0.72 + params.tune * 0.68)
  const out = ctx.createGain()
  out.gain.value = 1
  out.connect(output)
  const oscNodes = TOM_RATIOS.map(([ratio, amp, decMul]) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq * ratio * 1.42, t)
    safeExp(osc.frequency, freq * ratio, t + 0.05)
    gain.gain.setValueAtTime(v * amp * 0.85, t)
    safeExp(gain.gain, 0.0001, t + decay * decMul)
    osc.connect(gain); gain.connect(out)
    osc.start(t); osc.stop(t + decay + 0.05)
    return [osc, gain]
  }).flat()
  const noise = noiseSource(ctx)
  const bp = ctx.createBiquadFilter()
  const noiseGain = ctx.createGain()
  bp.type = 'bandpass'; bp.frequency.value = freq * 5.5; bp.Q.value = 1.1
  noiseGain.gain.setValueAtTime(v * 0.3, t)
  safeExp(noiseGain.gain, 0.0001, t + 0.035)
  noise.connect(bp); bp.connect(noiseGain); noiseGain.connect(out)
  noise.start(t, Math.random() * NOISE_DUR)
  noise.stop(t + 0.07)
  oscNodes[0].onended = () => cleanup([...oscNodes, noise, bp, noiseGain, out])
  return { stop(time = ctx.currentTime) { voiceStop([...oscNodes, noise], out, time) } }
}

function rim(ctx, output, params, event, t) {
  const v = baseVelocity(params, event)
  const out = ctx.createGain()
  out.gain.value = 1
  out.connect(output)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 1500 + params.tone * 1400
  bp.Q.value = 6
  bp.connect(out)
  // Two short pulses an octave apart, plus a noise tick. ~35 ms total.
  const oscNodes = [[220, 1], [440, 0.7]].map(([freq, amp]) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = freq * (0.85 + params.tone * 0.5)
    gain.gain.setValueAtTime(v * amp * 0.85, t)
    safeExp(gain.gain, 0.0001, t + 0.028)
    osc.connect(gain); gain.connect(bp)
    osc.start(t); osc.stop(t + 0.04)
    return [osc, gain]
  }).flat()
  const noise = noiseSource(ctx)
  const noiseGain = ctx.createGain()
  noiseGain.gain.setValueAtTime(v * 0.5, t)
  safeExp(noiseGain.gain, 0.0001, t + 0.008)
  noise.connect(noiseGain); noiseGain.connect(bp)
  noise.start(t, Math.random() * NOISE_DUR)
  noise.stop(t + 0.03)
  oscNodes[0].onended = () => cleanup([...oscNodes, noise, noiseGain, bp, out])
  return { stop(time = ctx.currentTime) { voiceStop([...oscNodes, noise], out, time) } }
}

// Four VCA hits ~10 ms apart, the last one carrying the room tail.
const CLAP_OFFSETS = [0, 0.010, 0.020, 0.031]

function clap(ctx, output, params, event, t) {
  const v = baseVelocity(params, event)
  const out = ctx.createGain()
  out.gain.value = 1
  const bp = ctx.createBiquadFilter()
  const hp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 900 + params.tone * 900
  bp.Q.value = 2.6
  hp.type = 'highpass'
  hp.frequency.value = 700
  hp.connect(bp); bp.connect(out); out.connect(output)
  const nodes = []
  CLAP_OFFSETS.forEach((offset, i) => {
    const last = i === CLAP_OFFSETS.length - 1
    const noise = noiseSource(ctx)
    const gain = ctx.createGain()
    const dur = last ? 0.09 + params.decay * 0.4 : 0.0075
    gain.gain.setValueAtTime(v * (last ? 0.95 : 0.72), t + offset)
    safeExp(gain.gain, 0.0001, t + offset + dur)
    noise.connect(gain); gain.connect(hp)
    noise.start(t + offset, Math.random() * NOISE_DUR)
    noise.stop(t + offset + dur + 0.04)
    nodes.push(noise, gain)
  })
  nodes[0].onended = () => cleanup([...nodes, hp, bp, out])
  return { stop(time = ctx.currentTime) { voiceStop(nodes, out, time) } }
}

// ---------------------------------------------------------------------------
// ROM playback voices
// ---------------------------------------------------------------------------

const METAL_VOICES = {
  ch: { rom: 'hat',   amp: 0.95, hp: 6400, peak: null,             decay: p => 0.018 + p.decay * 0.2 },
  oh: { rom: 'hat',   amp: 0.9,  hp: 5000, peak: null,             decay: p => 0.08 + p.decay * 0.9 },
  cr: { rom: 'crash', amp: 1.0,  hp: 2600, peak: null,             decay: p => 0.6 + p.decay * 1.5 },
  rd: { rom: 'ride',  amp: 0.95, hp: 3000, peak: [5600, 3.5, 7],   decay: p => 0.45 + p.decay * 1.3 },
}

function metallic(ctx, output, params, event, t, kind) {
  const spec = METAL_VOICES[kind]
  const v = baseVelocity(params, event)
  const decay = spec.decay(params)
  const src = ctx.createBufferSource()
  const hp = ctx.createBiquadFilter()
  const lp = ctx.createBiquadFilter()
  const gain = ctx.createGain()
  src.buffer = metalBuffer(ctx, spec.rom)
  // TUNE is the ROM clock rate, exactly as on the hardware.
  src.playbackRate.value = 0.75 + params.tune * 0.7
  hp.type = 'highpass'; hp.frequency.value = spec.hp; hp.Q.value = 0.7
  lp.type = 'lowpass'; lp.frequency.value = 13500
  gain.gain.setValueAtTime(v * spec.amp, t)
  safeExp(gain.gain, 0.0001, t + decay)
  let tail = lp
  const extra = []
  if (spec.peak) {
    const peak = ctx.createBiquadFilter()
    peak.type = 'peaking'
    peak.frequency.value = spec.peak[0]
    peak.Q.value = spec.peak[1]
    peak.gain.value = spec.peak[2]
    lp.connect(peak)
    tail = peak
    extra.push(peak)
  }
  src.connect(hp); hp.connect(lp); tail.connect(gain); gain.connect(output)
  src.start(t)
  src.stop(t + decay + 0.05)
  const handle = { stop(time = ctx.currentTime) { voiceStop([src], gain, time, 0.008) } }
  src.onended = () => cleanup([src, hp, lp, ...extra, gain])
  if (kind === 'ch' && activeOpenHat) activeOpenHat.stop(t)
  if (kind === 'oh') activeOpenHat = handle
  return handle
}

function createTr909Voice(ctx, output, instrumentId, kitParams, event = {}, time = ctx.currentTime) {
  const params = kitParams[instrumentId] || {}
  switch (instrumentId) {
    case 'bd': return kick(ctx, output, params, event, time)
    case 'sd': return snare(ctx, output, params, event, time)
    case 'lt': return tom(ctx, output, params, event, time, 82)
    case 'mt': return tom(ctx, output, params, event, time, 116)
    case 'ht': return tom(ctx, output, params, event, time, 160)
    case 'rs': return rim(ctx, output, params, event, time)
    case 'cp': return clap(ctx, output, params, event, time)
    case 'ch':
    case 'oh':
    case 'cr':
    case 'rd': return metallic(ctx, output, params, event, time, instrumentId)
    default: return { stop() {} }
  }
}

export { INSTRUMENTS, PARAM_DEFS, makeKitParams, createTr909Voice, metalBuffer, ROM_RATE }
