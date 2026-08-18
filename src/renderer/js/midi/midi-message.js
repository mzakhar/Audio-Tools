/**
 * midi-message.js
 * Pure parser: raw MIDI bytes -> a typed event object, or null if unhandled.
 * channel is `status & 0x0f`, 0-indexed (device channel 1 = channel: 0).
 * Never re-index channel anywhere else — this is the one place that reads it.
 */

export function parseMidiMessage(bytes) {
  const [status, data1, data2] = bytes
  const type = status & 0xf0
  const channel = status & 0x0f

  if (type === 0x90) {
    const velocity = data2
    if (velocity > 0) return { kind: 'note-on', channel, pitch: data1, velocity }
    return { kind: 'note-off', channel, pitch: data1 }
  }

  if (type === 0x80) {
    return { kind: 'note-off', channel, pitch: data1 }
  }

  if (type === 0xb0) {
    return { kind: 'cc', channel, controller: data1, value: data2 }
  }

  if (type === 0xe0) {
    const raw = (data2 << 7) | data1
    const value = raw === 8192 ? 0 : raw < 8192 ? (raw - 8192) / 8192 : (raw - 8192) / 8191
    return { kind: 'pitch-bend', channel, value }
  }

  if (status === 0xf8) return { kind: 'clock' }
  if (status === 0xfa) return { kind: 'start' }
  if (status === 0xfc) return { kind: 'stop' }
  if (status === 0xfb) return { kind: 'continue' }

  return null
}
