/**
 * sequencer.js
 * 16-step sequencer. Rows follow armed palette; sound selection lives in
 * instrument slot, not a second per-row model.
 */
import AudioEngine from './audio-engine.js'
import Palettes from './palettes.js'
import { LookaheadScheduler } from './rack/scheduler.js'

// ─── Constants ─────────────────────────────────────────────────────────────
const STEPS = 16

const DRUM_NAMES = ['Kick', 'Snare', 'Hi-Hat', 'Clap']

// Chromatic notes C2–C6
const CHROMATIC_NOTES = []
const NOTE_NAMES_CHROM = []
const NOTE_LETTERS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
for (let midi = 36; midi <= 84; midi++) {
  CHROMATIC_NOTES.push(midi)
  const oct = Math.floor(midi / 12) - 1
  const letter = NOTE_LETTERS[midi % 12]
  NOTE_NAMES_CHROM.push(letter + oct)
}

// ─── State ─────────────────────────────────────────────────────────────────
let bpm = 120
let isPlaying = false
let schedulerLoop = null

let tracks = []
let containerEl = null

function makeTrack(paletteKey, drumIndex, note) {
  return { paletteKey, drumIndex, note, steps: new Array(STEPS).fill(false) }
}

function defaultTracks() {
  return [
    makeTrack('classic', 0, 36),
    makeTrack('classic', 1, 38),
    makeTrack('classic', 2, 42),
    makeTrack('classic', 3, 46),
    makeTrack('classic', -1, 60),
    makeTrack('classic', -1, 64),
    makeTrack('classic', -1, 67),
    makeTrack('classic', -1, 72),
  ]
}

