const HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'thefirmwarehub.com'])
const MAX_BYTES = 8 * 1024 * 1024

function allowedUrl(value, base) {
  let url
  try { url = new URL(value, base) } catch { throw new Error('Invalid firmware URL') }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new Error('Firmware URL is not allowed')
  return url
}

export async function downloadFm1Firmware(entryId, catalog, { fetchFn = fetch, signal, onProgress, onChunk, timeoutMs = 30000 } = {}) {
  const entry = typeof entryId === 'string' && catalog?.entries?.find(row => row.id === entryId)
  if (!entry?.packageUrl) throw new Error('Unknown firmware entry')
  let url = allowedUrl(entry.packageUrl)
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('Firmware download timed out')), timeoutMs)
  try {
    let response
    for (let redirects = 0; ; redirects++) {
      response = await fetchFn(url.href, { redirect: 'manual', signal: controller.signal })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      if (redirects >= 5) throw new Error('Too many firmware redirects')
      const location = response.headers.get('location')
      if (!location) throw new Error('Firmware redirect has no location')
      url = allowedUrl(location, url)
      await response.body?.cancel()
    }
    if (!response.ok || !response.body) throw new Error(`Firmware download failed (${response.status})`)
    const encoding = response.headers.get('content-encoding')
    const length = !encoding || encoding === 'identity' ? Number(response.headers.get('content-length')) || undefined : undefined
    if (length > MAX_BYTES) throw new Error('Firmware download exceeds 8 MiB')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_BYTES) throw new Error('Firmware download exceeds 8 MiB')
      if (onChunk) await onChunk(chunk, length, controller.signal)
      else chunks.push(chunk)
      onProgress?.(size, length)
    }
    return onChunk ? null : Buffer.concat(chunks, size)
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason || error
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    controller.abort()
  }
}
