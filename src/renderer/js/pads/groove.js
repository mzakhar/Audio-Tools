// Pure groove/snap math. Units: beats (quarter = 1).

/** Swing percentages offered by the Groove control. */
export const GROOVE_STEPS = [0.5, 0.54, 0.58, 0.62, 0.66, 0.70, 0.75]

/** Snap grid sizes in beats. */
export const SNAP_GRIDS = { '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125, '1/32T': 1 / 12 }

const r9 = (x) => Math.round(x * 1e9) / 1e9

/** Clamp swing to [0.5, 0.75]; nearest GROOVE_STEPS entry unless fine (0.01 steps). */
export function snapGroove(value, fine = false) {
  const v = Math.min(0.75, Math.max(0.5, value))
  if (fine) return Math.round(v * 100) / 100
  return GROOVE_STEPS.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best))
}

/** Beats of delay for grid point `gridIndex`: odd points shift by (swing-0.5)*2*grid. Applies to triplet grids too. */
export function swingOffset(gridIndex, swing, grid = 0.25) {
  return Math.abs(gridIndex % 2) === 1 ? r9((swing - 0.5) * 2 * grid) : 0
}

/** Nearest swung grid point to `beat`. */
export function gridPoint(beat, grid = 0.25, swing = 0.5) {
  const c = Math.round(beat / grid)
  let best = null
  for (let i = c - 1; i <= c + 1; i++) {
    const p = i * grid + swingOffset(i, swing, grid)
    if (best === null || Math.abs(p - beat) < Math.abs(best - beat)) best = p
  }
  return r9(best)
}

/** Move `beat` toward its swung grid point by `strength` (0 = untouched, 1 = on grid). */
export function snap(beat, { grid = 0.25, strength = 1, swing = 0.5 } = {}) {
  return r9(beat + (gridPoint(beat, grid, swing) - beat) * strength)
}
