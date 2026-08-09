import MODULES from '../rack/modules/index.js'

export class ModuleBrowser {
  constructor(container, { hasWorklet = () => false, onPick } = {}) {
    this.container = container; this.hasWorklet = hasWorklet; this.onPick = onPick
    this.container.innerHTML = '<input type="search" placeholder="Search modules" aria-label="Search modules"><div class="module-browser-list"></div>'
    this.input = this.container.querySelector('input'); this.list = this.container.querySelector('div')
    this.input.addEventListener('input', () => this.render())
    this.render()
  }
  render() {
    const query = this.input.value.toLowerCase()
    const groups = {}
    for (const def of Object.values(MODULES)) {
      if (def.tier === 'worklet' && !this.hasWorklet()) continue
      if (query && !`${def.name} ${def.type}`.toLowerCase().includes(query)) continue
      ;(groups[def.group] ||= []).push(def)
    }
    this.list.replaceChildren(...Object.entries(groups).flatMap(([group, defs]) => [
      Object.assign(document.createElement('h3'), { textContent: group.toUpperCase() }),
      ...defs.map(def => { const b = document.createElement('button'); b.textContent = `${def.name} · ${def.hp}HP`; b.onclick = () => this.onPick?.(def.type); return b })
    ]))
  }
}
