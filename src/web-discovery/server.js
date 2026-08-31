import { createServer } from 'node:http'
import { createWebDiscoveryHandler } from './index.js'

const handler = createWebDiscoveryHandler({
  teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
  audience: process.env.CF_ACCESS_AUD,
  freesoundToken: process.env.FREESOUND_API_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
})

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok')
    return
  }
  handler(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Discovery unavailable' }))
  })
}).listen(8081)
