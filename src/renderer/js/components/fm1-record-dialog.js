// fm1-record-dialog.js — "Record FM-1 to audio track". One native modal <dialog> with
// three views driven by the flow's state: setup (source, start beat, length, tail, mute),
// recording (elapsed, level, Stop, Cancel) and a pending take (Retry, Save as WAV, Discard).
// Escape is Cancel while recording; with a pending take, closing asks twice before discarding.

import { openDialog, closeDialog } from '../ui/dialog.js'
import { parseOptions, isActive } from '../fm1/record-take.js'

export const RECORD_DIALOG_ID = 'fm1-record-dialog'

const make = (tag, className, attrs = {}) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  return node
}
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** deps: flow (createFm1RecordFlow), getTracks() -> [{id,name}] FM-1 tracks only, armedId() -> id | null */
export function createFm1RecordDialog({ flow, getTracks, armedId }) {
  const dlg = document.getElementById(RECORD_DIALOG_ID)
  const body = dlg?.querySelector('#fm1r-body')
  if (!dlg || !body) return null

  let confirming = false

  // ── setup view ───────────────────────────────────────────────────────────
  const field = (label, input) => {
    const row = make('div', 'dlg-row fm1r-field')
    const lab = make('label', 'dlg-label')
    lab.textContent = label
    lab.htmlFor = input.id
    row.append(lab, input)
    return row
  }
  const select = make('select', 'fm1r-source', { id: 'fm1r-source' })
  const startBeat = make('input', 'fm1r-beat', { id: 'fm1r-beat', type: 'number', min: '0', step: '1', value: '0' })
  const bars = make('input', 'fm1r-bars', { id: 'fm1r-bars', type: 'number', min: '1', step: '1', placeholder: 'until Stop' })
  const tail = make('input', 'fm1r-tail', { id: 'fm1r-tail', type: 'number', min: '0', max: '10', step: '0.5', value: '2' })
  const mute = make('input', 'fm1r-mute', { id: 'fm1r-mute', type: 'checkbox' })
  const muteRow = make('div', 'dlg-row fm1r-field')
  const muteLab = make('label', 'dlg-label')
  muteLab.htmlFor = 'fm1r-mute'
  muteLab.textContent = 'Mute source track after recording'
  muteRow.append(mute, muteLab)
  const startBtn = make('button', 'btn fm1r-start', { type: 'button' })
  startBtn.textContent = 'Start'
  const setup = make('div', 'fm1r-view fm1r-setup')
  setup.append(field('SOURCE TRACK', select), field('START BEAT', startBeat), field('LENGTH (BARS)', bars), field('TAIL (SECONDS)', tail), muteRow, startBtn)

  // ── recording view ───────────────────────────────────────────────────────
  const phaseEl = make('output', 'fm1r-phase lcd', { 'aria-live': 'off' })
  const elapsedEl = make('output', 'fm1r-elapsed lcd')
  const meter = make('meter', 'fm1r-meter', { min: '0', max: '1', value: '0', 'aria-label': 'Input level' })
  const stopBtn = make('button', 'btn fm1r-stop', { type: 'button' })
  stopBtn.textContent = 'Stop'
  const cancelBtn = make('button', 'btn fm1r-cancel', { type: 'button' })
  cancelBtn.textContent = 'Cancel'
  const running = make('div', 'fm1r-view fm1r-running')
  const runRow = make('div', 'dlg-row')
  runRow.append(stopBtn, cancelBtn)
  running.append(phaseEl, elapsedEl, meter, runRow)

  // ── pending view ─────────────────────────────────────────────────────────
  const retryBtn = make('button', 'btn fm1r-retry', { type: 'button' })
  retryBtn.textContent = 'Retry'
  const saveAsBtn = make('button', 'btn fm1r-saveas', { type: 'button' })
  saveAsBtn.textContent = 'Save as WAV…'
  const discardBtn = make('button', 'btn fm1r-discard', { type: 'button' })
  discardBtn.textContent = 'Discard take'
  const confirmText = make('p', 'fm1r-confirm dlg-note')
  confirmText.textContent = 'Discard take? It has not been saved anywhere.'
  const keepBtn = make('button', 'btn fm1r-keep', { type: 'button' })
  keepBtn.textContent = 'Keep'
  const reallyBtn = make('button', 'btn fm1r-really', { type: 'button' })
  reallyBtn.textContent = 'Discard'
  const confirmRow = make('div', 'dlg-row')
  confirmRow.append(keepBtn, reallyBtn)
  const pendingRow = make('div', 'dlg-row')
  pendingRow.append(retryBtn, saveAsBtn, discardBtn)
  const pendingView = make('div', 'fm1r-view fm1r-pending')
  pendingView.append(pendingRow, confirmText, confirmRow)

  const msg = make('p', 'fm1r-msg dlg-note', { role: 'status', 'aria-live': 'polite' })
  body.append(setup, running, pendingView, msg)

  // ── behavior ─────────────────────────────────────────────────────────────
  function fillSources() {
    const tracks = getTracks()
    const keep = select.value
    select.replaceChildren(...tracks.map(t => {
      const o = make('option', '', { value: t.id })
      o.textContent = t.name
      return o
    }))
    const want = tracks.some(t => t.id === keep) ? keep : (tracks.some(t => t.id === armedId()) ? armedId() : tracks[0]?.id)
    if (want) select.value = want
    return tracks.length
  }

  function render() {
    const s = flow.state()
    const phase = s.phase
    const busy = isActive(phase)
    const pend = phase === 'pending'
    setup.hidden = busy || pend
    running.hidden = !busy
    pendingView.hidden = !pend
    confirmText.hidden = confirmRow.hidden = !(pend && confirming)
    pendingRow.hidden = pend && confirming
    const n = getTracks().length
    startBtn.disabled = n === 0
    phaseEl.textContent = phase === 'arming' ? 'STARTING' : phase === 'recording' ? 'RECORDING' : phase === 'tail' ? 'TAIL' : phase === 'saving' ? 'SAVING' : ''
    elapsedEl.textContent = mmss(s.elapsed)
    meter.value = s.peak
    stopBtn.disabled = phase !== 'recording'
    cancelBtn.disabled = phase === 'saving'
    retryBtn.disabled = !s.canRetry
    const note = s.error ?? s.notice ?? (phase === 'done' ? 'Take added as a new audio track.' : n === 0 ? 'Add an FM-1 track first.' : '')
    msg.textContent = note
  }

  // Escape / ✕: cancel a recording; a pending take needs a second yes.
  function requestClose() {
    const phase = flow.state().phase
    if (phase === 'saving') return
    if (isActive(phase)) { flow.cancel(); return closeDialog(RECORD_DIALOG_ID) }
    if (phase === 'pending') {
      if (confirming) { confirming = false; return render() }   // second Escape = keep
      confirming = true
      return render()
    }
    if (phase === 'done') flow.reset()
    closeDialog(RECORD_DIALOG_ID)
  }

  dlg.addEventListener('cancel', event => { event.preventDefault(); requestClose() })
  dlg.querySelector('.dlg-close-btn')?.addEventListener('click', requestClose)
  startBtn.addEventListener('click', () => {
    const parsed = parseOptions({ startBeat: startBeat.value, bars: bars.value, tail: tail.value, mute: mute.checked })
    if (parsed.error) { msg.textContent = parsed.error; return }
    if (!select.value) return
    flow.start({ trackId: select.value, ...parsed.opts })
  })
  stopBtn.addEventListener('click', () => flow.stop())
  cancelBtn.addEventListener('click', requestClose)
  retryBtn.addEventListener('click', () => flow.retry())
  saveAsBtn.addEventListener('click', () => flow.saveAs())
  discardBtn.addEventListener('click', () => { confirming = true; render() })
  keepBtn.addEventListener('click', () => { confirming = false; render() })
  reallyBtn.addEventListener('click', () => { confirming = false; flow.cancel(); closeDialog(RECORD_DIALOG_ID) })
  flow.onChange(render)

  return {
    open() {
      confirming = false
      if (flow.state().phase === 'done') flow.reset()
      fillSources()
      render()
      return openDialog(RECORD_DIALOG_ID)
    },
    isOpen: () => dlg.open,
    refresh() { fillSources(); render() },
  }
}
