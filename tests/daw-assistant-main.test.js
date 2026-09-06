// Electron parity (phase 3): same shared plan contract, IPC transport. No
// mocking of Electron itself — createAssistantService takes connections and
// fetchFn directly, same idiom as music-discovery-main.test.js.
import { describe, expect, it, vi } from 'vitest'
import { createAssistantService } from '../src/main/daw-assistant.js'

const digest = { bpm: 120, timeSignature: [4, 4], tracks: [], mixer: [], racks: [], patterns: [] }
const validPlan = { summary: 'Set the tempo.', actions: [{ action: 'SetBpm', args: { bpm: 128 } }] }
const connection = { id: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-5.6-luna', auth: 'sk-secret' }

const respond = payload => vi.fn(async () => ({ ok: true, json: async () => ({ output_text: JSON.stringify(payload) }) }))

describe('main-process assistant service', () => {
  it('reports available only once a provider connection exists', () => {
    expect(createAssistantService({ connections: [] }).available()).toBe(false)
    expect(createAssistantService({ connections: [connection] }).available()).toBe(true)
  })

  it('proposes a validated plan, and the connection key never appears in what crosses back', async () => {
    const fetchFn = respond(validPlan)
    const service = createAssistantService({ connections: [connection], fetchFn })
    const result = await service.propose({ prompt: 'set bpm to 128', digest })
    expect(result).toEqual({ plan: validPlan })
    expect(JSON.stringify(result)).not.toContain('sk-secret')
  })

  it('refuses an invalid model plan before returning it', async () => {
    const fetchFn = respond({ summary: 'ok', actions: [{ action: 'DeleteEverything', args: {} }] })
    const service = createAssistantService({ connections: [connection], fetchFn })
    await expect(service.propose({ prompt: 'do something', digest })).rejects.toThrow(/invalid plan/)
  })

  it('clamps an oversized digest before it reaches the provider', async () => {
    const fetchFn = respond(validPlan)
    const service = createAssistantService({ connections: [connection], fetchFn })
    const hostile = { ...digest, tracks: Array.from({ length: 500 }, (_, i) => ({ id: `t${i}` })) }
    await service.propose({ prompt: 'do something', digest: hostile })
    const sentDigest = JSON.parse(JSON.parse(fetchFn.mock.calls[0][1].body).input).digest
    expect(sentDigest.tracks.length).toBeLessThanOrEqual(32)
  })

  it('ask mode returns { answer, cited } and never a plan', async () => {
    const fetchFn = respond({ answer: 'The tempo is 120 BPM.', cited: ['bpm'] })
    const service = createAssistantService({ connections: [connection], fetchFn })
    const result = await service.ask({ prompt: 'what is the tempo?', digest })
    expect(result).toEqual({ answer: 'The tempo is 120 BPM.', cited: ['bpm'] })
    expect(result).not.toHaveProperty('plan')
    expect(result).not.toHaveProperty('actions')
  })

  it('refuses an ask response smuggling an actions field', async () => {
    const fetchFn = respond({ answer: 'ok', cited: [], actions: [{ action: 'SetBpm', args: { bpm: 128 } }] })
    const service = createAssistantService({ connections: [connection], fetchFn })
    await expect(service.ask({ prompt: 'do something', digest })).rejects.toThrow(/invalid answer/)
  })

  it('refuses propose and ask when no provider connection is configured, with no request made', async () => {
    const fetchFn = vi.fn()
    const service = createAssistantService({ connections: [], fetchFn })
    await expect(service.propose({ prompt: 'x', digest })).rejects.toThrow(/provider/i)
    await expect(service.ask({ prompt: 'x', digest })).rejects.toThrow(/provider/i)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('picks the connection named by providerId over the default', async () => {
    const fetchFn = respond(validPlan)
    const other = { id: 'provider', baseUrl: 'https://models.example', model: 'm2', auth: 'other-secret' }
    const service = createAssistantService({ connections: [connection, other], fetchFn })
    await service.propose({ prompt: 'x', digest, providerId: 'provider' })
    expect(fetchFn.mock.calls[0][0]).toBe('https://models.example/v1/responses')
  })
})
