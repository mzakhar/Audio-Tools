// GRID16 — four lanes of sixteen steps, each cell carrying velocity,
// probability and a ratchet count. `algo` stays what it is (8×8, plain on/off);
// widening it would have reshaped its saved 64-cell buffer, so the beat-focused
// sequencer is a separate module rather than a migration.
//
// Same flat lane-major buffer as `algo`, but of objects instead of booleans.

export const LANES = 4
export const STEPS = 16
export const CELLS = LANES * STEPS
export const RATCHETS = [1, 2, 3, 4]
export const PROBS = [1, 0.75, 0.5, 0.25]

// Out-of-range returns -1 and never wraps — a wrapped index silently edits
// another lane.
export function cellIndex(lane, step) {
  if (lane < 0 || lane >= LANES || step < 0 || step >= STEPS) return -1
  return lane * STEPS + step
}

export function makeCell(on = false) {
  return { on, vel: 1, prob: 1, ratchet: 1 }
}

// A saved patch may predate a field, or carry a bare boolean from a hand-written
// preset. Read every cell through here so the sequencer never sees undefined.
export function readCell(pattern, lane, step) {
  const idx = cellIndex(lane, step)
  const raw = idx < 0 ? null : pattern?.[idx]
  if (!raw) return makeCell()
  if (raw === true) return makeCell(true)
  return { on: !!raw.on, vel: raw.vel ?? 1, prob: raw.prob ?? 1, ratchet: Math.max(1, Math.round(raw.ratchet ?? 1)) }
}

function defaultPattern() {
  const pattern = Array.from({ length: CELLS }, () => makeCell())
  // A kick/snare/hat skeleton, so a fresh module makes a beat rather than silence.
  for (const step of [0, 4, 8, 12]) pattern[cellIndex(0, step)].on = true
  for (const step of [4, 12]) pattern[cellIndex(1, step)].on = true
  for (let step = 0; step < STEPS; step += 2) pattern[cellIndex(2, step)].on = true
  return pattern
}

// Which slot plays next, given the one that just played.
export function nextStep(step, length, direction, forward, random) {
  const len = Math.max(1, Math.min(STEPS, Math.round(length)))
  if (direction === 'rand') return { step: Math.floor(random() * len), forward, wrapped: false }
  if (direction === 'rev') {
    const next = step <= 0 ? len - 1 : step - 1
    return { step: next, forward, wrapped: next === len - 1 }
  }
  if (direction === 'pend') {
    if (len === 1) return { step: 0, forward, wrapped: true }
    if (forward && step + 1 < len) return { step: step + 1, forward: true, wrapped: false }
    if (forward) return { step: len - 2, forward: false, wrapped: false }
    if (step - 1 > 0) return { step: step - 1, forward: false, wrapped: false }
    return { step: 0, forward: true, wrapped: true }
  }
  const next = (step + 1) % len
  return { step: next, forward, wrapped: next === 0 }
}

