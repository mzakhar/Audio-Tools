/**
 * wav-encoder.js
 * Shared WAV encoding utilities used by Recorder and TimelinePlayer.
 */

/**
 * Encode interleaved Int16 PCM samples into a RIFF WAV ArrayBuffer.
 * @param {Int16Array} pcm   Interleaved samples (L, R, L, R, ...)
 * @param {number} sampleRate
 * @param {number} numChannels
 * @returns {ArrayBuffer}
 */
export function encodeWAV(pcm, sampleRate, numChannels) {
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataLen = pcm.length * bytesPerSample
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)

  function writeStr(off, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)           // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)          // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)

  const dest = new Int16Array(buf, 44)
  dest.set(pcm)

  return buf
}

/**
 * Convert a Float32Array (one channel, -1..1) to clamped Int16Array.
 * @param {Float32Array} f32
 * @returns {Int16Array}
 */
export function f32ToI16(f32) {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    out[i] = Math.max(-1, Math.min(1, f32[i])) * 0x7FFF
  }
  return out
}

/**
 * Interleave two Float32Array channels into a single Int16Array.
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @returns {Int16Array}
 */
export function interleaveToI16(left, right) {
  const len = Math.min(left.length, right.length)
  const pcm = new Int16Array(len * 2)
  for (let i = 0; i < len; i++) {
    pcm[i * 2]     = Math.max(-1, Math.min(1, left[i]))  * 0x7FFF
    pcm[i * 2 + 1] = Math.max(-1, Math.min(1, right[i])) * 0x7FFF
  }
  return pcm
}

/**
 * Encode an AudioBuffer (from OfflineAudioContext) directly to a WAV ArrayBuffer.
 * @param {AudioBuffer} audioBuffer
 * @returns {ArrayBuffer}
 */
export function audioBufferToWAV(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels
  const sampleRate = audioBuffer.sampleRate
  const length = audioBuffer.length

  if (numChannels === 1) {
    const pcm = f32ToI16(audioBuffer.getChannelData(0))
    return encodeWAV(pcm, sampleRate, 1)
  }

  // Stereo: interleave channels 0 and 1
  const left  = audioBuffer.getChannelData(0)
  const right = audioBuffer.getChannelData(numChannels > 1 ? 1 : 0)
  const pcm = interleaveToI16(left, right)
  return encodeWAV(pcm, sampleRate, 2)
}
