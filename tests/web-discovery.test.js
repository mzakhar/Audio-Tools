import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const leadRequest = (method, payload, access = token()) => ({ method, url: '/api/music-discovery/leads', headers: { 'cf-access-jwt-assertion': access }, async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(JSON.stringify(payload)) } })
const response = () => {
  const res = { headersSent: false, end: vi.fn(), write: vi.fn(() => true) }
  res.writeHead = vi.fn(() => { res.headersSent = true })
  return res
}
const validBrief = { text: 'soul vocal', target: 'sample-loop', sources: ['web'] }
const freesound = { results: [{ name: 'Soul Vocal', username: 'Ada', url: 'https://freesound.org/people/ada/sounds/1/', license: 'CC0' }] }

function handler(fetchFn, extra = {}) {
  return createWebDiscoveryHandler({ teamDomain, audience, freesoundToken: 'fs-secret', openaiKey: 'oa-secret', fetchFn, ...extra })
}

describe('web music discovery proxy', () => {
  it('protects firmware downloads with Access and resolves only seed entries', async () => {
    const fetchFn = vi.fn(async target => String(target) === `${teamDomain}/cdn-cgi/access/certs`
      ? { ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig' }] }) }
      : new Response(new Uint8Array([1, 2, 3])))
    const firmwareRequest = (payload, access) => ({ ...request(payload, access), url: '/api/fm1-firmware' })
    const denied = response()
    await handler(fetchFn)(firmwareRequest({ catalogId: 'synth-seed', entryId: '646timur-cell/pulhra' }, 'invalid'), denied)
    expect(denied.writeHead).toHaveBeenCalledWith(403, expect.any(Object))
    expect(fetchFn).not.toHaveBeenCalled()
    const bad = response()
    await handler(fetchFn)(firmwareRequest({ catalogId: 'other', entryId: '646timur-cell/pulhra' }, token()), bad)
    expect(bad.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    const good = response()
    await handler(fetchFn)(firmwareRequest({ catalogId: 'synth-seed', entryId: '646timur-cell/pulhra' }, token()), good)
    expect(good.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'application/octet-stream' }))
    expect(Array.from(good.write.mock.calls[0][0])).toEqual([1, 2, 3])
    expect(good.end).toHaveBeenCalled()
  })

  it('limits concurrent firmware buffers and releases the slot', async () => {
    let release
    const fetchFn = vi.fn(async target => String(target) === `${teamDomain}/cdn-cgi/access/certs`
      ? { ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig' }] }) }
      : new Promise(resolve => { release = () => resolve(new Response(new Uint8Array([1]))) }))
    const run = handler(fetchFn)
    const firmwareRequest = () => ({ ...request({ catalogId: 'synth-seed', entryId: '646timur-cell/pulhra' }), url: '/api/fm1-firmware' })
    const first = run(firmwareRequest(), response())
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const second = response()
    await run(firmwareRequest(), second)
    expect(second.writeHead).toHaveBeenCalledWith(429, expect.any(Object))
    release()
    await first
    const third = run(firmwareRequest(), response())
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(5))
    release()
    await third
  })

  it('destroys a partial response when upstream exceeds the limit', async () => {
    const fetchFn = vi.fn(async target => String(target) === `${teamDomain}/cdn-cgi/access/certs`
      ? { ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig' }] }) }
      : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1)); controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.close() } })))
    const res = response()
    res.destroy = vi.fn()
    await handler(fetchFn)({ ...request({ catalogId: 'synth-seed', entryId: '646timur-cell/pulhra' }), url: '/api/fm1-firmware' }, res)
    expect(res.write).toHaveBeenCalledTimes(1)
    expect(res.destroy).toHaveBeenCalledOnce()
    expect(res.end).not.toHaveBeenCalled()
  })
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

  it('shares saved leads across Access identities and persists them atomically', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'synth-leads-'))
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig' }] }) }))
    const run = handler(fetchFn, { dataDir })
    try {
      const payload = { brief: validBrief, candidate: { assetName: 'Soul Vocal', creator: 'Ada', sourceId: 'freesound', sourceUrl: freesound.results[0].url, evidence: [{ url: freesound.results[0].url, title: 'Soul Vocal' }] } }
      const saved = response()
      const second = response()
      await Promise.all([run(leadRequest('POST', payload), saved), run(leadRequest('POST', { ...payload, candidate: { ...payload.candidate, assetName: 'Soul Choir' } }), second)])
      expect(saved.writeHead).toHaveBeenCalledWith(201, expect.any(Object))
      expect(JSON.parse(saved.end.mock.calls[0][0]).lead).toMatchObject({ savedBy: 'user@example.com', candidate: { sourceUrl: freesound.results[0].url } })
      const listed = response()
      await run(leadRequest('GET', undefined, token({ email: 'other@example.com' })), listed)
      expect(listed.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(JSON.parse(listed.end.mock.calls[0][0]).leads).toHaveLength(2)
    } finally { await rm(dataDir, { recursive: true, force: true }) }
  })
})
