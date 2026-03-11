/**
 * shortcuts.js
 * Centralised keyboard shortcut registry with context support.
 *
 * Usage:
 *   import ShortcutManager from './shortcuts.js'
 *   ShortcutManager.init()
 *
 *   const id = ShortcutManager.register({ key: 's', ctrl: true }, () => save())
 *   ShortcutManager.unregister(id)
 *
 *   ShortcutManager.setContext('pianoroll')   // push modal context
 *   ShortcutManager.setContext('global')      // restore
 *
 * Descriptor fields:
 *   key    — lowercase key string (e.g. 'z', ' ', 'f1', 'escape', 'delete')
 *   ctrl   — true = require Ctrl (Win) or Cmd (Mac). Default false.
 *   shift  — true = require Shift. Default false.
 *   alt    — true = require Alt. Default false.
 *   context — optional string; shortcut only fires in this context.
 *             Omit (or null) to fire in all contexts.
 *
 * Context rules:
 *   - When context is 'global' (default), all no-context shortcuts fire.
 *   - When context is set to e.g. 'pianoroll', only shortcuts registered
 *     with context:'pianoroll' OR no context will fire.
 *     This lets piano-roll-specific keys shadow global ones.
 */

let _idCounter = 0
const _bindings = new Map()  // id → { desc, handler }
let _context = 'global'
let _initialized = false

function _matchesEvent(desc, e) {
  if (desc.key !== e.key.toLowerCase()) return false
  // Treat Cmd (metaKey) as equivalent to Ctrl for cross-platform shortcuts
  const ctrlOrMeta = e.ctrlKey || e.metaKey
  if (desc.ctrl  !== ctrlOrMeta)  return false
  if (desc.shift !== e.shiftKey)  return false
  if (desc.alt   !== (e.altKey))  return false
  return true
}

function _onKeyDown(e) {
  // Never intercept while the user is typing in a form field
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

  // Collect all matching bindings (pianoroll-context ones take priority)
  let matched = null
  for (const [, binding] of _bindings) {
    const { desc } = binding
    // Skip if context-restricted and current context doesn't match
    if (desc.context && desc.context !== _context) continue
    if (!_matchesEvent(desc, e)) continue
    // Prefer context-specific match over generic
    if (!matched || (desc.context && !matched.desc.context)) {
      matched = binding
    }
  }
  if (matched) {
    e.preventDefault()
    matched.handler(e)
  }
}

const ShortcutManager = {
  /**
   * Start listening. Must be called once (typically in boot()).
   */
  init() {
    if (_initialized) return
    _initialized = true
    document.addEventListener('keydown', _onKeyDown)
  },

  destroy() {
    document.removeEventListener('keydown', _onKeyDown)
    _bindings.clear()
    _initialized = false
  },

  /**
   * Register a shortcut. Returns a numeric id for later unregistration.
   * @param {{ key: string, ctrl?: boolean, shift?: boolean, alt?: boolean, context?: string }} desc
   * @param {(e: KeyboardEvent) => void} handler
   * @returns {number}
   */
  register(desc, handler) {
    const id = ++_idCounter
    _bindings.set(id, {
      desc: {
        key:     desc.key.toLowerCase(),
        ctrl:    desc.ctrl  ?? false,
        shift:   desc.shift ?? false,
        alt:     desc.alt   ?? false,
        context: desc.context ?? null,
      },
      handler
    })
    return id
  },

  /** Unregister a previously registered shortcut by its id. */
  unregister(id) {
    _bindings.delete(id)
  },

  /** Set the active context ('global', 'pianoroll', etc.). */
  setContext(ctx) {
    _context = ctx || 'global'
  },

  getContext() { return _context }
}

export default ShortcutManager
