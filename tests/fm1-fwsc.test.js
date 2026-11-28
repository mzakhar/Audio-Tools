import { describe, it, expect } from 'vitest'
import { parseFwsc, MIN_PACKAGE, MAX_PACKAGE } from '../src/renderer/js/fm1/fwsc.js'
import { buildFwsc } from './helpers/fwsc-builder.js'

const reason = opts => parseFwsc(buildFwsc(opts).bytes).reason

describe('parseFwsc', () => {
  it('accepts a valid synthetic package', () => {
    const { bytes, appBin } = buildFwsc()
    expect(parseFwsc(bytes)).toEqual({
      ok: true, identity: 'FM-1_918', target: 'FM-1', product: '918', size: bytes.length, blocks: 20, appBinSize: appBin.length
    })
  })

  it('handles an unaligned app area and big app.bin', () => {
    const { bytes, appBin } = buildFwsc({ areaOffset: 260, appLength: 3000 })
    expect(parseFwsc(bytes)).toMatchObject({ ok: true, appBinSize: appBin.length })
  })

  it('reads the product from the identity', () => {
    expect(parseFwsc(buildFwsc({ identity: 'FM-1_015' }).bytes)).toMatchObject({ target: 'FM-1', product: '015' })
  })

  it('rejects by size', () => {
    expect(parseFwsc(new Uint8Array(MIN_PACKAGE - 1)).reason).toBe('too-small')
    expect(parseFwsc(new Uint8Array(MAX_PACKAGE + 1)).reason).toBe('too-large')
    expect(parseFwsc(new Uint8Array(0)).reason).toBe('too-small')
    for (const bad of [null, undefined, 5, 'x'.repeat(2000), [1, 2, 3], { length: 5e9 }]) expect(parseFwsc(bad)).toEqual({ ok: false, reason: 'bad-header' })
  })

  it('rejects each malformed shape with its reason', () => {
    expect(reason({ corruptCrc: true })).toBe('bad-header')
    expect(parseFwsc(new Uint8Array(2000)).reason).toBe('bad-header')
    expect(reason({ omitFlash: true })).toBe('no-flash-image')
    expect(reason({ truncate: 1100 })).toBe('truncated')
    expect(reason({ omitArea: true })).toBe('no-app-area')
    expect(reason({ omitConfig: true })).toBe('no-app-area')
    expect(reason({ omitAppBin: true })).toBe('no-app-bin')
  })

  it('rejects other targets as unsupported', () => {
    expect(reason({ identity: 'SMK-37 Pro_016' })).toBe('unsupported-target')
    expect(reason({ identity: 'XYZ_001' })).toBe('unsupported-target')
    expect(parseFwsc(buildFwsc({ identity: 'SMK-37 Pro_016' }).bytes)).toEqual({ ok: false, reason: 'unsupported-target', identity: 'SMK-37 Pro_016' })
  })

  it('fuzz: random bytes and mutated valid packages never throw', () => {
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 500; i++) {
      const b = new Uint8Array(Math.floor(rnd() * 3000)).map(() => Math.floor(rnd() * 256))
      expect(() => parseFwsc(b)).not.toThrow()
    }
    const { bytes } = buildFwsc({ appLength: 400 })
    for (let i = 0; i < 500; i++) {
      const m = bytes.slice()
      for (let k = 0, n = 1 + Math.floor(rnd() * 6); k < n; k++) m[Math.floor(rnd() * (rnd() < 0.5 ? 1100 : m.length))] = Math.floor(rnd() * 256)
      const r = parseFwsc(rnd() < 0.2 ? m.slice(0, Math.floor(rnd() * m.length)) : m)
      expect(typeof r.ok).toBe('boolean')
    }
  })
})
