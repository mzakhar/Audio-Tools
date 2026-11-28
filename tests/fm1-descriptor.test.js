import { describe, it, expect } from 'vitest'
import { fm1Descriptor, fm1InstrumentFor, bendBytes, modBytes, slowWarning, failureText } from '../src/renderer/js/fm1/descriptor.js'
import { ENCODERS, BUTTONS, KEYS, POT, boxStyle } from '../src/renderer/js/fm1/panel-layout.js'

describe('fm1 descriptor', () => {
  it('applies defaults and clamps', () => {
    expect(fm1Descriptor({ type: 'fm1', firmwareHash: 'sha256:a' })).toEqual({ type: 'fm1', firmwareHash: 'sha256:a', deviceChannel: 0, mhz: 120 })
    expect(fm1Descriptor({ firmwareHash: 'x', deviceChannel: 99, mhz: 5 })).toMatchObject({ deviceChannel: 15, mhz: 60 })
    expect(fm1Descriptor({ firmwareHash: 'x', deviceChannel: 'nope', mhz: 1000 })).toMatchObject({ deviceChannel: 0, mhz: 240 })
  })
  it('keeps unrelated instrument keys when building from a firmware record', () => {
    expect(fm1InstrumentFor({ id: 'sha256:b' }, { bendRange: 5 })).toEqual({ bendRange: 5, type: 'fm1', firmwareHash: 'sha256:b', deviceChannel: 0, mhz: 120 })
  })
})

describe('fm1 midi bytes', () => {
  it('centres pitch bend at 8192 and spans the 14-bit range on the device channel', () => {
    expect(bendBytes(3, 0)).toEqual([0xE3, 0, 64])
    expect(bendBytes(0, 1)).toEqual([0xE0, 127, 127])
    expect(bendBytes(0, -1)).toEqual([0xE0, 1, 0])
    expect(bendBytes(0, 9)).toEqual([0xE0, 127, 127])
  })
  it('sends the mod wheel as CC1', () => {
    expect(modBytes(2, 0.5)).toEqual([0xB2, 1, 64])
    expect(modBytes(0, 2)).toEqual([0xB0, 1, 127])
  })
})

describe('slow warnings', () => {
  it('warns under minMhz and on a too-slow note, not otherwise', () => {
    expect(slowWarning(100, { minMhz: 120 })).toMatch(/120 MHz/)
    expect(slowWarning(120, { minMhz: 120 })).toBeNull()
    expect(slowWarning(240, { minMhz: null, note: 'RTF 0.54; too slow live on reference PC' })).toMatch(/too slow/)
    expect(slowWarning(120, null)).toBeNull()
  })
  it('names every engine failure reason', () => {
    for (const reason of ['missing-firmware', 'boot-failed', 'wasm-failed', 'halted']) expect(failureText(reason)).not.toMatch(/failed \(/)
  })
})

describe('panel layout', () => {
  it('has 7 encoders, 14 buttons, 27 keys with unique matrix ids 0..40', () => {
    expect(ENCODERS).toHaveLength(7)
    expect(new Set(ENCODERS.map(e => e.enc))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]))
    expect(BUTTONS).toHaveLength(14)
    expect(KEYS).toHaveLength(27)
    expect(KEYS.filter(k => k.black)).toHaveLength(11)
    const ids = [...BUTTONS, ...KEYS].map(c => c.id).sort((a, b) => a - b)
    expect(ids).toEqual([...Array(41).keys()])
    expect(POT.max).toBe(1023)
  })
  it('names keys by pitch: id 14 is F3, id 21 is C4, id 40 is G5', () => {
    const name = id => KEYS.find(k => k.id === id).label
    expect([name(14), name(21), name(40), name(15)]).toEqual(['F3', 'C4', 'G5', 'F#3'])
  })
  it('places every control inside the panel', () => {
    for (const shape of [...ENCODERS, POT, ...BUTTONS, ...KEYS]) {
      const box = boxStyle(shape)
      for (const value of Object.values(box)) expect(parseFloat(value)).toBeGreaterThanOrEqual(0)
      expect(parseFloat(box.left) + parseFloat(box.width)).toBeLessThanOrEqual(100.01)
      expect(parseFloat(box.top) + parseFloat(box.height)).toBeLessThanOrEqual(100.01)
    }
  })
})
