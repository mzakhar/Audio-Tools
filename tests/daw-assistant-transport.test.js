// Transport selection: the dialog itself does not change (spec phase 3) — it
// just picks IPC when window.dawAssistant exists and no propose/ask dep was
// injected, otherwise the fetch route. No DOM markup needed: the constructor
// assigns this.propose/this.ask before it ever looks for #assistant-dialog.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantDialog } from '../src/renderer/js/components/assistant-dialog.js'

afterEach(() => {
  delete window.dawAssistant
  vi.unstubAllGlobals()
})

describe('assistant transport selection', () => {
  it('uses the IPC bridge when window.dawAssistant exists and no propose/ask dep was injected', async () => {
    const plan = { summary: 'Set the tempo.', actions: [{ action: 'SetBpm', args: { bpm: 128 } }] }
    window.dawAssistant = {
      propose: vi.fn().mockResolvedValue({ plan }),
      ask: vi.fn().mockResolvedValue({ answer: 'The tempo is 120 BPM.', cited: ['bpm'] }),
    }
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const dialog = new AssistantDialog()
    await expect(dialog.propose('set tempo', { bpm: 120 })).resolves.toEqual(plan)
    expect(window.dawAssistant.propose).toHaveBeenCalledWith('set tempo', { bpm: 120 })
    await expect(dialog.ask('what is the tempo?', { bpm: 120 })).resolves.toEqual({ answer: 'The tempo is 120 BPM.', cited: ['bpm'] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to the fetch route when window.dawAssistant is absent', async () => {
    const plan = { summary: 'Set the tempo.', actions: [{ action: 'SetBpm', args: { bpm: 128 } }] }
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ plan }) })
    vi.stubGlobal('fetch', fetchSpy)

    const dialog = new AssistantDialog()
    await expect(dialog.propose('set tempo', { bpm: 120 })).resolves.toEqual(plan)
    expect(fetchSpy).toHaveBeenCalledWith('/api/assistant', expect.objectContaining({ method: 'POST' }))
  })

  it('an injected propose/ask dep still wins even when window.dawAssistant exists', async () => {
    window.dawAssistant = { propose: vi.fn(), ask: vi.fn() }
    const propose = vi.fn().mockResolvedValue({ summary: 'x', actions: [] })
    const dialog = new AssistantDialog({ propose })
    await dialog.propose('hi', {})
    expect(propose).toHaveBeenCalled()
    expect(window.dawAssistant.propose).not.toHaveBeenCalled()
  })
})
