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
const WHITE_KEY_W = 44          // floor: never smaller than this
const MAX_WHITE_KEY_W = 88      // ceiling: full-width board, the way the pads fill their row
const WHITE_KEY_H = 130
const BLACK_KEY_W = 28
const BLACK_KEY_H = 80

let container = null
let containerId = null
let startNote = DEFAULT_START
let endNote   = DEFAULT_END
let touchBound = false
let resizeBound = false // render() runs again on every octave shift
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

/** White keys in the window — the divisor for a responsive key width. */
function whiteKeyCount(start, end) {
  let count = 0
  for (let note = start; note <= end; note++) if (![1, 3, 6, 8, 10].includes(note % 12)) count++
  return count || 1
}

/** Key sizes for the available width, clamped so keys stay playable. */
function keyMetrics(available, whites) {
  const whiteW = Math.max(WHITE_KEY_W, Math.min(MAX_WHITE_KEY_W, Math.floor((available - 4) / whites)))
  const whiteH = Math.round(whiteW * (WHITE_KEY_H / WHITE_KEY_W))
  return { whiteW, whiteH, blackW: Math.round(whiteW * (BLACK_KEY_W / WHITE_KEY_W)), blackH: Math.round(whiteH * (BLACK_KEY_H / WHITE_KEY_H)) }
}

function render(id, { start, end } = {}) {
  if (id) containerId = id
  if (start != null) startNote = start
  if (end != null) endNote = end
  container = document.getElementById(containerId)
  if (!container) return
  container.innerHTML = ''
  container.style.position = 'relative'

  // Keys fill the width they are given rather than floating at a fixed 44 px:
  // on a wide window a 25-key board was a small island in the middle.
  const metrics = keyMetrics(container.parentElement?.clientWidth ?? 0, whiteKeyCount(startNote, endNote))
  const layout = keyLayout({ start: startNote, end: endNote, ...metrics })
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

  if (!resizeBound && typeof ResizeObserver === 'function' && container.parentElement) {
    resizeBound = true
    let last = container.parentElement.clientWidth
    new ResizeObserver(() => {
      const width = container.parentElement.clientWidth
      if (Math.abs(width - last) < 8) return   // ignore the reflow our own render causes
      last = width
      render()
    }).observe(container.parentElement)
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

function setWindow({ start, end }, { force = false } = {}) {
  if (start === startNote && end === endNote) return false
  // An automatic follow must never truncate a note the player is holding, so
  // it waits. An explicit octave move is intent: it takes the notes with it,
  // releasing them first so nothing is stranded under a key that moved away.
  if (!force && (pressedKeys.size || heldKeys.size)) return false
  for (const note of [...pressedKeys]) fireNoteOff(note)
  for (const [key, note] of [...heldKeys]) { heldKeys.delete(key); fireNoteOff(note) }
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
  return setWindow(shiftWindow(startNote, endNote, octaves), { force: true })
}

// A keyup lost to alt-tab would otherwise leave a key "held" forever, which
// silently freezes the automatic window follow.
window.addEventListener('blur', () => {
  for (const [key, note] of [...heldKeys]) { heldKeys.delete(key); fireNoteOff(note) }
  for (const note of [...pressedKeys]) fireNoteOff(note)
  activeMouseNote.val = null
})

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
