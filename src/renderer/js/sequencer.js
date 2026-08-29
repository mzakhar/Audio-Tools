/**
 * sequencer.js
 * 16-step sequencer. Every row plays the armed instrument — a row only picks
 * *which* note, either a GM percussion pad or a pitch. Sound making is
 * injected (`playNote`), never built here: the scheduler hands out future
 * AudioContext timestamps, so a DOM event would lose the timing.
 */
import AudioEngine from './audio-engine.js'
import { LookaheadScheduler } from './rack/scheduler.js'
import { padBank, padToNote, noteToPad } from './instruments/pad-map.js'

// ─── Constants ─────────────────────────────────────────────────────────────
const STEPS = 16
const VELOCITY = 0.85

// Every pad of both banks, flattened for the row picker.
const PADS = ['A', 'B'].flatMap(bank => padBank(bank).map(pad => ({ ...pad, bank })))

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
let playNote = null

let tracks = []
let containerEl = null

function makeTrack(kind, note) {
  return { kind, note, steps: new Array(STEPS).fill(false) }
}

function defaultTracks() {
  // Bank A slots: 1 kick, 2 snare, 5 closed hat, 4 clap.
  const pads = [1, 2, 5, 4].map(slot => makeTrack('pad', padToNote('A', slot)))
  return pads.concat([60, 64, 67, 72].map(note => makeTrack('note', note)))
}

// ─── Init ───────────────────────────────────────────────────────────────────
function init(containerId, { playNote: player } = {}) {
  containerEl = document.getElementById(containerId)
  playNote = player || null
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
  row.dataset.kind = track.kind
  if (track.kind === 'pad') row.dataset.bank = noteToPad(track.note)?.bank || 'A'

  // Controls
  const ctrl = document.createElement('div')
  ctrl.className = 'seq-track-ctrl'

  // Row kind: pad (GM percussion) or pitched note
  const kindSel = document.createElement('select')
  kindSel.className = 'track-sel track-kind-sel'
  ;[['pad', 'PAD'], ['note', 'NOTE']].forEach(([value, label]) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    if (value === track.kind) o.selected = true
    kindSel.appendChild(o)
  })
  kindSel.addEventListener('change', () => {
    track.kind = kindSel.value
    track.note = track.kind === 'pad' ? padToNote('A', 1) : 60
    renderAll()
  })

  // Value picker for that kind
  const noteSel = document.createElement('select')
  noteSel.className = 'track-sel track-note-sel'
  buildNoteSelect(noteSel, track)
  noteSel.addEventListener('change', () => {
    track.note = parseInt(noteSel.value)
    if (track.kind === 'pad') row.dataset.bank = noteToPad(track.note)?.bank || 'A'
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

  ctrl.appendChild(kindSel)
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
  const options = track.kind === 'pad'
    ? PADS.map(pad => [pad.note, `${pad.bank}${pad.slot} ${pad.label}`])
    : CHROMATIC_NOTES.map((midi, i) => [midi, NOTE_NAMES_CHROM[i]])
  options.forEach(([value, label]) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    if (value === track.note) o.selected = true
    sel.appendChild(o)
  })
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
function stepDuration() {
  return (60 / bpm) / 4
}

function scheduleStep(step, time) {
  if (!playNote) return
  tracks.forEach(track => {
    if (track.steps[step]) playNote(track.note, VELOCITY, time)
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

function addTrack() {
  tracks.push(makeTrack('note', 60))
  renderTrackRow(tracks.length - 1)
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

const Sequencer = { init, play, stop, clear, setBPM, addTrack,
  getBPM() { return bpm },
  isPlaying() { return isPlaying },
  getTracks() { return tracks }
}
export default Sequencer
