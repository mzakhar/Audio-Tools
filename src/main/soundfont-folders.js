// A folder of SoundFont banks is registered, never copied: banks are read in
// place and only the metadata index lives under userData. The index is a cache
// keyed on path + size + mtime, so a rescan re-reads only what changed.

import { lstat, mkdir, open, readFile, readdir, writeFile } from 'fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { readBankIndex } from '../shared/sf2-index.js'

const FOLDERS_FILE = 'soundfont-folders.json'
const INDEX_FILE = 'soundfont-index.json'
const BANK_EXT = /\.sf[23]$/i

const statePath = (userData, file) => join(resolve(userData), file)

async function readState(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

async function writeState(userData, file, value) {
  await mkdir(resolve(userData), { recursive: true })
  await writeFile(statePath(userData, file), JSON.stringify(value), 'utf8')
}

/**
 * Positional reads off one file descriptor — indexing a 1.9 GB bank costs a few
 * kilobytes. fs.read may come up short of the buffer, and readBankIndex reads a
 * short return as EOF, so loop until satisfied or genuinely done.
 */
function readAt(handle) {
  return async (offset, length) => {
    const buffer = Buffer.alloc(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
      if (!bytesRead) break
      filled += bytesRead
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, filled)
  }
}

async function indexBank(path, folder, stat) {
  const handle = await open(path, 'r')
  try {
    const { title, info, presets } = await readBankIndex(readAt(handle), { fileName: basename(path), byteLength: stat.size })
    return { path, folder, fileName: basename(path), size: stat.size, mtimeMs: stat.mtimeMs, title, info, presets }
  } finally {
    await handle.close()
  }
}

/**
 * 101 of 500 real banks share an INAM, so disambiguate the duplicates only:
 * append the author, else the filename. Non-colliding titles stay untouched.
 */
function withDisplayTitles(banks) {
  const counts = new Map()
  for (const bank of banks) counts.set(bank.title, (counts.get(bank.title) || 0) + 1)
  return banks.map(bank => counts.get(bank.title) > 1
    ? { ...bank, title: `${bank.title} — ${bank.info?.author || bank.fileName}` }
    : bank)
}

export async function listSoundFontFolders(userData) {
  const saved = await readState(statePath(userData, FOLDERS_FILE))
  return Array.isArray(saved?.folders) ? saved.folders.filter(path => typeof path === 'string') : []
}

/** Registered paths are read-only inputs and live outside the pack root by design. */
export async function addSoundFontFolder(userData, folderPath) {
  const dir = resolve(String(folderPath || ''))
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose a folder of SoundFont banks')
  const folders = await listSoundFontFolders(userData)
  if (!folders.includes(dir)) folders.push(dir)
  await writeState(userData, FOLDERS_FILE, { version: 1, folders })
  return folders
}

/**
 * Authorization for a bank path the renderer names. Registering a folder is the
 * user granting read access to it; nothing else on the disk is in scope. Without
 * this, `importPreset` would be an arbitrary-file-read primitive for any
 * compromised renderer, since main would read whatever path it was handed.
 */
export async function isRegisteredBank(userData, bankPath) {
  const file = resolve(String(bankPath || ''))
  if (!BANK_EXT.test(file)) return false
  for (const folder of await listSoundFontFolders(userData)) {
    const root = resolve(folder), rel = relative(root, file)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel) && resolve(root, rel) === file) return true
  }
  return false
}

export async function removeSoundFontFolder(userData, folderPath) {
  const dir = resolve(String(folderPath || ''))
  const folders = (await listSoundFontFolders(userData)).filter(path => path !== dir)
  await writeState(userData, FOLDERS_FILE, { version: 1, folders })
  return folders
}

/**
 * Index every bank in every registered folder, reusing cached rows whose size
 * and mtime still match. A bank that fails to index is counted and skipped —
 * the collection holds malformed files and one must not cost you the rest.
 */
export async function scanSoundFontFolders(userData) {
  const folders = await listSoundFontFolders(userData)
  const cache = await readState(statePath(userData, INDEX_FILE))
  const cached = cache?.version === 1 && cache.banks ? cache.banks : {}
  const banks = {} // Rebuilt from the registered folders, so removed banks drop out.
  let skipped = 0
  for (const folder of folders) {
    let entries = []
    // A missing folder (unplugged drive) stays registered and contributes nothing.
    try { entries = await readdir(folder, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      // ponytail: non-recursive — real collections are one flat folder; walk deeper when one isn't.
      if (!entry.isFile() || !BANK_EXT.test(entry.name)) continue
      const path = join(folder, entry.name)
      try {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file')
        const hit = cached[path]
        banks[path] = hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs ? hit : await indexBank(path, folder, stat)
      } catch {
        skipped++
      }
    }
  }
  await writeState(userData, INDEX_FILE, { version: 1, banks })
  const rows = withDisplayTitles(Object.values(banks))
  return { folders, banks: rows.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path)), skipped }
}
