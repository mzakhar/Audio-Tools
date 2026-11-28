// Builds src/renderer/js/fm1/seed-catalog.json from fm1-emu's firmwares.json and the
// 2bbb/fm1-firmware-collection catalog. Deterministic (sorted by id, no timestamps beyond the fixed version).
//   node scripts/build-fm1-catalog.mjs --emu E:/tmp/fm1-emu/web/firmwares.json --coll E:/tmp/fm1-coll-catalog.json
import { readFileSync, writeFileSync } from 'node:fs'
import { parseCatalog, CATALOG_SCHEMA } from '../src/renderer/js/fm1/catalog.js'

const arg = n => process.argv[process.argv.indexOf(n) + 1]
const emu = JSON.parse(readFileSync(arg('--emu'), 'utf8'))
const coll = JSON.parse(readFileSync(arg('--coll'), 'utf8'))
const OUT = new URL('../src/renderer/js/fm1/seed-catalog.json', import.meta.url)
const VERSION = '2026-11-27'

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '') || 'unknown'
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const hubSha = new Map() // `${hubId}@${version}` -> { sha256, size }
for (const f of coll.firmwares) if (f.hub?.sha256) hubSha.set(`${f.hub.id}@${f.hub.version}`, f.hub)

const tested = {
  'mvave-v15': { id: 'm-vave/mvave-v15', version: 'V15', sha256: 'db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a', size: 699956, minMhz: null, note: 'RTF 0.54 @240 / 0.70 @120 JIT; too slow live on reference PC' },
  felucca: { id: 'hugelton/felucca', version: '1.8.4', sha256: 'fdc33af18a8af69a5c4a490afe94e116a5b486608ebb0a17ecb6e539ee3c4ebe', size: 610286, packageUrl: 'https://github.com/hugelton/Felucca/releases/tag/v1.8.4', minMhz: 120, note: 'RTF 0.93 @240 / 1.62 @120 JIT' },
  sloop: { id: 'isod89/sloop', version: '2.8.5', sha256: 'b0446effb840740a3aa5c386ce004e79334e4f833d48d82a9eb5edbfde92ae67', size: 610076, minMhz: 120, note: 'RTF 0.89 @240 / 1.60 @120 JIT' },
  fm1dock: { id: 'joakimeriksson/fm1-dock', version: '1.0.1-digital', sha256: 'c68a8f295a2987f4e105e83bfe5c6472bdaa893902366efdb558fb67713ef6bb', size: 611104, packageUrl: null, minMhz: 240, note: 'RTF 1.52 @240 / 2.83 @120 JIT' }
}

const entries = emu.firmwares.map(f => {
  const t = tested[f.id]
  const hub = f.hub && hubSha.get(`${f.hub}@${f.version}`)
  const skipped = emu.skipped?.[f.id]
  const license = f.license ? f.license.split(' (')[0] : null
  const e = {
    id: t?.id ?? `${slug(f.author)}/${slug(f.id)}`,
    name: f.name,
    author: f.author,
    version: t?.version ?? (f.version || null),
    target: 'FM-1',
    description: f.about ? clip(f.about, 300) : null,
    sourceUrl: f.repo ?? null,
    licenseId: license,
    licenseUrl: null,
    packageUrl: t && 'packageUrl' in t ? t.packageUrl : f.package ?? f.download ?? null,
    sha256: t?.sha256 ?? hub?.sha256 ?? null,
    size: t?.size ?? hub?.size ?? null,
    distribution: f.byo ? 'byo' : 'obtain-separately',
    compat: t
      ? { status: 'tested', by: 'synth-phase0', date: VERSION, note: t.note, minMhz: t.minMhz }
      : { status: 'upstream-ok', by: 'fm1-emu', date: null, note: null, minMhz: f.minMhz ?? null }
  }
  return e
})
// fm1-emu skipped list: ids not in firmwares[] (hub ids), kept as known-broken markers
for (const [hubId, why] of Object.entries(emu.skipped ?? {})) {
  const c = coll.firmwares.find(f => f.hub?.id === hubId)
  entries.push({
    id: `${slug(c?.repo?.split('/')[0] ?? 'hub')}/${slug(hubId)}`,
    name: c?.hub?.name ?? hubId, author: c?.repo?.split('/')[0] ?? null, version: c?.hub?.version ?? null, target: 'FM-1',
    description: clip(c?.description?.replace(/\*+/g, '') ?? '', 300) || null,
    sourceUrl: c?.url ?? null, licenseId: c?.license ?? null, licenseUrl: null, packageUrl: null,
    sha256: c?.hub?.sha256 ?? null, size: c?.hub?.size ?? null, distribution: 'obtain-separately',
    compat: { status: 'broken', by: 'fm1-emu', date: null, note: clip(why, 200), minMhz: null }
  })
}
entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const catalog = {
  schema: CATALOG_SCHEMA,
  catalogId: 'synth-seed',
  version: VERSION,
  generatedAt: `${VERSION}T00:00:00Z`,
  attribution: [
    { name: 'fm1-emu', url: 'https://github.com/joakimeriksson/fm1-emu', license: 'MIT', copyright: 'Copyright (c) 2026 Joakim Eriksson' },
    { name: 'fm1-firmware-collection', url: 'https://github.com/2bbb/fm1-firmware-collection', license: 'MIT', copyright: 'Copyright (c) 2026 ISHII 2bit' }
  ],
  entries
}
const text = JSON.stringify(catalog, null, 1) + '\n'
const parsed = parseCatalog(text)
if (!parsed.ok) throw new Error('seed catalog fails parseCatalog: ' + parsed.reason)
if (parsed.catalog.entries.length !== entries.length) throw new Error('entries dropped on parse')
writeFileSync(OUT, text)
console.log(`seed-catalog.json: ${entries.length} entries, ${text.length} bytes`)
