import { describe, expect, it, vi } from 'vitest'
import { createOpenAIWebSearchAdapter } from '../src/main/music-discovery/openai-web-search.js'

describe('OpenAI web-search source', () => {
  it('uses one bounded tool call and returns only citation-derived rows', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ output: [{ type: 'message', content: [{ annotations: [
      { type: 'url_citation', url: 'https://example.com/sample', title: 'Real sample' },
      { type: 'url_citation', url: 'javascript:bad', title: 'Bad' },
    ] }] }] }) })
    const source = createOpenAIWebSearchAdapter({ auth: 'key', model: 'gpt-test' }, { fetchFn })
    await expect(source.investigate({ brief: { text: 'house vocal' } })).resolves.toEqual({ candidates: [expect.objectContaining({ assetName: 'Real sample', creator: 'example.com', sourceUrl: 'https://example.com/sample', sourceId: 'openai-web-search' })] })
    const [, options] = fetchFn.mock.calls[0]
    expect(JSON.parse(options.body)).toMatchObject({ store: false, max_tool_calls: 1, parallel_tool_calls: false, tool_choice: { type: 'web_search' }, tools: [{ type: 'web_search', search_context_size: 'low' }] })
  })
})
