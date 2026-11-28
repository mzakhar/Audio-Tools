import { describe, it, expect, vi } from 'vitest'
import { canDownload, downloadFirmware, DOWNLOAD_UNAVAILABLE } from '../src/renderer/js/fm1/download.js'

describe('firmware download', () => {
  it('refuses LAN and only sends catalog identifiers to the same-origin service', async () => {
    const lan = { protocol: 'http:', hostname: 'themachine' }
    expect(canDownload(lan, null)).toBe(false)
    await expect(downloadFirmware({}, { location: lan, bridge: null })).rejects.toThrow(DOWNLOAD_UNAVAILABLE)
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2])))
    const bytes = await downloadFirmware({ catalogId: 'synth-seed', entryId: 'a/b', packageUrl: 'https://evil.example' }, { location: { protocol: 'https:', hostname: 'synth.zakharhome.org' }, bridge: null, fetcher })
    expect([...bytes]).toEqual([1, 2])
    expect(fetcher.mock.calls[0][0]).toBe('/api/fm1-firmware')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ catalogId: 'synth-seed', entryId: 'a/b' })
  })

  it('forwards desktop progress and cancellation', async () => {
    let listener, resolve
    const bridge = { download: vi.fn(() => new Promise(r => { resolve = r })), cancel: vi.fn(), onProgress: fn => { listener = fn; return () => {} } }
    const controller = new AbortController(), progress = vi.fn()
    const pending = downloadFirmware({ catalogId: 'c', entryId: 'e' }, { bridge, signal: controller.signal, progress })
    const id = bridge.download.mock.calls[0][2]
    listener({ requestId: id, loaded: 5, total: 10 })
    expect(progress).toHaveBeenCalledWith(5, 10)
    controller.abort(); expect(bridge.cancel).toHaveBeenCalledWith(id)
    resolve(new Uint8Array()); await pending
  })

  it('rejects an interrupted stream instead of returning partial firmware', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('upstream failed')) } })
    const fetcher = vi.fn(async () => new Response(body))
    await expect(downloadFirmware({ catalogId: 'synth-seed', entryId: 'a/b' }, { location: { protocol: 'https:', hostname: 'synth.zakharhome.org' }, bridge: null, fetcher })).rejects.toThrow('upstream failed')
  })
})
