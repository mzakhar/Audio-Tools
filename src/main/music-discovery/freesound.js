import { validateCandidate } from '../../shared/music-discovery/contracts.js'

const BASE_URL = 'https://freesound.org'
const MAX_QUERIES = 6
const MAX_ROWS = 30
const REQUEST_TIMEOUT_MS = 15000
const PREVIEW_HOST = 'cdn.freesound.org'

const clean = (value, max = 500) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : ''

function candidate(row) {
  const url = typeof row?.url === 'string' ? row.url : ''
  const previewUrl = freesoundPreviewUrl({ sourceId: 'freesound', previewUrl: row?.previews?.['preview-hq-mp3'] || row?.previews?.['preview-lq-mp3'] })
  const tags = Array.isArray(row?.tags) ? row.tags.map(tag => clean(tag, 40)).filter(Boolean).slice(0, 8) : []
  const licence = clean(row?.license, 160)
  return validateCandidate({
    assetName: clean(row?.name, 160),
    creator: clean(row?.username, 120),
    sourceId: 'freesound',
    sourceUrl: url,
    evidence: [{ url, title: clean(row?.name, 160), note: [licence, tags.length ? `Tags: ${tags.join(', ')}` : ''].filter(Boolean).join(' — ') }],
    ...(previewUrl ? { previewUrl } : {}),
    fitNote: '',
  })
}

/** Only Freesound's fixed CDN preview endpoint may reach the renderer. */
export function freesoundPreviewUrl(candidate) {
  if (candidate?.sourceId !== 'freesound' || typeof candidate.previewUrl !== 'string') return null
  try {
    const url = new URL(candidate.previewUrl)
    return url.protocol === 'https:' && url.hostname === PREVIEW_HOST && url.pathname.startsWith('/previews/') ? url.href : null
  } catch { return null }
}

/** Fixed-host, metadata-only Freesound source. It never follows result URLs. */
export function createFreesoundAdapter(options = {}) {
  const { token, fetchFn = fetch } = options || {}
  const auth = clean(token, 512)
  if (!auth || typeof fetchFn !== 'function') return null
  return {
    id: 'freesound',
    name: 'Freesound',
    async investigate({ brief, signal }) {
      // One direct brief query is sufficient today; hard caps prevent later expansion from becoming unbounded.
      const queries = [clean(brief?.text, 500)].filter(Boolean).slice(0, MAX_QUERIES)
      const candidates = []
      for (const query of queries) {
        const url = new URL('/apiv2/search/text/', BASE_URL)
        url.search = new URLSearchParams({
          query,
          page_size: String(MAX_ROWS),
          fields: 'id,name,username,url,license,tags,previews',
        }).toString()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(new Error('Freesound request timed out')), REQUEST_TIMEOUT_MS)
        const abort = () => controller.abort(signal?.reason)
        if (signal?.aborted) abort()
        signal?.addEventListener('abort', abort, { once: true })
        let response
        try {
          response = await fetchFn(url, { headers: { Authorization: `Token ${auth}` }, signal: controller.signal })
        } finally {
          clearTimeout(timeout)
          signal?.removeEventListener('abort', abort)
        }
        if (!response.ok) throw new Error(`Freesound search failed (${response.status})`)
        const body = await response.json()
        for (const row of (Array.isArray(body?.results) ? body.results : []).slice(0, MAX_ROWS - candidates.length)) {
          const checked = candidate(row)
          if (checked.ok) candidates.push(checked.value)
        }
      }
      return { candidates }
    },
  }
}
