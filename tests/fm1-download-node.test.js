import { describe, expect, it, vi } from 'vitest'
import { downloadFm1Firmware } from '../src/shared/fm1-download.js'

const url = 'https://github.com/example/firmware'
const catalog = packageUrl => ({ entries: [{ id: 'one', packageUrl }] })
const ok = bytes => new Response(bytes)

describe('FM-1 node downloader', () => {
  it('accepts only catalog entries and allowlisted redirect hosts', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }))
    await expect(downloadFm1Firmware('missing', catalog(url), { fetchFn })).rejects.toThrow('Unknown firmware')
    await expect(downloadFm1Firmware('one', catalog('http://github.com/x'), { fetchFn })).rejects.toThrow('not allowed')
    await expect(downloadFm1Firmware('one', catalog(url), { fetchFn })).rejects.toThrow('not allowed')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('follows allowed redirects and reports progress', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } })).mockResolvedValueOnce(ok(new Uint8Array([1, 2, 3])))
    const onProgress = vi.fn()
    expect(await downloadFm1Firmware('one', catalog(url), { fetchFn, onProgress })).toEqual(Buffer.from([1, 2, 3]))
    expect(onProgress).toHaveBeenCalledWith(3, undefined)
  })
  it('limits redirects and streamed bytes', async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: url } }))
    await expect(downloadFm1Firmware('one', catalog(url), { fetchFn: redirect })).rejects.toThrow('Too many')
    expect(redirect).toHaveBeenCalledTimes(6)
    await expect(downloadFm1Firmware('one', catalog(url), { fetchFn: async () => ok(new Uint8Array(8 * 1024 * 1024 + 1)) })).rejects.toThrow('8 MiB')
  })
  it('times out and supports cancellation', async () => {
    const fetchFn = (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    await expect(downloadFm1Firmware('one', catalog(url), { fetchFn, timeoutMs: 5 })).rejects.toThrow('timed out')
    const controller = new AbortController()
    const result = downloadFm1Firmware('one', catalog(url), { fetchFn, signal: controller.signal })
    controller.abort(new Error('Cancelled'))
    await expect(result).rejects.toThrow('Cancelled')
  })
})
