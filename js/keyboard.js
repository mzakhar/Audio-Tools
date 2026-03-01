/**
 * keyboard.js
 * Renders a 2-octave on-screen piano (C3–C5, 25 keys).
 * Fires custom events 'note-on' and 'note-off' on the document.
 * Handles mouse, touch, and PC keyboard input.
 */

const Keyboard = (() => {
  // C3 = MIDI 48, C5 = MIDI 72
  const START_NOTE = 48; // C3
  const END_NOTE   = 72; // C5
  const WHITE_KEY_W = 44;
  const WHITE_KEY_H = 130;
  const BLACK_KEY_W = 28;
  const BLACK_KEY_H = 80;

  // Which semitones in an octave are black keys (0=C)
  const BLACK_IN_OCT = new Set([1, 3, 6, 8, 10]);
  // For each black-key semitone: how many white-key widths from the octave's C
  // to the CENTER of that black key. Formula: left = (octaveCX + offset)*W - W_b/2
  // semitone → (prevWhiteIdx + 1):  C#=1, D#=2, F#=4, G#=5, A#=6
  const BLACK_OFFSET = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 };

  // PC keyboard → MIDI note map
  const KEY_MAP = {
    // Lower octave (C3–B3)
    'a': 48, 'w': 49, 's': 50, 'e': 51, 'd': 52,
    'f': 53, 't': 54, 'g': 55, 'y': 56, 'h': 57,
    'u': 58, 'j': 59,
    // Upper octave (C4–C5)
    'k': 60, 'o': 61, 'l': 62, 'p': 63, ';': 64,
    "'": 65, ']': 66, 'z': 67, '[': 68, 'x': 69,
    '-': 70, 'c': 71, 'v': 72,
  };

  let container = null;
  const pressedKeys = new Set(); // MIDI notes currently held
  const activeMouseNote = { val: null }; // currently held mouse note

  function noteToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function noteToName(midi) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const oct = Math.floor(midi / 12) - 1;
    return names[midi % 12] + oct;
  }

  function fireNoteOn(note) {
    if (pressedKeys.has(note)) return;
    pressedKeys.add(note);
    highlightKey(note, true);
    document.dispatchEvent(new CustomEvent('note-on', { detail: { note } }));
  }

  function fireNoteOff(note) {
    if (!pressedKeys.has(note)) return;
    pressedKeys.delete(note);
    highlightKey(note, false);
    document.dispatchEvent(new CustomEvent('note-off', { detail: { note } }));
  }

  function highlightKey(note, on) {
    const el = container && container.querySelector(`[data-note="${note}"]`);
    if (el) el.classList.toggle('active', on);
  }

  function buildKeyboardLabel(note) {
    // find PC key for this note
    for (const [k, n] of Object.entries(KEY_MAP)) {
      if (n === note) return k === "'" ? "'" : k;
    }
    return '';
  }

  function render(containerId) {
    container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    container.style.position = 'relative';

    // Calculate white key positions
    let whiteIndex = 0;
    const whitePositions = {}; // MIDI → x position

    for (let note = START_NOTE; note <= END_NOTE; note++) {
      const semitone = note % 12;
      if (!BLACK_IN_OCT.has(semitone)) {
        whitePositions[note] = whiteIndex;
        whiteIndex++;
      }
    }

    const totalWhites = whiteIndex;
    container.style.width = (totalWhites * WHITE_KEY_W) + 'px';
    container.style.height = WHITE_KEY_H + 'px';

    // Render white keys first (behind black)
    for (let note = START_NOTE; note <= END_NOTE; note++) {
      const semitone = note % 12;
      if (BLACK_IN_OCT.has(semitone)) continue;

      const x = whitePositions[note];
      const div = document.createElement('div');
      div.className = 'key-white';
      div.dataset.note = note;
      div.style.position = 'absolute';
      div.style.left = (x * WHITE_KEY_W) + 'px';
      div.style.top = '0';
      div.style.width = WHITE_KEY_W + 'px';
      div.style.height = WHITE_KEY_H + 'px';

      const label = document.createElement('span');
      label.className = 'key-label';
      label.textContent = buildKeyboardLabel(note) || (semitone === 0 ? noteToName(note) : '');
      div.appendChild(label);

      attachMouseEvents(div, note);
      container.appendChild(div);
    }

    // Render black keys on top
    for (let note = START_NOTE; note <= END_NOTE; note++) {
      const semitone = note % 12;
      if (!BLACK_IN_OCT.has(semitone)) continue;

      const octaveStart = note - semitone; // MIDI of the C in this octave (always white)
      const cX = whitePositions[octaveStart];
      if (cX === undefined) continue;

      // Center this black key at the boundary between the two flanking white keys
      const x = (cX + BLACK_OFFSET[semitone]) * WHITE_KEY_W - BLACK_KEY_W / 2;

      const div = document.createElement('div');
      div.className = 'key-black';
      div.dataset.note = note;
      div.style.position = 'absolute';
      div.style.left = Math.round(x) + 'px';
      div.style.top = '0';
      div.style.width = BLACK_KEY_W + 'px';
      div.style.height = BLACK_KEY_H + 'px';

      const label = document.createElement('span');
      label.className = 'key-label';
      label.textContent = buildKeyboardLabel(note);
      div.appendChild(label);

      attachMouseEvents(div, note);
      container.appendChild(div);
    }

    // Touch events on container (for multi-touch)
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: false });
    container.addEventListener('touchcancel', onTouchEnd, { passive: false });
  }

  function attachMouseEvents(el, note) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      activeMouseNote.val = note;
      fireNoteOn(note);
    });
    el.addEventListener('mouseenter', (e) => {
      if (e.buttons === 1 && activeMouseNote.val !== null) {
        if (activeMouseNote.val !== note) {
          fireNoteOff(activeMouseNote.val);
          activeMouseNote.val = note;
          fireNoteOn(note);
        }
      }
    });
    el.addEventListener('mouseleave', () => {
      // Don't stop on leave — handled by window mouseup
    });
  }

  // Global mouse up → release held note
  window.addEventListener('mouseup', () => {
    if (activeMouseNote.val !== null) {
      fireNoteOff(activeMouseNote.val);
      activeMouseNote.val = null;
    }
  });

  // Touch handling
  const touchNotes = new Map(); // touchId → note
  function getNoteFromTouch(touch) {
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    if (el && el.dataset.note) return parseInt(el.dataset.note);
    const parent = el && el.closest('[data-note]');
    return parent ? parseInt(parent.dataset.note) : null;
  }

  function onTouchStart(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const note = getNoteFromTouch(t);
      if (note !== null) {
        touchNotes.set(t.identifier, note);
        fireNoteOn(note);
      }
    }
  }

  function onTouchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const note = touchNotes.get(t.identifier);
      if (note !== undefined) {
        fireNoteOff(note);
        touchNotes.delete(t.identifier);
      }
    }
  }

  // PC keyboard events
  const heldKeys = new Set(); // keycodes currently down
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    // Don't capture if focus is on an input
    if (document.activeElement && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return;

    const key = e.key.toLowerCase();
    if (heldKeys.has(key)) return;
    const note = KEY_MAP[key];
    if (note !== undefined) {
      heldKeys.add(key);
      fireNoteOn(note);
    }
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    heldKeys.delete(key);
    const note = KEY_MAP[key];
    if (note !== undefined) {
      fireNoteOff(note);
    }
  });

  return { render, noteToFreq, noteToName };
})();
