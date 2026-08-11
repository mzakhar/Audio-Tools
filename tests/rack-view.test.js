import { describe, expect, it, vi } from 'vitest'
const engine = vi.hoisted(() => ({ mount: vi.fn(() => ({ ctx: null })), update: vi.fn(), unmount: vi.fn() }))
vi.mock('../src/renderer/js/rack/rack-engine.js', () => ({ default: engine }))
vi.mock('../src/renderer/js/components/rack-cables.js', () => ({ RackCables: class { constructor(canvas) { this.canvas = canvas } draw() {} setCables() {} hitTest() { return null } } }))
import { renderPanel, sideColumns } from '../src/renderer/js/components/rack-panel.js'
import { ModuleBrowser } from '../src/renderer/js/components/module-browser.js'
import { RackView, presetMenu } from '../src/renderer/js/components/rack-view.js'
import ProjectStore from '../src/renderer/js/store/ProjectStore.js'
import MODULES from '../src/renderer/js/rack/modules/index.js'
import { firstFreeSlot, tidyRack } from '../src/renderer/js/rack/rack-layout.js'

describe('rack panel', () => {
  it('renders registry controls and labelled jacks', () => {
    const panel = renderPanel({ id: 'v1', type: 'vco', params: {} })
    expect(panel.querySelector('[aria-label="VCO V/OCT input"]')).toBeTruthy()
    expect(panel.querySelectorAll('input, select').length).toBeGreaterThan(0)
  })

  it('draws its own DOM for a module with a panel() hook', () => {
    const panel = renderPanel({ id: 'k1', type: 'keys', params: {} })
    expect(panel.querySelector('.rack-keys')).toBeTruthy()
  })

  it('sends selected module from browser and hides unavailable worklets', () => {
    const root = document.createElement('div'), pick = vi.fn()
    new ModuleBrowser(root, { hasWorklet: () => false, onPick: pick })
    root.querySelector('button').click()
    expect(pick).toHaveBeenCalled()
    expect(root.textContent).not.toContain('SLEW')
  })

  it('orders a patch by port direction, whichever jack it started from', () => {
    ProjectStore.reset()
    const view = new RackView(document.createElement('div'), {})
    view.show()

    view.patch({ moduleId: 'starter-vca', port: 'cv', dir: 'in' }, { moduleId: 'starter-vco', port: 'sub', dir: 'out' })

    const cable = view.rack().cables.at(-1)
    expect(cable.from).toEqual({ moduleId: 'starter-vco', port: 'sub' })
    expect(cable.to).toEqual({ moduleId: 'starter-vca', port: 'cv' })

    // Two inputs (or two outputs) are not a patch.
    const before = view.rack().cables.length
    view.patch({ moduleId: 'starter-vca', port: 'in', dir: 'in' }, { moduleId: 'starter-vco', port: 'fm', dir: 'in' })
    expect(view.rack().cables).toHaveLength(before)
    view.destroy()
  })

  it('docks a dock:bottom module below the rails, clear of rail layout', () => {
    ProjectStore.reset()
    const view = new RackView(document.createElement('div'), {})
    view.show()

    view.add('keys')
    const keys = view.rack().modules.at(-1)
    expect(keys.rail).toBe(-1)
    // The dock sits below every rail, and every rail sits below the always-on
    // 110px util row.
    expect(view.railTop(view.rack(), keys.rail)).toBe(110 + view.rack().rails * 220)

    // Invisible to rail packing: TIDY must not pull it onto a rail, and a rail
    // module must still be free to take hp 0.
    expect(firstFreeSlot(view.rack(), MODULES, 4)).toEqual({ rail: 0, hp: 24 })
    expect(tidyRack(view.rack(), MODULES).modules.find(m => m.id === keys.id).hp).toBe(keys.hp)

    // A second docked module stacks beside it, not on top of it.
    view.add('keys')
    expect(view.rack().modules.at(-1)).toMatchObject({ rail: -1, hp: MODULES.keys.hp })
    view.destroy()
  })

  it('places a util:true module in the half-height row above the rails', () => {
    ProjectStore.reset()
    const view = new RackView(document.createElement('div'), {})
    view.show()

    view.add('bus')
    const bus = view.rack().modules.at(-1)
    expect(bus.rail).toBe(-2)
    expect(view.railTop(view.rack(), bus.rail)).toBe(0)
    view.destroy()
  })

  it('mounts once, updates, and unmounts the audio rack', () => {
    ProjectStore.reset(); engine.mount.mockClear(); engine.update.mockClear(); engine.unmount.mockClear()
    const ctx = {}, output = {}, root = document.createElement('div')
    engine.mount.mockImplementation(() => ({ ctx }))
    const view = new RackView(root, { getAudioContext: () => ctx, getMasterInput: () => output })
    view.show(); view.render()
    expect(engine.mount).toHaveBeenCalledTimes(1)
    expect(engine.mount).toHaveBeenCalledWith(ctx, expect.anything(), { output, hasWorklet: false, poll: expect.anything(), getBuffer: expect.any(Function) })
    expect(engine.update).toHaveBeenCalled()
    expect(view.getEngineHandle()).toEqual({ ctx })
    view.destroy()
    expect(engine.unmount).toHaveBeenCalledWith({ ctx })
  })
})

describe('side knob column', () => {
  it('wraps past three cells so a column cannot run off the panel', () => {
    expect(sideColumns(3, 20)).toBe(1)
    expect(sideColumns(4, 20)).toBe(2)
    expect(sideColumns(7, 24)).toBe(3)
  })

  // The bug this exists to stop: TURING at 8 HP asked for two 58px columns,
  // which came to exactly the panel width and left its LED readout 0px wide.
  it('never lets the knob column starve the display', () => {
    expect(sideColumns(4, 8)).toBe(1)
    expect(sideColumns(9, 8)).toBe(1)
    expect(sideColumns(9, 12)).toBe(1)
    expect(sideColumns(4, 20)).toBe(2)   // room for two once the panel is wide
  })

  it('always gives at least one column, however narrow the panel claims to be', () => {
    expect(sideColumns(5, 2)).toBe(1)
    expect(sideColumns(0, 20)).toBe(1)
  })
})

describe('preset menu', () => {
  const entries = {
    '../../presets/racks/zed.synthrack.json': { category: 'beat', rack: { name: 'Zed Kit' } },
    '../../presets/racks/abc.synthrack.json': { category: 'beat', rack: { name: 'Abc Kit' } },
    '../../presets/racks/loose.synthrack.json': { rack: { name: 'Loose Patch' } },
    '../../presets/racks/gen.synthrack.json': { category: 'generative', rack: { name: 'Gen' } }
  }

  it('groups by category, named categories first and other last', () => {
    const labels = [...presetMenu(entries).matchAll(/<optgroup label="([^"]+)"/g)].map(m => m[1])
    expect(labels).toEqual(['BEAT', 'GENERATIVE', 'OTHER'])
  })

  it('labels options with the patch name, alphabetically inside a group', () => {
    const names = [...presetMenu(entries).matchAll(/<option value="[^"]*">([^<]+)</g)].map(m => m[1])
    expect(names.slice(0, 2)).toEqual(['Abc Kit', 'Zed Kit'])
  })

  it('falls back to the filename when a preset carries no name', () => {
    const html = presetMenu({ '../../presets/racks/bare.synthrack.json': {} })
    expect(html).toContain('>bare<')
  })
})