// ─── Init ───────────────────────────────────────────────────────────────────
function init(containerId) {
  containerEl = document.getElementById(containerId)
  tracks = defaultTracks()
  renderAll()
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function renderAll() {
  if (!containerEl) return
  containerEl.innerHTML = ''
  renderHeader()
  tracks.forEach((_, i) => renderTrackRow(i))
}

function renderHeader() {
  const row = document.createElement('div')
  row.className = 'seq-track-row header'

  const spacer = document.createElement('div')
  spacer.className = 'seq-ctrl-spacer'
  row.appendChild(spacer)

  const steps = document.createElement('div')
  steps.className = 'seq-steps'
  for (let i = 0; i < STEPS; i++) {
    const d = document.createElement('div')
    d.className = 'step-num' + (i % 4 === 0 ? ' beat-marker' : '')
    d.textContent = i + 1
    steps.appendChild(d)
  }
  row.appendChild(steps)
  containerEl.appendChild(row)
}

function renderTrackRow(trackIdx) {
  const track = tracks[trackIdx]
  const row = document.createElement('div')
  row.className = 'seq-track-row'
  row.dataset.palette = track.paletteKey
  if (track.paletteKey === 'drum') row.dataset.drum = track.drumIndex

  // Controls
  const ctrl = document.createElement('div')
  ctrl.className = 'seq-track-ctrl'

  // Note/drum select
  const noteSel = document.createElement('select')
  noteSel.className = 'track-sel track-note-sel'
  buildNoteSelect(noteSel, track)

  noteSel.addEventListener('change', () => {
    if (track.paletteKey === 'drum') {
      track.drumIndex = parseInt(noteSel.value)
      row.dataset.drum = track.drumIndex
    } else {
      track.note = parseInt(noteSel.value)
    }
  })

  // Remove button
  const removeBtn = document.createElement('button')
  removeBtn.className = 'track-remove-btn transport-btn'
  removeBtn.textContent = '×'
  removeBtn.title = 'Remove track'
  removeBtn.addEventListener('click', () => {
    tracks.splice(trackIdx, 1)
    renderAll()
  })

  ctrl.appendChild(noteSel)
  ctrl.appendChild(removeBtn)
  row.appendChild(ctrl)

  // Steps
  const stepsEl = document.createElement('div')
  stepsEl.className = 'seq-steps'
  for (let s = 0; s < STEPS; s++) {
    const cell = document.createElement('div')
    cell.className = 'seq-cell' + (track.steps[s] ? ' active' : '')
    cell.dataset.step = s
    cell.addEventListener('click', () => {
      track.steps[s] = !track.steps[s]
      cell.classList.toggle('active', track.steps[s])
    })
    stepsEl.appendChild(cell)
  }
  row.appendChild(stepsEl)
  containerEl.appendChild(row)
}

function buildNoteSelect(sel, track) {
  sel.innerHTML = ''
  if (track.paletteKey === 'drum') {
    DRUM_NAMES.forEach((name, i) => {
      const o = document.createElement('option')
      o.value = i
      o.textContent = name
      if (i === track.drumIndex) o.selected = true
      sel.appendChild(o)
    })
  } else {
    CHROMATIC_NOTES.forEach((midi, i) => {
      const o = document.createElement('option')
      o.value = midi
      o.textContent = NOTE_NAMES_CHROM[i]
      if (midi === track.note) o.selected = true
      sel.appendChild(o)
    })
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
function stepDuration() {
  return (60 / bpm) / 4
}

function scheduleStep(step, time) {
  const ctx = AudioEngine.getContext()
  if (!ctx) return
  const out = AudioEngine.getMasterInput()
  const noteDur = stepDuration() * 0.85
  const vel = 0.85

  tracks.forEach(track => {
    if (!track.steps[step]) return
    const palette = Palettes[track.paletteKey]
    if (!palette) return
    if (track.paletteKey === 'drum') {
      palette.createDrumVoice(ctx, out, track.drumIndex, vel, time)
    } else {
      const freq = 440 * Math.pow(2, (track.note - 69) / 12)
      const voice = palette.createVoice(ctx, out, freq, vel, time)
      const stopMs = (time - ctx.currentTime + noteDur) * 1000
      setTimeout(() => { try { voice.stop(ctx.currentTime) } catch(e){} }, Math.max(0, stopMs))
    }
  })
}

// ─── Transport ──────────────────────────────────────────────────────────────
function play() {
  if (isPlaying) return
  const ctx = AudioEngine.getContext()
  if (!ctx) return
  isPlaying = true
  schedulerLoop = new LookaheadScheduler({
    getCurrentTime: () => AudioEngine.getContext()?.currentTime,
    schedule: scheduleStep,
    advance: stepDuration,
    steps: STEPS
  })
  schedulerLoop.stepTimes = new Array(STEPS).fill(-Infinity)
  schedulerLoop.start({ time: ctx.currentTime + 0.05 })
  startPlayhead()
  document.getElementById('play-btn')?.classList.add('active-btn')
}

function stop() {
  if (!isPlaying) return
  isPlaying = false
  schedulerLoop?.stop()
  stopPlayhead()
  document.getElementById('play-btn')?.classList.remove('active-btn')
}

function clear() {
  tracks.forEach(track => track.steps.fill(false))
  containerEl && containerEl.querySelectorAll('.seq-cell').forEach(c => c.classList.remove('active'))
}

function setBPM(v) {
  bpm = Math.max(40, Math.min(220, parseInt(v)))
}

function setPalette(paletteKey = 'classic') {
  if (!Palettes[paletteKey] || tracks.every(track => track.paletteKey === paletteKey)) return
  tracks.forEach((track, index) => {
    track.paletteKey = paletteKey
    track.drumIndex = paletteKey === 'drum' ? index % DRUM_NAMES.length : -1
  })
  renderAll()
}

function addTrack() {
  const paletteKey = tracks[0]?.paletteKey || 'classic'
  tracks.push(makeTrack(paletteKey, paletteKey === 'drum' ? tracks.length % DRUM_NAMES.length : -1, 60))
  const idx = tracks.length - 1
  renderTrackRow(idx)
}

// ─── Playhead ───────────────────────────────────────────────────────────────
let playheadStep = -1
let playheadRaf = null

function startPlayhead() {
  playheadStep = -1
  animatePlayhead()
}

function stopPlayhead() {
  cancelAnimationFrame(playheadRaf)
  clearPlayheadHighlight()
  playheadStep = -1
}

function animatePlayhead() {
  if (!isPlaying) return
  const ctx = AudioEngine.getContext()
  if (ctx) {
    const now = ctx.currentTime
    let bestStep = -1
    let bestTime = -Infinity
    for (let i = 0; i < STEPS; i++) {
      if (schedulerLoop?.stepTimes[i] <= now && schedulerLoop.stepTimes[i] > bestTime) {
        bestTime = schedulerLoop.stepTimes[i]
        bestStep = i
      }
    }
    if (bestStep !== -1 && bestStep !== playheadStep) {
      clearPlayheadHighlight()
      playheadStep = bestStep
      highlightStep(playheadStep)
    }
  }
  playheadRaf = requestAnimationFrame(animatePlayhead)
}

function clearPlayheadHighlight() {
  containerEl && containerEl.querySelectorAll('.seq-cell.playing').forEach(c => c.classList.remove('playing'))
}

function highlightStep(step) {
  containerEl && containerEl.querySelectorAll(`.seq-cell[data-step="${step}"]`)
    .forEach(c => c.classList.add('playing'))
}

const Sequencer = { init, play, stop, clear, setBPM, setPalette, addTrack,
  getBPM() { return bpm },
  isPlaying() { return isPlaying }
}
export default Sequencer
