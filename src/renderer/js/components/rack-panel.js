import { getModule, paramDefaults } from '../rack/modules/index.js'

export function renderPanel(module, { onParam, onJack } = {}) {
  const def = getModule(module.type)
  const el = document.createElement('article')
  el.className = 'rack-panel'
  el.dataset.moduleId = module.id
  el.style.width = `${(def?.hp || 8) * 16}px`
  if (!def) { el.textContent = `UNKNOWN\n${module.type}`; return el }
  el.innerHTML = `<header>${def.name}</header>`
  const params = { ...paramDefaults(module.type), ...module.params }
  for (const param of def.params) {
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
    input.addEventListener('input', () => onParam?.(module.id, param.key, input.type === 'checkbox' ? input.checked : (param.options ? input.value : Number(input.value))))
    label.append(input); el.append(label)
  }
  const ports = document.createElement('div'); ports.className = 'rack-jacks'
  for (const port of def.ports) {
    const jack = document.createElement('button')
    jack.className = `rack-jack ${port.dir} ${port.kind}`
    jack.dataset.port = port.id
    jack.dataset.dir = port.dir
    jack.setAttribute('aria-label', `${def.name} ${port.label || port.id} ${port.dir === 'in' ? 'input' : 'output'}`)
    jack.title = port.label || port.id
    jack.addEventListener('click', () => onJack?.(module.id, port.id, port.dir, jack))
    ports.append(jack)
  }
  el.append(ports)
  return el
}
