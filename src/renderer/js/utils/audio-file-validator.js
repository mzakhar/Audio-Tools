/**
 * audio-file-validator.js
 * Validates audio files by extension and magic bytes before decoding.
 */

/** Allowed audio file extensions (lowercase, without dot). */
export const ALLOWED_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'aiff', 'aif', 'm4a']

/** Maximum allowed file size in bytes (500 MB). */
export const MAX_FILE_BYTES = 500 * 1024 * 1024

/**
 * Detect the format of an audio file from its first 12 bytes.
 * @param {Uint8Array} header - first 12 bytes of the file
 * @returns {string|null} detected format key, or null if unrecognised
 */
export function detectFormat(header) {
  if (!header || header.length < 4) return null

  // WAV: RIFF????WAVE
  if (
    header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 && // 'RIFF'
    header.length >= 12 &&
    header[8] === 0x57 && header[9] === 0x41 && header[10] === 0x56 && header[11] === 0x45   // 'WAVE'
  ) {
    return 'wav'
  }

  // AIFF: FORM????AIFF or FORM????AIFC
  if (
    header[0] === 0x46 && header[1] === 0x4F && header[2] === 0x52 && header[3] === 0x4D && // 'FORM'
    header.length >= 12 && (
      (header[8] === 0x41 && header[9] === 0x49 && header[10] === 0x46 && header[11] === 0x46) || // 'AIFF'
      (header[8] === 0x41 && header[9] === 0x49 && header[10] === 0x46 && header[11] === 0x43)    // 'AIFC'
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

  // MP3: ID3 tag header
  if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
    return 'mp3'
  }

  // MP3: sync word variants (0xFF 0xFB, 0xFF 0xF3, 0xFF 0xF2)
  if (
    header[0] === 0xFF && (
      header[1] === 0xFB ||
      header[1] === 0xF3 ||
      header[1] === 0xF2
    )
  ) {
    return 'mp3'
  }

  // M4A/AAC: ????ftyp at bytes 4–7
  if (
    header.length >= 8 &&
    header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70 // 'ftyp'
  ) {
    return 'm4a'
  }

  return null
}

/**
 * Map a detected format to the set of extensions it is valid for.
 * @param {string} format
 * @returns {string[]}
 */
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

/**
 * Validate an audio file before decoding.
 * Checks: file size, extension whitelist, and magic-byte / extension consistency.
 *
 * @param {string} filename
 * @param {number} byteLength - total byte length of the file
 * @param {Uint8Array} header  - first 12 bytes of the file
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateAudioFile(filename, byteLength, header) {
  // 1. Size check
  if (byteLength > MAX_FILE_BYTES) {
    return { ok: false, error: 'File too large' }
  }

  // 2. Extension check
  const dotIdx = filename.lastIndexOf('.')
  const ext = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : ''
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `Unsupported file type: .${ext}` }
  }

  // 3. Magic byte check (requires at least 4 bytes; empty or very small files fail)
  if (!header || header.length < 4) {
    return { ok: false, error: 'File header does not match declared type' }
  }

  const detectedFormat = detectFormat(header)

  // If we cannot detect a format from the magic bytes the header does not match
  if (detectedFormat === null) {
    return { ok: false, error: 'File header does not match declared type' }
  }

  // Verify the detected format is consistent with the declared extension
  const validExts = _extensionsForFormat(detectedFormat)
  if (!validExts.includes(ext)) {
    return { ok: false, error: 'File header does not match declared type' }
  }

  return { ok: true }
}
