import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { normalizeBrief, rankCandidates, validateCandidate } from '../shared/music-discovery/contracts.js'

const MAX_BODY_BYTES = 16 * 1024
const REQUEST_TIMEOUT_MS = 15000
const FREESOUND_ORIGIN = 'https://freesound.org'
const OPENAI_URL = 'https://api.openai.com/v1/responses'

const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
const text = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''

function teamUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid Cloudflare team domain')
  return url.origin
}

function jwtParts(token) {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('Missing Access token')
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid Access token')
  return parts
}

async function accessIdentity(token, { teamDomain, audience, fetchFn, now }) {
  const [encodedHeader, encodedPayload, encodedSignature] = jwtParts(token)
  let header, payload
  try { header = decode(encodedHeader); payload = decode(encodedPayload) } catch { throw new Error('Invalid Access token') }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid Access token')
  if (payload?.iss !== teamDomain || !(typeof payload?.exp === 'number') || payload.exp * 1000 <= now()) throw new Error('Invalid Access token')
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(audience)) throw new Error('Invalid Access token')
  const response = await fetchFn(`${teamDomain}/cdn-cgi/access/certs`)
  if (!response.ok) throw new Error('Access keys unavailable')
  const jwks = await response.json()
  const jwk = Array.isArray(jwks?.keys) && jwks.keys.find(key => key?.kid === header.kid && key?.kty === 'RSA' && key?.use !== 'enc')
  if (!jwk) throw new Error('Invalid Access token')
  let verified = false
  try { verified = verifySignature('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(encodedSignature, 'base64url')) } catch { /* invalid key/signature */ }
  if (!verified) throw new Error('Invalid Access token')
  const identity = text(payload.email || payload.sub, 300)
  if (!identity) throw new Error('Invalid Access token')
  return identity
}

async function body(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Invalid JSON') }
}

function freesoundCandidate(row) {
  const sourceUrl = typeof row?.url === 'string' ? row.url : ''
  let trusted = false
  try { trusted = new URL(sourceUrl).origin === FREESOUND_ORIGIN } catch { /* rejected below */ }
  if (!trusted) return null
  const checked = validateCandidate({
    assetName: text(row?.name, 160), creator: text(row?.username, 120), sourceId: 'freesound', sourceUrl,
    evidence: [{ url: sourceUrl, title: text(row?.name, 160), note: text(row?.license, 160) }], reviewerScore: 0, fitNote: '',
  })
  return checked.ok ? checked.value : null
}

async function investigate(brief, { freesoundToken, fetchFn, signal }) {
  const url = new URL('/apiv2/search/text/', FREESOUND_ORIGIN)
  url.search = new URLSearchParams({ query: brief.text, page_size: '30', fields: 'id,name,username,url,license' }).toString()
  const response = await fetchFn(url, { headers: { Authorization: `Token ${freesoundToken}` }, signal })
  if (!response.ok) throw new Error('Freesound search unavailable')
  const data = await response.json()
  return (Array.isArray(data?.results) ? data.results : []).slice(0, 30).map(freesoundCandidate).filter(Boolean).slice(0, 12)
}

async function review(brief, candidates, { openaiKey, model, fetchFn, signal }) {
  if (!candidates.length) return []
  const response = await fetchFn(OPENAI_URL, {
    method: 'POST', signal, headers: { authorization: `Bearer ${openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, store: false, max_output_tokens: 1000,
      instructions: 'Rank only supplied Freesound records. Return JSON object {"ranked":[{"candidateIndex":number,"reviewerScore":number,"fitNote":string}]}. Never invent assets, creators, URLs, or facts.',
      input: JSON.stringify({ brief, candidates: candidates.map(({ assetName, creator, sourceUrl, evidence }) => ({ assetName, creator, sourceUrl, evidence })) }),
      text: { format: { type: 'json_object' } },
    }),
  })
  if (!response.ok) throw new Error('OpenAI review unavailable')
  const data = await response.json()
  const output = typeof data?.output_text === 'string' ? data.output_text : data?.output?.flatMap(item => item?.content || []).find(item => item?.type === 'output_text')?.text
  let ranked
  try { ranked = JSON.parse(output)?.ranked } catch { return [] }
  if (!Array.isArray(ranked)) return []
  const used = new Set()
  return ranked.flatMap(row => {
    const index = row?.candidateIndex
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length || used.has(index) || !Number.isFinite(row?.reviewerScore) || row.reviewerScore < 0 || row.reviewerScore > 100 || typeof row?.fitNote !== 'string') return []
    used.add(index)
    return [{ ...candidates[index], reviewerScore: row.reviewerScore, fitNote: text(row.fitNote, 500) }]
  })
}

const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }

/** Node http handler. Credentials remain server configuration, never request data. */
export function createWebDiscoveryHandler(options = {}) {
  const teamDomain = teamUrl(options.teamDomain)
  const audience = text(options.audience, 500)
  const freesoundToken = text(options.freesoundToken, 512)
  const openaiKey = text(options.openaiKey, 512)
  const model = text(options.model || 'gpt-5.6-luna', 160)
  const fetchFn = options.fetchFn || fetch
  const now = options.now || Date.now
  const limit = Number.isInteger(options.limit) ? options.limit : 12
  const windowMs = Number.isInteger(options.windowMs) ? options.windowMs : 60_000
  if (!audience || !freesoundToken || !openaiKey || !model || typeof fetchFn !== 'function' || limit < 1 || windowMs < 1) throw new Error('Invalid web discovery configuration')
  const requests = new Map()
  return async (req, res) => {
    if (req.method !== 'POST' || new URL(req.url || '/', 'http://origin').pathname !== '/api/music-discovery') return send(res, 404, { error: 'Not found' })
    try {
      const identity = await accessIdentity(req.headers?.['cf-access-jwt-assertion'], { teamDomain, audience, fetchFn, now })
      const previous = requests.get(identity) || []
      const recent = previous.filter(time => time > now() - windowMs)
      if (recent.length >= limit) return send(res, 429, { error: 'Too many requests' })
      requests.set(identity, [...recent, now()])
      const normalized = normalizeBrief(await body(req))
      if (!normalized.ok) return send(res, 400, { error: normalized.errors.join('; ') })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('Discovery request timed out')), REQUEST_TIMEOUT_MS)
      let sourced, reviewed
      try {
        sourced = await investigate(normalized.value, { freesoundToken, fetchFn, signal: controller.signal })
        reviewed = await review(normalized.value, sourced, { openaiKey, model, fetchFn, signal: controller.signal })
      } finally { clearTimeout(timeout) }
      return send(res, 200, { candidates: rankCandidates(reviewed.length ? reviewed : sourced, normalized.value) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Discovery unavailable'
      const status = /Access token|Access keys/.test(message) ? 403 : /JSON|too large/.test(message) ? 400 : 502
      return send(res, status, { error: message })
    }
  }
}
