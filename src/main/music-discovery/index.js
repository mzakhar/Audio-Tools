import { normalizeBrief, validateCandidate, dedupeCandidates, rankCandidates } from '../../shared/music-discovery/contracts.js'
import { createFreesoundAdapter } from './freesound.js'
const MAX_CANDIDATES = 5

export async function runDiscovery({ brief: rawBrief, source, signal, onEvent = () => {} }) {
  const brief = normalizeBrief(rawBrief)
  if (!brief.ok) throw new Error(brief.errors.join('; '))
  if (!source) throw new Error('Discovery source is unavailable')

  onEvent({ type: 'status', message: 'Searching Freesound…', sourceCount: 0 })
  // A model may rank evidence, never invent it.  Source adapters/manual mode
  // supply these records; generic completion is only a provider primitive today.
  if (typeof source.investigate !== 'function') throw new Error('No discovery source adapter is configured')
  const output = await source.investigate({ brief: brief.value, signal })
  const candidates = (Array.isArray(output?.candidates) ? output.candidates : [])
    .slice(0, MAX_CANDIDATES)
    .map(validateCandidate)
    .filter(result => result.ok)
    .map(result => result.value)
  onEvent({ type: 'status', message: 'Reviewing matches…', sourceCount: candidates.length })
  const ranked = rankCandidates(dedupeCandidates(candidates), brief.value).slice(0, MAX_CANDIDATES)
  for (const candidate of ranked) onEvent({ type: 'candidate', candidate })
  const final = { type: 'final', candidates: ranked }
  onEvent(final)
  return final
}

export function createDiscoveryService({ connections = [], freesound } = {}) {
  const source = createFreesoundAdapter(freesound) || connections.find(connection => typeof connection?.investigate === 'function')
  const runs = new Map()
  return {
    available: () => !!source,
    start({ brief, providerId }, onEvent) {
      if (!source) throw new Error('Discovery source is unavailable')
      const id = crypto.randomUUID()
      const controller = new AbortController()
      runs.set(id, controller)
      const emit = payload => onEvent({ runId: id, ...payload })
      runDiscovery({ brief, source, signal: controller.signal, onEvent: emit })
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
