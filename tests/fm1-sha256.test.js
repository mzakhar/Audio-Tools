import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { sha256Hex } from '../src/renderer/js/fm1/sha256.js'

const enc = s => new TextEncoder().encode(s)

describe('sha256Hex', () => {
  it('matches NIST vectors', () => {
    expect(sha256Hex(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    expect(sha256Hex(new Uint8Array(1_000_000).fill(97)))
      .toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })

  it('matches node:crypto on random buffers of every padding boundary', () => {
    for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 65537]) {
      const b = randomBytes(n)
      expect(sha256Hex(b)).toBe(createHash('sha256').update(b).digest('hex'))
    }
  })

  it('accepts an ArrayBuffer', () => {
    expect(sha256Hex(enc('abc').buffer)).toBe(sha256Hex(enc('abc')))
  })
})
