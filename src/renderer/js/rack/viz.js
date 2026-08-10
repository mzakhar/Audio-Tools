/**
 * viz.js
 * Pure math for the modular rack's visualization modules (scope, meters).
 * No DOM, no AudioContext, no globals — callers own the AnalyserNode reads
 * and the rAF loop; this module only turns sample buffers into numbers.
 */

// ─── Oscilloscope trigger ───
// Scans [1, buffer.length - displaySamples) for a level crossing in the
// requested direction, so the returned index always leaves a full display
// window behind it. Hysteresis arms the detector: the signal must travel
// past level-hysteresis (rising) / level+hysteresis (falling) before a
// crossing counts, otherwise noise dithering on the threshold retriggers
// every sample instead of locking to one stable edge.
export function findTrigger(buffer, displaySamples, level = 0, slope = 'rising', hysteresis = 0.02) {
  const searchEnd = buffer.length - displaySamples
  const rising = slope !== 'falling'
  let armed = false
  for (let i = 1; i < searchEnd; i++) {
    const prev = buffer[i - 1]
    const cur = buffer[i]
    if (rising) {
      if (!armed) {
        if (prev < level - hysteresis) armed = true
        continue
      }
      if (prev < level && cur >= level) return i
    } else {
      if (!armed) {
        if (prev > level + hysteresis) armed = true
        continue
      }
      if (prev > level && cur <= level) return i
    }
  }
  return -1
}

// ─── Levels ───
export function levels(buffer) {
  let peak = 0
  let sumSquares = 0
  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i]
    const a = Math.abs(v)
    if (a > peak) peak = a
    sumSquares += v * v
  }
  return { peak, rms: buffer.length ? Math.sqrt(sumSquares / buffer.length) : 0 }
}

// Signed extremes and mean — CV is valid at a steady negative DC, which
// abs()/dB metering destroys.
export function bipolar(buffer) {
  if (!buffer.length) return { min: 0, max: 0, mean: 0 }
  let min = buffer[0]
  let max = buffer[0]
  let sum = 0
  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i]
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  return { min, max, mean: sum / buffer.length }
}

// ─── dB scaling ───
// dbfs(0) === floor, never -Infinity: log10(0) is guarded by an epsilon
// below any sane floor, then the result is clamped to floor anyway.
export function dbfs(amplitude, floor = -60) {
  const db = 20 * Math.log10(Math.max(Math.abs(amplitude), 1e-10))
  return Math.max(db, floor)
}

export function dbToFraction(db, floor = -60) {
  const clamped = Math.min(0, Math.max(floor, db))
  return (clamped - floor) / -floor
}

// ─── Ballistics ───
// Frame-rate independent exponential approach: alpha = 1 - exp(-dt/tau).
// A fixed per-frame multiplier is wrong because it implies a different
// real-world time constant at every frame rate; this form doesn't.
export function approach(current, target, dt, tau) {
  if (tau <= 0 || dt <= 0) return target
  const alpha = 1 - Math.exp(-dt / tau)
  return current + (target - current) * alpha
}

// Peak-hold cap state machine, in dB. Snaps up instantly to any higher
// target, holds flat for holdSeconds, then decays toward floor.
export function peakHold(state, targetDb, dt, { holdSeconds = 1.5, decayTau = 0.5, floor = -60 } = {}) {
  if (targetDb >= state.value) {
    return { value: targetDb, hold: holdSeconds }
  }
  if (state.hold > 0) {
    return { value: state.value, hold: state.hold - dt }
  }
  return { value: approach(state.value, floor, dt, decayTau), hold: 0 }
}

// ─── AnalyserNode sizing ───
// Smallest power-of-two fftSize whose window (fftSize / sampleRate) covers
// windowSeconds, clamped to the AnalyserNode legal range [32, 32768].
export function fftSizeFor(windowSeconds, sampleRate) {
  const needed = Math.max(1, windowSeconds * sampleRate)
  let size = 32
  while (size < needed && size < 32768) size *= 2
  return size
}
