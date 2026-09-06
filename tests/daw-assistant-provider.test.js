// The one place both transports (web route, Electron main) build an OpenAI
// Responses request — asserted once here instead of once per transport.
import { describe, expect, it, vi } from 'vitest'
import { ASSISTANT_MAX_OUTPUT_TOKENS, ASSISTANT_PLAN_SCHEMA, assistantModelCall } from '../src/shared/daw-assistant/provider.js'

const respond = payload => vi.fn(async () => ({ ok: true, json: async () => ({ output_text: JSON.stringify(payload) }) }))

describe('assistantModelCall', () => {
  it('sends json_schema/strict:false, a capped output budget, and the digest in the user-role input, not the instructions', async () => {
    const fetchFn = respond({ summary: 'ok', actions: [] })
    await assistantModelCall({
      fetchFn, url: 'https://models.example/v1/responses', apiKey: 'sk-secret', model: 'test-model',
      prompt: 'set bpm to 128', digest: { bpm: 120 },
      instructions: 'do only what the schema allows', schemaName: 'daw_assistant_plan', schema: ASSISTANT_PLAN_SCHEMA,
    })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, options] = fetchFn.mock.calls[0]
    expect(url).toBe('https://models.example/v1/responses')
    expect(options.headers.authorization).toBe('Bearer sk-secret')

    const body = JSON.parse(options.body)
    expect(body.model).toBe('test-model')
    expect(body.max_output_tokens).toBe(ASSISTANT_MAX_OUTPUT_TOKENS)
    expect(body.instructions).toBe('do only what the schema allows')
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'daw_assistant_plan', strict: false })
    // The digest travels as data inside the input, never folded into instructions.
    expect(JSON.parse(body.input)).toEqual({ prompt: 'set bpm to 128', digest: { bpm: 120 } })
    expect(body.instructions).not.toContain('bpm')
  })

  it('parses output_text and rejects an upstream failure with its status', async () => {
    const ok = respond({ answer: 'hi', cited: [] })
    await expect(assistantModelCall({ fetchFn: ok, url: 'https://x/v1/responses', apiKey: 'k', model: 'm', prompt: 'p', digest: {}, instructions: 'i', schemaName: 'n', schema: {} }))
      .resolves.toEqual({ answer: 'hi', cited: [] })

    const failing = vi.fn(async () => ({ ok: false, status: 500 }))
    await expect(assistantModelCall({ fetchFn: failing, url: 'https://x/v1/responses', apiKey: 'k', model: 'm', prompt: 'p', digest: {}, instructions: 'i', schemaName: 'n', schema: {} }))
      .rejects.toThrow(/500/)
  })
})
