// Grids — a generative drum-pattern map (Mutable Instruments Grids topology).
//
// Nine pattern nodes sit on a 3×3 grid. X/Y pick a point in that grid and the
// four surrounding nodes are blended bilinearly, so moving the puck morphs one
// groove into another instead of switching between them. Each node holds three
// 32-step level tables (BD/SD/HH), one byte per step: the byte is how *likely*
// that step is, not whether it fires. Density turns the threshold, so one map
// covers everything from a bare kick to a busy break.
//
// Pure: no context, no globals, no randomness of its own — the caller passes
// the noise in. That is what makes it testable and the bounce reproducible.

export const CHANNELS = ['bd', 'sd', 'hh']
export const STEPS = 32
export const GRID = 3

// Patterns are written as 32 hex digits, grouped a beat (4 sixteenths) at a
// time. Digit → level ×17, so 'f' = 255 (accent), 'c' = 204 (hit),
// '8' = 136 (ghost, only audible past ~50% density), '0' = never.
function table(text) {
  const digits = text.replace(/\s+/g, '')
  if (digits.length !== STEPS) throw new Error(`grids pattern must be ${STEPS} steps, got ${digits.length}`)
  return Uint8Array.from(digits, d => parseInt(d, 16) * 17)
}

// Row-major, y outer: index = y * GRID + x. y=0 is the top of the pad.
export const NODES = [
  // x0y0 — straight four-on-the-floor, backbeat snare, eighth hats
  { bd: table('f000 c000 f000 c000 f000 c000 f000 c000'), sd: table('0000 f000 0000 c000 0000 f000 0000 c000'), hh: table('c080 c080 c080 c080 c080 c080 c080 c080') },
  // x1y0 — same pulse, sixteenth hats and a pushed kick
  { bd: table('f000 c000 f008 c000 f000 c000 f080 c000'), sd: table('0000 f000 0000 c008 0000 f000 0080 c000'), hh: table('c848 c848 c848 c848 c848 c848 c848 c848') },
  // x2y0 — busy: kick fills, ghost snares, rolling hats
  { bd: table('f008 c000 f080 c008 f000 c080 f008 c000'), sd: table('0080 f008 0000 c080 0008 f000 0080 c008'), hh: table('cc8c 8c8c cc8c 8c8c cc8c 8c8c cc8c 8c8c') },
  // x0y1 — half-time, quarter hats
  { bd: table('f000 0000 c000 0000 f000 0000 c000 0080'), sd: table('0000 0000 f000 0000 0000 0000 f000 0000'), hh: table('c000 8000 c000 8000 c000 8000 c000 8000') },
  // x1y1 — the centre groove everything blends through
  { bd: table('f000 0000 0080 c000 f000 0000 0080 c000'), sd: table('0000 f000 0000 c000 0000 f000 0008 c000'), hh: table('c080 8080 c080 8080 c080 8080 c088 8088') },
  // x2y1 — garage: broken kick, snare pushed off the grid
  { bd: table('f000 0008 0000 c080 f000 0000 8000 c008'), sd: table('0000 f080 0000 c000 0080 f000 0000 c080'), hh: table('c8c8 8c88 c8c8 8c88 c8c8 8c88 c8c8 8c8c') },
  // x0y2 — sparse: two kicks a bar and almost nothing else
  { bd: table('f000 0000 0000 0000 c000 0000 0000 0000'), sd: table('0000 0000 f000 0000 0000 0000 c000 0000'), hh: table('8000 0000 8000 0000 8000 0000 8000 0000') },
  // x1y2 — breakbeat
  { bd: table('f000 0000 008c 0000 0080 f000 0000 c000'), sd: table('0000 f000 0000 0080 c000 0000 f008 0000'), hh: table('c088 c088 c088 c088 c088 c088 c088 c088') },
  // x2y2 — dense and broken, nothing on the grid twice
  { bd: table('f008 0080 08c0 0008 0080 f000 0800 c080'), sd: table('0080 f008 8000 c008 0800 f080 0008 c800'), hh: table('cc88 8ccc 88cc c88c cc88 8ccc 88cc c88c') }
]

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v) || 0

// Blended step level, 0..255. `channel` is 'bd'|'sd'|'hh' or its index.
export function gridsLevel(x, y, channel, step) {
  const ch = typeof channel === 'number' ? CHANNELS[channel] : channel
  if (!CHANNELS.includes(ch)) return 0
  const s = ((Math.floor(step) % STEPS) + STEPS) % STEPS
  const u = clamp01(x) * (GRID - 1), v = clamp01(y) * (GRID - 1)
  // Clamp the corner index so x=1 blends the last cell rather than reading off
  // the end of the row.
  const x0 = Math.min(GRID - 2, Math.floor(u)), y0 = Math.min(GRID - 2, Math.floor(v))
  const fx = u - x0, fy = v - y0
  const at = (cx, cy) => NODES[cy * GRID + cx][ch][s]
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
  return top * (1 - fy) + bottom * fy
}

// Does this step fire? `noise` is a 0..1 sample from the caller's RNG; chaos
// scales how much of it is added, so chaos only ever *adds* hits — a groove
// never loses its downbeat to randomness.
export function gridsHit(level, density, chaos = 0, noise = 0) {
  return level + clamp01(chaos) * clamp01(noise) * 255 > (1 - clamp01(density)) * 255
}
