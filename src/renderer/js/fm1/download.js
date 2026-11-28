import { MAX_PACKAGE } from './fwsc.js'

export const DOWNLOAD_UNAVAILABLE = 'Download needs the desktop app or https://synth.zakharhome.org; on this address use Import firmware…'

export function canDownload(location = globalThis.location, bridge = globalThis.fm1Firmware) {
  return !!bridge || (location?.protocol === 'https:' && location?.hostname === 'synth.zakharhome.org')
}

export async function downloadFirmware(row, { signal, progress = () => {}, bridge = globalThis.fm1Firmware, location = globalThis.location, fetcher = globalThis.fetch } = {}) {
  if (!canDownload(location, bridge)) throw new Error(DOWNLOAD_UNAVAILABLE)
  if (bridge) {
    const requestId = `${Date.now()}-${Math.random()}`
    const abort = () => bridge.cancel(requestId)
    signal?.addEventListener('abort', abort, { once: true })
    const off = bridge.onProgress?.(({ requestId: id, loaded, total }) => { if (id === requestId) progress(loaded, total) })
    try {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      return await bridge.download(row.catalogId, row.entryId, requestId)
    } finally { signal?.removeEventListener('abort', abort); off?.() }
  }
  if (row.catalogId !== 'synth-seed') throw new Error('This catalog can be downloaded in the desktop app; use Import firmware here.')
  const response = await fetcher('/api/fm1-firmware', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ catalogId: row.catalogId, entryId: row.entryId }), signal
  })
  if (!response.ok) {
    let reason
    try { reason = (await response.json()).error } catch {}
    throw new Error(typeof reason === 'string' ? reason.slice(0, 300) : `Download failed (${response.status})`)
  }
  const reader = response.body.getReader(), chunks = []
  const total = Number(response.headers.get('content-length')) || 0
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PACKAGE) { await reader.cancel(); throw new Error('File is over 8 MB') }
      chunks.push(value); progress(size, total)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