export default {
  type: 'grid16', name: 'GRID16', group: 'seq', hp: 24, tier: 'native', poly: false,
  ports: [
    { id: 'clk', dir: 'in', kind: 'gate', label: 'CLK' },
    { id: 'rst', dir: 'in', kind: 'gate', label: 'RST' },
    ...Array.from({ length: LANES }, (_, i) => ({ id: `out${i + 1}`, dir: 'out', kind: 'gate', label: `${i + 1}` })),
    { id: 'acc', dir: 'out', kind: 'gate', label: 'ACC' },
    { id: 'eoc', dir: 'out', kind: 'gate', label: 'EOC' }
  ],
  params: [
    { key: 'pattern', label: 'PATTERN', def: defaultPattern() },
    { key: 'length', label: 'LENGTH', min: 1, max: 16, step: 1, def: 16, fmt: '' },
    { key: 'swing', label: 'SWING', min: 0, max: 0.75, step: 0.01, def: 0, fmt: '' },
    { key: 'direction', label: 'DIR', options: ['fwd', 'rev', 'pend', 'rand'], def: 'fwd' },
    { key: 'accentThresh', label: 'ACCENT', min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' }
  ],

  create(ctx, { params, emitEvent = () => {}, random = Math.random }) {
    const clk = ctx.createGain(), rst = ctx.createGain()
    const outs = Array.from({ length: LANES }, () => ctx.createGain())
    const acc = ctx.createGain(), eoc = ctx.createGain()
    let step = -1, forward = true, last = -1
    // Steps are scheduled ahead of the clock, so the panel asks which one the
    // context has actually reached instead of reading `step` (same trick as algo).
    let scheduled = []

    return {
      inputs: { clk: [clk], rst: [rst] },
      outputs: {
        ...Object.fromEntries(outs.map((g, i) => [`out${i + 1}`, [g]])),
        acc: [acc], eoc: [eoc]
      },
      setParam(key, value) { params[key] = value },
      uiStep() {
        const now = ctx.currentTime
        let current = -1
        for (const entry of scheduled) if (entry.time <= now) current = entry.step
        return current
      },
      onEvent(port, event) {
        if (port === 'rst' && event.type !== 'gate-off') { step = -1; forward = true; last = -1; scheduled = []; return }
        if (port !== 'clk' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const time = event.time ?? ctx.currentTime
        // ponytail: swing and ratchet spacing both ride the previous clock
        // interval, so the first tick after a tempo change uses the stale one.
        const interval = last >= 0 ? Math.max(0, time - last) : 0
        last = time

        const fresh = step < 0
        const advanced = nextStep(fresh ? (params.direction === 'rev' ? 0 : -1) : step, params.length, params.direction, forward, random)
        step = advanced.step
        forward = advanced.forward

        const swing = Math.min(0.75, Math.max(0, params.swing || 0))
        const at = time + (step % 2 ? swing * interval * 0.5 : 0)
        scheduled.push({ step, time: at })
        if (scheduled.length > STEPS * 2) scheduled = scheduled.slice(-STEPS)

        let peak = 0
        for (let lane = 0; lane < LANES; lane++) {
          const cell = readCell(params.pattern, lane, step)
          // Drawn every lane every step, hit or not, so a seeded bounce consumes
          // the same sequence whatever the pattern says.
          const roll = random()
          if (!cell.on || roll >= cell.prob) continue
          const ratchet = Math.max(1, Math.min(8, cell.ratchet))
          for (let r = 0; r < ratchet; r++) {
            emitEvent(`out${lane + 1}`, { type: 'trig', time: at + (interval * r) / ratchet, channel: 0, velocity: cell.vel })
          }
          peak = Math.max(peak, cell.vel)
        }
        // `peak > 0` guards the accent-knob-at-zero case: a step where nothing
        // played leaves peak at 0, which would otherwise clear a 0 threshold.
        if (peak > 0 && peak >= params.accentThresh) emitEvent('acc', { type: 'trig', time: at, channel: 0 })
        // Not on the very first tick after a reset: in `rev` the wrap point is
        // the top of the pattern, which is also where it starts.
        if (advanced.wrapped && !fresh) emitEvent('eoc', { type: 'trig', time: at, channel: 0 })
      },
      dispose() {
        for (const node of [clk, rst, acc, eoc, ...outs]) node.disconnect()
      }
    }
  },

  // The pattern is a structured param — without a panel it is unreachable.
  panel(module, { params, setParam, getInstance, addPoll }) {
    const wrapper = document.createElement('div')
    wrapper.className = 'grid16-seq'
    let lane = 0

    const laneRow = document.createElement('div')
    laneRow.className = 'grid16-lanes'
    const stepRow = document.createElement('div')
    stepRow.className = 'grid16-steps'
    wrapper.append(laneRow, stepRow)

    const paintSteps = () => {
      const pattern = params().pattern
      for (const el of stepRow.children) {
        const cell = readCell(pattern, lane, Number(el.dataset.step))
        el.classList.toggle('on', cell.on)
        el.dataset.ratchet = cell.ratchet
        el.style.setProperty('--prob', cell.prob)
        el.title = `step ${Number(el.dataset.step) + 1} — ${Math.round(cell.prob * 100)}% × ${cell.ratchet}`
      }
    }
    const paintLanes = () => {
      for (const button of laneRow.children) button.classList.toggle('sel', Number(button.dataset.lane) === lane)
    }
    // Cells are objects, so an edit has to clone the buffer *and* the cell —
    // mutating in place would make undo a no-op.
    const edit = (step, change) => {
      const pattern = params().pattern
      const next = Array.from({ length: CELLS }, (_, i) => readCell(pattern, Math.floor(i / STEPS), i % STEPS))
      const idx = cellIndex(lane, step)
      next[idx] = { ...next[idx], ...change }
      setParam('pattern', next)
      paintSteps()
      return next[idx]
    }

    for (let i = 0; i < LANES; i++) {
      const button = document.createElement('button')
      button.className = 'grid16-lane'
      button.dataset.lane = i
      button.textContent = i + 1
      button.title = `Edit lane ${i + 1} (output ${i + 1})`
      button.addEventListener('click', e => { e.stopPropagation(); lane = i; paintLanes(); paintSteps() })
      laneRow.append(button)
    }

    for (let i = 0; i < STEPS; i++) {
      const cell = document.createElement('button')
      cell.className = 'grid16-cell' + (i % 4 === 0 ? ' beat' : '')
      cell.dataset.step = i
      cell.addEventListener('click', e => {
        e.stopPropagation()
        const current = readCell(params().pattern, lane, i)
        // shift cycles ratchet, alt cycles probability, plain click toggles.
        if (e.shiftKey) edit(i, { ratchet: RATCHETS[(RATCHETS.indexOf(current.ratchet) + 1) % RATCHETS.length] || 1, on: true })
        else if (e.altKey) edit(i, { prob: PROBS[(PROBS.indexOf(current.prob) + 1) % PROBS.length] ?? 1, on: true })
        else edit(i, { on: !current.on })
      })
      stepRow.append(cell)
    }

    paintLanes()
    paintSteps()

    // Playhead, same contract as algo: the panel unregisters itself once it is
    // off the DOM, because RackView rebuilds panels wholesale.
    let lit = -1
    const removePoll = addPoll(() => {
      if (!wrapper.isConnected) { removePoll(); return }
      const at = getInstance()?.uiStep?.() ?? -1
      if (at === lit) return
      lit = at
      for (const el of stepRow.children) el.classList.toggle('at', Number(el.dataset.step) === at)
    })

    wrapper.refresh = paintSteps
    return wrapper
  }
}
