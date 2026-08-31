import { normalizeBrief, validateCandidate, dedupeCandidates, rankCandidates } from '../../shared/music-discovery/contracts.js'
import { createFreesoundAdapter } from './freesound.js'
import { createOpenAICompatibleAdapter } from './openai-compatible.js'
const MAX_CANDIDATES = 5

export async function runDiscovery({ brief: rawBrief, source, reviewer, signal, onEvent = () => {} }) {
  const brief = normalizeBrief(rawBrief)
  if (!brief.ok) throw new Error(brief.errors.join('; '))
  if (!source) throw new Error('Discovery source is unavailable')

  onEvent({ type: 'status', message: 'Searching Freesound…', sourceCount: 0 })
  // A model may rank evidence, never invent it.  Source adapters/manual mode
  // supply these records; generic completion is only a provider primitive today.
  if (typeof source.investigate !== 'function') throw new Error('No discovery source adapter is configured')
  const output = await source.investigate({ brief: brief.value, signal })
  const candidates = (Array.isArray(output?.candidates) ? output.candidates : [])
    .slice(0, brief.value.maxResults)
    .map(validateCandidate)
    .filter(result => result.ok)
    .map(result => result.value)
  onEvent({ type: 'status', message: 'Reviewing matches…', sourceCount: candidates.length })
  let reviewed = candidates
  if (reviewer?.review && candidates.length) {
    try {
      const sourceByUrl = new Map(candidates.map(candidate => [candidate.sourceUrl, candidate]))
      const scores = await reviewer.review({ brief: brief.value, candidates, signal })
      const vetted = Array.isArray(scores) ? scores.flatMap(score => {
        const sourceCandidate = sourceByUrl.get(score?.sourceUrl)
        if (!sourceCandidate || !Number.isFinite(score?.reviewerScore) || score.reviewerScore < 0 || score.reviewerScore > 100 || typeof score.fitNote !== 'string') return []
        return [{ ...sourceCandidate, reviewerScore: score.reviewerScore, fitNote: score.fitNote.slice(0, 500) }]
      }) : []
      reviewed = [...vetted, ...candidates]
    }
    catch (error) {
      if (signal?.aborted) throw error
      onEvent({ type: 'status', message: 'OpenAI review unavailable; showing Freesound matches.', sourceCount: candidates.length })
    }
  }
  const ranked = rankCandidates(dedupeCandidates(reviewed), brief.value).slice(0, MAX_CANDIDATES)
  for (const candidate of ranked) onEvent({ type: 'candidate', candidate })
  const final = { type: 'final', candidates: ranked }
  onEvent(final)
  return final
}

export function createDiscoveryService({ connections = [], freesound } = {}) {
  const source = createFreesoundAdapter(freesound) || connections.find(connection => typeof connection?.investigate === 'function')
  const reviewer = createOpenAICompatibleAdapter(connections.find(connection => connection?.id === 'openai'))
  const runs = new Map()
  return {
    available: () => !!source,
    start({ brief, providerId }, onEvent) {
      if (!source) throw new Error('Discovery source is unavailable')
      const id = crypto.randomUUID()
      const controller = new AbortController()
      runs.set(id, controller)
      const emit = payload => onEvent({ runId: id, ...payload })
      runDiscovery({ brief, source, reviewer, signal: controller.signal, onEvent: emit })
        .catch(error => emit({ type: 'error', message: controller.signal.aborted ? 'Discovery cancelled' : error.message }))
        .finally(() => runs.delete(id))
      return id
    },
    cancel(runId) {
      const controller = runs.get(runId)
      if (!controller) return false
      controller.abort()
      return true
    },
  }
}
