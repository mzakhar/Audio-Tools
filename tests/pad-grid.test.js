import { describe, expect, it, beforeEach, vi } from 'vitest'
import { PadGrid } from '../src/renderer/js/components/pad-grid.js'
import { padBank, padToNote, PALETTE_DRUM_NOTES } from '../src/renderer/js/instruments/pad-map.js'

function mount(deps = {}) {
  document.body.innerHTML = '<div id="pads"></div><div id="banks"></div>'
  const onPad = vi.fn()
  const grid = new PadGrid(document.getElementById('pads'), {
    bankEl: document.getElementById('banks'),
    onPad,
    ...deps
  })
  return { grid, onPad, container: document.getElementById('pads') }
}

const press = el => el.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }))
const lift  = el => el.dispatchEvent(new window.Event('pointerup', { bubbles: true, cancelable: true }))

describe('PadGrid', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('renders eight pads for the current bank', () => {
    const { container } = mount()
    expect(container.querySelectorAll('.drum-pad')).toHaveLength(8)
    expect(container.dataset.bank).toBe('A')
  })

  it('a press sends the note pad-map assigns to that slot, for both banks', () => {
    const { grid, onPad, container } = mount()
    for (const bank of ['A', 'B']) {
      grid.setBank(bank)
      for (const pad of padBank(bank)) {
        onPad.mockClear()
        const el = container.querySelector(`.drum-pad[data-slot="${pad.slot}"]`)
        press(el)
        expect(onPad).toHaveBeenCalledWith(padToNote(bank, pad.slot), true)
        lift(el)
        expect(onPad).toHaveBeenLastCalledWith(padToNote(bank, pad.slot), false)
      }
    }
  })

  it('bank B is eight different notes from bank A', () => {
    const a = padBank('A').map(pad => pad.note)
    const b = padBank('B').map(pad => pad.note)
    expect(new Set([...a, ...b]).size).toBe(16)
  })

  it('marks the toggle with aria-pressed', () => {
    const { grid } = mount()
    const [a, b] = document.getElementById('banks').querySelectorAll('.pad-bank')
    expect(a.getAttribute('aria-pressed')).toBe('true')
    grid.setBank('B')
    const [a2, b2] = document.getElementById('banks').querySelectorAll('.pad-bank')
    expect(a2.getAttribute('aria-pressed')).toBe('false')
    expect(b2.getAttribute('aria-pressed')).toBe('true')
    void b
  })

  it('renders a pad the instrument cannot play as unlit and dead', () => {
    // The internal drum palette only answers to the four mapped GM notes.
    const { onPad, container } = mount({ isPlayable: note => PALETTE_DRUM_NOTES[note] !== undefined })
    const dead = [...container.querySelectorAll('.drum-pad')].filter(el => el.disabled)
    expect(dead.length).toBe(8 - padBank('A').filter(pad => PALETTE_DRUM_NOTES[pad.note] !== undefined).length)
    press(dead[0])
    expect(onPad).not.toHaveBeenCalled()
  })

  it('trigger() presses the numbered slot of the current bank', () => {
    const { grid, onPad } = mount()
    grid.setBank('B')
    grid.trigger(3)
    expect(onPad).toHaveBeenCalledWith(padToNote('B', 3), true)
  })

  it('a pointerup anywhere releases a held pad', () => {
    const { onPad, container } = mount()
    press(container.querySelector('.drum-pad[data-slot="1"]'))
    window.dispatchEvent(new window.Event('pointerup'))
    expect(onPad).toHaveBeenLastCalledWith(padToNote('A', 1), false)
  })
})
