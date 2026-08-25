import { describe, expect, it } from 'vitest'
import { compilePackManifest, patchAddressKey, resolvePatch, validatePackManifest } from '../src/renderer/js/instruments/pack-registry.js'

const piano = { id: 'piano', name: 'Piano', kind: 'sample', address: { bankMsb: 0, bankLsb: 0, program: 0 }, zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'piano-c4' }] }
const kit = { id: 'kit', name: 'Kit', kind: 'drum-kit', channelProfile: 'gm-percussion', address: { bankMsb: 0, bankLsb: 0, program: 0 } }

function manifest(overrides = {}) {
  return { schemaVersion: 1, id: 'test-pack', version: '1.0.0', name: 'Test Pack', license: { spdx: 'MIT', noticeFile: 'NOTICE.txt' }, patches: [piano, kit], defaultPatchId: 'piano', defaultDrumPatchId: 'kit', ...overrides }
}

describe('pack registry', () => {
  it('validates and indexes patches by MIDI address and profile', () => {
    const pack = compilePackManifest(manifest())
    expect(pack.byAddress.get('0:0:0:')).toBe(piano)
    expect(pack.byAddress.get('0:0:0:gm-percussion')).toBe(kit)
    expect(patchAddressKey({ bankMsb: 0, bankLsb: 2, program: 127 })).toBe('0:2:127:')
  })

  it('rejects bad MIDI addresses, duplicate profile addresses, and invalid zones', () => {
    const bad = manifest({ patches: [piano, { ...piano, id: 'second', address: { bankMsb: 128, bankLsb: 0, program: 0 } }, { ...piano, id: 'third', zones: [{ keyLo: 70, keyHi: 60, rootKey: 60, sampleId: 'x' }] }] })
    const result = validatePackManifest(bad)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('address')
    expect(result.errors.join(' ')).toContain('zone')
  })

  it('rejects duplicate address/profile pairs while allowing melodic and percussion variants', () => {
    expect(validatePackManifest(manifest({ patches: [piano, kit, { ...piano, id: 'duplicate' }] })).ok).toBe(false)
    expect(validatePackManifest(manifest()).ok).toBe(true)
  })

  it('prefers percussion on MIDI channel ten and melodic elsewhere', () => {
    const pack = compilePackManifest(manifest())
    const address = { bankMsb: 0, bankLsb: 0, program: 0 }
    expect(resolvePatch(pack, address, { channel: 9 })).toMatchObject({ patch: kit, source: 'exact', selection: { packId: 'test-pack', packVersion: '1.0.0', patchId: 'kit', program: 0 } })
    expect(resolvePatch(pack, address, { channel: 0 })).toMatchObject({ patch: piano, source: 'exact', selection: { patchId: 'piano' } })
  })

  it('uses the appropriate default only after an exact address misses', () => {
    const pack = compilePackManifest(manifest())
    const missing = { bankMsb: 2, bankLsb: 3, program: 4 }
    expect(resolvePatch(pack, missing, { channel: 0 })).toMatchObject({ patch: piano, source: 'default', selection: { patchId: 'piano', bankMsb: 2, bankLsb: 3, program: 4 } })
    expect(resolvePatch(pack, missing, { channel: 9 })).toMatchObject({ patch: kit, source: 'default' })
    expect(resolvePatch(compilePackManifest(manifest({ defaultPatchId: undefined, defaultDrumPatchId: undefined })), missing)).toMatchObject({ patch: null, source: 'unresolved', selection: { patchId: null, unresolved: true } })
  })
})
