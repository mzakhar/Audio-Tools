import { describe, expect, it, vi } from 'vitest'
const engine = vi.hoisted(() => ({ mount: vi.fn(() => ({ ctx: null })), update: vi.fn(), unmount: vi.fn() }))
vi.mock('../src/renderer/js/rack/rack-engine.js', () => ({ default: engine }))
vi.mock('../src/renderer/js/components/rack-cables.js', () => ({ RackCables: class { constructor(canvas) { this.canvas = canvas } draw() {} setCables() {} hitTest() { return null } } }))
import { renderPanel } from '../src/renderer/js/components/rack-panel.js'
import { ModuleBrowser } from '../src/renderer/js/components/module-browser.js'
import { RackView } from '../src/renderer/js/components/rack-view.js'
import ProjectStore from '../src/renderer/js/store/ProjectStore.js'

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
    expect(root.textContent).not.toContain('FOLD')
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

  it('mounts once, updates, and unmounts the audio rack', () => {
    ProjectStore.reset(); engine.mount.mockClear(); engine.update.mockClear(); engine.unmount.mockClear()
    const ctx = {}, output = {}, root = document.createElement('div')
    engine.mount.mockImplementation(() => ({ ctx }))
    const view = new RackView(root, { getAudioContext: () => ctx, getMasterInput: () => output })
    view.show(); view.render()
    expect(engine.mount).toHaveBeenCalledTimes(1)
    expect(engine.mount).toHaveBeenCalledWith(ctx, expect.anything(), { output, hasWorklet: false, poll: expect.anything() })
    expect(engine.update).toHaveBeenCalled()
    expect(view.getEngineHandle()).toEqual({ ctx })
    view.destroy()
    expect(engine.unmount).toHaveBeenCalledWith({ ctx })
  })
})
