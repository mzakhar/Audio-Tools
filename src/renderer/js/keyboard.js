/**
 * keyboard.js
 * Renders a 2-octave on-screen piano (C3–C5, 25 keys).
 * Fires custom events 'note-on' and 'note-off' on the document.
 * Handles mouse, touch, and PC keyboard input.
 */

import { KEY_MAP, keyLayout, noteToName } from './key-layout.js'

// C3 = MIDI 48, C5 = MIDI 72
const START_NOTE = 48 // C3
const END_NOTE   = 72 // C5
const WHITE_KEY_W = 44
const WHITE_KEY_H = 130
const BLACK_KEY_W = 28
const BLACK_KEY_H = 80

let container = null
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

function buildKeyboardLabel(note) {
  // find PC key for this note
  for (const [k, n] of Object.entries(KEY_MAP)) {
    if (n === note) return k === "'" ? "'" : k
  }
  return ''
}

function render(containerId) {
  container = document.getElementById(containerId)
  if (!container) return
  container.innerHTML = ''
  container.style.position = 'relative'

  const layout = keyLayout({ start: START_NOTE, end: END_NOTE, whiteW: WHITE_KEY_W, whiteH: WHITE_KEY_H, blackW: BLACK_KEY_W, blackH: BLACK_KEY_H })
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

  // Touch events on container (for multi-touch)
  container.addEventListener('touchstart', onTouchStart, { passive: false })
  container.addEventListener('touchend', onTouchEnd, { passive: false })
  container.addEventListener('touchcancel', onTouchEnd, { passive: false })
}

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

// PC keyboard events
const heldKeys = new Set() // keycodes currently down
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
  // Don't capture if focus is on an input
  if (document.activeElement && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return

  const key = e.key.toLowerCase()
  if (heldKeys.has(key)) return
  const note = KEY_MAP[key]
  if (note !== undefined) {
    heldKeys.add(key)
    fireNoteOn(note)
  }
})

window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase()
  heldKeys.delete(key)
  const note = KEY_MAP[key]
  if (note !== undefined) {
    fireNoteOff(note)
  }
})

const Keyboard = { render, noteToFreq, noteToName }
export default Keyboard
