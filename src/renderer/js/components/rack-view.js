import ProjectStore, { AddRack, AddModule, MoveModule, RemoveModule, SetModuleParam, Connect, Disconnect, LoadRackPatch, SetRackRails } from '../store/ProjectStore.js'
import MODULES, { canConnect, paramDefaults } from '../rack/modules/index.js'
import { canPlace, firstFreeSlot, pxToHp, tidyRack, minRails, moduleWidthHp } from '../rack/rack-layout.js'
import { renderPanel } from './rack-panel.js'
import { paintKnob } from './knob.js'
import { ModuleBrowser } from './module-browser.js'
import { RackCables } from './rack-cables.js'
import RackEngine from '../rack/rack-engine.js'
import AudioStore from '../audio-store.js'
import FileAdapter from '../io/FileAdapter.js'
import { exportPatch, importPatch } from '../rack/patch-io.js'
import { RackPoll } from '../rack/rack-poll.js'

const presets = import.meta.glob('../../presets/racks/*.json', { eager: true, import: 'default' })

// Named categories first, in this order; anything else lands in "other".
const CATEGORY_ORDER = ['beat', 'generative', 'texture']

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// A flat filename list stopped scaling past a dozen patches. Group by the
// preset's own `category` field (metadata the importer ignores) and label each
// entry with the patch name rather than its filename. Exported for tests.
export function presetMenu(entries) {
  const groups = new Map()
  for (const [path, preset] of Object.entries(entries)) {
    const category = preset?.category || 'other'
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category).push({ path, name: preset?.rack?.name || path.split('/').pop().replace('.synthrack.json', '').replace('.json', '') })
  }
  const rank = c => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? CATEGORY_ORDER.length + (c === 'other' ? 1 : 0) : i }
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, items]) => {
      const options = items
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ path, name }) => `<option value="${escapeHtml(path)}">${escapeHtml(name)}</option>`)
        .join('')
      return `<optgroup label="${escapeHtml(category.toUpperCase())}">${options}</optgroup>`
    })
    .join('')
}

// Panels are small at 1:1; the rack is more usable zoomed in with less rail visible.
const DEFAULT_ZOOM = 1.6

// The dock is deeper than a 3U rail: a keyboard plus its jacks and knobs does not
// fit in 220px. Keep in step with `.rack-panel.docked` height in style.css.
const DOCK_H = 236

// The util row sits above the rails (rail index -2), half-height, for modules
// that never need a full 220px. Always present, empty or not: the rail stripes
// are painted from it, so a row that appeared and vanished would shift every
// panel off its stripe. Keep in step with `.rack-panel.util` and the
// `--rack-util-h` background offset in style.css.
const UTIL_RAIL = -2
const UTIL_H = 110

// Kept in patch form so NEW and the empty-rack bootstrap both go through importPatch.
// Exported for tests only — production code below still reaches it via closure.
export const starter = {
  format: 'synthrack',
  version: 1,
  rack: {
    name: 'Starter rack', rails: 2, railHp: 104,
    modules: [
      { id: 'starter-vc', type: 'vc', rail: UTIL_RAIL, hp: 0, params: {}, atten: {} },
      { id: 'starter-out', type: 'out', rail: UTIL_RAIL, hp: 24, params: {}, atten: {} },
      { id: 'starter-vco', type: 'vco', rail: 0, hp: 0, params: {}, atten: {} },
      { id: 'starter-vca', type: 'vca', rail: 0, hp: 12, params: {}, atten: {} },
      { id: 'starter-adsr', type: 'adsr', rail: 0, hp: 26, params: {}, atten: {} }
    ],
    // The ADSR is here to keep the rack quiet, not just to be useful: an
    // unpatched VCA normals its CV to unity, so VCO → VCA → OUT alone is a
    // drone the moment the view mounts. An envelope resting at 0 with nothing
    // gating it closes the VCA until the user patches a gate into it.
    cables: [
      { id: 'starter-vco-vca', from: { moduleId: 'starter-vco', port: 'out' }, to: { moduleId: 'starter-vca', port: 'in' } },
      { id: 'starter-vca-out', from: { moduleId: 'starter-vca', port: 'out' }, to: { moduleId: 'starter-out', port: 'in' } },
      { id: 'starter-adsr-vca', from: { moduleId: 'starter-adsr', port: 'env' }, to: { moduleId: 'starter-vca', port: 'cv' } }
    ]
  }
}

