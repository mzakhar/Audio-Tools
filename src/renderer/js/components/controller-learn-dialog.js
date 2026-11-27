// controller-learn-dialog.js — "Controller map…": click an action, move a
// control on the device, and that control now does it. Overrides live in
// localStorage per device name (a per-user hardware fact, not the project).
// The pure parts (load/save/learn) are exported; the dialog is a thin shell.

import { openDialog } from '../ui/dialog.js'
import { learnKey } from '../pads/profile.js'

export const LEARN_DIALOG_ID = 'controller-learn-dialog'
export const storageKey = device => `synth_pads_map_${device}`

export const LEARN_ACTIONS = [
  ['play', 'Play / stop'], ['layer', 'Layer'], ['repeat', 'Repeat'], ['wipe', 'Wipe'], ['full', 'Full'], ['overlay', 'Overlay'],
  ...Array.from({ length: 8 }, (_, i) => [`knob:${i}`, `Knob ${i + 1}`])
]

export function loadOverrides(storage, device) {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(device)) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function saveOverrides(storage, device, map) {
  try {
    if (Object.keys(map).length) storage.setItem(storageKey(device), JSON.stringify(map))
    else storage.removeItem(storageKey(device))
  } catch {}
}

/** Pure: bind `key` to `action`, dropping any earlier control bound to that action. */
export function learnInto(map, key, action) {
  const next = Object.fromEntries(Object.entries(map).filter(([, a]) => a !== action))
  next[key] = action
  return next
}

/** The control key an action is bound to in `map`, if learned. */
const keyOf = (map, action) => Object.keys(map).find(k => map[k] === action)

/**
 * getDevice() -> device name | null; isConnected() -> bool; onChange(device) after a save/reset;
 * router.capture is set while an action is armed.
 */
export function createControllerLearn({ storage = localStorage, getDevice, isConnected, router, onChange = () => {}, root = document }) {
  let armed = null
  let map = {}
  const $ = id => root.getElementById(id)

  function capture(detail, device) {
    if (!armed) return
    const key = detail.kind === 'cc' || detail.kind === 'note-on' ? learnKey(detail) : null
    if (!key) return
    map = learnInto(map, key, armed)
    saveOverrides(storage, device, map)
    armed = null
    router.capture = null
    render()
    onChange(device)
  }

  function render() {
    const list = $('controller-learn-list')
    const device = getDevice()
    const dev = $('controller-learn-device')
    const note = $('controller-learn-note')
    if (!list) return
    const live = !!device && isConnected()
    if (dev) dev.textContent = live ? device : 'no device'
    if (note) note.textContent = live
      ? (armed ? 'Move or press the control you want…' : 'Pick an action, then move a control on the device.')
      : 'No MIDI device connected. Web MIDI needs https or the desktop app; it does not exist on the plain-http LAN address.'
    list.innerHTML = ''
    for (const [action, label] of LEARN_ACTIONS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn'
      btn.dataset.action = action
      btn.disabled = !live
      btn.setAttribute('aria-pressed', String(armed === action))
      const key = keyOf(map, action)
      btn.textContent = `${label}: ${armed === action ? '…' : key ?? 'default'}`
      btn.addEventListener('click', () => {
        armed = armed === action ? null : action
        router.capture = armed ? capture : null
        render()
      })
      list.appendChild(btn)
    }
  }

  function open() {
    const device = getDevice()
    map = device ? loadOverrides(storage, device) : {}
    armed = null
    render()
    return openDialog(LEARN_DIALOG_ID, { onClose: () => { armed = null; router.capture = null } })
  }

  $('controller-learn-reset')?.addEventListener('click', () => {
    const device = getDevice()
    if (!device) return
    map = {}
    saveOverrides(storage, device, map)
    armed = null
    router.capture = null
    render()
    onChange(device)
  })

  return { open, render }
}
