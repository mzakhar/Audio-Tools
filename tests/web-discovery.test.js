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
const request = (payload, access = token()) => ({ method: 'POST', url: '/api/music-discovery', headers: { 'cf-access-jwt-assertion': access }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)) } })
const response = () => ({ writeHead: vi.fn(), end: vi.fn() })
const validBrief = { text: 'soul vocal', target: 'sample-loop', sources: ['web'] }
const freesound = { results: [{ name: 'Soul Vocal', username: 'Ada', url: 'https://freesound.org/people/ada/sounds/1/', license: 'CC0' }] }

function handler(fetchFn, extra = {}) {
  return createWebDiscoveryHandler({ teamDomain, audience, freesoundToken: 'fs-secret', openaiKey: 'oa-secret', fetchFn, ...extra })
}

describe('web music discovery proxy', () => {
  it('verifies Access, uses fixed upstream hosts, and returns bounded grounded rows', async () => {
    const fetchFn = vi.fn(async (url, options) => {
      if (String(url) === `${teamDomain}/cdn-cgi/access/certs`) return { ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig' }] }) }
      if (String(url).startsWith('https://freesound.org/apiv2/search/text/')) return { ok: true, json: async () => freesound }
      if (String(url) === 'https://api.openai.com/v1/responses') {
        const body = JSON.parse(options?.body || '{}')
        return { ok: true, json: async () => body.tools
          ? ({ output: [{ type: 'message', content: [{ annotations: [{ type: 'url_citation', url: 'https://example.com/real-sample', title: 'Real sample' }] }] }] })
          : ({ output_text: JSON.stringify({ ranked: [{ candidateIndex: 0, reviewerScore: 90, fitNote: 'Fits.' }] }) }) }
      }
      throw new Error(`unexpected host ${url}`)
    })
    const res = response()
    await handler(fetchFn)(request(validBrief), res)
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    expect(JSON.parse(res.end.mock.calls[0][0]).candidates).toMatchObject([{ sourceUrl: freesound.results[0].url, reviewerScore: 90 }])
    expect(fetchFn.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([teamDomain, 'https://freesound.org', 'https://api.openai.com', 'https://api.openai.com'])
  })

  it('rejects bad JWT signatures and never calls content providers', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig' }] }) }))
    const res = response()
    await handler(fetchFn)(request(validBrief, `${token()}.tampered`), res)
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object))
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('limits each verified identity', async () => {
    const fetchFn = vi.fn(async url => String(url) === `${teamDomain}/cdn-cgi/access/certs`
      ? { ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig' }] }) }
      : String(url).startsWith('https://freesound.org') ? { ok: true, json: async () => ({ results: [] }) } : { ok: true, json: async () => ({ output_text: '{"ranked":[]}' }) })
    const run = handler(fetchFn, { limit: 1 })
    await run(request(validBrief), response())
    const res = response()
    await run(request(validBrief), res)
    expect(res.writeHead).toHaveBeenCalledWith(429, expect.any(Object))
  })
})
