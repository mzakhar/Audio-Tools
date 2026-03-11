/**
 * piano-roll.js
 * Canvas-based MIDI piano roll editor.
 * Tools: draw, select, erase. Quantize snap. Velocity lane.
 */
import ProjectStore, {
  AddMidiNote, RemoveMidiNote, MoveMidiNote, ResizeMidiNote, SetMidiNoteVelocity
} from '../store/ProjectStore.js'

// ── Layout constants ─────────────────────────────────────────────────────────
const PIANO_W   = 48    // px — left piano key column
const NOTE_H    = 10    // px — height per semitone row
const RULER_H   = 20    // px — top beat ruler
const VEL_H     = 64    // px — velocity lane at bottom
const DEFAULT_PPB = 80  // px per beat (more zoomed than arrangement)
const MAX_PITCH = 108   // C8
const MIN_PITCH = 12    // C0

// White keys in an octave (semitone indices)
const WHITE_SET = new Set([0, 2, 4, 5, 7, 9, 11])
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

function pitchName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1)
}

function snapBeat(beat, quantize) {
  if (quantize <= 0) return beat
  return Math.round(beat / quantize) * quantize
}

let _noteIdCounter = 0
function genNoteId() { return `pr-n-${++_noteIdCounter}-${Date.now()}` }

