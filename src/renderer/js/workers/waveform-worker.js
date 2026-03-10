/**
 * waveform-worker.js
 * Computes peak/RMS LOD data for waveform rendering.
 * Dual-use: exports computeLod() for testing; wires self.onmessage when in worker context.
 *
 * Message in:  { type: 'compute', id: string, channels: Float32Array[], sampleRate: number }
 *   channels: array of Float32Array, one per audio channel (already extracted from AudioBuffer)
 *
 * Message out: { type: 'done', id: string, lods: Object<number, Float32Array> }
 *              { type: 'error', id: string, message: string }
 */

const LOD_LEVELS = [32, 64, 128, 256, 512, 1024, 2048, 4096]

/**
 * Compute peak/RMS LOD data for the given channels.
 * @param {Float32Array[]} channels - one per audio channel
 * @param {number[]} levels - LOD levels to compute (default LOD_LEVELS)
 * @returns {Object<number, Float32Array>} maps each level to interleaved [peak, rms, ...]
 */
function computeLod(channels, levels = LOD_LEVELS) {
  if (!channels || channels.length === 0) {
    throw new Error('channels must be a non-empty array')
  }

  const numChannels = channels.length
  const numSamples = channels[0].length

  // Compute mono mix: average of all channels
  const mono = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    let sum = 0
    for (let ch = 0; ch < numChannels; ch++) {
      sum += channels[ch][i]
    }
    mono[i] = sum / numChannels
  }

  const result = {}

  for (const level of levels) {
    const numBuckets = Math.ceil(numSamples / level)
    const lodData = new Float32Array(numBuckets * 2)

    for (let b = 0; b < numBuckets; b++) {
      const start = b * level
      const end = Math.min(start + level, numSamples)
      let peak = 0
      let sumSq = 0

      for (let s = start; s < end; s++) {
        const abs = Math.abs(mono[s])
        if (abs > peak) peak = abs
        sumSq += mono[s] * mono[s]
      }

      const rms = Math.sqrt(sumSq / (end - start))
      lodData[b * 2] = peak
      lodData[b * 2 + 1] = rms
    }

    result[level] = lodData
  }

  return result
}

// Only wire the handler when running as a worker
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (e) => {
    const { type, id, channels, sampleRate } = e.data
    if (type !== 'compute') return
    try {
      const lods = computeLod(channels)
      self.postMessage({ type: 'done', id, lods })
    } catch (err) {
      self.postMessage({ type: 'error', id, message: err.message })
    }
  }
}

export { computeLod, LOD_LEVELS }
