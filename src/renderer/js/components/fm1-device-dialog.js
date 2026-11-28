// fm1-device-dialog.js — the FM-1's front panel for one track. A non-modal
// <dialog>: an LCD canvas fed by the track's session, with real <button> /
// role=slider elements laid over a scaled panel (geometry: fm1/panel-layout.js)
// so every control has a name and works from the keyboard.
// Closing only unsubscribes the LCD; the device keeps running.

import { openDialog } from '../ui/dialog.js'
import { ENCODERS, POT, BUTTONS, KEYS, LCD, boxStyle } from '../fm1/panel-layout.js'
import { fm1Descriptor, failureText, slowWarning } from '../fm1/descriptor.js'

export const DEVICE_DIALOG_ID = 'fm1-device-dialog'

const LCD_PX = 240
const ENC_WHEEL_PX = 40   // wheel distance per encoder click
const ENC_DRAG_PX = 12    // vertical drag per encoder click
const POT_STEP = 16

/** Status line text. Pure. `strained` = the audio broke up since the dialog opened. */
export function statusLine(status, { strained = false } = {}) {
  if (!status) return 'The device is not available.'
  if (status.state === 'booting') return 'Starting the device…'
  if (status.state === 'failed') return failureText(status.reason)
  if (status.state === 'disposed') return 'The device is stopped.'
  const rtf = Number.isFinite(status.rtf) ? ` · ${status.rtf.toFixed(1)}x realtime` : ''
  return `Running${rtf}${strained ? ' · Struggling to keep up: lower the clock in the instrument settings.' : ''}`
}

const make = (tag, className, attrs = {}) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  return node
}
const place = (node, shape) => Object.assign(node.style, boxStyle(shape))
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))

/**
 * deps: getSession(trackId) → session | null (acquires it if needed),
 *       getTrack(trackId) → track | null, compatFor(firmwareHash) → catalog compat | null
 */
