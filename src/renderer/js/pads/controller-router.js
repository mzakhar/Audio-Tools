// controller-router.js — shell: routes a controller's non-pad controls (encoders,
// buttons, channel pressure) through its profile. Pads stay on the note path:
// handle() returns false for them, and for any event it does not own.
// Everything effectful is injected, so a fake view and fake effects test it.

import { resolve, knobDelta, learnKey } from './profile.js'

/**
 * profileFor(device) -> profile | null     overrides(device) -> { 'cc:0:25': 'layer', ... }
 * applyKnob(index, delta, ctx) -> effect[] (pads/knob-roles.js; may be absent)
 * knobCtx() -> the ctx applyKnob wants    run(effects)
 * actions: { play, layer, repeat(pressed), wipe(pressed), full, pressure(value) }
 * view() -> PadsView | null (turnKnob, pressControl)
 * active() -> bool: false (not the Pads view) = every control falls through to normal handling
 */
export function createControllerRouter({ profileFor, overrides, applyKnob, knobCtx, run, actions, view, active = () => true }) {
  const last = new Map() // learn key (cc:<ch>:<cc>) -> last absolute value; keyed by control, not knob index, so a remap cannot inherit a stale seed
  let swallowRelease = false
  const router = {
    /** While set (learn dialog), every device event goes here and nothing else sees it. */
    capture: null,
    /** Forget encoder positions: the next message per control just re-seeds. */
    resetKnobs() { last.clear() },
    /** Learn capture starts: let go of anything latched, and re-seed encoders. */
    beginCapture(fn) {
      actions.repeat?.(false)
      actions.wipe?.(false)
      for (const a of ['repeat', 'wipe', 'overlay']) view()?.pressControl?.(a, false)
      last.clear()
      swallowRelease = false
      router.capture = fn
    },
    /** Learn capture ends; `learned` = a control was bound, whose release is still to come and must not fire. */
    endCapture(learned) {
      router.capture = null
      last.clear()
      swallowRelease = !!learned
    },
    handle(detail) {
      const device = detail.device
      if (!device) return false
      const profile = profileFor(device)
      if (!profile) return false
      if (router.capture) { router.capture(detail, device); return true }
      if (!active()) return false
      const r = resolve(detail, profile, overrides(device))
      if (!r || r.kind === 'pad' || r.kind === 'pad-off') return false
      const swallow = swallowRelease
      swallowRelease = false
      if (swallow && r.kind === 'button' && !r.pressed) return true
      if (r.kind === 'knob') {
        const key = learnKey(detail)
        const delta = knobDelta(last.get(key), r.value)
        last.set(key, r.value)
        if (delta) {
          run(applyKnob?.(r.index, delta, knobCtx()) ?? [])
          view()?.turnKnob?.(r.index)
        }
      } else if (r.kind === 'button') {
        // play / layer / full toggle on press; repeat / wipe / overlay follow the hold.
        const hold = r.action === 'repeat' || r.action === 'wipe' || r.action === 'overlay'
        if (hold || r.pressed) actions[r.action]?.(r.pressed)
        view()?.pressControl?.(r.action, r.pressed)
      } else if (r.kind === 'pressure') actions.pressure?.(r.value)
      return true
    }
  }
  return router
}
