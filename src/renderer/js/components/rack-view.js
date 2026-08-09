import ProjectStore, { AddRack, AddModule, MoveModule, RemoveModule, SetModuleParam, Connect, Disconnect, LoadRackPatch } from '../store/ProjectStore.js'
import MODULES, { canConnect } from '../rack/modules/index.js'
import { canPlace, firstFreeSlot, pxToHp, tidyRack } from '../rack/rack-layout.js'
import { renderPanel } from './rack-panel.js'
import { ModuleBrowser } from './module-browser.js'
import { RackCables } from './rack-cables.js'
import RackEngine from '../rack/rack-engine.js'
import FileAdapter from '../io/FileAdapter.js'
import { exportPatch, importPatch } from '../rack/patch-io.js'
import { RackPoll } from '../rack/rack-poll.js'

const presets = import.meta.glob('../../presets/racks/*.json', { eager: true, import: 'default' })

// Panels are small at 1:1; the rack is more usable zoomed in with less rail visible.
const DEFAULT_ZOOM = 1.6

// Kept in patch form so NEW and the empty-rack bootstrap both go through importPatch.
const starter = {
  format: 'synthrack',
  version: 1,
  rack: {
    name: 'Starter rack', rails: 2, railHp: 104,
    modules: [
      { id: 'starter-vco', type: 'vco', rail: 0, hp: 0, params: {}, atten: {} },
      { id: 'starter-vca', type: 'vca', rail: 0, hp: 12, params: {}, atten: {} },
      { id: 'starter-out', type: 'out', rail: 0, hp: 20, params: {}, atten: {} }
    ],
    cables: [
      { id: 'starter-vco-vca', from: { moduleId: 'starter-vco', port: 'out' }, to: { moduleId: 'starter-vca', port: 'in' } },
      { id: 'starter-vca-out', from: { moduleId: 'starter-vca', port: 'out' }, to: { moduleId: 'starter-out', port: 'l' } }
    ]
  }
}

