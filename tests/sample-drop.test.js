import { describe, it, expect } from 'vitest'
import { checkSampleFile, padEndSec, slotCommands, samplePadsOf, MAX_FILE_BYTES } from '../src/renderer/js/pads/sample-drop.js'

describe('checkSampleFile', () => {
  it('accepts audio by mime or extension', () => {
    expect(checkSampleFile({ name: 'a.wav', size: 10, type: 'audio/wav' })).toEqual({ ok: true })
    expect(checkSampleFile({ name: 'a.FLAC', size: 10, type: '' })).toEqual({ ok: true })
  })
  it('rejects empty, oversize and non-audio with a reason', () => {
    expect(checkSampleFile(null).ok).toBe(false)
    expect(checkSampleFile({ name: 'a.wav', size: 0, type: 'audio/wav' })).toMatchObject({ ok: false, reason: 'Empty file' })
    expect(checkSampleFile({ name: 'a.wav', size: MAX_FILE_BYTES + 1, type: 'audio/wav' })).toMatchObject({ ok: false, reason: expect.stringContaining('25 MB') })
    expect(checkSampleFile({ name: 'a.txt', size: 10, type: 'text/plain' })).toMatchObject({ ok: false, reason: 'Not an audio file' })
    expect(checkSampleFile({ name: 'a.wav', size: MAX_FILE_BYTES, type: 'audio/wav' }).ok).toBe(true)
  })
})

describe('slot helpers', () => {
  it('padEndSec caps at 60 s', () => {
    expect(padEndSec(24000, 48000)).toBe(0.5)
    expect(padEndSec(48000 * 90, 48000)).toBe(60)
  })
  it('slotCommands seeds a code-only kit once, then one SetKitSlot per note', () => {
    const slots = { 36: { voice: 'sample' }, 37: { voice: 'sample' } }
    const cmds = slotCommands('default-909', { slots: {} }, false, slots)
    expect(cmds).toHaveLength(3)
    expect(slotCommands('default-909', { slots: {} }, true, slots)).toHaveLength(2)
  })
  it('samplePadsOf lists pad indexes of sample slots across banks', () => {
    const kit = { slots: { 36: { voice: 'bd' }, 37: { voice: 'sample' }, 51: { voice: 'sample' }, 52: { voice: 'sample' } } }
    expect([...samplePadsOf(kit)].sort((a, b) => a - b)).toEqual([1, 15])
    expect(samplePadsOf(null).size).toBe(0)
  })
})
