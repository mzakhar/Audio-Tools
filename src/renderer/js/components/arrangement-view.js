/**
 * arrangement-view.js
 * Canvas-based arrangement timeline with LOD waveform rendering,
 * drag/trim interaction, and track header overlay.
 */

import {
  beatsToPx,
  rulerTicks,
  selectLodLevel,
  samplesPerPixel,
  visibleBeatRange
} from '../utils/timeline-math.js'

import ProjectStore, { MoveClip, TrimClip } from '../store/ProjectStore.js'
import AudioStore from '../audio-store.js'

// Layout constants
const TRACK_HEADER_W = 160  // px — left sidebar with track names
const RULER_H        = 32   // px — top ruler bar
const TRACK_H        = 72   // px — height per track row
const DEFAULT_PPB    = 40   // pixels per beat at default zoom

/**
 * Hit-test a clip against a mouse position.
 * @param {object} clip
 * @param {number} mouseX
 * @param {number} trackY  (unused currently, kept for signature parity)
 * @param {number} ppb
 * @param {number} scrollLeft
 * @param {number} trackHeaderW
 * @param {number} trackH  (unused currently, kept for signature parity)
 * @returns {'trim-left'|'trim-right'|'body'|null}
 */
export function hitTestClip(clip, mouseX, trackY, ppb, scrollLeft, trackHeaderW, trackH) {
  const clipX = beatsToPx(clip.startBeat, ppb) - scrollLeft + trackHeaderW
  const clipW = beatsToPx(clip.duration, ppb)
  const EDGE = 8 // px hit zone for trim handles

  if (mouseX < clipX || mouseX > clipX + clipW) return null
  if (mouseX < clipX + EDGE) return 'trim-left'
  if (mouseX > clipX + clipW - EDGE) return 'trim-right'
  return 'body'
}

export class ArrangementView {
  constructor(container, { store, audioStore }) {
    this._store = store || ProjectStore
    this._audioStore = audioStore || AudioStore
    this._container = container

    this._ppb = DEFAULT_PPB
    this._scrollLeft = 0
    this._scrollTop = 0
    this._playheadBeat = 0
    this._drag = null

    // Wrapper div
    this._wrapper = document.createElement('div')
    this._wrapper.className = 'arrangement-wrapper'
    container.appendChild(this._wrapper)

    // Main canvas
    this._canvas = document.createElement('canvas')
    this._canvas.setAttribute('role', 'application')
    this._canvas.setAttribute('aria-label', 'Arrangement timeline. Double-click MIDI clips to open piano roll.')
    this._canvas.setAttribute('tabindex', '0')
    this._wrapper.appendChild(this._canvas)
    this._ctx = this._canvas.getContext('2d')

    // Track header overlay
    this._headerList = document.createElement('div')
    this._headerList.className = 'track-header-list'
    this._wrapper.appendChild(this._headerList)

    this._selectedTrackId = null

    // Attach mouse events
    this._onMouseDown = this._onMouseDown.bind(this)
    this._onMouseMove = this._onMouseMove.bind(this)
    this._onMouseUp   = this._onMouseUp.bind(this)
    this._onDblClick  = this._onDblClick.bind(this)
    this._canvas.addEventListener('mousedown', this._onMouseDown)
    this._canvas.addEventListener('mousemove', this._onMouseMove)
    this._canvas.addEventListener('mouseup',   this._onMouseUp)
    this._canvas.addEventListener('dblclick',  this._onDblClick)

    // ResizeObserver
    this._resizeObserver = new ResizeObserver(() => this._onResize())
    this._resizeObserver.observe(container)
    this._onResize()

    // Subscribe to store
    this._unsub = this._store.subscribe(() => this.render())
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setPixelsPerBeat(ppb) {
    this._ppb = ppb
    this.render()
  }

  setScrollLeft(px) {
    this._scrollLeft = px
    this.render()
  }

  setScrollTop(px) {
    this._scrollTop = px
    this.render()
  }

  setPlayheadBeat(beat) {
    this._playheadBeat = beat
  }

  render() {
    const state = this._store.getState()
    const ctx = this._ctx
    const w = this._canvas.width
    const h = this._canvas.height

    ctx.clearRect(0, 0, w, h)
    this._drawRuler(ctx, state)
    this._drawTracks(ctx, state)
    this._drawPlayhead(ctx, state)
    this._updateTrackHeaders(state)
  }

  destroy() {
    this._unsub()
    this._canvas.removeEventListener('mousedown', this._onMouseDown)
    this._canvas.removeEventListener('mousemove', this._onMouseMove)
    this._canvas.removeEventListener('mouseup',   this._onMouseUp)
    this._canvas.removeEventListener('dblclick',  this._onDblClick)
    this._resizeObserver.disconnect()
    this._wrapper.remove()
  }

  // ── Resize ──────────────────────────────────────────────────────────────────

  _onResize() {
    const rect = this._container.getBoundingClientRect()
    this._canvas.width  = rect.width  || this._container.offsetWidth
    this._canvas.height = rect.height || this._container.offsetHeight
    this.render()
  }

  // ── Draw methods ─────────────────────────────────────────────────────────────

  _drawRuler(ctx, state) {
    const w = this._canvas.width
    ctx.fillStyle = '#141414'
    ctx.fillRect(0, 0, w, RULER_H)

    const { startBeat, endBeat } = visibleBeatRange(this._scrollLeft, w - TRACK_HEADER_W, this._ppb)
    const ticks = rulerTicks(startBeat, endBeat, this._ppb, state.timeSignature, this._scrollLeft)

    for (const tick of ticks) {
      const x = tick.x + TRACK_HEADER_W
      if (x < TRACK_HEADER_W || x > w) continue

      if (tick.isBar) {
        ctx.strokeStyle = '#555'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, RULER_H)
        ctx.stroke()

        if (tick.label) {
          ctx.fillStyle = '#aaa'
          ctx.font = '10px monospace'
          ctx.fillText(tick.label, x + 3, RULER_H - 8)
        }
      } else {
        ctx.strokeStyle = '#333'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, RULER_H * 0.5)
        ctx.lineTo(x, RULER_H)
        ctx.stroke()
      }
    }

