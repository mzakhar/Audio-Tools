// fm1-flash-files.js — FM-1 saved device state inside a project folder: <projectDir>/fm1/<id>.flash.
// The renderer names only the file; the name pattern plus path containment keep every read and
// write under fm1/. Files are immutable (a save writes a new one), so a temp file + rename is
// enough to never leave a half-written asset under its real name.
//
// projectDir comes from the renderer, so it is trusted only when main itself handed it out: a
// directory picked in the main process's open dialog (createProjectDirs().allowFromDialog).
// Symlinks / junctions are refused for fm1/ and the asset, and the real fm1/ must sit inside the
// real project folder.
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { relative, resolve, isAbsolute } from 'node:path'

export const FM1_FLASH_NAME = /^[\w-]+\.flash$/
export const MAX_FM1_FLASH_BYTES = 2 * 1024 * 1024   // a full 1 MiB flash diff encodes to ~1.03 MiB
// Windows device names stay devices with any extension (con.flash is the console)
const RESERVED_STEM = /^(con|prn|aux|nul|com\d|lpt\d)$/i

const invalid = () => new Error('Invalid FM-1 flash path')
const inside = (base, path) => {
  const rel = relative(base, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Absolute paths for a flash asset, or a throw for anything that is not a plain name under <projectDir>/fm1/. */
export function fm1FlashPath(projectDir, name) {
  if (typeof projectDir !== 'string' || !projectDir || typeof name !== 'string' || !FM1_FLASH_NAME.test(name)
    || RESERVED_STEM.test(name.slice(0, -'.flash'.length))) {
    throw invalid()
  }
  const dir = resolve(projectDir, 'fm1')
  const file = resolve(dir, name)
  if (!inside(dir, file)) throw invalid()
  return { dir, file }
}

/**
 * Project folders main has handed out. allowFromDialog(options, result) records the directories a
 * main-process open dialog returned; check(dir) returns dir, or throws for any other folder.
 */
export function createProjectDirs({ caseInsensitive = process.platform === 'win32' } = {}) {
  const dirs = new Set()
  const keyOf = dir => { const r = resolve(dir); return caseInsensitive ? r.toLowerCase() : r }
  return {
    allow(dir) { if (typeof dir === 'string' && dir) dirs.add(keyOf(dir)) },
    allowFromDialog(options, result) {
      if (result?.canceled || !options?.properties?.includes?.('openDirectory')) return
      for (const dir of result?.filePaths ?? []) this.allow(dir)
    },
    check(dir) {
      if (typeof dir !== 'string' || !dir || !dirs.has(keyOf(dir))) throw new Error('Unknown project folder')
      return dir
    }
  }
}

const lstatOrNull = path => lstat(path).catch(e => { if (e?.code === 'ENOENT') return null; throw e })

// fm1/ is a real directory (not a link) whose real path is inside the real project folder
async function checkDir(projectDir, dir) {
  const st = await lstatOrNull(dir)
  if (!st) return false
  if (st.isSymbolicLink() || !st.isDirectory()) throw invalid()
  if (!inside(await realpath(projectDir), await realpath(dir))) throw invalid()
  return true
}

const toBytes = bytes => {
  // by tag, not instanceof: IPC (and tests) can hand over another realm's typed arrays
  const tag = Object.prototype.toString.call(bytes)
  if (tag === '[object ArrayBuffer]') return new Uint8Array(bytes)
  if (tag === '[object Uint8Array]') return bytes   // Buffer is one too
  throw new Error('Invalid FM-1 flash data')
}

// fsRename: the rename step, passed in only by the temp-file cleanup test
export async function writeFm1Flash(projectDir, name, bytes, { fsRename = rename } = {}) {
  const { dir, file } = fm1FlashPath(projectDir, name)
  const data = toBytes(bytes)
  if (data.byteLength > MAX_FM1_FLASH_BYTES) throw new Error('FM-1 flash data too large')
  if (!await checkDir(projectDir, dir)) {
    await mkdir(dir, { recursive: true })
    await checkDir(projectDir, dir)
  }
  const existing = await lstatOrNull(file)
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw invalid()
  // a fresh temp name opened exclusively: never follows a planted link, never reuses a stale temp
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  // ponytail: no fsync; an OS crash just after a save can leave an unflushed asset (opens as flash-missing/corrupt, reset stays explicit). Add handle.sync() if that is ever seen
  try {
    const handle = await open(tmp, 'wx')
    try { await handle.writeFile(data) } finally { await handle.close() }
    await fsRename(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

/** The asset bytes, or null when the file does not exist. */
export async function readFm1Flash(projectDir, name) {
  const { dir, file } = fm1FlashPath(projectDir, name)
  if (!await checkDir(projectDir, dir)) return null
  const st = await lstatOrNull(file)
  if (!st) return null
  if (st.isSymbolicLink() || !st.isFile()) throw invalid()
  // ponytail: lstat then open leaves a swap window (no O_NOFOLLOW on Windows); the fstat below still checks type and size
  const handle = await open(file, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_FM1_FLASH_BYTES) throw new Error('FM-1 flash file refused (not a file, or over 2 MiB)')
    return new Uint8Array(await handle.readFile())
  } finally {
    await handle.close()
  }
}
