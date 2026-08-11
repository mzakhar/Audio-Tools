import { getModule, paramDefaults } from '../rack/modules/index.js'
import { renderKnob } from './knob.js'

// Side-column geometry. Keep in step with `--side-col` in style.css: a 216px
// panel has room for three stacked knobs under the header and above the jacks.
const SIDE_ROWS = 3
const SIDE_COL_W = 58
const SIDE_GAP = 6
// The display is why the panel draws at all, so the knob column is never allowed
// to squeeze it below this. TURING at 8 HP lost its LED readout entirely to a
// two-column knob track that happened to be exactly as wide as the panel.
const MIN_DISPLAY_W = 96
const PANEL_PAD = 12

// How many knob columns this panel can afford without starving its display.
export function sideColumns(cells, hp, rows = SIDE_ROWS) {
  const wanted = Math.max(1, Math.ceil(cells / rows))
  const budget = hp * 16 - MIN_DISPLAY_W - PANEL_PAD - SIDE_GAP
  const affordable = Math.max(1, Math.floor(budget / (SIDE_COL_W + SIDE_GAP)))
  return Math.min(wanted, affordable)
}

export function renderPanel(module, { onParam, onJack, onEvent, getParams, getInstance, addPoll } = {}) {
  const def = getModule(module.type)
  const el = document.createElement('article')
  el.className = 'rack-panel'
  el.dataset.moduleId = module.id
  el.style.width = `${(def?.hp || 8) * 16}px`
  if (!def) { el.textContent = `UNKNOWN\n${module.type}`; return el }
  el.innerHTML = `<header>${def.name}</header>`
  const body = document.createElement('div'); body.className = 'rack-params'
  // A module that draws its own panel needs the height for it — lay its controls
  // across the width instead of down the panel. Docked panels already do this
  // their own way; applying both wraps their knobs and pushes the drawing out.
  // `compactParams` opts a panel in without a drawing: a module with five
  // stacked full-width controls runs out of panel before it runs out of width,
  // and wrapping them two-up is the difference between a visible SCALE select
  // and one that scrolls out of sight.
  if ((def.panel || def.compactParams) && !def.dock) body.classList.add('rack-params-compact')
  el.append(body)
  const params = { ...paramDefaults(module.type), ...module.params }
  let knobs = 0
  for (const param of def.params) {
    // Structured params (seq8 steps, drum patterns) have no scalar control —
    // a range input over an array is worse than showing nothing.
    if (!param.options && !param.toggle && param.min === undefined) continue
    // A param the module's own panel() already drives — GRIDS' X and Y are the
    // XY pad. A knob beside the pad is a second control for one value.
    if (param.hidden) continue
    const label = document.createElement('label')
    label.textContent = param.label
    let input
    if (param.options) {
      input = document.createElement('select')
      param.options.forEach(value => input.add(new Option(value, value, false, value === params[param.key])))
    } else {
      input = document.createElement('input')
      input.type = param.toggle ? 'checkbox' : 'range'
      if (param.toggle) input.checked = !!params[param.key]
      else Object.assign(input, { min: param.min, max: param.max, step: param.step, value: params[param.key] })
    }
    input.dataset.param = param.key
    input.addEventListener('input', () => onParam?.(module.id, param.key, input.type === 'checkbox' ? input.checked : (param.options ? input.value : Number(input.value))))
    // Panels with width but little height take knobs, not stacked full-width
    // sliders: docked and util rows are short by construction, and a panel that
    // draws needs its height for the drawing.
    if ((def.dock || def.util || def.panel) && input.type === 'range') { body.append(renderKnob(param, input)); knobs++; continue }
    label.append(input); body.append(label)
  }
  const custom = def.panel?.(module, {
    sendEvent: (port, event) => onEvent?.(module.id, port, event),
    // Must read live state: a param change does not rebuild the panel, so the
    // `module` captured here goes stale the moment a knob moves.
    params: () => getParams?.(module.id) ?? { ...paramDefaults(module.type), ...module.params },
    setParam: (key, value) => onParam?.(module.id, key, value),
    // For panels that show what the running module is doing (a playhead, a meter).
    // `addPoll` returns its own remover; a panel that registers one is responsible
    // for calling it once the panel leaves the DOM.
    getInstance: () => getInstance?.(module.id) ?? null,
    addPoll: job => addPoll?.(job) ?? (() => {})
  })
  // A panel that draws from params has to redraw when they change. `input` covers
  // the user turning a control; RackView calls __refresh for undo/preset changes,
  // which set values silently.
  if (custom) {
    el.append(custom)
    if (custom.refresh) { el.__refresh = custom.refresh; el.addEventListener('input', custom.refresh) }
    // Knobs stacked above a drawing still eat the height it needs — SCOPE's
    // output jacks fell off the bottom of the panel. Move them into a column
    // down the right instead. Only when there are knobs to move: a panel whose
    // controls are all selects (METER) keeps the full width for its display.
    //
    // `panelInline` opts out: a panel that draws a single short row (SAMPLR's
    // file button) wants the knobs wrapped above it across the full width, not
    // squeezed into a side column beside 18px of nothing.
    if (def.panelInline) el.classList.add('rack-panel-inline')
    if (knobs && !def.dock && !def.util && !def.panelInline) {
      el.classList.add('rack-panel-side')
      // One column of knobs only fits three before it runs off the bottom of a
      // 216px panel. Wrap into as many columns as that takes and widen the
      // track to match, so the module's declared HP is what has to cover it.
      // Every cell counts, not just the knobs: a select or a checkbox takes a
      // row in the same grid, and leaving them out of the maths is what pushed
      // TURING's BIPOLAR and CHORD's SCALE off the bottom.
      const cols = sideColumns(body.children.length, def.hp || 8)
      el.style.setProperty('--side-cols', cols)
      el.style.setProperty('--side-col', `${cols * SIDE_COL_W + (cols - 1) * SIDE_GAP}px`)
    }
  }
  // Inputs and outputs get their own labelled block, the way a real panel is silk-screened.
  // A module may declare its own jack rows (`port.row`) instead of the default
  // in-block-then-out-block — bus needs two independent rows, each mixing an
  // input with its own outputs.
  const rows = def.ports.some(p => p.row !== undefined)
    ? [...new Set(def.ports.map(p => p.row ?? 0))].sort((a, b) => a - b).map(r => def.ports.filter(p => (p.row ?? 0) === r))
    : ['in', 'out'].map(d => def.ports.filter(p => p.dir === d))
  for (const ports of rows) {
    if (!ports.length) continue
    const dir = ports.every(p => p.dir === ports[0].dir) ? ports[0].dir : null
    const group = document.createElement('div')
    group.className = dir ? `rack-jacks rack-jacks-${dir}` : 'rack-jacks'
    for (const port of ports) {
      const slot = document.createElement('span')
      slot.className = 'rack-jack-slot'
      const jack = document.createElement('button')
      jack.className = `rack-jack ${port.dir} ${port.kind}`
      jack.dataset.port = port.id
      jack.dataset.dir = port.dir
      jack.setAttribute('aria-label', `${def.name} ${port.label || port.id} ${port.dir === 'in' ? 'input' : 'output'}`)
      jack.title = `${port.label || port.id} — ${port.kind} ${port.dir === 'in' ? 'input' : 'output'}`
      jack.addEventListener('click', () => onJack?.(module.id, port.id, port.dir, jack))
      const caption = document.createElement('em')
      caption.textContent = port.label || port.id
      slot.append(jack, caption)
      group.append(slot)
    }
    el.append(group)
  }
  return el
}
