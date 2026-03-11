/**
 * timeline-math.js
 * Pure beat/time/zoom math for the arrangement timeline.
 */

export const LOD_LEVELS = [32, 64, 128, 256, 512, 1024, 2048, 4096]

// Beat <-> time
export function beatsToSeconds(beats, bpm) {
  return beats * (60 / bpm)
}
export function secondsToBeats(seconds, bpm) {
  return seconds / (60 / bpm)
}

// Bar/beat labels. timeSignature is [numerator, denominator] e.g. [4, 4]
export function barBeats(beat, timeSignature) {
  const num = timeSignature[0]
  const bar = Math.floor(beat / num) + 1
  const beatInBar = (beat % num) + 1
  return { bar, beatInBar }
}

// Snap a beat value to the nearest grid subdivision (e.g. 4 = 16th note grid in 4/4)
export function snapToGrid(beat, subdivisions) {
  const grid = 1 / subdivisions
  return Math.round(beat / grid) * grid
}

// Pixel <-> beat
export function beatsToPx(beats, pixelsPerBeat) {
  return beats * pixelsPerBeat
}
export function pxToBeats(px, pixelsPerBeat) {
  return px / pixelsPerBeat
}

// How many audio samples correspond to one pixel at a given zoom level
// pixelsPerBeat: zoom level (e.g. 40 px/beat)
// bpm: beats per minute
// sampleRate: audio sample rate (e.g. 44100)
export function samplesPerPixel(pixelsPerBeat, bpm, sampleRate) {
  const samplesPerBeat = sampleRate * (60 / bpm)
  return samplesPerBeat / pixelsPerBeat
}

// Select the best LOD level for the current zoom
// Returns the smallest LOD_LEVELS entry >= samplesPerPx (avoid aliasing)
// Clamps to min and max of LOD_LEVELS
export function selectLodLevel(samplesPerPx) {
  for (const level of LOD_LEVELS) {
    if (level >= samplesPerPx) return level
  }
  return LOD_LEVELS[LOD_LEVELS.length - 1]
}

// Compute the visible beat range given scroll and viewport
export function visibleBeatRange(scrollLeft, viewportWidth, pixelsPerBeat) {
  const startBeat = pxToBeats(scrollLeft, pixelsPerBeat)
  const endBeat = pxToBeats(scrollLeft + viewportWidth, pixelsPerBeat)
  return { startBeat, endBeat }
}

// Generate ruler tick marks for the visible range
// Returns Array<{ beat, label, isBar, isBeat, x }>
// x is in pixels relative to the left edge of the canvas (not scrolled)
export function rulerTicks(startBeat, endBeat, pixelsPerBeat, timeSignature, scrollLeft = 0) {
  const ticks = []
  if (endBeat <= startBeat) return ticks
  const num = timeSignature[0]

  // Decide tick density based on zoom
  // At low zoom show only bars; at high zoom show beats too
  const pxPerBar = pixelsPerBeat * num
  const showBeats = pxPerBar >= 40

  const firstBeat = Math.floor(startBeat)
  const lastBeat = Math.ceil(endBeat)

  for (let beat = firstBeat; beat <= lastBeat; beat++) {
    const isBar = beat % num === 0
    if (!isBar && !showBeats) continue
    const x = beatsToPx(beat, pixelsPerBeat) - scrollLeft
    const { bar, beatInBar } = barBeats(beat, timeSignature)
    const label = isBar ? String(bar) : ''
    ticks.push({ beat, label, isBar, isBeat: !isBar, x })
  }
  return ticks
}
