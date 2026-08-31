import { describe, expect, it, vi } from 'vitest'
import { createOpenAICompatibleAdapter } from '../src/main/music-discovery/openai-compatible.js'

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
})
