const DEFAULT_MAX_BYTES = 128 * 1024 * 1024

function bufferBytes(buffer) {
  return (buffer?.length || 0) * (buffer?.numberOfChannels || 0) * 4
}

/**
 * Decoded sample cache. `resolve` deliberately owns file/IPC/network access;
 * this module only deduplicates decoding and bounds renderer memory.
 */
export function createSampleStore({ load, ctx, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof load !== 'function') throw new TypeError('sampleStore load is required')
  if (!ctx?.decodeAudioData) throw new TypeError('sampleStore ctx.decodeAudioData is required')
  const cache = new Map()
  const pending = new Map()
  let usedBytes = 0

  const evict = () => {
    while (usedBytes > maxBytes && cache.size) {
      const [id, entry] = cache.entries().next().value
      cache.delete(id)
      usedBytes -= entry.bytes
    }
  }

  return {
    get(sampleId) {
      if (cache.has(sampleId)) {
        const entry = cache.get(sampleId)
        cache.delete(sampleId) // Map order is LRU order.
        cache.set(sampleId, entry)
        return Promise.resolve(entry.buffer)
      }
      if (pending.has(sampleId)) return pending.get(sampleId)
      const request = Promise.resolve(load(sampleId)).then(bytes => ctx.decodeAudioData(bytes)).then(buffer => {
        if (!buffer) throw new Error(`Sample unavailable: ${sampleId}`)
        const entry = { buffer, bytes: bufferBytes(buffer) }
        cache.set(sampleId, entry)
        usedBytes += entry.bytes
        evict()
        return buffer
      }).finally(() => pending.delete(sampleId))
      pending.set(sampleId, request)
      return request
    },
    preload(sampleIds) {
      return Promise.all([...new Set(sampleIds)].map(id => this.get(id)))
    },
    clear() { cache.clear(); usedBytes = 0 },
    get bytes() { return usedBytes },
    get size() { return cache.size }
  }
}

export { DEFAULT_MAX_BYTES }
