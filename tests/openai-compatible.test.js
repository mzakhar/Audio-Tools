import { describe, expect, it, vi } from 'vitest'
import { createOpenAICompatibleAdapter, responsesUrl } from '../src/main/music-discovery/openai-compatible.js'

const rows = [{ assetName: 'Vocal', creator: 'Maker', sourceUrl: 'https://freesound.org/s/1', evidence: [{ url: 'https://freesound.org/s/1', title: 'Vocal' }] }]

describe('OpenAI discovery reviewer', () => {
  it('sends only supplied evidence and maps structured indexes back to it', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ output_text: JSON.stringify({ ranked: [{ candidateIndex: 0, reviewerScore: 88, fitNote: 'Fits.' }, { candidateIndex: 4, reviewerScore: 99, fitNote: 'Invented.' }] }) }) })
    const reviewer = createOpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com', auth: 'key', model: 'gpt-test' }, { fetchFn })
    await expect(reviewer.review({ brief: { text: 'vocal' }, candidates: rows })).resolves.toEqual([{ ...rows[0], reviewerScore: 88, fitNote: 'Fits.' }])
    const [url, options] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(JSON.parse(options.body)).toMatchObject({ store: false, max_output_tokens: 1200, text: { format: { type: 'json_schema', strict: true } } })
    expect(JSON.parse(JSON.parse(options.body).input).candidates).toEqual(rows)
  })

  it('uses an explicit compatible provider endpoint without exporting its key', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ output_text: JSON.stringify({ ranked: [] }) }) })
    const reviewer = createOpenAICompatibleAdapter({ baseUrl: 'https://models.example/api/v1', auth: 'private-key', model: 'small' }, { fetchFn })
    await reviewer.review({ brief: { text: 'vocal' }, candidates: rows })
    expect(fetchFn.mock.calls[0][0]).toBe('https://models.example/api/v1/responses')
    expect(fetchFn.mock.calls[0][1].body).not.toContain('private-key')
    expect(responsesUrl('http://models.example')).toBeNull()
  })
})