export function createFm1DeviceDialog({ getSession, getTrack, compatFor }) {
  const dlg = document.getElementById(DEVICE_DIALOG_ID)
  const body = dlg?.querySelector('#fm1d-body')
  if (!dlg || !body) return null
  const title = dlg.querySelector('#fm1d-title')

  let session = null
  let unLcd = null
  let unStatus = null
  let strained = false
  let baseline = { underruns: 0, starved: 0 }
  const releasers = new Set()      // held controls, released when the dialog closes
  const leds = new Map()           // matrix id → element
  const pots = new Map()           // trackId → last pot value, so reopening shows where it was
  let trackId = null

  // ── DOM, built once ──────────────────────────────────────────────────────
  const statusEl = make('p', 'fm1d-status', { role: 'status', 'aria-live': 'polite' })
  const scroll = make('div', 'fm1d-scroll')
  const panel = make('div', 'fm1d-panel')
  scroll.append(panel)
  const noteEl = make('p', 'fm1d-note')
  const warnEl = make('p', 'fm1d-note')
  body.append(statusEl, scroll, noteEl, warnEl)

  const canvas = make('canvas', 'fm1d-lcd', { width: LCD_PX, height: LCD_PX, role: 'img', 'aria-label': 'FM-1 display' })
  place(canvas, LCD)
  panel.append(canvas)
  const lcd2d = canvas.getContext?.('2d') ?? null

  function pressable(node, id) {
    let held = false
    const down = () => { if (held) return; held = true; node.classList.add('down'); session?.key(id, true) }
    const up = () => { if (!held) return; held = false; node.classList.remove('down'); session?.key(id, false) }
    releasers.add(up)
    node.addEventListener('pointerdown', event => { event.preventDefault(); node.setPointerCapture?.(event.pointerId); down() })
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) node.addEventListener(type, up)
    node.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      if (!event.repeat) down()
    })
    node.addEventListener('keyup', event => { if (event.key === 'Enter' || event.key === ' ') up() })
    node.addEventListener('blur', up)
  }

  for (const def of BUTTONS) {
    const node = make('button', 'fm1d-btn', { type: 'button', 'aria-label': def.label })
    node.textContent = def.label
    const led = make('i', 'fm1d-led')
    node.append(led)
    leds.set(def.id, node)
    place(node, def)
    pressable(node, def.id)
    panel.append(node)
  }
  for (const def of KEYS) {
    const node = make('button', `fm1d-key${def.black ? ' black' : ''}`, { type: 'button', 'aria-label': `Key ${def.label}` })
    node.append(make('i', 'fm1d-led'))
    leds.set(def.id, node)
    place(node, def)
    pressable(node, def.id)
    panel.append(node)
  }

  for (const def of ENCODERS) {
    const node = make('div', 'fm1d-enc', { role: 'slider', tabindex: '0', 'aria-label': def.label, 'aria-valuetext': 'turn', 'aria-valuenow': '0' })
    const mark = make('i')
    node.append(mark, document.createTextNode(def.label))
    place(node, def)
    let turns = 0
    let wheel = 0
    let drag = 0
    const turn = clicks => {
      turns += clicks
      node.setAttribute('aria-valuenow', String(turns))
      node.setAttribute('aria-valuetext', `${turns} clicks`)
      mark.style.transform = `rotate(${(turns * 12) % 360}deg)`
      session?.enc(def.enc, clicks)
    }
    node.addEventListener('keydown', event => {
      const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[event.key]
      if (!step) return
      event.preventDefault()
      turn(step)
    })
    node.addEventListener('wheel', event => {
      event.preventDefault()
      wheel -= event.deltaY
      const clicks = Math.trunc(wheel / ENC_WHEEL_PX)
      if (clicks) { wheel -= clicks * ENC_WHEEL_PX; turn(clicks) }
    }, { passive: false })
    let lastY = null
    node.addEventListener('pointerdown', event => { lastY = event.clientY; drag = 0; node.setPointerCapture?.(event.pointerId) })
    node.addEventListener('pointermove', event => {
      if (lastY === null) return
      drag += lastY - event.clientY
      lastY = event.clientY
      const clicks = Math.trunc(drag / ENC_DRAG_PX)
      if (clicks) { drag -= clicks * ENC_DRAG_PX; turn(clicks) }
    })
    for (const type of ['pointerup', 'pointercancel']) node.addEventListener(type, () => { lastY = null })
    panel.append(node)
  }

  const pot = make('div', 'fm1d-pot', { role: 'slider', tabindex: '0', 'aria-label': POT.label, 'aria-valuemin': '0', 'aria-valuemax': String(POT.max) })
  const potMark = make('i')
  pot.append(potMark, document.createTextNode(POT.label))
  place(pot, POT)
  const showPot = value => {
    pot.setAttribute('aria-valuenow', String(value))
    potMark.style.transform = `rotate(${-135 + value / POT.max * 270}deg)`
  }
  const setPot = value => {
    const next = clamp(Math.round(value), 0, POT.max)
    pots.set(trackId, next)
    showPot(next)
    session?.pot(next)
  }
  const potValue = () => pots.get(trackId) ?? POT.initial
  pot.addEventListener('keydown', event => {
    const next = { ArrowUp: potValue() + POT_STEP, ArrowRight: potValue() + POT_STEP, ArrowDown: potValue() - POT_STEP, ArrowLeft: potValue() - POT_STEP,
      PageUp: potValue() + POT_STEP * 8, PageDown: potValue() - POT_STEP * 8, Home: 0, End: POT.max }[event.key]
    if (next === undefined) return
    event.preventDefault()
    setPot(next)
  })
  pot.addEventListener('wheel', event => { event.preventDefault(); setPot(potValue() - event.deltaY * 0.5) }, { passive: false })
  let potY = null
  pot.addEventListener('pointerdown', event => { potY = event.clientY; pot.setPointerCapture?.(event.pointerId) })
  pot.addEventListener('pointermove', event => {
    if (potY === null) return
    setPot(potValue() + (potY - event.clientY) * 4)
    potY = event.clientY
  })
  for (const type of ['pointerup', 'pointercancel']) pot.addEventListener(type, () => { potY = null })
  panel.append(pot)

  // ── Session binding ──────────────────────────────────────────────────────
  function drawLcd(rgba, ledValues) {
    if (lcd2d && rgba && typeof ImageData === 'function') lcd2d.putImageData(new ImageData(rgba, LCD_PX, LCD_PX), 0, 0)
    if (!ledValues) return
    for (const [id, node] of leds) node.style.setProperty('--led', String(ledValues[id] ?? 0))
  }

  function paintStatus() {
    const status = session?.status?.() ?? null
    if (status && (status.underruns > baseline.underruns || status.starved > baseline.starved)) strained = true
    statusEl.textContent = statusLine(status, { strained })
    statusEl.classList.toggle('warn', !status || status.state === 'failed' || strained)
  }

  function unbind() {
    unLcd?.(); unStatus?.()
    unLcd = unStatus = null
    for (const release of releasers) release()
    session = null
  }

  function bind(id) {
    unbind()
    trackId = id
    const track = getTrack(id)
    const descriptor = fm1Descriptor(track?.instrument)
    title.textContent = `FM-1 · ${track?.name || 'MIDI'}`
    session = getSession(id)
    strained = false
    const first = session?.status?.()
    baseline = { underruns: first?.underruns ?? 0, starved: first?.starved ?? 0 }
    showPot(potValue())
    noteEl.textContent = [
      session?.path === 'worker' ? 'Worker mode: about 100 ms latency on this connection.' : '',
      'Saves on the device are not kept yet.'
    ].filter(Boolean).join(' ')
    warnEl.textContent = slowWarning(descriptor.mhz, compatFor?.(descriptor.firmwareHash)) || ''
    paintStatus()
    if (!session) return
    unStatus = session.onStatus?.(paintStatus) ?? null
    unLcd = session.onLcd?.(drawLcd) ?? null
  }

  dlg.addEventListener('close', unbind)

  return {
    /** Open (or re-point) the panel at an FM-1 track. False if the track is not FM-1. */
    open(id) {
      const track = getTrack(id)
      if (track?.instrument?.type !== 'fm1') return false
      if (!dlg.open && !openDialog(DEVICE_DIALOG_ID, { modal: false })) return false
      bind(id)
      return true
    },
    close() { dlg.close?.() },
    isOpen: () => !!dlg.open
  }
}
