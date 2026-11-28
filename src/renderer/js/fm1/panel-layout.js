// panel-layout.js — pure geometry of the FM-1 flat panel, in the 1280x820 space
// of the upstream renderer (crates/fm1-live/src/panel.rs). No DOM.

export const PANEL_W = 1280
export const PANEL_H = 820
export const LCD = { x: 370, y: 42, w: 480, h: 480 }

// enc = matrix encoder id for session.enc(); idx order is the panel's own.
export const ENCODERS = [
  { label: 'SELECT', enc: 0, cx: 250, cy: 135, r: 44 },
  { label: 'PRESETS', enc: 6, cx: 110, cy: 295, r: 44 },
  { label: 'ALGORITHM', enc: 1, cx: 250, cy: 295, r: 44 },
  { label: 'KNOB 1', enc: 2, cx: 935, cy: 120, r: 36 },
  { label: 'KNOB 2', enc: 3, cx: 1027, cy: 120, r: 36 },
  { label: 'KNOB 3', enc: 4, cx: 1119, cy: 120, r: 36 },
  { label: 'KNOB 4', enc: 5, cx: 1211, cy: 120, r: 36 }
]

export const POT = { label: 'MASTER', cx: 110, cy: 135, r: 44, max: 1023, initial: 900 }

const ROW1 = ['FX', 'SCL', 'ENV', 'LFO', 'EDIT', 'GLO']
const ROW2 = ['HOME', 'SAVE', 'ARP', 'SEQ', 'PLAY', 'REC']

// id = matrix id for session.key(). 0,1 octave; 2..13 the two rows.
export const BUTTONS = [
  { label: 'OCT -', id: 0, x: 62, y: 398, w: 112, h: 44 },
  { label: 'OCT +', id: 1, x: 186, y: 398, w: 112, h: 44 },
  ...ROW1.map((label, i) => ({ label, id: 2 + i, x: 906 + 58 * i, y: 232, w: 50, h: 64 })),
  ...ROW2.map((label, i) => ({ label, id: 8 + i, x: 906 + 58 * i, y: 308, w: 50, h: 64 }))
]

// 27 keys F3..G5, id 14 + semitone from F3. White keys sit in a row, black keys above.
const WHITE = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26]
const BLACK = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25]
const NAMES = ['F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E']
const keyName = n => `${NAMES[n % 12]}${3 + Math.floor((n + 5) / 12)}`
const WHITE_X = i => 61 + 73 * i

export const KEYS = [
  ...WHITE.map((n, i) => ({ label: keyName(n), id: 14 + n, black: false, x: WHITE_X(i), y: 680, w: 62, h: 106 })),
  ...BLACK.map(n => {
    const left = WHITE.filter(w => w < n).length - 1   // the white key just below this black one
    return { label: keyName(n), id: 14 + n, black: true, x: WHITE_X(left) + 67 - 20, y: 574, w: 40, h: 94 }
  })
]

const pct = (v, total) => `${(v / total * 100).toFixed(3)}%`

/** CSS box (percent of the panel) for a rect or a circle. */
export function boxStyle(shape) {
  const { x, y, w, h } = 'r' in shape ? { x: shape.cx - shape.r, y: shape.cy - shape.r, w: shape.r * 2, h: shape.r * 2 } : shape
  return { left: pct(x, PANEL_W), top: pct(y, PANEL_H), width: pct(w, PANEL_W), height: pct(h, PANEL_H) }
}
