import { describe, expect, it, vi } from 'vitest'
import { createDiscoveryService } from '../src/main/music-discovery/index.js'
import { listLeads, saveLead } from '../src/main/music-discovery/leads.js'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const brief = { text: 'soulful hard house vocal', target: 'sample-loop', sources: ['web'] }
const candidate = {
  assetName: 'Soul Phrase', creator: 'DJ Example', sourceId: 'manual',
  sourceUrl: 'https://sounds.example/phrase', evidence: [{ url: 'https://sounds.example/phrase', title: 'Soul Phrase' }],
  reviewerScore: 80, fitNote: 'Works at 136 BPM.',
}

describe('music discovery main boundary', () => {
  it('streams only validated remote candidates and finishes a bounded run', async () => {
    const events = []
    const service = createDiscoveryService({ connections: [{ id: 'test', investigate: vi.fn().mockResolvedValue({ candidates: [candidate, { ...candidate, sourceUrl: 'file:///bad' }] }) }] })
    const id = service.start({ brief, providerId: 'test' }, event => events.push(event))
    await vi.waitFor(() => expect(events.some(event => event.type === 'final')).toBe(true))
    expect(id).toEqual(expect.any(String))
    expect(events.filter(event => event.type === 'candidate')).toHaveLength(1)
    expect(events.find(event => event.type === 'candidate').candidate.kind).toBe('remote')
  })

  it('aborts the active provider request', async () => {
    const events = []
    const service = createDiscoveryService({ connections: [{ id: 'test', investigate: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }] })
    const id = service.start({ brief, providerId: 'test' }, event => events.push(event))
    expect(service.cancel(id)).toBe(true)
    await vi.waitFor(() => expect(events.some(event => event.type === 'error' && event.message === 'Discovery cancelled')).toBe(true))
  })

  it('persists only validated leads', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'synth-discovery-'))
    await expect(saveLead(userData, { brief, candidate })).resolves.toMatchObject({ candidate: { kind: 'remote' }, disposition: 'saved' })
    await expect(saveLead(userData, { brief, candidate: { ...candidate, sourceUrl: 'javascript:alert(1)' } })).rejects.toThrow('https')
    await expect(listLeads(userData)).resolves.toHaveLength(1)
  })
})