export class RackView {
  constructor(container, { hasWorklet, getAudioContext, getMasterInput } = {}) {
    this.container = container; this.hasWorklet = hasWorklet || (() => false); this.getAudioContext = getAudioContext || (() => null); this.getMasterInput = getMasterInput || (() => null); this.rackId = null; this.selected = null; this.pending = null; this.engineHandle = null; this.poll = new RackPoll()
    const presetOptions = presetMenu(presets)
    container.innerHTML = `<div class="rack-toolbar"><button data-action="add">+ MODULE</button><button data-action="delete">REMOVE</button><button data-action="tidy">TIDY</button><button data-action="cables">CABLES</button><span class="rack-count"></span><button data-action="new">NEW</button><select data-action="preset"><option value="">LOAD PRESET</option>${presetOptions}</select><button data-action="import">IMPORT</button><button data-action="export">EXPORT</button><button data-action="save-preset">SAVE AS PRESET</button><label>ZOOM <input data-action="zoom" type="range" min=".6" max="2.5" step=".1" value="${DEFAULT_ZOOM}"></label><label>RAILS <input data-action="rails" type="number" min="1" max="8" step="1" value="2"></label></div><aside class="module-browser"></aside><main class="rack-scroll"><div class="rack-rails"><canvas class="rack-canvas"></canvas></div></main>`
    this.rails = container.querySelector('.rack-rails'); this.rails.style.setProperty('--rack-zoom', DEFAULT_ZOOM); this.canvas = new RackCables(container.querySelector('.rack-canvas'), this.rails)
    this.browser = new ModuleBrowser(container.querySelector('.module-browser'), { hasWorklet: this.hasWorklet, onPick: type => this.add(type) })
    container.querySelector('[data-action="add"]').onclick = () => container.classList.toggle('browser-open')
    container.querySelector('[data-action="delete"]').onclick = () => this.selected && ProjectStore.dispatch(RemoveModule(this.rackId, this.selected))
    // tidyRack returns a bare rack, not a patch — importPatch would reject it.
    container.querySelector('[data-action="tidy"]').onclick = () => ProjectStore.dispatch(LoadRackPatch(this.rackId, tidyRack(this.rack(), MODULES)))
    container.querySelector('[data-action="cables"]').onclick = e => { this.canvas.hidden = !this.canvas.hidden; e.currentTarget.classList.toggle('active', !this.canvas.hidden) }
    container.querySelector('[data-action="new"]').onclick = () => this.load(starter, { tidy: true })
    container.querySelector('[data-action="preset"]').onchange = e => { if (e.target.value) this.load(presets[e.target.value], { tidy: true }); e.target.value = '' }
    container.querySelector('[data-action="import"]').onclick = async () => { try { const json = await FileAdapter.importRackPatch(); if (json) this.load(json) } catch (e) { if (e.name !== 'AbortError') console.warn('Rack import failed', e) } }
    container.querySelector('[data-action="export"]').onclick = () => this.save()
    container.querySelector('[data-action="save-preset"]').onclick = () => this.save(`${this.rack()?.name || 'preset'}.synthrack`)
    container.querySelector('[data-action="zoom"]').oninput = e => { this.rails.style.setProperty('--rack-zoom', e.target.value); this.sizeRails(); this.canvas.draw() }
    container.querySelector('[data-action="rails"]').onchange = e => {
      const rack = this.rack(); if (!rack) return
      const rails = Math.max(minRails(rack), Math.min(8, Number(e.target.value) || 1))
      e.target.value = rails
      ProjectStore.dispatch(SetRackRails(this.rackId, rails))
    }
    // Delegated so it survives the panel rebuilds; the rails element itself is stable.
    this.rails.addEventListener('pointerdown', e => {
      const jack = e.target.closest('.rack-jack')
      if (jack) this.beginPatchDrag(e, jack)
    })
    // offsetX/Y is relative to whatever was hit — and panels now cover the full rail
    // height, so a cable is almost always over a panel. Measure against the rails.
    this.rails.addEventListener('dblclick', e => {
      const rect = this.rails.getBoundingClientRect(), zoom = this.canvas.zoom()
      const hit = this.canvas.hitTest((e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom)
      if (hit) ProjectStore.dispatch(Disconnect(this.rackId, hit.id))
    })
    this.unsubscribe = ProjectStore.subscribe(() => this.render())
  }
  show() { this.container.style.display = 'grid'; this.poll.start(); if (!this.rackId) { const racks = ProjectStore.getState().racks; this.rackId = Object.keys(racks)[0] || 'starter-rack'; if (!racks[this.rackId]) ProjectStore.dispatch(AddRack('Starter rack', this.rackId)); if (!ProjectStore.getState().racks[this.rackId].modules.length) this.load(starter, { tidy: true }) } this.render() }
  hide() { this.container.style.display = 'none'; this.poll.stop() }
  destroy() { this.unsubscribe?.(); this.poll.stop(); this.poll.clear(); this.unmountEngine() }
  getEngineHandle() { return this.engineHandle }
  rack() { return ProjectStore.getState().racks[this.rackId] }
  // rail -1 is the dock: the strip under the rails. canPlace already rejects a
  // negative rail and firstFreeSlot/packRail only walk 0..rails, so a docked
  // module is invisible to rail layout and never collides with one.
  add(type) {
    const rack = this.rack(), def = MODULES[type]
    if (!def) return
    const slot = def.util
      ? { rail: UTIL_RAIL, hp: rack.modules.filter(m => m.rail === UTIL_RAIL).reduce((x, m) => x + moduleWidthHp(m, MODULES), 0) }
      : def.dock
      ? { rail: -1, hp: rack.modules.filter(m => m.rail === -1).reduce((x, m) => x + moduleWidthHp(m, MODULES), 0) }
      : firstFreeSlot(rack, MODULES, def.hp)
    if (slot) ProjectStore.dispatch(AddModule(this.rackId, type, slot))
  }
  railTop(rack, rail) {
    if (rail === UTIL_RAIL) return 0
    return (this.railOffset ?? 0) + (rail < 0 ? rack.rails : rail) * 220
  }
  // Live params for a module, read from the store at call time. Panels that draw
  // from params (KEYS, ALGO) outlive the snapshot they were built with.
  moduleParams(moduleId) {
    const mod = this.rack()?.modules.find(m => m.id === moduleId)
    return mod ? { ...paramDefaults(mod.type), ...mod.params } : {}
  }
  // `tidy` packs the rails flush on load. On for the canned patches (presets, NEW);
  // off for IMPORT, where the file carries a layout the user arranged themselves.
  load(json, { tidy = false } = {}) {
    const { rack, warnings } = importPatch(json, MODULES)
    ProjectStore.dispatch(LoadRackPatch(this.rackId, tidy ? tidyRack(rack, MODULES) : rack))
    warnings.forEach(warning => console.warn(warning))
  }
  async save(name) { try { await FileAdapter.exportRackPatch(exportPatch(this.rack()), name || `${this.rack()?.name || 'patch'}.synthrack`) } catch (e) { if (e.name !== 'AbortError') console.warn('Rack export failed', e) } }
  render() {
    if (!this.rackId) return
    const rack = this.rack(); if (!rack) { this.unmountEngine(); return }
    const count = this.container.querySelector('.rack-count'); if (count) { const warning = rack.modules.length > 96 || rack.cables.length > 128; count.textContent = `${rack.modules.length}M ${rack.cables.length}C`; count.classList.toggle('warning', warning) }
    const railsInput = this.container.querySelector('[data-action="rails"]')
    if (railsInput && railsInput !== document.activeElement) railsInput.value = rack.rails
    // An engine failure must not take the panels down with it.
    try { this.syncEngine(rack) } catch (e) { console.warn('Rack engine sync failed', e) }
    if (this.container.style.display === 'none') return
    this.railHp = rack.railHp; this.railCount = rack.rails
    this.dockRows = rack.modules.some(m => m.rail === -1) ? 1 : 0
    this.railOffset = UTIL_H
    this.sizeRails()
    // Rebuilding the panels on every store change destroys whatever control the user
    // is holding — an open <select> closes, a slider drag drops. Only rebuild when the
    // rack's shape actually changed; otherwise push values into the existing controls.
    const shape = JSON.stringify([rack.rails, rack.railHp, rack.modules.map(m => [m.id, m.type, m.rail, m.hp]), rack.cables.map(c => c.id)])
    if (shape === this.shape) { this.syncValues(rack); this.canvas.setCables(rack.cables); return }
    this.shape = shape
    this.rails.replaceChildren(this.canvas.canvas)
    for (const module of rack.modules) {
      const panel = renderPanel(module, { onParam: (id, key, value) => ProjectStore.dispatch(SetModuleParam(this.rackId, id, key, value)), onJack: (...args) => this.jack(...args), onEvent: (id, port, event) => this.engineHandle && RackEngine.sendEvent(this.engineHandle, id, port, event), getParams: id => this.moduleParams(id), getInstance: id => this.engineHandle && RackEngine.getInstance(this.engineHandle, id), addPoll: job => this.poll.add(job) })
      panel.style.left = `${module.hp * 16}px`; panel.style.top = `${this.railTop(rack, module.rail)}px`; panel.classList.toggle('selected', this.selected === module.id); panel.classList.toggle('docked', module.rail === -1); panel.classList.toggle('util', module.rail === UTIL_RAIL)
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
        else if (String(input.value) !== String(value)) { input.value = value; paintKnob(input) }
      }
      panel.__refresh?.()
    }
  }
  // `transform: scale()` does not grow the layout box, so the scroll container would
  // clip a zoomed-in rack. Reserve the extra with margins.
  sizeRails() {
    const width = (this.railHp ?? 104) * 16, height = UTIL_H + (this.railCount ?? 2) * 220 + (this.dockRows ?? 0) * DOCK_H
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
      this.engineHandle = RackEngine.mount(ctx, rack, { output: this.getMasterInput(), hasWorklet: this.hasWorklet(), poll: this.poll, getBuffer: key => AudioStore.getBufferOrLoad(key) })
    }
  }
  unmountEngine() {
    if (this.engineHandle) RackEngine.unmount(this.engineHandle)
    this.engineHandle = null
  }
  jack(moduleId, port, dir, jack) {
    const end = { moduleId, port, dir }
    if (!this.pending) { this.pending = end; jack.classList.add('patching'); return }
    this.patch(this.pending, end)
    this.clearPending()
  }
  clearPending() {
    this.pending = null
    this.rails.querySelectorAll('.patching').forEach(x => x.classList.remove('patching'))
  }
  endpointOf(jack) {
    const moduleId = jack.closest('[data-module-id]')?.dataset.moduleId
    return moduleId ? { moduleId, port: jack.dataset.port, dir: jack.dataset.dir } : null
  }
  // A patch has no inherent direction on a real rack — you can start at either end.
  // canConnect does care, so order the pair before handing it over.
  patch(a, b) {
    if (!a || !b || a.dir === b.dir) return
    const [out, into] = a.dir === 'out' ? [a, b] : [b, a]
    const from = { moduleId: out.moduleId, port: out.port }, to = { moduleId: into.moduleId, port: into.port }
    const result = canConnect(this.rack(), from, to)
    if (result.ok) ProjectStore.dispatch(Connect(this.rackId, from, to))
    else console.warn(`Cannot patch ${from.moduleId}.${from.port} into ${to.moduleId}.${to.port}: ${result.reason}`)
  }
  // Drag a cable from one jack to another. A press that never moves stays a plain
  // click, so the click-then-click way of patching keeps working.
  beginPatchDrag(e, jackEl) {
    const from = this.endpointOf(jackEl)
    if (!from) return
    e.preventDefault()
    const anchor = this.canvas.point(from.moduleId, from.port)
    const layout = ev => {
      const rect = this.rails.getBoundingClientRect(), zoom = this.canvas.zoom()
      return { x: (ev.clientX - rect.left) / zoom, y: (ev.clientY - rect.top) / zoom }
    }
    let dragging = false
    const move = ev => {
      if (!dragging && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
      dragging = true
      this.canvas.setPreview(anchor, layout(ev))
    }
    const up = ev => {
      window.removeEventListener('pointermove', move)
      this.canvas.setPreview(null, null)
      if (!dragging) return
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.rack-jack')
      this.patch(from, target && this.endpointOf(target))
      this.clearPending()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }
  drag(e, module, panel) {
    if (module.rail < 0) return // docked: the strip is its only home
    if (e.target.closest('input,select,button,.rack-keys')) return
    // Pointer deltas arrive in screen px; the rails are scaled, so convert to layout px.
    const zoom = this.canvas.zoom()
    const start = { x: e.clientX, y: e.clientY, hp: module.hp, rail: module.rail }
    const left = ev => start.hp * 16 + (ev.clientX - start.x) / zoom
    const top = ev => this.railTop(this.rack(), start.rail) + (ev.clientY - start.y) / zoom
    const move = ev => { panel.style.left = `${left(ev)}px`; panel.style.top = `${top(ev)}px`; this.canvas.draw() }
    const up = ev => {
      window.removeEventListener('pointermove', move)
      const rack = this.rack()
      const rail = Math.max(0, Math.min(rack.rails - 1, Math.round((top(ev) - (this.railOffset ?? 0)) / 220)))
      const hp = Math.max(0, pxToHp(left(ev)))
      if (canPlace(rack, MODULES, { rail, hp, widthHp: MODULES[module.type]?.hp || 8, ignoreId: module.id })) {
        ProjectStore.dispatch(MoveModule(this.rackId, module.id, rail, hp))
      }
      // Snap to whatever the store settled on. Covers a rejected drop and a no-op drop,
      // where the shape is unchanged so render() will not rebuild this panel.
      const now = this.rack(), placed = now.modules.find(m => m.id === module.id)
      if (placed) {
        panel.style.left = `${placed.hp * 16}px`
        panel.style.top = `${this.railTop(now, placed.rail)}px`
      }
      this.canvas.draw()
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true })
  }
}