// ── PianoRoll class ───────────────────────────────────────────────────────────
export class PianoRoll {
  constructor(container, { store } = {}) {
    this._store    = store || ProjectStore
    this._container = container
    this._trackId  = null
    this._clipId   = null
    this._ppb      = DEFAULT_PPB
    this._scrollLeft = 0
    this._scrollTop  = (MAX_PITCH - 72) * NOTE_H  // center around C4
    this._quantize = 0.25
    this._tool     = 'draw'
    this._selected = new Set()   // selected note ids
    this._drag     = null

    // Canvas
    this._canvas = document.createElement('canvas')
    this._canvas.className = 'piano-roll-canvas'
    this._canvas.setAttribute('role', 'application')
    this._canvas.setAttribute('aria-label', 'Piano roll note editor. Use draw, select, or erase tools.')
    this._canvas.setAttribute('tabindex', '0')
    container.appendChild(this._canvas)
    this._ctx = this._canvas.getContext('2d')

    // Event binding
    this._onMouseDown = this._onMouseDown.bind(this)
    this._onMouseMove = this._onMouseMove.bind(this)
    this._onMouseUp   = this._onMouseUp.bind(this)
    this._onWheel     = this._onWheel.bind(this)
    this._canvas.addEventListener('mousedown', this._onMouseDown)
    this._canvas.addEventListener('mousemove', this._onMouseMove)
    this._canvas.addEventListener('mouseup',   this._onMouseUp)
    this._canvas.addEventListener('wheel',     this._onWheel, { passive: false })

    // Resize
    this._ro = new ResizeObserver(() => this._onResize())
    this._ro.observe(container)
    this._onResize()

    // Store subscription
    this._unsub = this._store.subscribe(() => this.render())
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  open(trackId, clipId) {
    this._trackId = trackId
    this._clipId  = clipId
    this._selected.clear()
    this._drag = null
    // Scroll to first note if any
    const clip = this._getClip()
    if (clip && clip.notes && clip.notes.length) {
      const pitches = clip.notes.map(n => n.pitch)
      const midPitch = Math.round((Math.max(...pitches) + Math.min(...pitches)) / 2)
      const gridH = this._gridH()
      this._scrollTop = Math.max(0, (MAX_PITCH - midPitch) * NOTE_H - gridH / 2)
    }
    this.render()
  }

  setTool(tool) { this._tool = tool; this._selected.clear(); this.render() }
  setQuantize(beats) { this._quantize = parseFloat(beats); this.render() }

  render() {
    if (!this._trackId || !this._clipId) return
    const clip = this._getClip()
    if (!clip) return
    const ctx = this._ctx
    const w = this._canvas.width
    const h = this._canvas.height
    ctx.clearRect(0, 0, w, h)
    this._drawGrid(ctx, clip, w, h)
    this._drawPianoKeys(ctx, h)
    this._drawRuler(ctx, clip, w)
    this._drawNotes(ctx, clip, w, h)
    this._drawVelocityLane(ctx, clip, w, h)
    if (this._drag && this._drag.type === 'draw-new') {
      this._drawNewNotePreview(ctx)
    }
  }

  destroy() {
    this._unsub()
    this._ro.disconnect()
    this._canvas.removeEventListener('mousedown', this._onMouseDown)
    this._canvas.removeEventListener('mousemove', this._onMouseMove)
    this._canvas.removeEventListener('mouseup',   this._onMouseUp)
    this._canvas.removeEventListener('wheel',     this._onWheel)
    this._canvas.remove()
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────────

  _gridH() { return this._canvas.height - RULER_H - VEL_H }
  _pitchToY(pitch) { return RULER_H + (MAX_PITCH - pitch) * NOTE_H - this._scrollTop }
  _yToPitch(y)     { return MAX_PITCH - Math.floor((y - RULER_H + this._scrollTop) / NOTE_H) }
  _beatToX(beat)   { return PIANO_W + beat * this._ppb - this._scrollLeft }
  _xToBeat(x)      { return (x - PIANO_W + this._scrollLeft) / this._ppb }

  // ── Draw helpers ──────────────────────────────────────────────────────────────

  _drawGrid(ctx, clip, w, h) {
    const gridH = this._gridH()

    // Row backgrounds
    for (let pitch = MAX_PITCH; pitch >= MIN_PITCH; pitch--) {
      const y = this._pitchToY(pitch)
      if (y + NOTE_H < RULER_H || y > RULER_H + gridH) continue
      const semitone = pitch % 12
      ctx.fillStyle = WHITE_SET.has(semitone) ? '#181818' : '#121212'
      ctx.fillRect(PIANO_W, y, w - PIANO_W, NOTE_H)
      // C separator
      if (semitone === 0) {
        ctx.strokeStyle = '#252525'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(PIANO_W, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
    }

    // Beat / quantize lines
    const startBeat = Math.max(0, Math.floor(this._xToBeat(PIANO_W)))
    const endBeat = Math.ceil(this._xToBeat(w))
    const q = this._quantize
    for (let b = startBeat; b <= endBeat; b += q) {
      const x = this._beatToX(b)
      if (x < PIANO_W || x > w) continue
      const isBeat = Math.abs(b - Math.round(b)) < 1e-9
      ctx.strokeStyle = isBeat ? '#2a2a2a' : '#1c1c1c'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, RULER_H)
      ctx.lineTo(x, RULER_H + gridH)
      ctx.stroke()
    }

    // Clip duration boundary
    const endX = this._beatToX(clip.duration || 16)
    if (endX > PIANO_W && endX < w) {
      ctx.strokeStyle = '#ff00aa33'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(endX, RULER_H)
      ctx.lineTo(endX, RULER_H + gridH)
      ctx.stroke()
    }
  }

  _drawPianoKeys(ctx, h) {
    const gridH = this._gridH()
    // Column background
    ctx.fillStyle = '#0e0e0e'
    ctx.fillRect(0, RULER_H, PIANO_W, gridH)

    for (let pitch = MAX_PITCH; pitch >= MIN_PITCH; pitch--) {
      const y = this._pitchToY(pitch)
      if (y + NOTE_H < RULER_H || y > RULER_H + gridH) continue
      const semitone = pitch % 12
      const isWhite = WHITE_SET.has(semitone)
      ctx.fillStyle = isWhite ? '#d0d0d0' : '#1a1a1a'
      ctx.fillRect(1, y + 1, PIANO_W - 2, NOTE_H - 1)
      if (semitone === 0) {
        ctx.fillStyle = '#555'
        ctx.font = '8px monospace'
        ctx.fillText(pitchName(pitch), 2, y + NOTE_H - 2)
      }
    }

    // Right border
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PIANO_W, RULER_H)
    ctx.lineTo(PIANO_W, RULER_H + gridH)
    ctx.stroke()
  }

  _drawRuler(ctx, clip, w) {
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, w, RULER_H)
    // Beat numbers
    const start = Math.max(0, Math.floor(this._xToBeat(PIANO_W)))
    const end   = Math.ceil(this._xToBeat(w))
    for (let b = start; b <= end; b++) {
      const x = this._beatToX(b)
      if (x < PIANO_W || x > w) continue
      ctx.strokeStyle = '#333'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, 4)
      ctx.lineTo(x, RULER_H)
      ctx.stroke()
      ctx.fillStyle = '#777'
      ctx.font = '9px monospace'
      ctx.fillText(b + 1, x + 2, RULER_H - 4)
    }
    // Bottom border
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, RULER_H)
    ctx.lineTo(w, RULER_H)
    ctx.stroke()
  }

  _drawNotes(ctx, clip, w, h) {
    const gridH = this._gridH()
    const notes = clip.notes || []
    for (const note of notes) {
      // Apply drag preview offsets
      let beat  = note.startBeat
      let pitch = note.pitch
      if (this._drag) {
        if (this._drag.type === 'move' && this._drag.noteId === note.id) {
          beat  = this._drag.previewBeat  ?? beat
          pitch = this._drag.previewPitch ?? pitch
        } else if (this._drag.type === 'move-selected' && this._selected.has(note.id)) {
          beat  = Math.max(0, snapBeat(note.startBeat + this._drag.dBeats, this._quantize))
          pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, note.pitch + this._drag.dSemi))
        }
      }

      const x  = this._beatToX(beat)
      const y  = this._pitchToY(pitch)
      const nw = Math.max(2, note.duration * this._ppb)

      if (x + nw < PIANO_W || x > w) continue
      if (y + NOTE_H < RULER_H || y > RULER_H + gridH) continue

      const sel = this._selected.has(note.id)
      ctx.fillStyle = sel ? '#ff00bb' : '#00e5ff'
      ctx.fillRect(x, y + 1, nw - 1, NOTE_H - 2)

      // Pitch label for wide enough notes
      if (nw > 24) {
        ctx.save()
        ctx.rect(x, y + 1, nw - 1, NOTE_H - 2)
        ctx.clip()
        ctx.fillStyle = '#000a'
        ctx.font = '8px monospace'
        ctx.fillText(pitchName(note.pitch), x + 2, y + NOTE_H - 2)
        ctx.restore()
      }
    }
  }

  _drawVelocityLane(ctx, clip, w, h) {
    const velY = h - VEL_H
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, velY, w, VEL_H)
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, velY)
    ctx.lineTo(w, velY)
    ctx.stroke()
    ctx.fillStyle = '#444'
    ctx.font = '8px monospace'
    ctx.fillText('VEL', 2, velY + 12)

    const notes = clip.notes || []
    const barW  = Math.max(2, 8)
    for (const note of notes) {
      const x = this._beatToX(note.startBeat)
      if (x < PIANO_W || x > w) continue
      const barH = Math.max(2, (note.velocity || 0.8) * (VEL_H - 8))
      const barY = h - 4 - barH
      const sel  = this._selected.has(note.id)
      ctx.fillStyle = sel ? '#ff00bb99' : '#00e5ff66'
      ctx.fillRect(x, barY, barW, barH)
    }
  }

  _drawNewNotePreview(ctx) {
    const { startBeat, pitch, endBeat } = this._drag
    const duration = Math.max(this._quantize, endBeat - startBeat)
    const x  = this._beatToX(startBeat)
    const y  = this._pitchToY(pitch)
    const nw = duration * this._ppb
    ctx.fillStyle = '#00e5ff55'
    ctx.strokeStyle = '#00e5ff'
    ctx.lineWidth = 1
    ctx.fillRect(x, y + 1, Math.max(2, nw - 1), NOTE_H - 2)
    ctx.strokeRect(x, y + 1, Math.max(2, nw - 1), NOTE_H - 2)
  }

  // ── Interaction ───────────────────────────────────────────────────────────────

  _getClip() {
    const state = this._store.getState()
    const track = state.tracks.find(t => t.id === this._trackId)
    return track ? track.clips.find(c => c.id === this._clipId) ?? null : null
  }

  _hitNote(mx, my, notes) {
    const h = this._canvas.height
    if (my > h - VEL_H || my < RULER_H || mx < PIANO_W) return null
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i]
      const x  = this._beatToX(note.startBeat)
      const y  = this._pitchToY(note.pitch)
      const nw = Math.max(2, note.duration * this._ppb)
      if (mx >= x && mx <= x + nw && my >= y && my <= y + NOTE_H) return note
    }
    return null
  }

  _onMouseDown(e) {
    const mx = e.offsetX
    const my = e.offsetY
    const clip = this._getClip()
    if (!clip) return
    const h = this._canvas.height
    const notes = clip.notes || []

    // ── Velocity lane ──────────────────────────────────────────────────────────
    if (my > h - VEL_H && mx > PIANO_W) {
      let closest = null; let minDist = Infinity
      for (const note of notes) {
        const d = Math.abs(mx - this._beatToX(note.startBeat))
        if (d < minDist) { minDist = d; closest = note }
      }
      if (closest && minDist < 20) {
        const frac = 1 - (my - (h - VEL_H)) / VEL_H
        this._store.dispatch(SetMidiNoteVelocity(this._trackId, this._clipId, closest.id, frac))
      }
      return
    }

    if (mx < PIANO_W) return

    const note = this._hitNote(mx, my, notes)

    if (this._tool === 'draw') {
      if (note) {
        // Move existing note
        this._drag = {
          type: 'move',
          noteId: note.id,
          origBeat:  note.startBeat,
          origPitch: note.pitch,
          startX: mx, startY: my,
          previewBeat:  note.startBeat,
          previewPitch: note.pitch
        }
      } else {
        // Draw new note
        const rawBeat  = this._xToBeat(mx)
        const startBeat = Math.max(0, snapBeat(rawBeat, this._quantize))
        const pitch     = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this._yToPitch(my)))
        this._drag = { type: 'draw-new', startBeat, pitch, endBeat: startBeat + this._quantize }
      }

    } else if (this._tool === 'select') {
      if (note) {
        if (!e.shiftKey && !this._selected.has(note.id)) this._selected.clear()
        this._selected.add(note.id)
        this._drag = {
          type: 'move-selected',
          startX: mx, startY: my,
          dBeats: 0, dSemi: 0,
          origNotes: notes.filter(n => this._selected.has(n.id))
            .map(n => ({ id: n.id, startBeat: n.startBeat, pitch: n.pitch }))
        }
      } else {
        this._selected.clear()
      }

    } else if (this._tool === 'erase') {
      if (note) this._store.dispatch(RemoveMidiNote(this._trackId, this._clipId, note.id))
      this._drag = { type: 'erase' }
    }

    this.render()
  }

  _onMouseMove(e) {
    if (!this._drag) return
    const mx = e.offsetX
    const my = e.offsetY
    const clip = this._getClip()
    if (!clip) return

    if (this._drag.type === 'draw-new') {
      const raw = this._xToBeat(mx)
      const snapped = snapBeat(raw, this._quantize)
      this._drag.endBeat = Math.max(this._drag.startBeat + this._quantize, snapped)
      this.render()

    } else if (this._drag.type === 'move') {
      const dBeats = (mx - this._drag.startX) / this._ppb
      const dSemi  = -Math.round((my - this._drag.startY) / NOTE_H)
      this._drag.previewBeat  = Math.max(0, snapBeat(this._drag.origBeat  + dBeats, this._quantize))
      this._drag.previewPitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this._drag.origPitch + dSemi))
      this.render()

    } else if (this._drag.type === 'move-selected') {
      this._drag.dBeats = (mx - this._drag.startX) / this._ppb
      this._drag.dSemi  = -Math.round((my - this._drag.startY) / NOTE_H)
      this.render()

    } else if (this._drag.type === 'erase') {
      const note = this._hitNote(mx, my, clip.notes || [])
      if (note) this._store.dispatch(RemoveMidiNote(this._trackId, this._clipId, note.id))
    }
  }

  _onMouseUp(e) {
    if (!this._drag) return
    const drag = this._drag
    this._drag = null

    if (drag.type === 'draw-new') {
      const duration = Math.max(this._quantize, drag.endBeat - drag.startBeat)
      this._store.dispatch(AddMidiNote(this._trackId, this._clipId, {
        id:        genNoteId(),
        pitch:     drag.pitch,
        startBeat: drag.startBeat,
        duration,
        velocity:  0.8
      }))

    } else if (drag.type === 'move') {
      this._store.dispatch(MoveMidiNote(
        this._trackId, this._clipId, drag.noteId,
        drag.previewBeat, drag.previewPitch
      ))

    } else if (drag.type === 'move-selected') {
      for (const orig of drag.origNotes) {
        const newBeat  = Math.max(0, snapBeat(orig.startBeat + drag.dBeats, this._quantize))
        const newPitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, orig.pitch + drag.dSemi))
        this._store.dispatch(MoveMidiNote(this._trackId, this._clipId, orig.id, newBeat, newPitch))
      }
    }
    this.render()
  }

  _onWheel(e) {
    e.preventDefault()
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this._scrollLeft = Math.max(0, this._scrollLeft + (e.deltaX || e.deltaY))
    } else {
      const maxScroll = Math.max(0, (MAX_PITCH - MIN_PITCH) * NOTE_H - this._gridH())
      this._scrollTop = Math.max(0, Math.min(maxScroll, this._scrollTop + e.deltaY))
    }
    this.render()
  }

  _onResize() {
    const rect = this._container.getBoundingClientRect()
    this._canvas.width  = rect.width  || this._container.offsetWidth
    this._canvas.height = rect.height || this._container.offsetHeight
    this.render()
  }
}