    // Ruler bottom border
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, RULER_H)
    ctx.lineTo(w, RULER_H)
    ctx.stroke()
  }

  _drawTracks(ctx, state) {
    const w = this._canvas.width
    const h = this._canvas.height
    const tracks = state.tracks || []

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      const trackY = RULER_H + i * TRACK_H - this._scrollTop

      if (trackY + TRACK_H < RULER_H || trackY > h) continue

      // Alternating row backgrounds
      ctx.fillStyle = i % 2 === 0 ? '#141414' : '#181818'
      ctx.fillRect(TRACK_HEADER_W, trackY, w - TRACK_HEADER_W, TRACK_H)

      // Row separator
      ctx.strokeStyle = '#2a2a2a'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(TRACK_HEADER_W, trackY + TRACK_H - 0.5)
      ctx.lineTo(w, trackY + TRACK_H - 0.5)
      ctx.stroke()

      // Draw clips
      const clips = track.clips || []
      for (const clip of clips) {
        if (clip.type === 'audio') {
          this._drawClip(ctx, clip, trackY, state)
        } else if (clip.type === 'midi') {
          this._drawMidiClip(ctx, clip, trackY)
        }
      }
    }
  }

  _drawClip(ctx, clip, trackY, state) {
    const w = this._canvas.width
    const clipX = beatsToPx(clip.startBeat, this._ppb) - this._scrollLeft + TRACK_HEADER_W
    const clipW = beatsToPx(clip.duration, this._ppb)

    // Off-screen culling
    if (clipX + clipW < TRACK_HEADER_W) return
    if (clipX > w) return

    const clipPad = 2
    const clipH = TRACK_H - clipPad * 2
    const clipDrawY = trackY + clipPad

    // Check if drag preview modifies this clip
    let drawX = clipX
    let drawW = clipW
    if (this._drag && this._drag.clipId === clip.id) {
      const deltaBeats = (this._drag.currentX - this._drag.startX) / this._ppb
      if (this._drag.type === 'body') {
        const newStart = Math.max(0, this._drag.origStartBeat + deltaBeats)
        drawX = beatsToPx(newStart, this._ppb) - this._scrollLeft + TRACK_HEADER_W
      } else if (this._drag.type === 'trim-left') {
        const newOffset = this._drag.origOffset + deltaBeats
        const newDuration = this._drag.origDuration - deltaBeats
        if (newDuration > 0.1) {
          drawX = beatsToPx(clip.startBeat + deltaBeats, this._ppb) - this._scrollLeft + TRACK_HEADER_W
          drawW = beatsToPx(newDuration, this._ppb)
        }
      } else if (this._drag.type === 'trim-right') {
        const newDuration = Math.max(0.1, this._drag.origDuration + deltaBeats)
        drawW = beatsToPx(newDuration, this._ppb)
      }
    }

    // Clip body
    ctx.fillStyle = '#1e2a30'
    ctx.strokeStyle = '#00e5ff55'
    ctx.lineWidth = 1
    ctx.fillRect(drawX, clipDrawY, drawW, clipH)
    ctx.strokeRect(drawX + 0.5, clipDrawY + 0.5, drawW - 1, clipH - 1)

    // Clip label
    const label = clip.name || (clip.file ? clip.file.split('/').pop() : 'clip')
    ctx.fillStyle = '#aaa'
    ctx.font = '9px monospace'
    ctx.save()
    ctx.rect(drawX, clipDrawY, drawW, clipH)
    ctx.clip()
    ctx.fillText(label, drawX + 4, clipDrawY + 12)

    // Waveform or placeholder
    if (this._audioStore.isLodReady(clip.file)) {
      this._drawWaveform(ctx, clip, drawX, trackY, drawW, state)
    } else {
      ctx.fillStyle = '#00e5ff22'
      ctx.fillRect(drawX + 1, clipDrawY + 1, drawW - 2, clipH - 2)
      ctx.fillStyle = '#555'
      ctx.font = '9px monospace'
      ctx.fillText('Loading...', drawX + 4, clipDrawY + clipH / 2 + 4)
    }

    ctx.restore()
  }

  _drawWaveform(ctx, clip, clipX, trackY, clipW, state) {
    const spp = samplesPerPixel(this._ppb, state.bpm, state.sampleRate)
    const level = selectLodLevel(spp)
    const lod = this._audioStore.getLod(clip.file, level)
    if (!lod) return

    const clipPad = 2
    const clipDrawY = trackY + clipPad
    const clipH = TRACK_H - clipPad * 2
    const midY = clipDrawY + clipH / 2
    const halfH = (clipH - 18) / 2 // leave room for label

    const secPerBeat = 60 / state.bpm
    const startSample = (clip.offset || 0) * state.sampleRate * secPerBeat
    const maxPx = Math.min(clipW, this._canvas.width - clipX)

    for (let px = 0; px < maxPx; px++) {
      const sampleIdx = startSample + px * spp
      const bucket = Math.floor(sampleIdx / level)
      if (bucket * 2 + 1 >= lod.length) break

      const peak = lod[bucket * 2]
      const rms  = lod[bucket * 2 + 1]

      // RMS bar
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(clipX + px, midY - rms * halfH)
      ctx.lineTo(clipX + px, midY + rms * halfH)
      ctx.stroke()

      // Peak markers
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.7)'
      ctx.beginPath()
      ctx.moveTo(clipX + px, midY - peak * halfH)
      ctx.lineTo(clipX + px, midY - peak * halfH + 1)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(clipX + px, midY + peak * halfH)
      ctx.lineTo(clipX + px, midY + peak * halfH - 1)
      ctx.stroke()
    }
  }

  _drawMidiClip(ctx, clip, trackY) {
    const w = this._canvas.width
    const clipX = beatsToPx(clip.startBeat, this._ppb) - this._scrollLeft + TRACK_HEADER_W
    const clipW = beatsToPx(clip.duration || 4, this._ppb)
    if (clipX + clipW < TRACK_HEADER_W || clipX > w) return

    const pad = 2
    const clipH = TRACK_H - pad * 2
    const clipDrawY = trackY + pad

    // Body
    ctx.fillStyle = '#1a2620'
    ctx.strokeStyle = '#39ff1455'
    ctx.lineWidth = 1
    ctx.fillRect(clipX, clipDrawY, clipW, clipH)
    ctx.strokeRect(clipX + 0.5, clipDrawY + 0.5, clipW - 1, clipH - 1)

    // Label
    ctx.fillStyle = '#aaa'
    ctx.font = '9px monospace'
    ctx.save()
    ctx.rect(clipX, clipDrawY, clipW, clipH)
    ctx.clip()
    ctx.fillText(clip.name || 'MIDI', clipX + 4, clipDrawY + 12)

    // Mini note bars
    const notes = clip.notes || []
    if (notes.length) {
      const pitches = notes.map(n => n.pitch)
      const minP = Math.min(...pitches)
      const maxP = Math.max(...pitches)
      const pitchRange = Math.max(1, maxP - minP)
      const noteAreaH = clipH - 14

      for (const note of notes) {
        const nx = clipX + beatsToPx(note.startBeat, this._ppb)
        const nw = Math.max(1, beatsToPx(note.duration, this._ppb) - 1)
        const ny = clipDrawY + 14 + (1 - (note.pitch - minP) / pitchRange) * (noteAreaH - 2)
        if (nx > clipX && nx < clipX + clipW) {
          ctx.fillStyle = '#39ff14bb'
          ctx.fillRect(nx, ny, nw, 2)
        }
      }
    }

    ctx.restore()
  }

  _drawPlayhead(ctx, state) {
    const x = beatsToPx(this._playheadBeat, this._ppb) - this._scrollLeft + TRACK_HEADER_W
    if (x < TRACK_HEADER_W || x > this._canvas.width) return

    ctx.strokeStyle = '#ff00aa'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x, RULER_H)
    ctx.lineTo(x, this._canvas.height)
    ctx.stroke()
  }

  // ── Track headers ────────────────────────────────────────────────────────────

  _updateTrackHeaders(state) {
    const tracks = state.tracks || []
    const items = this._headerList.querySelectorAll('.track-header-item')

    // Add missing divs
    while (this._headerList.children.length < tracks.length) {
      const div = document.createElement('div')
      div.className = 'track-header-item'

      const name = document.createElement('span')
      name.className = 'track-name'

      const muteBtn = document.createElement('button')
      muteBtn.className = 'mute-btn'
      muteBtn.textContent = 'M'

      const soloBtn = document.createElement('button')
      soloBtn.className = 'solo-btn'
      soloBtn.textContent = 'S'

      div.append(name, muteBtn, soloBtn)
      this._headerList.appendChild(div)
    }

    // Remove excess divs
    while (this._headerList.children.length > tracks.length) {
      this._headerList.removeChild(this._headerList.lastChild)
    }

    // Sync each header item
    const headerItems = this._headerList.querySelectorAll('.track-header-item')
    tracks.forEach((track, i) => {
      const item = headerItems[i]
      const nameEl = item.querySelector('.track-name')
      nameEl.textContent = track.name || 'Track'

      const top = RULER_H + i * TRACK_H - this._scrollTop
      item.style.top = top + 'px'
      item.style.height = TRACK_H + 'px'
      item.style.position = 'absolute'
      item.style.width = '160px'

      // Channel lookup for mute/solo state
      const channel = state.mixer.channels.find(ch => ch.id === track.mixerChannelId)
      const muteBtn = item.querySelector('.mute-btn')
      const soloBtn = item.querySelector('.solo-btn')

      if (channel) {
        muteBtn.className = 'mute-btn' + (channel.mute ? ' active' : '')
        soloBtn.className = 'solo-btn' + (channel.solo ? ' active' : '')
      }
    })
  }

  // ── Mouse interaction ────────────────────────────────────────────────────────

  _onMouseDown(e) {
    const state = this._store.getState()
    const tracks = state.tracks || []
    const mx = e.offsetX
    const my = e.offsetY

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      const trackY = RULER_H + i * TRACK_H - this._scrollTop

      if (my < trackY || my > trackY + TRACK_H) continue
      this._selectedTrackId = track.id
      document.dispatchEvent(new CustomEvent('track-selected', { detail: { trackId: track.id } }))

      const clips = track.clips || []
      for (const clip of clips) {
        if (clip.type !== 'audio') continue
        const hitType = hitTestClip(clip, mx, trackY, this._ppb, this._scrollLeft, TRACK_HEADER_W, TRACK_H)
        if (hitType) {
          this._drag = {
            type: hitType,
            clipId: clip.id,
            trackId: track.id,
            startX: mx,
            currentX: mx,
            origStartBeat: clip.startBeat,
            origOffset: clip.offset || 0,
            origDuration: clip.duration
          }
          return
        }
      }
    }
  }

  _onDblClick(e) {
    const state = this._store.getState()
    const tracks = state.tracks || []
    const mx = e.offsetX
    const my = e.offsetY

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      const trackY = RULER_H + i * TRACK_H - this._scrollTop
      if (my < trackY || my > trackY + TRACK_H) continue

      for (const clip of track.clips || []) {
        if (clip.type === 'midi') {
          const clipX = beatsToPx(clip.startBeat, this._ppb) - this._scrollLeft + TRACK_HEADER_W
          const clipW = beatsToPx(clip.duration || 4, this._ppb)
          if (mx >= clipX && mx <= clipX + clipW) {
            document.dispatchEvent(new CustomEvent('open-piano-roll', {
              detail: { trackId: track.id, clipId: clip.id, clipName: clip.name || 'MIDI' }
            }))
            return
          }
        }
      }
    }
  }

  _onMouseMove(e) {
    if (!this._drag) return
    this._drag.currentX = e.offsetX
    this.render()
  }

  _onMouseUp(e) {
    if (!this._drag) return

    const drag = this._drag
    this._drag = null

    const deltaBeats = (e.offsetX - drag.startX) / this._ppb

    if (drag.type === 'body') {
      const newStartBeat = Math.max(0, drag.origStartBeat + deltaBeats)
      this._store.dispatch(MoveClip(drag.trackId, drag.clipId, newStartBeat))
    } else if (drag.type === 'trim-left') {
      const newOffset = drag.origOffset + deltaBeats
      const newDuration = Math.max(0.1, drag.origDuration - deltaBeats)
      this._store.dispatch(TrimClip(drag.trackId, drag.clipId, newOffset, newDuration))
    } else if (drag.type === 'trim-right') {
      const newDuration = Math.max(0.1, drag.origDuration + deltaBeats)
      this._store.dispatch(TrimClip(drag.trackId, drag.clipId, drag.origOffset, newDuration))
    }
  }
}
