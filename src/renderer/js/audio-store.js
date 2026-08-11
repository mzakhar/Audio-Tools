/**
 * audio-store.js
 * In-memory AudioBuffer and LOD cache. Manages the waveform Web Worker.
 */
import AudioEngine from './audio-engine.js'
import FileAdapter from './io/FileAdapter.js'
import { validateAudioFile } from './utils/audio-file-validator.js'

let _projectDirHandle = null
const _buffers = new Map()  // fileKey → AudioBuffer
const _lods    = new Map()  // fileKey → Object<number, Float32Array>
const _pending = new Map()  // fileKey → Promise<AudioBuffer>  (dedup)
const _requested = new Set() // fileKey → already asked for by getBufferOrLoad
const _lodCallbacks = new Set()

let _worker = null

function _getWorker() {
  if (_worker) return _worker
  _worker = new Worker(new URL('./workers/waveform-worker.js', import.meta.url), { type: 'module' })
  _worker.onmessage = _onWorkerMessage
  _worker.onerror = (e) => console.error('[AudioStore] worker error', e)
  return _worker
}

function _onWorkerMessage(e) {
  const { type, id, lods, message } = e.data
  if (type === 'done') {
    _lods.set(id, lods)
    _lodCallbacks.forEach(cb => cb(id))
  } else if (type === 'error') {
    console.error('[AudioStore] LOD computation failed for', id, message)
  }
}

function _computeLod(fileKey, audioBuffer) {
  const worker = _getWorker()
  const numCh = audioBuffer.numberOfChannels
  // Extract channel data as plain Float32Array (AudioBuffer is not transferable)
  const channels = []
  for (let ch = 0; ch < numCh; ch++) {
    channels.push(new Float32Array(audioBuffer.getChannelData(ch)))
  }
  worker.postMessage({ type: 'compute', id: fileKey, channels, sampleRate: audioBuffer.sampleRate })
}

const AudioStore = {
  setProjectDir(handle) {
    _projectDirHandle = handle
  },

  getProjectDir() {
    return _projectDirHandle
  },

  async importFile(fileHandle) {
    if (!_projectDirHandle) throw new Error('No project open. Call setProjectDir first.')
    const fileKey = await FileAdapter.importAudio(fileHandle, _projectDirHandle)
    await this.loadBuffer(fileKey)
    return fileKey
  },

  async loadBuffer(fileKey) {
    if (_buffers.has(fileKey)) return _buffers.get(fileKey)
    if (_pending.has(fileKey)) return _pending.get(fileKey)

    const promise = (async () => {
      // Read the raw bytes from the project folder
      // FileAdapter.readProject is for JSON; we need raw file access.
      // Use the project dir handle directly.
      let arrayBuffer
      if (typeof _projectDirHandle === 'string') {
        // Electron: read via IPC  (dirPath, relPath)
        arrayBuffer = await window.electronFS.readAudioBytes(_projectDirHandle, fileKey)
      } else {
        // Browser: traverse FileSystemDirectoryHandle
        const parts = fileKey.split('/')
        let dir = _projectDirHandle
        for (let i = 0; i < parts.length - 1; i++) {
          dir = await dir.getDirectoryHandle(parts[i])
        }
        const fh = await dir.getFileHandle(parts[parts.length - 1])
        const file = await fh.getFile()
        arrayBuffer = await file.arrayBuffer()
      }

      // Validate magic bytes before handing to the decoder
      const filename = fileKey.split('/').pop()
      const header = new Uint8Array(arrayBuffer, 0, Math.min(12, arrayBuffer.byteLength))
      const validation = validateAudioFile(filename, arrayBuffer.byteLength, header)
      if (!validation.ok) throw new Error(validation.error)

      const ctx = AudioEngine.getContext()
      if (!ctx) throw new Error('AudioContext not initialized')
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
      _buffers.set(fileKey, audioBuffer)
      _pending.delete(fileKey)
      _computeLod(fileKey, audioBuffer)
      return audioBuffer
    })()

    // A rejected load must not stay in the dedup map, or every later attempt
    // returns the same failed promise and the file can never be loaded again.
    promise.catch(() => _pending.delete(fileKey))
    _pending.set(fileKey, promise)
    return promise
  },

  getBuffer(fileKey) {
    return _buffers.get(fileKey) ?? null
  },

  // Synchronous lookup for callers that cannot await — rack modules build their
  // graph in a plain function call. A miss kicks off the decode once and returns
  // null; the next call finds it. Failures are remembered so a missing file is
  // not re-read on every frame.
  getBufferOrLoad(fileKey) {
    if (!fileKey) return null
    const buffer = _buffers.get(fileKey)
    if (buffer) return buffer
    if (!_requested.has(fileKey)) {
      _requested.add(fileKey)
      this.loadBuffer(fileKey).catch(err => {
        // Forget the failure so the next call retries. A patch mounted before
        // the project directory is set fails once; without this the key stays
        // poisoned and the sampler is silent for the rest of the session.
        _requested.delete(fileKey)
        _pending.delete(fileKey)
        console.warn('[AudioStore] load failed for', fileKey, err?.message)
      })
    }
    return null
  },

  getLod(fileKey, level) {
    const lods = _lods.get(fileKey)
    if (!lods) return null
    return lods[level] ?? null
  },

  isLodReady(fileKey) {
    return _lods.has(fileKey)
  },

  async waitForLod(fileKey) {
    if (this.isLodReady(fileKey)) return
    return new Promise(resolve => {
      const check = (id) => {
        if (id === fileKey) {
          _lodCallbacks.delete(check)
          resolve()
        }
      }
      _lodCallbacks.add(check)
    })
  },

  onLodReady(cb) {
    _lodCallbacks.add(cb)
    return () => _lodCallbacks.delete(cb)
  },

  unloadBuffer(fileKey) {
    _buffers.delete(fileKey)
    _lods.delete(fileKey)
    _pending.delete(fileKey)
    _requested.delete(fileKey)
  },

  reset() {
    _buffers.clear()
    _lods.clear()
    _pending.clear()
    _requested.clear()
    _lodCallbacks.clear()
    _projectDirHandle = null
    if (_worker) {
      _worker.terminate()
      _worker = null
    }
  },

  // Exposed for testing purposes
  _buffers,
  _lods
}

export default AudioStore
