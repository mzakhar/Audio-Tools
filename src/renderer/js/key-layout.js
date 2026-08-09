/**
 * key-layout.js
 * Pure piano geometry — shared by the synth keyboard and the rack KEYS panel.
 * No DOM.
 */

// Which semitones in an octave are black keys (0=C)
export const BLACK_IN_OCT = new Set([1, 3, 6, 8, 10])
// For each black-key semitone: how many white-key widths from the octave's C
// to the CENTER of that black key. Formula: left = (octaveCX + offset)*W - W_b/2
// semitone → (prevWhiteIdx + 1):  C#=1, D#=2, F#=4, G#=5, A#=6
export const BLACK_OFFSET = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 }

// PC keyboard → MIDI note map
export const KEY_MAP = {
  // Lower octave (C3–B3)
  'a': 48, 'w': 49, 's': 50, 'e': 51, 'd': 52,
  'f': 53, 't': 54, 'g': 55, 'y': 56, 'h': 57,
  'u': 58, 'j': 59,
  // Upper octave (C4–C5)
  'k': 60, 'o': 61, 'l': 62, 'p': 63, ';': 64,
  "'": 65, ']': 66, 'z': 67, '[': 68, 'x': 69,
  '-': 70, 'c': 71, 'v': 72,
}

export function noteToName(midi) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
  const oct = Math.floor(midi / 12) - 1
  return names[midi % 12] + oct
}

// Pure. Returns { width, height, keys: [{ note, black, x, w, h }] }
// whites laid flush left; blacks centred on the white boundary using BLACK_OFFSET,
// x = (cX + BLACK_OFFSET[semitone]) * whiteW - blackW / 2, rounded.
// Black keys come AFTER whites in the array so DOM append order paints them on top.
export function keyLayout({ start = 48, end = 72, whiteW = 44, whiteH = 130, blackW = 28, blackH = 80 } = {}) {
  let whiteIndex = 0
  const whitePositions = {} // MIDI → x position (in white-key units)
  for (let note = start; note <= end; note++) {
    if (!BLACK_IN_OCT.has(note % 12)) { whitePositions[note] = whiteIndex; whiteIndex++ }
  }
  const totalWhites = whiteIndex

  const keys = []
  for (let note = start; note <= end; note++) {
    if (BLACK_IN_OCT.has(note % 12)) continue
    keys.push({ note, black: false, x: whitePositions[note] * whiteW, w: whiteW, h: whiteH })
  }
  for (let note = start; note <= end; note++) {
    const semitone = note % 12
    if (!BLACK_IN_OCT.has(semitone)) continue
    const octaveStart = note - semitone
    const cX = whitePositions[octaveStart]
    if (cX === undefined) continue
    const x = Math.round((cX + BLACK_OFFSET[semitone]) * whiteW - blackW / 2)
    keys.push({ note, black: true, x, w: blackW, h: blackH })
  }

  return { width: totalWhites * whiteW, height: whiteH, keys }
}
