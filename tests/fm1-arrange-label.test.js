// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { ArrangementView } from '../src/renderer/js/components/arrangement-view.js'

describe('arrangement strip label for an FM-1 track', () => {
  it('names the installed firmware (the installed list is injected), and Missing firmware otherwise', () => {
    globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} }
    HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => k in t ? t[k] : () => ({ addColorStop() {} }), set: (t, k, v) => { t[k] = v; return true } })
    const track = { id: 't1', type: 'midi', name: 'Lead', mixerChannelId: null, clips: [], instrument: { type: 'fm1', firmwareHash: 'sha256:aa' } }
    const state = { tracks: [track], bpm: 120, timeSignature: [4, 4], mixer: { channels: [] }, racks: {}, kits: {} }
    const store = { getState: () => state, subscribe: () => () => {}, dispatch() {} }
    let installed = [{ id: 'sha256:aa', name: 'felucca-1.8.4' }]
    const container = document.createElement('div')
    document.body.append(container)
    const view = new ArrangementView(container, { store, audioStore: new Proxy({}, { get: () => () => () => {} }), fm1Installed: () => installed })
    view.render()
    expect(container.querySelector('.track-instrument-chip').textContent).toBe('felucca-1.8.4')
    installed = []
    view.render()
    const chip = container.querySelector('.track-instrument-chip')
    expect(chip.textContent).toBe('Missing firmware')
    expect(chip.classList.contains('missing')).toBe(true)
  })
})
