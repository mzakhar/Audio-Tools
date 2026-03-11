/**
 * Tests for ShortcutManager — registration, dispatch, contexts, suppression.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ShortcutManager from '../src/renderer/js/shortcuts.js'

function fire(key, mods = {}) {
  const e = new KeyboardEvent('keydown', {
    key,
    ctrlKey:  mods.ctrl  ?? false,
    metaKey:  mods.meta  ?? false,
    shiftKey: mods.shift ?? false,
    altKey:   mods.alt   ?? false,
    bubbles: true,
    cancelable: true
  })
  document.dispatchEvent(e)
  return e
}

beforeEach(() => {
  ShortcutManager.init()
  ShortcutManager.setContext('global')
})

afterEach(() => {
  ShortcutManager.destroy()
})

describe('registration and dispatch', () => {
  it('fires handler on matching keydown', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 'z', ctrl: true }, fn)
    fire('z', { ctrl: true })
    expect(fn).toHaveBeenCalledOnce()
  })

  it('does not fire for wrong key', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 'z', ctrl: true }, fn)
    fire('x', { ctrl: true })
    expect(fn).not.toHaveBeenCalled()
  })

  it('does not fire when modifier mismatch', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 'z', ctrl: true }, fn)
    fire('z')          // no ctrl
    expect(fn).not.toHaveBeenCalled()
  })

  it('treats metaKey (Cmd) as equivalent to ctrlKey', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 's', ctrl: true }, fn)
    fire('s', { meta: true })  // Cmd+S
    expect(fn).toHaveBeenCalledOnce()
  })

  it('respects shift modifier', () => {
    const fnWithShift    = vi.fn()
    const fnWithoutShift = vi.fn()
    ShortcutManager.register({ key: 'z', ctrl: true, shift: true }, fnWithShift)
    ShortcutManager.register({ key: 'z', ctrl: true },              fnWithoutShift)
    fire('z', { ctrl: true, shift: true })
    expect(fnWithShift).toHaveBeenCalledOnce()
    expect(fnWithoutShift).not.toHaveBeenCalled()
  })

  it('preventDefault is called on match', () => {
    ShortcutManager.register({ key: ' ' }, vi.fn())
    const e = fire(' ')
    expect(e.defaultPrevented).toBe(true)
  })

  it('first registered match wins (no double-fire)', () => {
    const fn1 = vi.fn(); const fn2 = vi.fn()
    ShortcutManager.register({ key: 'f' }, fn1)
    ShortcutManager.register({ key: 'f' }, fn2)
    fire('f')
    // Only one fires because dispatch stops at first match
    expect(fn1.mock.calls.length + fn2.mock.calls.length).toBe(1)
  })
})

describe('unregister', () => {
  it('stops delivering after unregister', () => {
    const fn = vi.fn()
    const id = ShortcutManager.register({ key: 'q' }, fn)
    ShortcutManager.unregister(id)
    fire('q')
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('context', () => {
  it('context-scoped shortcut fires only in that context', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 'd', context: 'pianoroll' }, fn)
    fire('d')  // global context
    expect(fn).not.toHaveBeenCalled()
    ShortcutManager.setContext('pianoroll')
    fire('d')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('no-context shortcut fires in any context', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 'f1' }, fn)
    ShortcutManager.setContext('pianoroll')
    fire('f1')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('context-specific shortcut shadows global for same key', () => {
    const globalFn = vi.fn()
    const prFn     = vi.fn()
    ShortcutManager.register({ key: 'e' },                    globalFn)
    ShortcutManager.register({ key: 'e', context: 'pianoroll' }, prFn)
    ShortcutManager.setContext('pianoroll')
    fire('e')
    expect(prFn).toHaveBeenCalledOnce()
    expect(globalFn).not.toHaveBeenCalled()
  })

  it('setContext restores global behavior', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 'd', context: 'pianoroll' }, fn)
    ShortcutManager.setContext('pianoroll')
    ShortcutManager.setContext('global')
    fire('d')
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('input suppression', () => {
  it('does not fire when activeElement is INPUT', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 's', ctrl: true }, fn)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    fire('s', { ctrl: true })
    expect(fn).not.toHaveBeenCalled()
    input.remove()
  })

  it('does not fire when activeElement is TEXTAREA', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 'z', ctrl: true }, fn)
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    fire('z', { ctrl: true })
    expect(fn).not.toHaveBeenCalled()
    ta.remove()
  })

  it('does not fire when activeElement is SELECT', () => {
    const fn = vi.fn()
    ShortcutManager.register({ key: 'z' }, fn)
    const sel = document.createElement('select')
    document.body.appendChild(sel)
    sel.focus()
    fire('z')
    expect(fn).not.toHaveBeenCalled()
    sel.remove()
  })
})
