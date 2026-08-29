/**
 * sf2-worker.js
 * Parses a SoundFont off the main thread. Dual-use: exports parseSf2Message()
 * for testing; wires self.onmessage when in worker context.
 *
 * Message in:  { type: 'parse', id: string, bytes: ArrayBuffer, name: string,
 *                presets?: number[] }   // phdr indices; omitted means whole bank
 * Message out: { type: 'done', id, manifest, samples: [{ id, wav: ArrayBuffer }] }
 *              { type: 'error', id, message: string }
 */

import { importSf2 } from '../../../shared/sf2-import.js'

export function parseSf2Message({ id, bytes, name, presets = null } = {}) {
  try {
    const { manifest, samples } = importSf2(new Uint8Array(bytes), { id: name, presets })
    return { type: 'done', id, manifest, samples }
  } catch (error) {
    return { type: 'error', id, message: error?.message || 'Could not read SoundFont' }
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = event => {
    const result = parseSf2Message(event.data)
    // Transfer the WAV bytes back; a big SoundFont must not be copied twice.
    self.postMessage(result, result.type === 'done' ? result.samples.map(sample => sample.wav) : [])
  }
}
