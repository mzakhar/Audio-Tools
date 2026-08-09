// A rotary knob wrapped around a real <input type=range>. The input stays in the
// DOM — hidden, focusable, still carrying data-param — so keyboard control and
// RackView.syncValues keep working without knowing a knob exists.

const SWEEP = 270 // degrees of travel, centred on 12 o'clock
const DRAG_PX = 120 // pixels of vertical drag for the full range

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

  // Vertical relative drag, not the input's own absolute hit-position behaviour.
  dial.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation()
    const span = Number(input.max) - Number(input.min), start = Number(input.value), step = Number(input.step) || 1
    const move = ev => {
      const raw = start + (e.clientY - ev.clientY) / DRAG_PX * span
      const next = Math.min(Number(input.max), Math.max(Number(input.min), Math.round(raw / step) * step))
      if (next === Number(input.value)) return
      input.value = next
      paintKnob(input)
      cap.textContent = String(next)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const up = () => { window.removeEventListener('pointermove', move); cap.textContent = param.label }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  })
  return el
}
