import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createWebDiscoveryHandler } from '../src/web-discovery/index.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const teamDomain = 'https://family.cloudflareaccess.com'
const audience = 'synth-audience'
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = (claims = {}) => {
  const head = b64({ alg: 'RS256', kid: 'key-1' })
  const payload = b64({ iss: teamDomain, aud: [audience], exp: 2_000_000_000, email: 'user@example.com', ...claims })
  return `${head}.${payload}.${sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), privateKey).toString('base64url')}`
}
const certsResponse = { ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig' }] }) }
const assistantRequest = (payload, access = token()) => ({ method: 'POST', url: '/api/assistant', headers: { 'cf-access-jwt-assertion': access }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)) } })
const leadsGet = (access = token()) => ({ method: 'GET', url: '/api/music-discovery/leads', headers: { 'cf-access-jwt-assertion': access }, async *[Symbol.asyncIterator]() {} })
const response = () => ({ writeHead: vi.fn(), end: vi.fn() })
const validDigest = { bpm: 120, timeSignature: [4, 4], tracks: [], mixer: [], racks: [], patterns: [] }
const validPlan = { summary: 'Set the tempo.', actions: [{ action: 'SetBpm', args: { bpm: 128 } }] }

function handler(fetchFn, extra = {}) {
  return createWebDiscoveryHandler({ teamDomain, audience, freesoundToken: 'fs-secret', openaiKey: 'oa-secret', fetchFn, ...extra })
}

function planFetch(plan) {
  return vi.fn(async url => {
    if (String(url) === `${teamDomain}/cdn-cgi/access/certs`) return certsResponse
    if (String(url) === 'https://api.openai.com/v1/responses') return { ok: true, json: async () => ({ output_text: JSON.stringify(plan) }) }
    throw new Error(`unexpected host ${url}`)
  })
}

describe('POST /api/assistant', () => {
  it('refuses an unauthenticated request before any provider call', async () => {
    const fetchFn = vi.fn(async () => certsResponse)
    const res = response()
    await handler(fetchFn)(assistantRequest({ prompt: 'do something', digest: validDigest }, `${token()}.tampered`), res)
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object))
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a body over the route cap', async () => {
    const fetchFn = vi.fn(async url => (String(url) === `${teamDomain}/cdn-cgi/access/certs` ? certsResponse : { ok: true, json: async () => ({}) }))
    const res = response()
    const oversized = { prompt: 'hi', digest: { padding: 'x'.repeat(130 * 1024) } }
    await handler(fetchFn)(assistantRequest(oversized), res)
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    expect(fetchFn).toHaveBeenCalledTimes(1) // only the Access certs lookup
  })

  it('refuses a prompt over 2000 characters', async () => {
    const fetchFn = vi.fn(async () => certsResponse)
    const res = response()
    await handler(fetchFn)(assistantRequest({ prompt: 'x'.repeat(2001), digest: validDigest }), res)
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('refuses a model response that is not shape-valid, never returning a plan', async () => {
    const fetchFn = planFetch({ summary: 'ok', actions: [{ action: 'DeleteEverything', args: {} }] })
    const res = response()
    await handler(fetchFn)(assistantRequest({ prompt: 'do something', digest: validDigest }), res)
    expect(res.writeHead).toHaveBeenCalledWith(502, expect.any(Object))
    expect(JSON.parse(res.end.mock.calls[0][0])).not.toHaveProperty('plan')
  })

  it('returns the plan for a shape-valid response', async () => {
    const fetchFn = planFetch(validPlan)
    const res = response()
    await handler(fetchFn)(assistantRequest({ prompt: 'set bpm to 128', digest: validDigest }), res)
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    expect(JSON.parse(res.end.mock.calls[0][0]).plan).toMatchObject(validPlan)
  })

  it('429s past the assistant limit while /leads for the same identity still works', async () => {
    const fetchFn = planFetch(validPlan)
    const run = handler(fetchFn, { assistantLimit: 1 })
    await run(assistantRequest({ prompt: 'set bpm to 128', digest: validDigest }), response())
    const limited = response()
    await run(assistantRequest({ prompt: 'set bpm to 130', digest: validDigest }), limited)
    expect(limited.writeHead).toHaveBeenCalledWith(429, expect.any(Object))
    const leads = response()
    await run(leadsGet(), leads)
    expect(leads.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  })

  it('rate limits /leads too', async () => {
    const fetchFn = vi.fn(async () => certsResponse)
    const run = handler(fetchFn, { limit: 1 })
    await run(leadsGet(), response())
    const res = response()
    await run(leadsGet(), res)
    expect(res.writeHead).toHaveBeenCalledWith(429, expect.any(Object))
  })
})
