import { describe, expect, it, vi } from 'vitest'
import { createDiscoveryService, runDiscovery } from '../src/main/music-discovery/index.js'
import { linkLead, listLeads, saveLead } from '../src/main/music-discovery/leads.js'
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

  it('keeps only source candidates when the reviewer ranks them', async () => {
    const invented = { ...candidate, sourceUrl: 'https://freesound.org/sounds/999', evidence: [{ url: 'https://freesound.org/sounds/999', title: 'Invented' }] }
    const final = await runDiscovery({ brief, source: { investigate: async () => ({ candidates: [candidate] }) }, reviewer: {
      review: async () => [invented, { ...candidate, reviewerScore: 99, fitNote: 'Good fit.' }],
    } })
    expect(final.candidates).toMatchObject([{ sourceUrl: candidate.sourceUrl, reviewerScore: 99, fitNote: 'Good fit.' }])
  })

  it('reviews up to twelve source rows but returns only five', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ ...candidate,
      assetName: `Soul Phrase ${index}`, sourceUrl: `https://sounds.example/phrase-${index}`,
      evidence: [{ url: `https://sounds.example/phrase-${index}`, title: `Soul Phrase ${index}` }], reviewerScore: 0,
    }))
    const review = vi.fn(async ({ candidates }) => [{ ...candidates[11], reviewerScore: 100, fitNote: 'Best.' }])
    const final = await runDiscovery({ brief, source: { investigate: async () => ({ candidates: rows }) }, reviewer: { review } })
    expect(review).toHaveBeenCalledOnce()
    expect(review.mock.calls[0][0].candidates).toHaveLength(12)
    expect(final.candidates).toHaveLength(5)
    expect(final.candidates[0]).toMatchObject({ sourceUrl: rows[11].sourceUrl, reviewerScore: 100 })
  })

  it('persists only validated leads', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'synth-discovery-'))
    await expect(saveLead(userData, { brief, candidate })).resolves.toMatchObject({ candidate: { kind: 'remote' }, disposition: 'saved' })
    await expect(saveLead(userData, { brief, candidate: { ...candidate, sourceUrl: 'javascript:alert(1)' } })).rejects.toThrow('https')
    await expect(listLeads(userData)).resolves.toHaveLength(1)
  })

  it('links only an existing saved local lead to structural imported-pack data', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'synth-discovery-'))
    const remote = await saveLead(userData, { brief, candidate })
    const local = await saveLead(userData, { brief, candidate: {
      kind: 'local-preset', assetName: 'Warm Pad', creator: 'Bank', local: { bankPath: 'banks/house.sf2', presetIndex: 4 },
    } })
    await expect(linkLead(userData, remote.id, { packId: 'house', packVersion: '1.0.0', patchId: 'sf2-4' })).rejects.toThrow('Only local')
    await expect(linkLead(userData, local.id, { packId: '../escape', packVersion: '1.0.0', patchId: 'sf2-4' })).rejects.toThrow('Invalid pack id')
    await expect(linkLead(userData, local.id, { packId: 'house', packVersion: '1.0.0', patchId: 'sf2-4' })).resolves.toMatchObject({ handoff: { packId: 'house', packVersion: '1.0.0', patchId: 'sf2-4' } })
    await expect(listLeads(userData)).resolves.toEqual([expect.objectContaining({ id: remote.id }), expect.objectContaining({ id: local.id, handoff: { packId: 'house', packVersion: '1.0.0', patchId: 'sf2-4' } })])
  })
})
