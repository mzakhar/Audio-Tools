// Pure controller-profile resolution: parsed midi-event detail -> app-level control event.

/** Bank 0..3 of a pad note, null outside 36..99. */
export function bankOf(note) {
  return Number.isInteger(note) && note >= 36 && note <= 99 ? Math.floor((note - 36) / 16) : null
}

/** Pad 0..15 within its bank, null outside 36..99. */
export function padOf(note) {
  return bankOf(note) === null ? null : (note - 36) % 16
}

/** Stable key for learn/overrides: 'cc:<ch>:<cc>' | 'note:<ch>:<note>' | null. */
export function learnKey(event) {
  if (!event) return null
  if (event.kind === 'cc') return `cc:${event.channel}:${event.controller}`
  if (event.kind === 'note-on' || event.kind === 'note-off') return `note:${event.channel}:${event.pitch}`
  return null
}

/** Absolute encoder value -> delta. First message (prev undefined) just seeds. */
export function knobDelta(prev, value) {
  return prev === undefined || prev === null ? 0 : value - prev
}

export function resolve(event, profile, overrides = {}) {
  if (!event || !profile) return null
  const key = learnKey(event)
  const action = key && overrides[key]
  if (action) {
    // Learned encoders are stored as 'knob:<index>' and keep encoder semantics.
    const knob = /^knob:(\d)$/.exec(action)
    if (knob && event.kind === 'cc') return { kind: 'knob', index: +knob[1], value: event.value }
    if (event.kind === 'cc') return { kind: 'button', action, pressed: event.value > 0 }
    if (event.kind === 'note-on') return { kind: 'button', action, pressed: event.velocity > 0 }
    return { kind: 'button', action, pressed: false }
  }
  const { pads, encoders, buttons } = profile
  switch (event.kind) {
    case 'note-on':
    case 'note-off': {
      if (event.channel !== pads.channel) return null
      const note = event.pitch
      const bank = bankOf(note)
      if (bank === null) return null
      const pad = padOf(note)
      if (event.kind === 'note-on' && event.velocity > 0) return { kind: 'pad', note, bank, pad, velocity: event.velocity }
      return { kind: 'pad-off', note, bank, pad }
    }
    case 'cc': {
      if (event.channel === encoders.channel) {
        const index = encoders.ccs.indexOf(event.controller)
        if (index >= 0) return { kind: 'knob', index, value: event.value }
      }
      if (event.channel === buttons.channel) {
        const action = buttons.map[event.controller]
        if (action) return { kind: 'button', action, pressed: event.value > 0 }
      }
      return null
    }
    case 'channel-aftertouch':
      if (profile.aftertouch === 'channel' && event.channel === pads.channel) return { kind: 'pressure', value: event.pressure }
      return null
    default:
      return null
  }
}
