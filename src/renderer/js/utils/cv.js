/**
 * cv.js
 * Pure control-voltage math for the modular rack.
 * Signal conventions: audio +-1.0; bipolar CV +-1.0 == +-5V;
 * pitch CV 0.1 graph units per octave (1V/oct at 0.1 == 1V), 0.0 == C4.
 */

export const C4_HZ = 261.6255653005986
export const PITCH_CV_GAIN = 12000 // GainNode gain: pitch-CV graph value -> cents (0.1 in -> 1200 cents)

// ─── Pitch CV <-> MIDI ───
export function midiToPitchCv(midi) {
  return (midi - 60) / 120
}
export function pitchCvToMidi(cv) {
  return cv * 120 + 60
}

// ─── Pitch CV <-> Hz ───
export function pitchCvToHz(cv) {
  return C4_HZ * Math.pow(2, cv * 10)
}
export function hzToPitchCv(hz) {
  if (hz <= 0) return 0
  return Math.log2(hz / C4_HZ) / 10
}

// ─── Volts / gate helpers ───
export function voltsToCents(volts) {
  return volts * 1200
}
export function gateFromVelocity(velocity) {
  return velocity > 0 ? 1 : 0
}

// ─── Clamp ───
export function clampCv(v, min = -1, max = 1) {
  const n = Number.isFinite(v) ? v : 0
  return Math.min(max, Math.max(min, n))
}
