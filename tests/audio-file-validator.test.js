import { describe, it, expect } from 'vitest'
import {
  validateAudioFile,
  detectFormat,
  ALLOWED_EXTENSIONS,
  MAX_FILE_BYTES,
} from '../src/renderer/js/utils/audio-file-validator.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a 12-byte Uint8Array with specific bytes set. */
function makeHeader(bytes) {
  const h = new Uint8Array(12)
  bytes.forEach((b, i) => { h[i] = b })
  return h
}

const WAV_HEADER = makeHeader([
  0x52, 0x49, 0x46, 0x46, // 'RIFF'
  0x00, 0x00, 0x00, 0x00, // chunk size (don't care)
  0x57, 0x41, 0x56, 0x45, // 'WAVE'
])

const MP3_ID3_HEADER = makeHeader([
  0x49, 0x44, 0x33, // 'ID3'
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

const MP3_SYNC_FB_HEADER = makeHeader([
  0xFF, 0xFB, 0x90, 0x00, // sync word 0xFF 0xFB
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

const MP3_SYNC_F3_HEADER = makeHeader([
  0xFF, 0xF3, 0x90, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

const MP3_SYNC_F2_HEADER = makeHeader([
  0xFF, 0xF2, 0x90, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

const FLAC_HEADER = makeHeader([
  0x66, 0x4C, 0x61, 0x43, // 'fLaC'
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

const OGG_HEADER = makeHeader([
  0x4F, 0x67, 0x67, 0x53, // 'OggS'
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

const AIFF_HEADER = makeHeader([
  0x46, 0x4F, 0x52, 0x4D, // 'FORM'
  0x00, 0x00, 0x00, 0x00, // chunk size
  0x41, 0x49, 0x46, 0x46, // 'AIFF'
])

const AIFC_HEADER = makeHeader([
  0x46, 0x4F, 0x52, 0x4D, // 'FORM'
  0x00, 0x00, 0x00, 0x00,
  0x41, 0x49, 0x46, 0x43, // 'AIFC'
])

const M4A_HEADER = makeHeader([
  0x00, 0x00, 0x00, 0x20, // box size
  0x66, 0x74, 0x79, 0x70, // 'ftyp'
  0x4D, 0x34, 0x41, 0x20, // 'M4A '
])

const NORMAL_SIZE = 1024 * 1024 // 1 MB — well within limit

// ─── ALLOWED_EXTENSIONS / MAX_FILE_BYTES exports ─────────────────────────────

describe('exports', () => {
  it('ALLOWED_EXTENSIONS contains expected formats', () => {
    expect(ALLOWED_EXTENSIONS).toContain('wav')
    expect(ALLOWED_EXTENSIONS).toContain('mp3')
    expect(ALLOWED_EXTENSIONS).toContain('flac')
    expect(ALLOWED_EXTENSIONS).toContain('ogg')
    expect(ALLOWED_EXTENSIONS).toContain('aiff')
    expect(ALLOWED_EXTENSIONS).toContain('aif')
    expect(ALLOWED_EXTENSIONS).toContain('m4a')
  })

  it('MAX_FILE_BYTES equals 500 MB', () => {
    expect(MAX_FILE_BYTES).toBe(500 * 1024 * 1024)
  })
})

// ─── detectFormat ─────────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('detects WAV', () => expect(detectFormat(WAV_HEADER)).toBe('wav'))
  it('detects FLAC', () => expect(detectFormat(FLAC_HEADER)).toBe('flac'))
  it('detects OGG', () => expect(detectFormat(OGG_HEADER)).toBe('ogg'))
  it('detects MP3 via ID3', () => expect(detectFormat(MP3_ID3_HEADER)).toBe('mp3'))
  it('detects MP3 via sync 0xFF 0xFB', () => expect(detectFormat(MP3_SYNC_FB_HEADER)).toBe('mp3'))
  it('detects MP3 via sync 0xFF 0xF3', () => expect(detectFormat(MP3_SYNC_F3_HEADER)).toBe('mp3'))
  it('detects MP3 via sync 0xFF 0xF2', () => expect(detectFormat(MP3_SYNC_F2_HEADER)).toBe('mp3'))
  it('detects AIFF', () => expect(detectFormat(AIFF_HEADER)).toBe('aiff'))
  it('detects AIFC', () => expect(detectFormat(AIFC_HEADER)).toBe('aiff'))
  it('detects M4A', () => expect(detectFormat(M4A_HEADER)).toBe('m4a'))
  it('returns null for unknown bytes', () => expect(detectFormat(new Uint8Array(12))).toBeNull())
  it('returns null for header shorter than 4 bytes', () => expect(detectFormat(new Uint8Array(2))).toBeNull())
})

// ─── validateAudioFile ────────────────────────────────────────────────────────

describe('validateAudioFile — valid files', () => {
  it('valid WAV returns { ok: true }', () => {
    const result = validateAudioFile('sample.wav', NORMAL_SIZE, WAV_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid MP3 with ID3 header returns { ok: true }', () => {
    const result = validateAudioFile('track.mp3', NORMAL_SIZE, MP3_ID3_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid MP3 with sync word 0xFF 0xFB returns { ok: true }', () => {
    const result = validateAudioFile('track.mp3', NORMAL_SIZE, MP3_SYNC_FB_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid MP3 with sync word 0xFF 0xF3 returns { ok: true }', () => {
    const result = validateAudioFile('track.mp3', NORMAL_SIZE, MP3_SYNC_F3_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid MP3 with sync word 0xFF 0xF2 returns { ok: true }', () => {
    const result = validateAudioFile('track.mp3', NORMAL_SIZE, MP3_SYNC_F2_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid FLAC returns { ok: true }', () => {
    const result = validateAudioFile('song.flac', NORMAL_SIZE, FLAC_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid OGG returns { ok: true }', () => {
    const result = validateAudioFile('audio.ogg', NORMAL_SIZE, OGG_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid AIFF returns { ok: true }', () => {
    const result = validateAudioFile('file.aiff', NORMAL_SIZE, AIFF_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid AIF (short extension) returns { ok: true }', () => {
    const result = validateAudioFile('file.aif', NORMAL_SIZE, AIFF_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid AIFC returns { ok: true }', () => {
    const result = validateAudioFile('file.aiff', NORMAL_SIZE, AIFC_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('valid M4A returns { ok: true }', () => {
    const result = validateAudioFile('audio.m4a', NORMAL_SIZE, M4A_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('extension matching is case-insensitive', () => {
    const result = validateAudioFile('TRACK.MP3', NORMAL_SIZE, MP3_ID3_HEADER)
    expect(result).toEqual({ ok: true })
  })
})

describe('validateAudioFile — size limit', () => {
  it('file exactly at MAX_FILE_BYTES passes', () => {
    const result = validateAudioFile('sample.wav', MAX_FILE_BYTES, WAV_HEADER)
    expect(result).toEqual({ ok: true })
  })

  it('file one byte over MAX_FILE_BYTES fails with "File too large"', () => {
    const result = validateAudioFile('sample.wav', MAX_FILE_BYTES + 1, WAV_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('File too large')
  })

  it('very large file fails with "File too large"', () => {
    const result = validateAudioFile('big.mp3', MAX_FILE_BYTES * 2, MP3_ID3_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('File too large')
  })
})

describe('validateAudioFile — unsupported extension', () => {
  it('unsupported extension .xyz returns error with extension name', () => {
    const result = validateAudioFile('audio.xyz', NORMAL_SIZE, WAV_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Unsupported file type: .xyz')
  })

  it('unsupported extension .txt returns appropriate error', () => {
    const result = validateAudioFile('notes.txt', NORMAL_SIZE, WAV_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('.txt')
  })

  it('no extension at all returns unsupported error', () => {
    const result = validateAudioFile('audiofile', NORMAL_SIZE, WAV_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unsupported file type')
  })
})

describe('validateAudioFile — magic byte mismatch', () => {
  it('.wav extension with FLAC magic bytes returns mismatch error', () => {
    const result = validateAudioFile('fake.wav', NORMAL_SIZE, FLAC_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('File header does not match declared type')
  })

  it('.mp3 extension with WAV magic bytes returns mismatch error', () => {
    const result = validateAudioFile('fake.mp3', NORMAL_SIZE, WAV_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('File header does not match declared type')
  })

  it('.flac extension with OGG magic bytes returns mismatch error', () => {
    const result = validateAudioFile('fake.flac', NORMAL_SIZE, OGG_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('File header does not match declared type')
  })

  it('.ogg extension with MP3 magic bytes returns mismatch error', () => {
    const result = validateAudioFile('fake.ogg', NORMAL_SIZE, MP3_ID3_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('File header does not match declared type')
  })

  it('unrecognised magic bytes with valid extension returns mismatch error', () => {
    const unknownHeader = makeHeader([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
    const result = validateAudioFile('audio.wav', NORMAL_SIZE, unknownHeader)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('File header does not match declared type')
  })
})

describe('validateAudioFile — empty / tiny files', () => {
  it('empty file (0 bytes) fails', () => {
    const result = validateAudioFile('empty.wav', 0, new Uint8Array(0))
    expect(result.ok).toBe(false)
  })

  it('file with only 3 bytes fails (header too short to detect)', () => {
    const result = validateAudioFile('tiny.mp3', 3, new Uint8Array(3))
    expect(result.ok).toBe(false)
  })
})

describe('validateAudioFile — error priority', () => {
  it('size check takes priority over extension check', () => {
    // Too large AND bad extension — should report "File too large"
    const result = validateAudioFile('huge.xyz', MAX_FILE_BYTES + 1, WAV_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('File too large')
  })

  it('extension check takes priority over magic-byte check', () => {
    // Good size but bad extension — should report extension error, not header mismatch
    const result = validateAudioFile('audio.xyz', NORMAL_SIZE, WAV_HEADER)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unsupported file type')
  })
})
