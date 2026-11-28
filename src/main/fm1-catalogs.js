import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import seed from '../renderer/js/fm1/seed-catalog.json'
import { parseCatalog, reconcileCatalog, MAX_CATALOG_CHARS } from '../renderer/js/fm1/catalog.js'

const catalogPath = (dir, id) => join(dir, 'fm1-catalogs', `${id}.json`)
const validId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(id)

export async function loadFm1Catalog(dir, id) {
  if (id === seed.catalogId) return seed
  if (!validId(id)) throw new Error('Unknown catalog')
  let text
  try { text = await readFile(catalogPath(dir, id), 'utf8') } catch { throw new Error('Unknown catalog') }
  const parsed = parseCatalog(text)
  if (!parsed.ok || parsed.catalog.catalogId !== id) throw new Error('Invalid catalog')
  return parsed.catalog
}

export async function importFm1Catalog(dir, text) {
  if (typeof text !== 'string' || text.length > MAX_CATALOG_CHARS) throw new Error('Catalog is over 2 MB')
  const parsed = parseCatalog(text)
  if (!parsed.ok) throw new Error(`Not a valid catalog (${parsed.reason})`)
  const incoming = parsed.catalog
  if (incoming.catalogId === seed.catalogId) throw new Error('That catalog id is reserved')
  let existing = null
  try { existing = await loadFm1Catalog(dir, incoming.catalogId) } catch (e) { if (e.message !== 'Unknown catalog') throw e }
  const result = reconcileCatalog(existing, incoming)
  if (!result.ok) throw new Error('Catalog is older than the one you have')
  const path = catalogPath(dir, incoming.catalogId)
  await mkdir(join(dir, 'fm1-catalogs'), { recursive: true })
  const temp = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(result.catalog), 'utf8')
  await rename(temp, path)
  return text
}
