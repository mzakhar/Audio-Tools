// Untrusted discovery input stops here.  Keep this module browser- and Node-safe.

export const MAX_BRIEF_TEXT = 500
export const MAX_RESULTS = 12
export const MAX_CANDIDATES = 30

const TARGETS = new Set(['sample-loop', 'drum-pack', 'playable-preset'])
const LOOP_TYPES = new Set(['either', 'one-shot', 'loop'])
const BUDGETS = new Set(['either', 'free', 'paid'])
const SOURCES = new Set(['local', 'web'])

const text = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : ''

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const canonicalUrl = value => {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

const finite = value => Number.isFinite(value) ? value : null

/** Validate user-controlled search controls; unknown fields never enter a run. */
export function normalizeBrief(input) {
  if (!plainObject(input)) return { ok: false, errors: ['Brief must be an object'] }
  const value = {
    text: text(input.text ?? input.query ?? '', MAX_BRIEF_TEXT),
    target: input.target ?? 'sample-loop',
    tempo: null,
    loop: input.loop ?? 'either',
    vocalsAllowed: input.vocalsAllowed ?? input.vocals ?? true,
    budget: input.budget ?? 'either',
    sources: [...new Set((Array.isArray(input.sources) ? input.sources : ['local', 'web']).filter(source => SOURCES.has(source)))],
    maxResults: Math.min(MAX_RESULTS, Math.max(1, Math.trunc(finite(input.maxResults ?? input.resultCount) ?? MAX_RESULTS))),
  }
  const errors = []
  if (!value.text) errors.push('Brief text is required')
  if (!TARGETS.has(value.target)) errors.push('Invalid target')
  if (!LOOP_TYPES.has(value.loop)) errors.push('Invalid loop type')
  if (typeof value.vocalsAllowed !== 'boolean') errors.push('vocalsAllowed must be boolean')
  if (!BUDGETS.has(value.budget)) errors.push('Invalid budget')
  if (!value.sources.length) errors.push('At least one source is required')

  const rawTempo = plainObject(input.tempo) ? input.tempo : input
  const min = finite(rawTempo.min ?? rawTempo.tempoMin)
  const max = finite(rawTempo.max ?? rawTempo.tempoMax)
  if (min !== null || max !== null) {
    if (min === null || max === null || min < 20 || max > 400 || min > max) errors.push('Invalid tempo range')
    else value.tempo = { min: Math.round(min), max: Math.round(max) }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value }
}

/**
 * Model output is remote-only. Local rows must be classified by the trusted
 * caller from the indexed preset record, never by a model-controlled field.
 */
export function validateCandidate(candidate, { kind = 'remote' } = {}) {
  if (!plainObject(candidate)) return { ok: false, errors: ['Candidate must be an object'] }
  if (kind === 'local-preset') {
    const assetName = text(candidate.assetName, 160)
    const creator = text(candidate.creator, 120)
    const bankPath = text(candidate.local?.bankPath, 1024)
    const presetIndex = candidate.local?.presetIndex
    const score = finite(candidate.reviewerScore)
    const errors = []
    if (!assetName) errors.push('assetName is required')
    if (!creator) errors.push('creator is required')
    if (!bankPath) errors.push('local bankPath is required')
    if (!Number.isInteger(presetIndex) || presetIndex < 0) errors.push('local presetIndex is required')
    if (score !== null && (score < 0 || score > 100)) errors.push('reviewerScore must be 0-100')
    return errors.length ? { ok: false, errors } : { ok: true, value: {
      kind, assetName, creator, sourceId: 'local', local: { bankPath, presetIndex },
      reviewerScore: score ?? 0, fitNote: text(candidate.fitNote, 500),
    } }
  }
  if (kind !== 'remote') return { ok: false, errors: ['Invalid candidate kind'] }
  const assetName = text(candidate.assetName, 160)
  const creator = text(candidate.creator, 120)
  const sourceId = text(candidate.sourceId, 80)
  const sourceUrl = canonicalUrl(candidate.sourceUrl)
  const errors = []
  if (!assetName) errors.push('assetName is required')
  if (!creator) errors.push('creator is required')
  if (!sourceId) errors.push('sourceId is required')
  if (!sourceUrl) errors.push('sourceUrl must be an https URL')
  if (!Array.isArray(candidate.evidence) || !candidate.evidence.length || candidate.evidence.length > 8) errors.push('Evidence is required')
  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.map(item => {
    if (!plainObject(item)) return null
    const url = canonicalUrl(item.url)
    return url ? { url, title: text(item.title, 160), note: text(item.note, 500) } : null
  }).filter(Boolean) : []
  if (Array.isArray(candidate.evidence) && evidence.length !== candidate.evidence.length) errors.push('Evidence URLs must be https URLs')
  if (sourceUrl && evidence.length && !evidence.some(item => new URL(item.url).host === new URL(sourceUrl).host)) {
    errors.push('sourceUrl host must appear in evidence')
  }
  const score = finite(candidate.reviewerScore)
  if (score !== null && (score < 0 || score > 100)) errors.push('reviewerScore must be 0-100')
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: {
    kind: 'remote', assetName, creator, sourceId, sourceUrl, evidence,
    reviewerScore: score ?? 0, fitNote: text(candidate.fitNote, 500),
  } }
}

/** First valid row wins, preserving investigation order. */
export function dedupeCandidates(candidates) {
  if (!Array.isArray(candidates)) return []
  const seen = new Set()
  return candidates.slice(0, MAX_CANDIDATES).flatMap(candidate => {
    const checked = validateCandidate(candidate)
    if (!checked.ok) return []
    const value = checked.value
    const key = `${value.sourceUrl}\u0000${value.creator.toLocaleLowerCase()}\u0000${value.assetName.toLocaleLowerCase()}`
    if (seen.has(key)) return []
    seen.add(key)
    return [value]
  })
}

/** Reviewer score wins; stable lexical fields make ties repeatable. */
export function rankCandidates(candidates, brief) {
  const normalizedBrief = normalizeBrief(brief)
  if (!normalizedBrief.ok) return []
  return dedupeCandidates(candidates).sort((a, b) =>
    b.reviewerScore - a.reviewerScore ||
    a.assetName.localeCompare(b.assetName) ||
    a.creator.localeCompare(b.creator) ||
    a.sourceUrl.localeCompare(b.sourceUrl)
  ).slice(0, Math.min(5, normalizedBrief.value.maxResults))
}

/** Return the canonical URL only when it can be tied to candidate evidence. */
export function safeOpenUrl(candidate) {
  const checked = validateCandidate(candidate)
  if (!checked.ok) return null
  const { sourceUrl, evidence } = checked.value
  return evidence.some(item => new URL(item.url).host === new URL(sourceUrl).host) ? sourceUrl : null
}
