import { describe, expect, it, vi } from 'vitest'
import { createFreesoundAdapter, freesoundPreviewUrl } from '../src/main/music-discovery/freesound.js'
import { createDiscoveryService } from '../src/main/music-discovery/index.js'

const brief = { text: 'soul vocal', target: 'sample-loop', sources: ['web'] }
const result = {
  results: [
    { id: 1, name: 'Soul Vocal', username: 'Ada', url: 'https://freesound.org/people/ada/sounds/1/', license: 'CC0', tags: ['soul', 'vocal'], previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/1/one-hq.mp3' } },
    { id: 2, name: 'Bad', username: 'Mallory', url: 'file:///bad', tags: [] },
  ],
}

describe('Freesound adapter', () => {
  it('stays unavailable before setup', () => {
    expect(createFreesoundAdapter(null)).toBeNull()
  })

  it('uses fixed token auth and returns only validated metadata candidates', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => result })
    const adapter = createFreesoundAdapter({ token: 'secret', fetchFn })
    const output = await adapter.investigate({ brief })
    const [url, options] = fetchFn.mock.calls[0]
    expect(url.origin).toBe('https://freesound.org')
    expect(url.pathname).toBe('/apiv2/search/text/')
    expect(url.searchParams.get('page_size')).toBe('30')
    expect(url.searchParams.get('fields')).toContain('previews')
    expect(options.headers.Authorization).toBe('Token secret')
    expect(output.candidates).toEqual([expect.objectContaining({ assetName: 'Soul Vocal', sourceId: 'freesound', previewUrl: 'https://cdn.freesound.org/previews/1/one-hq.mp3' })])
  })

  it('permits only fixed Freesound CDN preview URLs', () => {
    expect(freesoundPreviewUrl({ sourceId: 'freesound', previewUrl: 'https://cdn.freesound.org/previews/1/one.mp3' })).toBe('https://cdn.freesound.org/previews/1/one.mp3')
    expect(freesoundPreviewUrl({ sourceId: 'freesound', previewUrl: 'https://evil.test/previews/1/one.mp3' })).toBeNull()
    expect(freesoundPreviewUrl({ sourceId: 'freesound', previewUrl: 'https://cdn.freesound.org/not-previews/one.mp3' })).toBeNull()
  })

  it('adds Freesound to the discovery service without replacing other connections', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => result })
    const service = createDiscoveryService({ connections: [{ id: 'other', investigate: vi.fn() }], freesound: { token: 'secret', fetchFn } })
    const events = []
    service.start({ brief, providerId: 'freesound' }, event => events.push(event))
    await vi.waitFor(() => expect(events.some(event => event.type === 'final')).toBe(true))
    expect(events.find(event => event.type === 'final').candidates).toHaveLength(1)
  })
})
