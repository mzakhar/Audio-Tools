/**
 * keyboard.js
 * Renders an on-screen piano over a movable window of the MIDI range
 * (C3–C5, 25 keys by default). Fires custom events 'note-on' and 'note-off'
 * on the document. Handles mouse, touch, and PC keyboard input.
 *
 * The window is what makes a hardware octave button visible: an incoming note
 * outside it scrolls the whole thing rather than vanishing. Range maths is
 * pure and lives in keyboard-range.js.
 */

import { KEY_MAP, keyLayout, noteToName } from './key-layout.js'
import { windowForNote, shiftWindow } from './keyboard-range.js'
import ShortcutManager from './shortcuts.js'

// C3 = MIDI 48, C5 = MIDI 72 — defaults, not constants any more.
const DEFAULT_START = 48
const DEFAULT_END   = 72
const WHITE_KEY_W = 44
const WHITE_KEY_H = 130
const BLACK_KEY_W = 28
const BLACK_KEY_H = 80

let container = null
let containerId = null
let startNote = DEFAULT_START
let endNote   = DEFAULT_END
let touchBound = false // render() runs again on every octave shift
const pressedKeys = new Set() // MIDI notes currently held
const activeMouseNote = { val: null } // currently held mouse note

function noteToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function fireNoteOn(note) {
  if (pressedKeys.has(note)) return
  pressedKeys.add(note)
  highlightKey(note, true)
  document.dispatchEvent(new CustomEvent('note-on', { detail: { note } }))
}

function fireNoteOff(note) {
  if (!pressedKeys.has(note)) return
  pressedKeys.delete(note)
  highlightKey(note, false)
  document.dispatchEvent(new CustomEvent('note-off', { detail: { note } }))
}

function highlightKey(note, on) {
  const el = container && container.querySelector(`[data-note="${note}"]`)
  if (el) el.classList.toggle('active', on)
}

// PC keys are laid out relative to the window, not to MIDI 48, so the same
// finger plays the same key of whatever octave is on screen.
function pcNote(key) {
  const note = KEY_MAP[key]
  return note === undefined ? undefined : note - DEFAULT_START + startNote
}

function buildKeyboardLabel(note) {
  for (const [k, n] of Object.entries(KEY_MAP)) {
    if (n - DEFAULT_START + startNote === note) return k
  }
  return ''
}

function render(id, { start, end } = {}) {
  if (id) containerId = id
  if (start != null) startNote = start
  if (end != null) endNote = end
  container = document.getElementById(containerId)
  if (!container) return
  container.innerHTML = ''
  container.style.position = 'relative'

  const layout = keyLayout({ start: startNote, end: endNote, whiteW: WHITE_KEY_W, whiteH: WHITE_KEY_H, blackW: BLACK_KEY_W, blackH: BLACK_KEY_H })
  container.style.width = layout.width + 'px'
  container.style.height = layout.height + 'px'

  for (const key of layout.keys) {
    const div = document.createElement('div')
    div.className = key.black ? 'key-black' : 'key-white'
    div.dataset.note = key.note
    div.style.position = 'absolute'
    div.style.left = key.x + 'px'
    div.style.top = '0'
    div.style.width = key.w + 'px'
    div.style.height = key.h + 'px'

    const label = document.createElement('span')
    label.className = 'key-label'
    label.textContent = buildKeyboardLabel(key.note) || (!key.black && key.note % 12 === 0 ? noteToName(key.note) : '')
    div.appendChild(label)

    attachMouseEvents(div, key.note)
    container.appendChild(div)
  }

  // Touch events live on the container, which survives a re-render — bind once
  // or every octave shift stacks another listener on it.
  if (!touchBound) {
    touchBound = true
    container.addEventListener('touchstart', onTouchStart, { passive: false })
    container.addEventListener('touchend', onTouchEnd, { passive: false })
    container.addEventListener('touchcancel', onTouchEnd, { passive: false })
  }

  for (const note of [...pressedKeys]) highlightKey(note, true)
  renderRange()
}

