import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MixerStrip } from '../src/renderer/js/components/mixer-strip.js'

function makeChannel(overrides = {}) {
  return { id: 'ch-1', trackId: 'track-1', volume: 0.8, pan: 0.0, mute: false, solo: false, ...overrides }
}
function makeTrack(overrides = {}) {
  return { id: 'track-1', name: 'Drums', type: 'audio', clips: [], ...overrides }
}

describe('MixerStrip', () => {
  let container

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('appends a child element to container', () => {
    const onParam = vi.fn()
    new MixerStrip(container, { channel: makeChannel(), track: makeTrack(), onParam })
    expect(container.children.length).toBe(1)
  })

  it('fader value input triggers onParam with volume', () => {
    const onParam = vi.fn()
    new MixerStrip(container, { channel: makeChannel(), track: makeTrack(), onParam })
    const fader = container.querySelector('.mixer-fader')
    fader.value = '0.5'
    fader.dispatchEvent(new Event('input'))
    expect(onParam).toHaveBeenCalledWith('ch-1', 'volume', 0.5)
  })

  it('pan knob input triggers onParam with pan', () => {
    const onParam = vi.fn()
    new MixerStrip(container, { channel: makeChannel(), track: makeTrack(), onParam })
    const pan = container.querySelector('.mixer-pan')
    pan.value = '-0.5'
    pan.dispatchEvent(new Event('input'))
    expect(onParam).toHaveBeenCalledWith('ch-1', 'pan', -0.5)
  })

  it('mute button click triggers onParam toggling mute', () => {
    const onParam = vi.fn()
    new MixerStrip(container, { channel: makeChannel({ mute: false }), track: makeTrack(), onParam })
    const muteBtn = container.querySelector('.mute-btn')
    muteBtn.click()
    expect(onParam).toHaveBeenCalledWith('ch-1', 'mute', true)
  })

  it('update() syncs fader value', () => {
    const onParam = vi.fn()
    const strip = new MixerStrip(container, { channel: makeChannel({ volume: 0.8 }), track: makeTrack(), onParam })
    strip.update(makeChannel({ volume: 0.3 }), makeTrack())
    const fader = container.querySelector('.mixer-fader')
    expect(parseFloat(fader.value)).toBeCloseTo(0.3, 5)
  })

  it('destroy() removes element from DOM', () => {
    const strip = new MixerStrip(container, { channel: makeChannel(), track: makeTrack(), onParam: vi.fn() })
    strip.destroy()
    expect(container.children.length).toBe(0)
  })
})
