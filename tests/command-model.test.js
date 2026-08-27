import { describe, expect, it } from 'vitest'
import { commandItems } from '../src/renderer/js/ui/command-model.js'

function find(items, id) {
  return items.find(i => i.id === id)
}

describe('commandItems', () => {
  it('never throws on a partial object', () => {
    expect(() => commandItems({})).not.toThrow()
    expect(() => commandItems()).not.toThrow()
  })

  it('disables project-gated items with no project, enables with one', () => {
    const closed = commandItems({ projectOpen: false })
    expect(find(closed, 'bounce').enabled).toBe(false)
    expect(find(closed, 'save').enabled).toBe(false)
    expect(find(closed, 'import-audio').enabled).toBe(false)
    expect(find(closed, 'add-midi-track').enabled).toBe(false)

    const open = commandItems({ projectOpen: true })
    expect(find(open, 'bounce').enabled).toBe(true)
    expect(find(open, 'save').enabled).toBe(true)
    expect(find(open, 'import-audio').enabled).toBe(true)
    expect(find(open, 'add-midi-track').enabled).toBe(true)
  })

  it('disables play only on the 909 view, which owns its own transport', () => {
    expect(find(commandItems({ mode: 'tr909' }), 'play').enabled).toBe(false)
    expect(find(commandItems({ mode: 'synth' }), 'play').enabled).toBe(true)
    expect(find(commandItems({ mode: 'arrange' }), 'play').enabled).toBe(true)
    expect(find(commandItems({ mode: 'rack' }), 'play').enabled).toBe(true)
  })

  it('shows add-track only in arrange', () => {
    expect(find(commandItems({ mode: 'arrange' }), 'add-track').visible).toBe(true)
    expect(find(commandItems({ mode: 'synth' }), 'add-track').visible).toBe(false)
  })

  it('hides the midi token with no input, shows it with the device name as label', () => {
    expect(find(commandItems({ midiInput: null }), 'midi-token').visible).toBe(false)
    const withInput = commandItems({ midiInput: 'K25' })
    expect(find(withInput, 'midi-token').visible).toBe(true)
    expect(find(withInput, 'midi-token').label).toBe('K25')
  })

  it('labels record by mode and recording state', () => {
    expect(find(commandItems({ mode: 'arrange' }), 'record').label).toBe('Record MIDI')
    expect(find(commandItems({ mode: 'synth' }), 'record').label).toBe('Record audio')
    expect(find(commandItems({ mode: 'synth', recording: true }), 'record').label).toBe('Stop recording')
  })

  it('mixer only visible in arrange', () => {
    expect(find(commandItems({ mode: 'arrange' }), 'mixer').visible).toBe(true)
    expect(find(commandItems({ mode: 'synth' }), 'mixer').visible).toBe(false)
  })
})