/** The "which octaves am I looking at" readout, plus its two octave buttons. */
function renderRange() {
  const label = document.getElementById('keyboard-range-label')
  if (label) label.textContent = noteToName(startNote) + ' – ' + noteToName(endNote)
  const down = document.getElementById('kb-oct-down')
  const up   = document.getElementById('kb-oct-up')
  if (down && !down.dataset.bound) {
    down.dataset.bound = '1'
    down.addEventListener('click', () => shiftOctave(-1))
  }
  if (up && !up.dataset.bound) {
    up.dataset.bound = '1'
    up.addEventListener('click', () => shiftOctave(1))
  }
  if (down) down.disabled = shiftWindow(startNote, endNote, -1).start === startNote
  if (up)   up.disabled   = shiftWindow(startNote, endNote, 1).start === startNote
}

function setWindow({ start, end }) {
  if (start === startNote && end === endNote) return false
  // A shifting window would otherwise strand held notes under keys that are no
  // longer on screen, and nothing would ever send their note-off. Rather than
  // cut them, refuse to move while anything is held — an automatic follow must
  // never truncate a note the player is still holding.
  if (pressedKeys.size || heldKeys.size) return false
  for (const note of [...pressedKeys]) fireNoteOff(note)
  activeMouseNote.val = null
  render(null, { start, end })
  return true
}

/** Scroll the window, in whole octaves, so `note` is on screen. */
function ensureVisible(note) {
  if (!container) return false
  return setWindow(windowForNote(startNote, endNote, note))
}

function shiftOctave(octaves) {
  return setWindow(shiftWindow(startNote, endNote, octaves))
}

function getRange() { return { start: startNote, end: endNote } }

function attachMouseEvents(el, note) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault()
    activeMouseNote.val = note
    fireNoteOn(note)
  })
  el.addEventListener('mouseenter', (e) => {
    if (e.buttons === 1 && activeMouseNote.val !== null) {
      if (activeMouseNote.val !== note) {
        fireNoteOff(activeMouseNote.val)
        activeMouseNote.val = note
        fireNoteOn(note)
      }
    }
  })
  el.addEventListener('mouseleave', () => {
    // Don't stop on leave — handled by window mouseup
  })
}

// Global mouse up → release held note
window.addEventListener('mouseup', () => {
  if (activeMouseNote.val !== null) {
    fireNoteOff(activeMouseNote.val)
    activeMouseNote.val = null
  }
})

// Touch handling
const touchNotes = new Map() // touchId → note
function getNoteFromTouch(touch) {
  const el = document.elementFromPoint(touch.clientX, touch.clientY)
  if (el && el.dataset.note) return parseInt(el.dataset.note)
  const parent = el && el.closest('[data-note]')
  return parent ? parseInt(parent.dataset.note) : null
}

function onTouchStart(e) {
  e.preventDefault()
  for (const t of e.changedTouches) {
    const note = getNoteFromTouch(t)
    if (note !== null) {
      touchNotes.set(t.identifier, note)
      fireNoteOn(note)
    }
  }
}

function onTouchEnd(e) {
  e.preventDefault()
  for (const t of e.changedTouches) {
    const note = touchNotes.get(t.identifier)
    if (note !== undefined) {
      fireNoteOff(note)
      touchNotes.delete(t.identifier)
    }
  }
}

// PC keyboard events. heldKeys remembers the note each key actually fired, so
// an octave shift mid-hold still releases the note that sounded.
const heldKeys = new Map() // key → MIDI note
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
  // Only the synth view plays from the PC keyboard. Without this, letter keys
  // sound notes (and auto-provision a track) from inside every dialog, and
  // from the arrange, rack and 909 views where the keyboard is not on screen.
  if (ShortcutManager.getContext() !== 'synth') return
  // Don't capture if focus is on an input
  if (document.activeElement && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return

  const key = e.key.toLowerCase()
  if (heldKeys.has(key)) return
  const note = pcNote(key)
  if (note !== undefined) {
    heldKeys.set(key, note)
    fireNoteOn(note)
  }
})

window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase()
  const note = heldKeys.get(key)
  heldKeys.delete(key)
  if (note !== undefined) fireNoteOff(note)
})

const Keyboard = { render, noteToFreq, noteToName, ensureVisible, shiftOctave, getRange }
export default Keyboard
