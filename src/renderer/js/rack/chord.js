// Pure core for CHORD — one root pitch CV to four voiced pitch CVs.
//
// Everything here is semitones until the last line; 1 V/oct is 0.1 per octave
// (utils/cv.js), so a semitone is 1/120 and the conversion is one divide.

export const CHORD_TYPES = {
  oct: [0, 12, 24, 36],
  '5th': [0, 7, 12, 19],
  maj: [0, 4, 7],
  min: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  add9: [0, 4, 7, 14]
}

const VOICES = 4

export function chordVoltages(rootCv = 0, type = 'maj', inversion = 0, voicing = 'close') {
  // Invert first, pad second: a triad's fourth voice is whatever the inverted
  // chord's lowest note is, an octave up. Padding first would double a voice.
  const base = (CHORD_TYPES[type] || CHORD_TYPES.maj).slice()
  const turns = Math.max(0, Math.min(VOICES - 1, Math.round(inversion) || 0))
  for (let i = 0; i < turns; i++) base.push(base.shift() + 12)

  const notes = base.slice(0, VOICES)
  while (notes.length < VOICES) notes.push(notes[notes.length - base.length] + 12)

  if (voicing === 'open') notes[1] += 12          // spread the second voice out
  else if (voicing === 'drop2') notes[VOICES - 2] -= 12   // classic drop-2
  return notes.map(semitone => rootCv + semitone / 120)
}
