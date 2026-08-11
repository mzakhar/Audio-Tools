// ALGO — eight independent 8-step trigger lanes, one output jack each
// (Grayscale Algorhythm). Event-domain clocking, same shape as seq8.
//
// The pattern is one flat 64-cell buffer, lane-major. Only one lane is on
// screen at a time; the panel's lane selector moves the edit cursor, which is a
// view concern and deliberately not rack state.

export const LANES = 8
export const STEPS = 8
export const CELLS = LANES * STEPS

// Flat index into the pattern buffer. Out-of-range returns -1, never wraps —
// a wrapped index would silently edit a different lane.
export function cellIndex(lane, step) {
  if (lane < 0 || lane >= LANES || step < 0 || step >= STEPS) return -1
  return lane * STEPS + step
}

function defaultPattern() {
  const pattern = Array.from({ length: CELLS }, () => false)
  for (const [lane, step] of [[0, 0], [0, 4], [1, 2], [1, 6]]) pattern[cellIndex(lane, step)] = true
  return pattern
}

export default {
  type: 'algo',
  name: 'ALGO',
  group: 'seq',
  hp: 20,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'clk', dir: 'in', kind: 'gate', label: 'CLK' },
    { id: 'rst', dir: 'in', kind: 'gate', label: 'RST' },
    ...Array.from({ length: LANES }, (_, i) => ({ id: `out${i + 1}`, dir: 'out', kind: 'gate', label: `${i + 1}` })),
    { id: 'eoc', dir: 'out', kind: 'gate', label: 'EOC' }
  ],
  params: [
    { key: 'pattern', label: 'PATTERN', def: defaultPattern() },
    { key: 'mode', label: 'MODE', options: ['loop', 'one-shot'], def: 'loop' },
    { key: 'order', label: 'ORDER', options: ['fwd', 'rand'], def: 'fwd' },
    { key: 'gate', label: 'GATE', options: ['trig', 'gate'], def: 'trig' }
  ],

  create(ctx, { params = {}, emitEvent = () => {}, random = Math.random } = {}) {
    params = { pattern: defaultPattern(), mode: 'loop', order: 'fwd', gate: 'trig', ...params }
    const clk = ctx.createGain()
    const rst = ctx.createGain()
    const outs = Array.from({ length: LANES }, () => ctx.createGain())
    const eoc = ctx.createGain()
    let step = -1
    let stopped = false
    // Steps are scheduled ahead of the clock, so the panel cannot just read
    // `step` — it would light the slot before it sounds. Keep the recent
    // schedule and let the panel ask which one the context has reached.
    let scheduled = []

    return {
      inputs: { clk: [clk], rst: [rst] },
      outputs: {
        ...Object.fromEntries(outs.map((g, i) => [`out${i + 1}`, [g]])),
        eoc: [eoc]
      },
      setParam(key, value) { params[key] = value },
      // Which slot the clock has actually reached, or -1 before the first tick.
      // Read-only, safe to call from a UI poll.
      uiStep() {
        const now = ctx.currentTime
        let current = -1
        for (const entry of scheduled) if (entry.time <= now) current = entry.step
        return current
      },
      onEvent(portId, event) {
        if (portId === 'rst' && event.type !== 'gate-off') { step = -1; stopped = false; scheduled = []; return }
        if (portId !== 'clk' || event.type === 'gate-off') return
        if (stopped) return
        const time = event.time ?? ctx.currentTime
        const width = event.pulseWidth ?? 0.05
        step = params.order === 'rand' ? Math.floor(random() * STEPS) : (step + 1) % STEPS
        // Append in schedule order (so uiStep can scan for the last one reached)
        // and trim from the front, never below one full bar of lookbehind.
        scheduled.push({ step, time })
        if (scheduled.length > STEPS * 2) scheduled = scheduled.slice(-STEPS)
        for (let lane = 0; lane < LANES; lane++) {
          if (!params.pattern[cellIndex(lane, step)]) continue
          const port = `out${lane + 1}`
          if (params.gate === 'gate') {
            emitEvent(port, { type: 'gate-on', time })
            emitEvent(port, { type: 'gate-off', time: time + width })
          } else {
            emitEvent(port, { type: 'trig', time })
          }
        }
        if (step === STEPS - 1) {
          emitEvent('eoc', { type: 'trig', time })
          if (params.mode === 'one-shot') stopped = true
        }
      },
      dispose() {
        for (const node of [clk, rst, ...outs, eoc]) node.disconnect()
      }
    }
  },

  // Without this the pattern is unreachable — renderPanel skips structured params.
  panel(module, { params, setParam, getInstance, addPoll }) {
    const wrapper = document.createElement('div')
    wrapper.className = 'algo-seq'
    let lane = 0

    const laneRow = document.createElement('div')
    laneRow.className = 'algo-lanes'
    const stepRow = document.createElement('div')
    stepRow.className = 'algo-steps'
    wrapper.append(laneRow, stepRow)

    const paintSteps = () => {
      const pattern = params().pattern || []
      for (const cell of stepRow.children) cell.classList.toggle('on', !!pattern[cellIndex(lane, Number(cell.dataset.step))])
    }
    const paintLanes = () => {
      for (const button of laneRow.children) button.classList.toggle('sel', Number(button.dataset.lane) === lane)
    }

    for (let i = 0; i < LANES; i++) {
      const button = document.createElement('button')
      button.className = 'algo-lane'
      button.dataset.lane = i
      button.textContent = i + 1
      button.title = `Edit lane ${i + 1} (output ${i + 1})`
      button.addEventListener('click', e => { e.stopPropagation(); lane = i; paintLanes(); paintSteps() })
      laneRow.append(button)
    }

    for (let i = 0; i < STEPS; i++) {
      const cell = document.createElement('button')
      cell.className = 'algo-cell' + (i % 4 === 0 ? ' beat' : '')
      cell.dataset.step = i
      cell.addEventListener('click', e => {
        e.stopPropagation()
        const next = (params().pattern || []).slice()
        const idx = cellIndex(lane, i)
        next[idx] = !next[idx]
        setParam('pattern', next)
        cell.classList.toggle('on', next[idx])
      })
      stepRow.append(cell)
    }

    paintLanes()
    paintSteps()

    // Playhead: the running module reports which slot the clock has reached and
    // the cell borders glow as it passes. Unregisters itself once the panel is
    // off the DOM — RackView rebuilds panels wholesale and never tears them down.
    let lit = -1
    const removePoll = addPoll(() => {
      if (!wrapper.isConnected) { removePoll(); return }
      const at = getInstance()?.uiStep?.() ?? -1
      if (at === lit) return
      lit = at
      for (const cell of stepRow.children) cell.classList.toggle('at', Number(cell.dataset.step) === at)
    })

    // A param change does not rebuild the panel, so undo and preset loads have
    // to repaint the visible lane themselves.
    wrapper.refresh = paintSteps
    return wrapper
  }
}
