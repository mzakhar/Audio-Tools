import { getModule, paramDefaults } from '../rack/modules/index.js'

export function renderPanel(module, { onParam, onJack, onEvent } = {}) {
  const def = getModule(module.type)
  const el = document.createElement('article')
  el.className = 'rack-panel'
  el.dataset.moduleId = module.id
  el.style.width = `${(def?.hp || 8) * 16}px`
  if (!def) { el.textContent = `UNKNOWN\n${module.type}`; return el }
  el.innerHTML = `<header>${def.name}</header>`
  const body = document.createElement('div'); body.className = 'rack-params'
  el.append(body)
  const params = { ...paramDefaults(module.type), ...module.params }
  for (const param of def.params) {
    // Structured params (seq8 steps, drum patterns) have no scalar control —
    // a range input over an array is worse than showing nothing.
    if (!param.options && !param.toggle && param.min === undefined) continue
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
    label.append(input); body.append(label)
  }
  const custom = def.panel?.(module, {
    sendEvent: (port, event) => onEvent?.(module.id, port, event),
    params: () => ({ ...paramDefaults(module.type), ...module.params })
  })
  if (custom) el.append(custom)
  // Inputs and outputs get their own labelled block, the way a real panel is silk-screened.
  for (const dir of ['in', 'out']) {
    const ports = def.ports.filter(port => port.dir === dir)
    if (!ports.length) continue
    const group = document.createElement('div')
    group.className = `rack-jacks rack-jacks-${dir}`
    for (const port of ports) {
      const slot = document.createElement('span')
      slot.className = 'rack-jack-slot'
      const jack = document.createElement('button')
      jack.className = `rack-jack ${port.dir} ${port.kind}`
      jack.dataset.port = port.id
      jack.dataset.dir = port.dir
      jack.setAttribute('aria-label', `${def.name} ${port.label || port.id} ${dir === 'in' ? 'input' : 'output'}`)
      jack.title = `${port.label || port.id} — ${port.kind} ${dir === 'in' ? 'input' : 'output'}`
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
