// Ask mode: the model answers a question about the digest, it never edits.
// No DOM, no context, no globals — same discipline as digest.js/plan.js.

import { text } from './digest.js'

export const MODES = Object.freeze(['plan', 'ask'])

export const MAX_ANSWER = 1200
export const MAX_CITED = 12
export const MAX_CITED_LEN = 120

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

// Dot-separated segments, each a bare word or a digit run (array index).
// Deliberately conservative: no brackets, no wildcards, no leading/trailing dot.
const CITED_PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/

/** Structure only — mirrors validatePlanShape's idiom. */
export function validateAnswerShape(answer) {
  if (!plainObject(answer)) return { ok: false, errors: ['Answer must be an object'] }
  const errors = []
  // Ask mode must never smuggle an edit plan back in through a model that
  // ignores its instructions — a schema-valid actions field is refused whole.
  if ('actions' in answer) errors.push('Answer must not include actions')

  let value = null
  if (typeof answer.answer !== 'string') errors.push('answer must be a string')
  else if (answer.answer.length > MAX_ANSWER) errors.push(`answer must be <= ${MAX_ANSWER} characters`)
  else value = text(answer.answer, MAX_ANSWER)

  const cited = []
  if (answer.cited !== undefined) {
    if (!Array.isArray(answer.cited)) errors.push('cited must be an array')
    else if (answer.cited.length > MAX_CITED) errors.push(`cited must be <= ${MAX_CITED} entries`)
    else {
      answer.cited.forEach((raw, index) => {
        if (typeof raw !== 'string' || raw.length > MAX_CITED_LEN || !CITED_PATH.test(raw)) {
          errors.push(`cited[${index}]: invalid path`)
          return
        }
        cited.push(raw)
      })
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: { answer: value, cited } }
}

/** Walk a digest path, own-properties only.  Only a scalar leaf resolves. */
export function resolveCitation(digest, path) {
  if (typeof path !== 'string' || !CITED_PATH.test(path) || path.length > MAX_CITED_LEN) return null
  const segments = path.split('.')
  let current = digest
  for (const segment of segments) {
    if (UNSAFE.has(segment)) return null
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return null
      const index = Number(segment)
      if (index >= current.length) return null
      current = current[index]
      continue
    }
    if (!plainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return null
    current = current[segment]
  }
  const isScalar = current === null || ['string', 'number', 'boolean'].includes(typeof current)
  return isScalar ? { path, value: current } : null
}

/** Resolve every cited path against the digest, dropping unresolvable ones. */
export function resolveCitations(digest, cited) {
  return (Array.isArray(cited) ? cited : [])
    .map(path => resolveCitation(digest, path))
    .filter(Boolean)
}
