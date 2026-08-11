// A rotary knob wrapped around a real <input type=range>. The input stays in the
// DOM — hidden, focusable, still carrying data-param — so keyboard control and
// RackView.syncValues keep working without knowing a knob exists.

const SWEEP = 270 // degrees of travel, centred on 12 o'clock
const DRAG_PX = 120 // pixels of vertical drag for the full range
const MAX_DECIMALS = 3

// How many decimals this control can actually express. Reading it off the step
// is what keeps `Math.round(raw / step) * step` from surfacing as
// 0.30000000000000004 in the caption — and off the stored value too.
export function decimalsFor(step) {
  const text = String(step ?? 1)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : Math.min(MAX_DECIMALS, text.length - dot - 1)
}

// Snap to the step's precision. Number() drops the trailing zeros toFixed adds,
// so 0.50 reads as 0.5 and 3.00 as 3.
export function snap(value, step) {
  return Number(Number(value).toFixed(decimalsFor(step)))
}

// Pure: value -> indicator angle in degrees.
export function knobAngle(value, min, max) {
  if (!(max > min)) return -SWEEP / 2
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)))
  return -SWEEP / 2 + SWEEP * t
}

export function paintKnob(input) {
  const dial = input.parentElement?.querySelector('.knob-dial')
  if (dial) dial.style.setProperty('--angle', `${knobAngle(Number(input.value), Number(input.min), Number(input.max))}deg`)
}

// Wraps an existing range input; the caller has already bound its 'input' listener.
export function renderKnob(param, input) {
  const el = document.createElement('label')
  el.className = 'knob'
  const cap = document.createElement('span')
  cap.className = 'knob-cap'
  cap.textContent = param.label
  const dial = document.createElement('span')
  dial.className = 'knob-dial'
  el.append(cap, dial, input)
  paintKnob(input)

  const step = Number(input.step) || 1
  const showValue = () => { cap.textContent = String(snap(input.value, step)) }
  const showLabel = () => { cap.textContent = param.label }

  // Vertical relative drag, not the input's own absolute hit-position behaviour.
  dial.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation()
    // Focus on grab: the range input underneath is the real control, so once it
    // has focus the arrow keys drive the knob for free — left/down anticlockwise,
    // right/up clockwise — and ShortcutManager already stays out of the way of a
    // focused INPUT.
    input.focus()
    const span = Number(input.max) - Number(input.min), start = Number(input.value)
    const move = ev => {
      const raw = start + (e.clientY - ev.clientY) / DRAG_PX * span
      const next = snap(Math.min(Number(input.max), Math.max(Number(input.min), Math.round(raw / step) * step)), step)
      if (next === Number(input.value)) return
      input.value = next
      paintKnob(input)
      showValue()
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      // Keep the reading up while the knob still has focus — the arrow keys are
      // live at that point and a label would hide what they are doing.
      if (document.activeElement === input) showValue(); else showLabel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  })

  // Arrow keys land here as a plain input event, and so does an external change.
  input.addEventListener('input', () => { paintKnob(input); if (document.activeElement === input) showValue() })
  input.addEventListener('focus', showValue)
  input.addEventListener('blur', showLabel)
  return el
}
