const MAX_OUTPUT_TOKENS = 1200

export function createOpenAICompatibleAdapter(connection) {
  const endpoint = new URL('chat/completions', `${connection.baseUrl}/`)
  if (endpoint.origin !== new URL(connection.baseUrl).origin) throw new Error('Invalid provider URL')

  return {
    async complete({ messages, signal }) {
      const response = await fetch(endpoint, {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${connection.auth}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: connection.model, messages, temperature: 0.2, max_tokens: MAX_OUTPUT_TOKENS, response_format: { type: 'json_object' } }),
      })
      if (!response.ok) throw new Error(`Discovery provider failed (${response.status})`)
      const body = await response.json()
      const text = body?.choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new Error('Discovery provider returned no result')
      return JSON.parse(text)
    },
  }
}
