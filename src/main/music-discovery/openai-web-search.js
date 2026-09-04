import { validateCandidate } from '../../shared/music-discovery/contracts.js'
import { responsesUrl } from './openai-compatible.js'
const MAX_RESULTS = 12
const REQUEST_TIMEOUT_MS = 15000

const text = (value, max = 500) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''

function citations(body) {
  return (Array.isArray(body?.output) ? body.output : []).flatMap(item => item?.type === 'message'
    ? (Array.isArray(item.content) ? item.content : []).flatMap(content => Array.isArray(content?.annotations) ? content.annotations : []) : [])
    .filter(item => item?.type === 'url_citation')
}

/** Bounded provider search. Candidate fields come only from returned citations. */
export function createOpenAIWebSearchAdapter(connection = {}, { fetchFn = connection.fetchFn || fetch } = {}) {
  if (typeof connection.auth !== 'string' || !connection.auth || typeof connection.model !== 'string' || !connection.model) return null
  const endpoint = responsesUrl(connection.baseUrl)
  if (!endpoint || typeof fetchFn !== 'function') throw new Error('Invalid provider configuration')
  return {
    async investigate({ brief, signal }) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('OpenAI web search timed out')), REQUEST_TIMEOUT_MS)
      const abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) abort()
      signal?.addEventListener('abort', abort, { once: true })
      let response
      try {
        response = await fetchFn(endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { authorization: `Bearer ${connection.auth}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: connection.model, store: false, max_output_tokens: 200, max_tool_calls: 1, parallel_tool_calls: false,
            tool_choice: { type: 'web_search' }, tools: [{ type: 'web_search', search_context_size: 'low' }],
            instructions: 'Search once for existing music assets matching the brief. Cite source pages. Do not recommend, rank, or create assets in prose.',
            input: JSON.stringify(brief),
          }),
        })
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
      }
      if (!response.ok) throw new Error(`OpenAI web search failed (${response.status})`)
      const used = new Set()
      const candidates = citations(await response.json()).flatMap(citation => {
        const url = text(citation?.url, 2048)
        const assetName = text(citation?.title, 160)
        let host = ''
        try { host = new URL(url).hostname } catch { return [] }
        if (!assetName || used.has(url)) return []
        used.add(url)
        const checked = validateCandidate({
          assetName, creator: host, sourceId: connection.id === 'provider' ? 'provider-web-search' : 'openai-web-search', sourceUrl: url,
          evidence: [{ url, title: assetName, note: 'Provider web-search citation' }], reviewerScore: 0, fitNote: '',
        })
        return checked.ok ? [checked.value] : []
      })
      return { candidates: candidates.slice(0, MAX_RESULTS) }
    },
  }
}
