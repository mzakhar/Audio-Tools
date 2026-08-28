// pack-import-web.js — the browser half of "+ IMPORT .SF2".
//
// Same conversion as the Electron path (one shared parser), different edges:
// a file input instead of a native dialog, IndexedDB instead of userData.

// IndexedDB is not a filesystem; keep the ceiling well under the Electron one.
export const MAX_SF2_BYTES = 128 * 1024 * 1024
const MAX_SAMPLES = 4096

/** Hidden input, created per use — a permanent one in index.html keeps a file handle alive. */
export function pickSf2File() {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.sf2,.sf3'
    input.style.display = 'none'
    document.body.appendChild(input)
    const finish = value => { input.remove(); resolve(value) }
    input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    input.click()
  })
}

function parseInWorker(bytes, name) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/sf2-worker.js', import.meta.url), { type: 'module' })
    const close = () => worker.terminate()
    worker.onmessage = event => {
      close()
      if (event.data?.type === 'done') resolve(event.data)
      else reject(new Error(event.data?.message || 'Could not read SoundFont'))
    }
    worker.onerror = error => { close(); reject(new Error(error?.message || 'SoundFont parser failed to start')) }
    worker.postMessage({ type: 'parse', id: 1, bytes, name }, [bytes])
  })
}

/**
 * Pick (or take) a .sf2, convert it off the main thread and store it.
 * @returns {Promise<{id, version, manifest}|null>} null when the user cancels.
 */
export async function importPackFromFile({ store, file, onProgress = () => {} } = {}) {
  if (!store) throw new Error('This browser cannot store instrument packs (IndexedDB is unavailable).')
  const chosen = file || await pickSf2File()
  if (!chosen) return null
  if (!/\.sf[23]$/i.test(chosen.name)) throw new Error('Choose a .sf2 file')
  if (chosen.size > MAX_SF2_BYTES) {
    throw new Error(`That SoundFont is ${Math.round(chosen.size / 1048576)} MB. The browser build accepts up to ${MAX_SF2_BYTES / 1048576} MB — use the desktop app for larger files.`)
  }

  onProgress({ stage: 'reading', name: chosen.name })
  const bytes = await chosen.arrayBuffer()

  onProgress({ stage: 'parsing', name: chosen.name })
  const { manifest, samples } = await parseInWorker(bytes, chosen.name.replace(/\.sf[23]$/i, ''))
  if (samples.length > MAX_SAMPLES) throw new Error('SoundFont has too many samples')

  onProgress({ stage: 'storing', name: chosen.name })
  const saved = await store.savePack(manifest, samples)

  onProgress({ stage: 'done', name: chosen.name })
  return saved
}
