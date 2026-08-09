import ProjectStore, { AddRack, AddModule, MoveModule, RemoveModule, SetModuleParam, Connect, Disconnect, LoadRackPatch } from '../store/ProjectStore.js'
import MODULES, { canConnect } from '../rack/modules/index.js'
import { canPlace, firstFreeSlot, pxToHp } from '../rack/rack-layout.js'
import { renderPanel } from './rack-panel.js'
import { ModuleBrowser } from './module-browser.js'
import { RackCables } from './rack-cables.js'
import RackEngine from '../rack/rack-engine.js'
import FileAdapter from '../io/FileAdapter.js'
import { exportPatch, importPatch } from '../rack/patch-io.js'

const presets = import.meta.glob('../../presets/racks/*.json', { eager: true, import: 'default' })

const starter = { name: 'Starter rack', rails: 3, railHp: 104, modules: [
  { id: 'starter-vco', type: 'vco', rail: 0, hp: 0, params: {}, atten: {} },
  { id: 'starter-vca', type: 'vca', rail: 0, hp: 12, params: {}, atten: {} },
  { id: 'starter-out', type: 'out', rail: 0, hp: 20, params: {}, atten: {} }
], cables: [] }

export class RackView {
  constructor(container, { hasWorklet, getAudioContext, getMasterInput } = {}) {
    this.container = container; this.hasWorklet = hasWorklet || (() => false); this.getAudioContext = getAudioContext || (() => null); this.getMasterInput = getMasterInput || (() => null); this.rackId = null; this.selected = null; this.pending = null; this.engineHandle = null
    const presetOptions = Object.entries(presets).map(([path]) => `<option value="${path}">${path.split('/').pop().replace('.json', '')}</option>`).join('')
    container.innerHTML = `<div class="rack-toolbar"><button data-action="add">+ MODULE</button><button data-action="delete">REMOVE</button><button data-action="new">NEW</button><select data-action="preset"><option value="">LOAD PRESET</option>${presetOptions}</select><button data-action="import">IMPORT</button><button data-action="export">EXPORT</button><button data-action="save-preset">SAVE AS PRESET</button><label>ZOOM <input data-action="zoom" type="range" min=".5" max="1.5" step=".1" value="1"></label></div><aside class="module-browser"></aside><main class="rack-scroll"><div class="rack-rails"><canvas class="rack-canvas"></canvas></div></main>`
    this.rails = container.querySelector('.rack-rails'); this.canvas = new RackCables(container.querySelector('.rack-canvas'), this.rails)
    this.browser = new ModuleBrowser(container.querySelector('.module-browser'), { hasWorklet: this.hasWorklet, onPick: type => this.add(type) })
    container.querySelector('[data-action="add"]').onclick = () => container.classList.toggle('browser-open')
    container.querySelector('[data-action="delete"]').onclick = () => this.selected && ProjectStore.dispatch(RemoveModule(this.rackId, this.selected))
    container.querySelector('[data-action="new"]').onclick = () => this.load(starter)
    container.querySelector('[data-action="preset"]').onchange = e => { if (e.target.value) this.load(presets[e.target.value]); e.target.value = '' }
    container.querySelector('[data-action="import"]').onclick = async () => { try { const json = await FileAdapter.importRackPatch(); if (json) this.load(json) } catch (e) { if (e.name !== 'AbortError') console.warn('Rack import failed', e) } }
    container.querySelector('[data-action="export"]').onclick = () => this.save()
    container.querySelector('[data-action="save-preset"]').onclick = () => this.save(`${this.rack()?.name || 'preset'}.synthrack`)
    container.querySelector('[data-action="zoom"]').oninput = e => { this.rails.style.setProperty('--rack-zoom', e.target.value); this.canvas.draw() }
    this.rails.addEventListener('dblclick', e => { const hit = this.canvas.hitTest(e.offsetX, e.offsetY); if (hit) ProjectStore.dispatch(Disconnect(this.rackId, hit.id)) })
    this.unsubscribe = ProjectStore.subscribe(() => this.render())
  }
  show() { this.container.style.display = 'flex'; if (!this.rackId) { const racks = ProjectStore.getState().racks; this.rackId = Object.keys(racks)[0] || 'starter-rack'; if (!racks[this.rackId]) ProjectStore.dispatch(AddRack('Starter rack', this.rackId)); if (!ProjectStore.getState().racks[this.rackId].modules.length) { for (const mod of starter.modules) ProjectStore.dispatch(AddModule(this.rackId, mod.type, mod)) } } this.render() }
  hide() { this.container.style.display = 'none' }
  destroy() { this.unsubscribe?.(); this.unmountEngine() }
  getEngineHandle() { return this.engineHandle }
  rack() { return ProjectStore.getState().racks[this.rackId] }
  add(type) { const rack = this.rack(), slot = firstFreeSlot(rack, MODULES, MODULES[type].hp); if (slot) ProjectStore.dispatch(AddModule(this.rackId, type, slot)) }
  load(json) { const { rack, warnings } = importPatch(json, MODULES); ProjectStore.dispatch(LoadRackPatch(this.rackId, rack)); warnings.forEach(warning => console.warn(warning)) }
  async save(name) { try { await FileAdapter.exportRackPatch(exportPatch(this.rack()), name || `${this.rack()?.name || 'patch'}.synthrack`) } catch (e) { if (e.name !== 'AbortError') console.warn('Rack export failed', e) } }
  render() {
    if (!this.rackId) return
    const rack = this.rack(); if (!rack) { this.unmountEngine(); return }
    this.syncEngine(rack)
    if (this.container.style.display === 'none') return
    this.rails.replaceChildren(this.canvas.canvas)
    this.rails.style.width = `${rack.railHp * 16}px`; this.rails.style.height = `${rack.rails * 220}px`
    for (const module of rack.modules) {
      const panel = renderPanel(module, { onParam: (id, key, value) => ProjectStore.dispatch(SetModuleParam(this.rackId, id, key, value)), onJack: (...args) => this.jack(...args) })
      panel.style.left = `${module.hp * 16}px`; panel.style.top = `${module.rail * 220}px`; panel.classList.toggle('selected', this.selected === module.id)
      panel.onclick = e => { if (!e.target.classList.contains('rack-jack')) { this.selected = module.id; this.render() } }
      panel.onpointerdown = e => this.drag(e, module, panel)
      this.rails.append(panel)
    }
    this.canvas.setCables(rack.cables)
  }
  syncEngine(rack) {
    const ctx = this.getAudioContext()
    if (!ctx) return
    if (this.engineHandle?.ctx === ctx) RackEngine.update(this.engineHandle, rack)
    else {
      this.unmountEngine()
      this.engineHandle = RackEngine.mount(ctx, rack, { output: this.getMasterInput(), hasWorklet: this.hasWorklet() })
    }
  }
  unmountEngine() {
    if (this.engineHandle) RackEngine.unmount(this.engineHandle)
    this.engineHandle = null
  }
  jack(moduleId, port, dir, jack) {
    const end = { moduleId, port }
    if (!this.pending) { if (dir === 'out') { this.pending = end; jack.classList.add('patching') } return }
    const result = canConnect(this.rack(), this.pending, end)
    if (result.ok) ProjectStore.dispatch(Connect(this.rackId, this.pending, end))
    this.pending = null; this.rails.querySelectorAll('.patching').forEach(x => x.classList.remove('patching'))
  }
  drag(e, module, panel) {
    if (e.target.closest('input,select,button')) return
    const start = { x: e.clientX, y: e.clientY, hp: module.hp, rail: module.rail }, move = ev => { panel.style.left = `${start.hp * 16 + ev.clientX - start.x}px`; panel.style.top = `${start.rail * 220 + ev.clientY - start.y}px`; this.canvas.draw() }, up = ev => { window.removeEventListener('pointermove', move); const rack = this.rack(), rail = Math.max(0, Math.min(rack.rails - 1, Math.round((start.rail * 220 + ev.clientY - start.y) / 220))), hp = Math.max(0, pxToHp(start.hp * 16 + ev.clientX - start.x)); if (canPlace(rack, MODULES, { rail, hp, widthHp: MODULES[module.type]?.hp || 8, ignoreId: module.id })) ProjectStore.dispatch(MoveModule(this.rackId, module.id, rail, hp)); else this.render() }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true })
  }
}
