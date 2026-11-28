import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import seed from '../src/renderer/js/fm1/seed-catalog.json'

const handlers = vi.hoisted(() => new Map())
vi.mock('electron', () => ({
  app: { requestSingleInstanceLock: () => false, quit: () => {}, on: () => {}, getPath: () => '.' },
  BrowserWindow: {}, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  dialog: {}, safeStorage: {}, shell: {},
}))

beforeAll(async () => { await import('../src/main/index.js') })
afterEach(() => { vi.unstubAllGlobals() })

describe('FM-1 Electron IPC', () => {
  it('rejects unknown entry IDs before contacting the network', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const event = { sender: { id: 1 } }
    await expect(handlers.get('fm1:download')(event, 'synth-seed', 'not-an-entry', 'one')).rejects.toThrow('Unknown firmware entry')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels only requests belonging to the same sender', async () => {
    let started
    const ready = new Promise(resolve => { started = resolve })
    const fetch = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      started()
    }))
    vi.stubGlobal('fetch', fetch)
    const event = { sender: { id: 1, isDestroyed: () => false } }
    const entry = seed.entries.find(row => row.packageUrl?.startsWith('https://github.com/'))
    const pending = handlers.get('fm1:download')(event, 'synth-seed', entry.id, 'two')
    await ready
    handlers.get('fm1:cancel')({ sender: { id: 2 } }, 'two')
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false)
    handlers.get('fm1:cancel')(event, 'two')
    await expect(pending).rejects.toThrow()
  })
})
