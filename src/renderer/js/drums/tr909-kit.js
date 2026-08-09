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

function createNoiseBuffer(ctx, duration) {
  const length = Math.max(1, Math.ceil(ctx.sampleRate * duration))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  return buffer
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

function kick(ctx, output, params, event, t) {
  const v = baseVelocity(params, event)
  const decay = 0.18 + params.decay * 0.75
  const tune = 42 + params.tune * 42
  const osc = ctx.createOscillator()
  const click = ctx.createOscillator()
  const gain = ctx.createGain()
  const clickGain = ctx.createGain()
  const drive = ctx.createWaveShaper()
  drive.curve = new Float32Array([-1, -0.62, 0, 0.62, 1])
  osc.type = 'sine'
  osc.frequency.setValueAtTime(tune * 2.2, t)
  safeExp(osc.frequency, tune, t + Math.max(0.035, decay * 0.45))
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.linearRampToValueAtTime(v, t + 0.004)
  safeExp(gain.gain, 0.0001, t + decay)
  click.type = 'triangle'
  click.frequency.value = 900 + params.attack * 2400
  clickGain.gain.setValueAtTime(v * params.attack * 0.35, t)
  safeExp(clickGain.gain, 0.0001, t + 0.025)
  osc.connect(gain); gain.connect(drive); drive.connect(output)
  click.connect(clickGain); clickGain.connect(output)
  osc.start(t); click.start(t)
  osc.stop(t + decay + 0.05); click.stop(t + 0.04)
  osc.onended = () => cleanup([osc, gain, drive, click, clickGain])
  return { stop(time = ctx.currentTime) { voiceStop([osc, click], gain, time) } }
}

function snare(ctx, output, params, event, t) {
  const v = baseVelocity(params, event)
  const toneFreq = 150 + params.tune * 150
  const noiseDur = 0.08 + params.snappy * 0.32
  const body = ctx.createOscillator()
  const bodyGain = ctx.createGain()
  const noise = ctx.createBufferSource()
  const filter = ctx.createBiquadFilter()
  const noiseGain = ctx.createGain()
  body.type = 'triangle'
  body.frequency.setValueAtTime(toneFreq, t)
  safeExp(body.frequency, toneFreq * 0.72, t + 0.12)
  bodyGain.gain.setValueAtTime(v * 0.55, t)
  safeExp(bodyGain.gain, 0.0001, t + 0.16)
  noise.buffer = createNoiseBuffer(ctx, noiseDur + 0.03)
  filter.type = 'bandpass'
  filter.frequency.value = 1200 + params.tone * 4200
  filter.Q.value = 0.9
  noiseGain.gain.setValueAtTime(v * (0.25 + params.snappy * 0.75), t)
  safeExp(noiseGain.gain, 0.0001, t + noiseDur)
  body.connect(bodyGain); bodyGain.connect(output)
  noise.connect(filter); filter.connect(noiseGain); noiseGain.connect(output)
  body.start(t); noise.start(t)
  body.stop(t + 0.22); noise.stop(t + noiseDur + 0.05)
  noise.onended = () => cleanup([body, bodyGain, noise, filter, noiseGain])
  return { stop(time = ctx.currentTime) { voiceStop([body, noise], noiseGain, time) } }
}

function tom(ctx, output, params, event, t, baseFreq) {
  const v = baseVelocity(params, event)
  const decay = 0.12 + params.decay * 0.72
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  const freq = baseFreq * (0.72 + params.tune * 0.68)
  osc.frequency.setValueAtTime(freq * 1.35, t)
  safeExp(osc.frequency, freq, t + 0.07)
  gain.gain.setValueAtTime(v, t)
  safeExp(gain.gain, 0.0001, t + decay)
  osc.connect(gain); gain.connect(output)
  osc.start(t); osc.stop(t + decay + 0.05)
  osc.onended = () => cleanup([osc, gain])
  return { stop(time = ctx.currentTime) { voiceStop([osc], gain, time) } }
}

function rim(ctx, output, params, event, t) {
  const v = baseVelocity(params, event)
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const filter = ctx.createBiquadFilter()
  osc.type = 'square'
  osc.frequency.value = 650 + params.tone * 900
  filter.type = 'bandpass'
  filter.frequency.value = 1300 + params.tone * 1600
  filter.Q.value = 8
  gain.gain.setValueAtTime(v * 1.05, t)
  safeExp(gain.gain, 0.0001, t + 0.055)
  osc.connect(filter); filter.connect(gain); gain.connect(output)
  osc.start(t); osc.stop(t + 0.08)
  osc.onended = () => cleanup([osc, filter, gain])
  return { stop(time = ctx.currentTime) { voiceStop([osc], gain, time) } }
}

function clap(ctx, output, params, event, t) {
  const nodes = []
  const v = baseVelocity(params, event)
  const out = ctx.createGain()
  out.gain.value = 1
  out.connect(output)
  ;[0, 0.012, 0.024, 0.043].forEach((offset, i) => {
    const noise = ctx.createBufferSource()
    const filter = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    const dur = i === 3 ? 0.08 + params.decay * 0.42 : 0.024
    noise.buffer = createNoiseBuffer(ctx, dur + 0.02)
    filter.type = 'bandpass'
    filter.frequency.value = 950 + params.tone * 1700
    filter.Q.value = 0.9
      gain.gain.setValueAtTime(v * (i === 3 ? 1.0 : 0.58), t + offset)
    safeExp(gain.gain, 0.0001, t + offset + dur)
    noise.connect(filter); filter.connect(gain); gain.connect(out)
    noise.start(t + offset); noise.stop(t + offset + dur + 0.04)
    nodes.push(noise, filter, gain)
  })
  nodes[0].onended = () => cleanup([...nodes, out])
  return { stop(time = ctx.currentTime) { voiceStop(nodes.filter(n => typeof n.stop === 'function'), out, time) } }
}

function metallic(ctx, output, params, event, t, kind) {
  const isClosed = kind === 'ch'
  const isOpen = kind === 'oh'
  const decay = isClosed ? params.decay : 0.25 + params.decay
  const v = baseVelocity(params, event)
  const out = ctx.createGain()
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 5200 + params.tune * 5200
  out.gain.setValueAtTime(v * (isClosed ? 0.9 : 1.05), t)
  safeExp(out.gain, 0.0001, t + decay)
  hp.connect(out); out.connect(output)
  const oscs = [1, 1.34, 1.49, 1.8, 2.14, 2.46].map((ratio, i) => {
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = (210 + params.tune * 110) * ratio
    const g = ctx.createGain()
    g.gain.value = 0.1 + (i % 2) * 0.025
    osc.connect(g); g.connect(hp)
    osc.start(t); osc.stop(t + decay + 0.05)
    return [osc, g]
  }).flat()
  const handle = { stop(time = ctx.currentTime) { voiceStop(oscs.filter(n => typeof n.stop === 'function'), out, time, 0.012) } }
  oscs[0].onended = () => cleanup([...oscs, hp, out])
  if (isClosed && activeOpenHat) activeOpenHat.stop(t)
  if (isOpen) activeOpenHat = handle
  return handle
}

function cymbal(ctx, output, params, event, t, isRide) {
  const v = baseVelocity(params, event)
  const decay = 0.35 + params.decay
  const out = ctx.createGain()
  const hp = ctx.createBiquadFilter()
  const bp = ctx.createBiquadFilter()
  hp.type = 'highpass'; hp.frequency.value = 3200 + params.tune * 3800
  bp.type = 'bandpass'; bp.frequency.value = isRide ? 6200 : 4800; bp.Q.value = isRide ? 4 : 1.6
  out.gain.setValueAtTime(v * (isRide ? 0.95 : 1.08), t)
  safeExp(out.gain, 0.0001, t + decay)
  hp.connect(bp); bp.connect(out); out.connect(output)
  const oscs = [1, 1.17, 1.31, 1.58, 1.92, 2.23].map(ratio => {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = (310 + params.tune * 180) * ratio
    g.gain.value = isRide ? 0.085 : 0.11
    osc.connect(g); g.connect(hp)
    osc.start(t); osc.stop(t + decay + 0.08)
    return [osc, g]
  }).flat()
  oscs[0].onended = () => cleanup([...oscs, hp, bp, out])
  return { stop(time = ctx.currentTime) { voiceStop(oscs.filter(n => typeof n.stop === 'function'), out, time, 0.02) } }
}

function createTr909Voice(ctx, output, instrumentId, kitParams, event = {}, time = ctx.currentTime) {
  const params = kitParams[instrumentId] || {}
  switch (instrumentId) {
    case 'bd': return kick(ctx, output, params, event, time)
    case 'sd': return snare(ctx, output, params, event, time)
    case 'lt': return tom(ctx, output, params, event, time, 95)
    case 'mt': return tom(ctx, output, params, event, time, 132)
    case 'ht': return tom(ctx, output, params, event, time, 178)
    case 'rs': return rim(ctx, output, params, event, time)
    case 'cp': return clap(ctx, output, params, event, time)
    case 'ch': return metallic(ctx, output, params, event, time, 'ch')
    case 'oh': return metallic(ctx, output, params, event, time, 'oh')
    case 'cr': return cymbal(ctx, output, params, event, time, false)
    case 'rd': return cymbal(ctx, output, params, event, time, true)
    default: return { stop() {} }
  }
}

export { INSTRUMENTS, PARAM_DEFS, makeKitParams, createTr909Voice }
