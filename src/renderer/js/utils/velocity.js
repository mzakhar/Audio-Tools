// Pure MIDI velocity (0-127) -> amplitude 0-1.
// Linear velocity/127 puts a normal finger-drum hit (~45) at -9 dB, so pads had
// to be struck hard to be heard. Power curve plus a floor restores the feel.
const EXPONENT = 0.6
const FLOOR = 0.15

export function velocityGain(velocity) {
  const v = Math.max(0, Math.min(127, Number(velocity) || 0)) / 127
  if (v === 0) return 0
  return FLOOR + (1 - FLOOR) * Math.pow(v, EXPONENT)
}
