// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { openDialog, closeDialog, isOpen } from '../src/renderer/js/ui/dialog.js'
import ShortcutManager from '../src/renderer/js/shortcuts.js'

function makeDialog(id) {
  const el = document.createElement('dialog')
  el.id = id
  document.body.appendChild(el)
  // jsdom does not implement showModal/close; stub them like a real <dialog>.
  el.showModal = () => { el.open = true }
  el.close = () => {
    if (!el.open) return
    el.open = false
    el.dispatchEvent(new Event('close'))
  }
  return el
}

describe('dialog', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    ShortcutManager.setContext('global')
  })

  it('returns false and does nothing for a missing id', () => {
    expect(() => openDialog('nope')).not.toThrow()
    expect(openDialog('nope')).toBe(false)
    expect(closeDialog('nope')).toBe(false)
  })

  it('returns false for an element without showModal', () => {
    const el = document.createElement('div')
    el.id = 'not-a-dialog'
    document.body.appendChild(el)
    expect(openDialog('not-a-dialog')).toBe(false)
  })

  it('sets the shortcut context on open and restores it on close', () => {
    makeDialog('d1')
    ShortcutManager.setContext('global')

    openDialog('d1', { context: 'dialog' })
    expect(ShortcutManager.getContext()).toBe('dialog')
    expect(isOpen('d1')).toBe(true)

    closeDialog('d1')
    expect(ShortcutManager.getContext()).toBe('global')
    expect(isOpen('d1')).toBe(false)
  })

  it('restores exactly once when closed twice', () => {
    const el = makeDialog('d2')
    openDialog('d2', { context: 'dialog' })

    closeDialog('d2') // real close, restores
    ShortcutManager.setContext('dialog') // simulate something re-entering the context
    el.dispatchEvent(new Event('close')) // a stray second close event

    expect(ShortcutManager.getContext()).toBe('dialog') // not clobbered a second time
  })

  it('calls onClose and restores focus to the previously focused element', () => {
    makeDialog('d3')
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    let closed = false
    openDialog('d3', { onClose: () => { closed = true } })
    closeDialog('d3')

    expect(closed).toBe(true)
    expect(document.activeElement).toBe(trigger)
  })

  it('refuses a second open and leaves one restore behind', () => {
    const el = makeDialog('d4')
    ShortcutManager.setContext('synth')

    expect(openDialog('d4', { context: 'dialog' })).toBe(true)
    expect(openDialog('d4', { context: 'dialog' })).toBe(false)  // already open
    closeDialog('d4')

    // A second listener from the refused open would restore 'dialog' here.
    expect(ShortcutManager.getContext()).toBe('synth')
    expect(el.open).toBe(false)
  })

  it('does not focus a trigger that was removed while the dialog was open', () => {
    makeDialog('d5')
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    openDialog('d5')
    trigger.remove()
    expect(() => closeDialog('d5')).not.toThrow()
  })
})
