const MAX_OUTPUT_TOKENS = 1200
const MAX_CANDIDATES = 30
const REQUEST_TIMEOUT_MS = 15000

const schema = {
  type: 'object', additionalProperties: false, required: ['ranked'],
  properties: { ranked: { type: 'array', maxItems: MAX_CANDIDATES, items: {
    type: 'object', additionalProperties: false,
    required: ['candidateIndex', 'reviewerScore', 'fitNote'],
    properties: {
      candidateIndex: { type: 'integer', minimum: 0, maximum: MAX_CANDIDATES - 1 },
      reviewerScore: { type: 'number', minimum: 0, maximum: 100 },
      fitNote: { type: 'string', maxLength: 500 },
    },
  } } },
}

const outputText = body => typeof body?.output_text === 'string'
  ? body.output_text
  : body?.output?.flatMap(item => item?.content || []).find(item => item?.type === 'output_text')?.text

export function responsesUrl(baseUrl = 'https://api.openai.com') {
  let url
  try { url = new URL(baseUrl) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
  const path = url.pathname.replace(/\/$/, '')
  url.pathname = /\/v1\/responses$/.test(path) ? path : `${path.endsWith('/v1') ? path : `${path}/v1`}/responses`
  return url.href
}

/** OpenAI reviewer. It receives Freesound metadata and can only return indexes into it. */
export function createOpenAICompatibleAdapter(connection = {}, { fetchFn = connection.fetchFn || fetch } = {}) {
  if (typeof connection.auth !== 'string' || !connection.auth || typeof connection.model !== 'string' || !connection.model) return null
  const endpoint = responsesUrl(connection.baseUrl)
  if (!endpoint || typeof fetchFn !== 'function') throw new Error('Invalid provider configuration')
  return {
    async review({ brief, candidates, signal }) {
      const rows = Array.isArray(candidates) ? candidates.slice(0, MAX_CANDIDATES) : []
      if (!rows.length) return []
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('OpenAI review timed out')), REQUEST_TIMEOUT_MS)
      const abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) abort()
      signal?.addEventListener('abort', abort, { once: true })
      let response
      try {
        response = await fetchFn(endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { authorization: `Bearer ${connection.auth}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: connection.model, store: false, max_output_tokens: MAX_OUTPUT_TOKENS,
            instructions: 'Rank only the supplied Freesound records for the brief. Return only candidate indexes from those records. Do not invent assets, creators, URLs, or facts. Use empty ranked when none fit.',
            input: JSON.stringify({ brief, candidates: rows.map(({ assetName, creator, sourceUrl, evidence }) => ({ assetName, creator, sourceUrl, evidence })) }),
            text: { format: { type: 'json_schema', name: 'freesound_ranking', strict: true, schema } },
          }),
        })
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
      }
      if (!response.ok) throw new Error(`OpenAI review failed (${response.status})`)
      let result
      try { result = JSON.parse(outputText(await response.json())) } catch { throw new Error('OpenAI review returned invalid JSON') }
      if (!Array.isArray(result?.ranked)) throw new Error('OpenAI review returned no ranking')
      const used = new Set()
      return result.ranked.flatMap(row => {
        const index = row?.candidateIndex
        const score = row?.reviewerScore
        if (!Number.isInteger(index) || index < 0 || index >= rows.length || used.has(index) || !Number.isFinite(score) || score < 0 || score > 100 || typeof row?.fitNote !== 'string') return []
        used.add(index)
        return [{ ...rows[index], reviewerScore: score, fitNote: row.fitNote.slice(0, 500) }]
      })
    },
  }
}
