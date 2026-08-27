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

// id → previous context, so a stray double 'close' event restores once.
const _pending = new Map()

export function openDialog(id, { context = 'dialog', onClose } = {}) {
  const el = document.getElementById(id)
  if (!el || typeof el.showModal !== 'function') return false
  // A second open would capture the dialog's own context as "previous" and
  // leave a second close listener behind, stranding ShortcutManager forever.
  if (el.open) return false

  const previousContext = ShortcutManager.getContext()
  const previousFocus = document.activeElement

  el.showModal()
  ShortcutManager.setContext(context)

  const restore = () => {
    if (!_pending.has(id)) return // already restored
    _pending.delete(id)
    ShortcutManager.setContext(previousContext)
    if (onClose) onClose()
    // The element that opened the dialog may have been re-rendered or hidden
    // while it was open — falling back to nothing beats focusing a dead node.
    if (previousFocus?.isConnected && !previousFocus.hidden && typeof previousFocus.focus === 'function') previousFocus.focus()
    el.removeEventListener('close', restore)
  }

  _pending.set(id, true)
  el.addEventListener('close', restore)

  return true
}

export function closeDialog(id) {
  const el = document.getElementById(id)
  if (!el || typeof el.close !== 'function') return false
  el.close()
  return true
}

export function isOpen(id) {
  const el = document.getElementById(id)
  return !!(el && el.open)
}
