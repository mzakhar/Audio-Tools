/**
 * dialog.js
 * Thin imperative shell over the native <dialog> element.
 *
 * openDialog(id, opts) → showModal(), push a shortcut context.
 * closeDialog(id)      → .close(); the 'close' listener does the restoring,
 *                        so Esc, a close button and a programmatic close all
 *                        restore state identically.
 */

import ShortcutManager from '../shortcuts.js'

// Open dialogs, innermost last. A stack rather than a per-id "previous
// context" because <dialog>.close() fires its close event on a queued task:
// closing one dialog and opening another in the same tick would otherwise let
// the first dialog's late restore stamp its context over the second's.
const _stack = []
let _baseContext = null

function restore(id) {
  const index = _stack.findIndex(entry => entry.id === id)
  if (index === -1) return // already restored
  const [entry] = _stack.splice(index, 1)
  entry.el.removeEventListener('close', entry.onCloseEvent)
  // Whatever is still open owns the keyboard; only the last one out restores.
  ShortcutManager.setContext(_stack.length ? _stack[_stack.length - 1].context : _baseContext)
  if (!_stack.length) _baseContext = null
  entry.onClose?.()
  const focus = entry.previousFocus
  // The opener may have been re-rendered or hidden while the dialog was open —
  // focusing a dead node is worse than leaving focus where the browser put it.
  if (focus?.isConnected && !focus.hidden && typeof focus.focus === 'function') focus.focus()
}

export function openDialog(id, { context = 'dialog', onClose } = {}) {
  const el = document.getElementById(id)
  if (!el || typeof el.showModal !== 'function') return false
  // An entry whose element left the DOM (a re-rendered view, a torn-down test)
  // is stale: its close event can never arrive, so it must not block reopening.
  for (const entry of [..._stack]) if (!entry.el.isConnected) restore(entry.id)
  // A second open would push a duplicate entry and leak a close listener.
  if (el.open || _stack.some(entry => entry.id === id)) return false

  if (!_stack.length) _baseContext = ShortcutManager.getContext()
  const entry = { id, el, context, onClose, previousFocus: document.activeElement, onCloseEvent: () => restore(id) }
  _stack.push(entry)
  el.addEventListener('close', entry.onCloseEvent)

  el.showModal()
  ShortcutManager.setContext(context)
  return true
}

export function closeDialog(id) {
  const el = document.getElementById(id)
  if (!el || typeof el.close !== 'function') return false
  el.close()
  // The close event is queued, so restore here too: callers that close one
  // dialog and open another in the same tick must see the context settled.
  restore(id)
  return true
}

export function isOpen(id) {
  const el = document.getElementById(id)
  return !!(el && el.open)
}
