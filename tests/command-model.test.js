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

  it('record (header ●) is MIDI record, enabled only in arrange', () => {
    expect(find(commandItems({ mode: 'arrange' }), 'record')).toMatchObject({ label: 'Record MIDI', enabled: true, group: 'transport' })
    expect(find(commandItems({ mode: 'synth' }), 'record').enabled).toBe(false)
    expect(find(commandItems({ mode: 'pads' }), 'record').enabled).toBe(false)
    expect(find(commandItems({ mode: 'arrange', recording: true }), 'record').label).toBe('Stop recording')
  })

  it('record-master is a setup toggle whose label reads the way out', () => {
    expect(find(commandItems({}), 'record-master')).toMatchObject({ label: 'Record master to WAV…', group: 'setup', enabled: true, visible: true })
    expect(find(commandItems({ masterRecording: true }), 'record-master').label).toBe('Stop master recording')
  })

  it('gates import-pack on a host that can import, enabled by default', () => {
    expect(find(commandItems({}), 'import-pack').enabled).toBe(true)
    // Either backend counts: Electron IPC or browser IndexedDB storage.
    expect(find(commandItems({ canImportPacks: true }), 'import-pack').enabled).toBe(true)
    expect(find(commandItems({ canImportPacks: false }), 'import-pack').enabled).toBe(false)
  })

  it('mixer only visible in arrange', () => {
    expect(find(commandItems({ mode: 'arrange' }), 'mixer').visible).toBe(true)
    expect(find(commandItems({ mode: 'synth' }), 'mixer').visible).toBe(false)
  })
})

it('lists Lessons in setup, always visible', () => {
  const item = commandItems({}).find(i => i.id === 'lessons')
  expect(item).toMatchObject({ group: 'setup', enabled: true, visible: true })
})

it('fm1-record needs an open project and an armed FM-1 track', () => {
  const find = opts => commandItems(opts).find(i => i.id === 'fm1-record')
  expect(find({ projectOpen: true, fm1Armed: true })).toMatchObject({ label: 'Record FM-1 to audio track…', group: 'setup', enabled: true, visible: true })
  expect(find({ projectOpen: true, fm1Armed: false }).enabled).toBe(false)
  expect(find({ projectOpen: false, fm1Armed: true }).enabled).toBe(false)
})
