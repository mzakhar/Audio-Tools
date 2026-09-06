// Electron parity for the assistant: same shared plan contract, same shared
// provider call, transport is IPC instead of the web proxy's HTTP route.
//
// Rate limiting is a shared-host concern (the web route protects one key
// shared by every family member on a public host); Electron here is one
// local user spending their own configured key, so there is nothing to limit.

import { validatePlanShape } from '../shared/daw-assistant/plan.js'
import { clampDigest, text } from '../shared/daw-assistant/digest.js'
import { validateAnswerShape } from '../shared/daw-assistant/ask.js'
import {
  ASSISTANT_ASK_INSTRUCTIONS, ASSISTANT_ASK_SCHEMA, ASSISTANT_INSTRUCTIONS, ASSISTANT_PLAN_SCHEMA,
  assistantModelCall,
} from '../shared/daw-assistant/provider.js'
import { responsesUrl } from './music-discovery/openai-compatible.js'

const ASSISTANT_MAX_PROMPT = 2000

function pickConnection(connections, providerId) {
  if (typeof providerId === 'string' && providerId) return connections.find(connection => connection?.id === providerId) || null
  return connections.find(connection => connection?.id === 'openai') || connections.find(connection => connection?.id === 'provider') || connections[0] || null
}

function checkedPrompt(rawPrompt) {
  if (typeof rawPrompt !== 'string' || rawPrompt.length < 1 || rawPrompt.length > ASSISTANT_MAX_PROMPT) throw new Error(`Prompt must be 1-${ASSISTANT_MAX_PROMPT} characters`)
  const prompt = text(rawPrompt, ASSISTANT_MAX_PROMPT)
  if (!prompt) throw new Error('Prompt is required')
  return prompt
}

function checkedDigest(rawDigest) {
  if (rawDigest === null || typeof rawDigest !== 'object' || Array.isArray(rawDigest)) throw new Error('Digest must be an object')
  // Never trust that the renderer sent buildDigest() output — clamp it to the
  // same caps and shape before it reaches a paid model, same as the web route.
  return clampDigest(rawDigest)
}

/** connections: the same safeStorage-backed list music-discovery/connections.js loads. */
export function createAssistantService({ connections = [], fetchFn = fetch } = {}) {
  // One model call, two modes — the only difference is which instructions and
  // schema go up and which validator gates what comes back.
  const run = async ({ prompt: rawPrompt, digest: rawDigest, providerId }, noun, instructions, schemaName, schema, validate) => {
    const connection = pickConnection(connections, providerId)
    if (!connection) throw new Error('No assistant provider is configured')
    const url = responsesUrl(connection.baseUrl)
    if (!url) throw new Error('Invalid provider configuration')
    const prompt = checkedPrompt(rawPrompt)
    const digest = checkedDigest(rawDigest)
    const parsed = await assistantModelCall({
      fetchFn, url, apiKey: connection.auth, model: connection.model, prompt, digest,
      instructions, schemaName, schema,
    })
    const validated = validate(parsed)
    // Only the validated value crosses back — never the connection or its key.
    if (!validated.ok) throw new Error(`Assistant produced an invalid ${noun}: ${validated.errors.join('; ')}`)
    return validated.value
  }

  return {
    available: () => connections.length > 0,
    async propose(request = {}) {
      return { plan: await run(request, 'plan', ASSISTANT_INSTRUCTIONS, 'daw_assistant_plan', ASSISTANT_PLAN_SCHEMA, validatePlanShape) }
    },
    async ask(request = {}) {
      return run(request, 'answer', ASSISTANT_ASK_INSTRUCTIONS, 'daw_assistant_answer', ASSISTANT_ASK_SCHEMA, validateAnswerShape)
    },
  }
}
