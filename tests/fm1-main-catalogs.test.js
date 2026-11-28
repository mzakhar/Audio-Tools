import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importFm1Catalog, loadFm1Catalog } from '../src/main/fm1-catalogs.js'

describe('Electron FM-1 catalogs', () => {
  it('resolves only seed and independently imported catalogs, preserving version checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fm1-catalog-'))
    try {
      expect((await loadFm1Catalog(dir, 'synth-seed')).entries.length).toBeGreaterThan(0)
      await expect(loadFm1Catalog(dir, '../outside')).rejects.toThrow('Unknown catalog')
      await expect(loadFm1Catalog(dir, 'missing')).rejects.toThrow('Unknown catalog')
      const catalog = { schema: 'synth-fm1-catalog@1', catalogId: 'example', version: '2026-11-28', entries: [{ id: 'one', name: 'One', packageUrl: 'https://github.com/example/file' }] }
      await importFm1Catalog(dir, JSON.stringify(catalog))
      expect((await loadFm1Catalog(dir, 'example')).entries[0].packageUrl).toBe(catalog.entries[0].packageUrl)
      await expect(importFm1Catalog(dir, JSON.stringify({ ...catalog, version: '2025-01-01' }))).rejects.toThrow('older')
      expect((await loadFm1Catalog(dir, 'example')).version).toBe('2026-11-28')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
