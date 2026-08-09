// KEYS — an on-panel piano wired straight into the poly note path. Same voice
// allocation as MIDI IN, just played with the mouse/PC keyboard instead of a
// host device.

import midiIn from './midi-in.js'
import { keyLayout, KEY_MAP } from '../../key-layout.js'

export default {
  type: 'keys',
  name: 'KEYS',
  group: 'io',
  hp: 28,
  tier: 'native',
  poly: true,
  polySource: mod => mod.params?.voices ?? 4,
  ports: [
    { id: 'v_oct', dir: 'out', kind: 'cv', label: 'V/OCT' },
    { id: 'gate', dir: 'out', kind: 'gate', label: 'GATE' },
    { id: 'vel', dir: 'out', kind: 'cv', label: 'VEL' }
  ],
  params: [
    { key: 'voices', label: 'VOICES', min: 1, max: 8, step: 1, def: 4, fmt: '' },
    { key: 'octave', label: 'OCTAVE', min: -2, max: 2, step: 1, def: 0, fmt: '' },
    { key: 'glide', label: 'GLIDE', min: 0, max: 2, step: 0.01, def: 0, fmt: 's' }
  ],

  // MIDI IN's create() is the allocation path — KEYS is the same voice source
  // with a keyboard on the front instead of a host device. Its extra `mod`/`pb`
  // ConstantSources are undeclared here (no mod wheel or pitch bend on-panel)
  // and simply idle; dispose() already stops and disconnects them.
  create: midiIn.create,

  panel(module, { sendEvent, params }) {
    const L = keyLayout({ whiteW: 28, whiteH: 72, blackW: 18, blackH: 44 })
    const wrapper = document.createElement('div')
    wrapper.className = 'rack-keys'
    wrapper.tabIndex = 0
    wrapper.style.position = 'relative'
    wrapper.style.width = L.width + 'px'
    wrapper.style.height = L.height + 'px'

    // Keyed by the key that was pressed, valued by the note actually sent. Turning
    // the OCTAVE knob while a key is held must not release a different pitch.
    const held = new Map()
    let dragNote = null // note under the active pointer drag, for pointerenter glide
    const noteOn = midi => {
      if (held.has(midi)) return
      const note = midi + params().octave * 12
      held.set(midi, note)
      wrapper.querySelector(`[data-note="${midi}"]`)?.classList.add('active')
      sendEvent('note', { type: 'note-on', note, velocity: 100 })
    }
    const noteOff = midi => {
      if (!held.has(midi)) return
      const note = held.get(midi)
      held.delete(midi)
      wrapper.querySelector(`[data-note="${midi}"]`)?.classList.remove('active')
      sendEvent('note', { type: 'note-off', note })
    }

    for (const key of L.keys) {
      const div = document.createElement('div')
      div.className = key.black ? 'key-black' : 'key-white'
      div.dataset.note = key.note
      div.style.position = 'absolute'
      div.style.left = key.x + 'px'
      div.style.top = '0'
      div.style.width = key.w + 'px'
      div.style.height = key.h + 'px'
      div.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation()
        dragNote = key.note
        noteOn(key.note)
        const up = () => { noteOff(dragNote); dragNote = null }
        window.addEventListener('pointerup', up, { once: true })
        window.addEventListener('pointercancel', up, { once: true })
      })
      div.addEventListener('pointerenter', e => {
        if (e.buttons !== 1 || dragNote === null || dragNote === key.note) return
        noteOff(dragNote)
        dragNote = key.note
        noteOn(key.note)
      })
      wrapper.append(div)
    }

    wrapper.addEventListener('keydown', e => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const note = KEY_MAP[e.key.toLowerCase()]
      if (note !== undefined) noteOn(note)
    })
    wrapper.addEventListener('keyup', e => {
      const note = KEY_MAP[e.key.toLowerCase()]
      if (note !== undefined) noteOff(note)
    })

    return wrapper
  }
}
