/**
 * decode-worker.js
 * Validation + format-detection worker for audio files.
 *
 * The actual decoding stays on the main thread via AudioContext.decodeAudioData()
 * (Chromium/Electron supports WAV, MP3, FLAC, OGG, M4A natively).
 * This worker validates the file off the main thread to avoid blocking.
 *
 * Message in:
 *   { type: 'validate', buffer: ArrayBuffer, filename: string }
 *
 * Message out:
 *   { type: 'validated', ok: boolean, error?: string, format?: string }
 */

// ─── Inline validation logic (no imports in plain Workers) ───────────────────

const ALLOWED_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'aiff', 'aif', 'm4a']
const MAX_FILE_BYTES = 500 * 1024 * 1024

/**
 * Detect the audio format from the first 12 bytes of a file.
 * @param {Uint8Array} header
 * @returns {string|null}
 */
function detectFormat(header) {
  if (!header || header.length < 4) return null

  // WAV: RIFF????WAVE
  if (
    header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
    header.length >= 12 &&
    header[8] === 0x57 && header[9] === 0x41 && header[10] === 0x56 && header[11] === 0x45
  ) {
    return 'wav'
  }

  // AIFF: FORM????AIFF or FORM????AIFC
  if (
    header[0] === 0x46 && header[1] === 0x4F && header[2] === 0x52 && header[3] === 0x4D &&
    header.length >= 12 && (
      (header[8] === 0x41 && header[9] === 0x49 && header[10] === 0x46 && header[11] === 0x46) ||
      (header[8] === 0x41 && header[9] === 0x49 && header[10] === 0x46 && header[11] === 0x43)
    )
  ) {
    return 'aiff'
  }

  // FLAC: fLaC
  if (
    header[0] === 0x66 && header[1] === 0x4C && header[2] === 0x61 && header[3] === 0x43
  ) {
    return 'flac'
  }

  // OGG: OggS
  if (
    header[0] === 0x4F && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53
  ) {
    return 'ogg'
  }

  // MP3: ID3 tag
  if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
    return 'mp3'
  }

  // MP3: sync word
  if (
    header[0] === 0xFF && (
      header[1] === 0xFB ||
      header[1] === 0xF3 ||
      header[1] === 0xF2
    )
  ) {
    return 'mp3'
  }

  // M4A: ????ftyp
  if (
    header.length >= 8 &&
    header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70
  ) {
    return 'm4a'
  }

  return null
}

function _extensionsForFormat(format) {
  switch (format) {
    case 'wav':  return ['wav']
    case 'mp3':  return ['mp3']
    case 'flac': return ['flac']
    case 'ogg':  return ['ogg']
    case 'aiff': return ['aiff', 'aif']
    case 'm4a':  return ['m4a']
    default:     return []
  }
}

function validateAudioFile(filename, byteLength, header) {
  if (byteLength > MAX_FILE_BYTES) {
    return { ok: false, error: 'File too large' }
  }

  const dotIdx = filename.lastIndexOf('.')
  const ext = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : ''
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `Unsupported file type: .${ext}` }
  }

  if (!header || header.length < 4) {
    return { ok: false, error: 'File header does not match declared type' }
  }

  const detectedFormat = detectFormat(header)
  if (detectedFormat === null) {
    return { ok: false, error: 'File header does not match declared type' }
  }

  const validExts = _extensionsForFormat(detectedFormat)
  if (!validExts.includes(ext)) {
    return { ok: false, error: 'File header does not match declared type' }
  }

  return { ok: true }
}

// ─── Worker message handler ───────────────────────────────────────────────────

self.onmessage = async (e) => {
  if (e.data.type === 'validate') {
    const { buffer, filename } = e.data
    const header = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength))
    const result = validateAudioFile(filename, buffer.byteLength, header)
    const format = result.ok ? detectFormat(header) : undefined
    self.postMessage({ type: 'validated', ...result, format })
  }
}