export class RackView {
  constructor(container, { hasWorklet, getAudioContext, getMasterInput } = {}) {
    this.container = container; this.hasWorklet = hasWorklet || (() => false); this.getAudioContext = getAudioContext || (() => null); this.getMasterInput = getMasterInput || (() => null); this.rackId = null; this.selected = null; this.pending = null; this.engineHandle = null; this.poll = new RackPoll()
    const presetOptions = Object.entries(presets).map(([path]) => `<option value="${path}">${path.split('/').pop().replace('.json', '')}</option>`).join('')
    container.innerHTML = `<div class="rack-toolbar"><button data-action="add">+ MODULE</button><button data-action="delete">REMOVE</button><button data-action="tidy">TIDY</button><button data-action="cables">CABLES</button><span class="rack-count"></span><button data-action="new">NEW</button><select data-action="preset"><option value="">LOAD PRESET</option>${presetOptions}</select><button data-action="import">IMPORT</button><button data-action="export">EXPORT</button><button data-action="save-preset">SAVE AS PRESET</button><label>ZOOM <input data-action="zoom" type="range" min=".6" max="2.5" step=".1" value="${DEFAULT_ZOOM}"></label></div><aside class="module-browser"></aside><main class="rack-scroll"><div class="rack-rails"><canvas class="rack-canvas"></canvas></div></main>`
    this.rails = container.querySelector('.rack-rails'); this.rails.style.setProperty('--rack-zoom', DEFAULT_ZOOM); this.canvas = new RackCables(container.querySelector('.rack-canvas'), this.rails)
    this.browser = new ModuleBrowser(container.querySelector('.module-browser'), { hasWorklet: this.hasWorklet, onPick: type => this.add(type) })
    container.querySelector('[data-action="add"]').onclick = () => container.classList.toggle('browser-open')
    container.querySelector('[data-action="delete"]').onclick = () => this.selected && ProjectStore.dispatch(RemoveModule(this.rackId, this.selected))
    // tidyRack returns a bare rack, not a patch — importPatch would reject it.
    container.querySelector('[data-action="tidy"]').onclick = () => ProjectStore.dispatch(LoadRackPatch(this.rackId, tidyRack(this.rack(), MODULES)))
    container.querySelector('[data-action="cables"]').onclick = e => { this.canvas.hidden = !this.canvas.hidden; e.currentTarget.classList.toggle('active', !this.canvas.hidden) }
    container.querySelector('[data-action="new"]').onclick = () => this.load(starter)
    container.querySelector('[data-action="preset"]').onchange = e => { if (e.target.value) this.load(presets[e.target.value]); e.target.value = '' }
    container.querySelector('[data-action="import"]').onclick = async () => { try { const json = await FileAdapter.importRackPatch(); if (json) this.load(json) } catch (e) { if (e.name !== 'AbortError') console.warn('Rack import failed', e) } }
    container.querySelector('[data-action="export"]').onclick = () => this.save()
    container.querySelector('[data-action="save-preset"]').onclick = () => this.save(`${this.rack()?.name || 'preset'}.synthrack`)
    container.querySelector('[data-action="zoom"]').oninput = e => { this.rails.style.setProperty('--rack-zoom', e.target.value); this.sizeRails(); this.canvas.draw() }
    // offsetX/Y is relative to whatever was hit — and panels now cover the full rail
    // height, so a cable is almost always over a panel. Measure against the rails.
    this.rails.addEventListener('dblclick', e => {
      const rect = this.rails.getBoundingClientRect(), zoom = this.canvas.zoom()
      const hit = this.canvas.hitTest((e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom)
      if (hit) ProjectStore.dispatch(Disconnect(this.rackId, hit.id))
    })
    this.unsubscribe = ProjectStore.subscribe(() => this.render())
  }
  show() { this.container.style.display = 'grid'; this.poll.start(); if (!this.rackId) { const racks = ProjectStore.getState().racks; this.rackId = Object.keys(racks)[0] || 'starter-rack'; if (!racks[this.rackId]) ProjectStore.dispatch(AddRack('Starter rack', this.rackId)); if (!ProjectStore.getState().racks[this.rackId].modules.length) this.load(starter) } this.render() }
  hide() { this.container.style.display = 'none'; this.poll.stop() }
  destroy() { this.unsubscribe?.(); this.poll.stop(); this.poll.clear(); this.unmountEngine() }
  getEngineHandle() { return this.engineHandle }
  rack() { return ProjectStore.getState().racks[this.rackId] }
  add(type) { const rack = this.rack(), slot = firstFreeSlot(rack, MODULES, MODULES[type].hp); if (slot) ProjectStore.dispatch(AddModule(this.rackId, type, slot)) }
  load(json) { const { rack, warnings } = importPatch(json, MODULES); ProjectStore.dispatch(LoadRackPatch(this.rackId, rack)); warnings.forEach(warning => console.warn(warning)) }
  async save(name) { try { await FileAdapter.exportRackPatch(exportPatch(this.rack()), name || `${this.rack()?.name || 'patch'}.synthrack`) } catch (e) { if (e.name !== 'AbortError') console.warn('Rack export failed', e) } }
  render() {
    if (!this.rackId) return
    const rack = this.rack(); if (!rack) { this.unmountEngine(); return }
    const count = this.container.querySelector('.rack-count'); if (count) { const warning = rack.modules.length > 96 || rack.cables.length > 128; count.textContent = `${rack.modules.length}M ${rack.cables.length}C`; count.classList.toggle('warning', warning) }
    // An engine failure must not take the panels down with it.
    try { this.syncEngine(rack) } catch (e) { console.warn('Rack engine sync failed', e) }
    if (this.container.style.display === 'none') return
    this.railHp = rack.railHp; this.railCount = rack.rails
    this.sizeRails()
    // Rebuilding the panels on every store change destroys whatever control the user
    // is holding — an open <select> closes, a slider drag drops. Only rebuild when the
    // rack's shape actually changed; otherwise push values into the existing controls.
    const shape = JSON.stringify([rack.rails, rack.railHp, rack.modules.map(m => [m.id, m.type, m.rail, m.hp]), rack.cables.map(c => c.id)])
    if (shape === this.shape) { this.syncValues(rack); this.canvas.setCables(rack.cables); return }
    this.shape = shape
    this.rails.replaceChildren(this.canvas.canvas)
    for (const module of rack.modules) {
      const panel = renderPanel(module, { onParam: (id, key, value) => ProjectStore.dispatch(SetModuleParam(this.rackId, id, key, value)), onJack: (...args) => this.jack(...args) })
      panel.style.left = `${module.hp * 16}px`; panel.style.top = `${module.rail * 220}px`; panel.classList.toggle('selected', this.selected === module.id)
      panel.onclick = e => { if (!e.target.classList.contains('rack-jack')) this.select(module.id) }
      panel.onpointerdown = e => this.drag(e, module, panel)
      this.rails.append(panel)
    }
    this.canvas.setCables(rack.cables)
  }
  // Selection is a CSS class, not a reason to rebuild the DOM.
  select(moduleId) {
    this.selected = moduleId
    for (const panel of this.rails.querySelectorAll('.rack-panel')) panel.classList.toggle('selected', panel.dataset.moduleId === moduleId)
  }
  // Params changed underneath us (undo, preset param edit, automation). Update the
  // controls, but never the one the user is currently interacting with.
  syncValues(rack) {
    for (const module of rack.modules) {
      const panel = this.rails.querySelector(`[data-module-id="${module.id}"]`)
      if (!panel) continue
      for (const [key, value] of Object.entries(module.params || {})) {
        const input = panel.querySelector(`[data-param="${key}"]`)
        if (!input || input === document.activeElement) continue
        if (input.type === 'checkbox') input.checked = !!value
        else if (String(input.value) !== String(value)) input.value = value
      }
    }
  }
  // `transform: scale()` does not grow the layout box, so the scroll container would
  // clip a zoomed-in rack. Reserve the extra with margins.
  sizeRails() {
    const width = (this.railHp ?? 104) * 16, height = (this.railCount ?? 2) * 220
    const zoom = Number(getComputedStyle(this.rails).getPropertyValue('--rack-zoom')) || 1
    Object.assign(this.rails.style, {
      width: `${width}px`,
      height: `${height}px`,
      marginRight: `${width * (zoom - 1)}px`,
      marginBottom: `${height * (zoom - 1)}px`
    })
  }
  syncEngine(rack) {
    const ctx = this.getAudioContext()
    if (!ctx) return
    if (this.engineHandle?.ctx === ctx) RackEngine.update(this.engineHandle, rack)
    else {
      this.unmountEngine()
      this.engineHandle = RackEngine.mount(ctx, rack, { output: this.getMasterInput(), hasWorklet: this.hasWorklet(), poll: this.poll })
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
    // Pointer deltas arrive in screen px; the rails are scaled, so convert to layout px.
    const zoom = this.canvas.zoom()
    const start = { x: e.clientX, y: e.clientY, hp: module.hp, rail: module.rail }
    const left = ev => start.hp * 16 + (ev.clientX - start.x) / zoom
    const top = ev => start.rail * 220 + (ev.clientY - start.y) / zoom
    const move = ev => { panel.style.left = `${left(ev)}px`; panel.style.top = `${top(ev)}px`; this.canvas.draw() }
    const up = ev => { window.removeEventListener('pointermove', move); const rack = this.rack(), rail = Math.max(0, Math.min(rack.rails - 1, Math.round(top(ev) / 220))), hp = Math.max(0, pxToHp(left(ev))); if (canPlace(rack, MODULES, { rail, hp, widthHp: MODULES[module.type]?.hp || 8, ignoreId: module.id })) ProjectStore.dispatch(MoveModule(this.rackId, module.id, rail, hp)); else { panel.style.left = `${module.hp * 16}px`; panel.style.top = `${module.rail * 220}px`; this.canvas.draw() } }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true })
  }
}
