// fm1-flash-files.js — FM-1 saved device state inside a project folder: <projectDir>/fm1/<id>.flash.
// The renderer names only the file; the name pattern plus path containment keep every read and
// write under fm1/. Files are immutable (a save writes a new one), so a temp file + rename is
// enough to never leave a half-written asset under its real name.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative, resolve, isAbsolute } from 'node:path'

export const FM1_FLASH_NAME = /^[\w-]+\.flash$/

/** Absolute paths for a flash asset, or a throw for anything that is not a plain name under <projectDir>/fm1/. */
export function fm1FlashPath(projectDir, name) {
  if (typeof projectDir !== 'string' || !projectDir || typeof name !== 'string' || !FM1_FLASH_NAME.test(name)) {
    throw new Error('Invalid FM-1 flash path')
  }
  const dir = resolve(projectDir, 'fm1')
  const file = resolve(dir, name)
  const rel = relative(dir, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid FM-1 flash path')
  return { dir, file }
}

export async function writeFm1Flash(projectDir, name, bytes) {
  const { dir, file } = fm1FlashPath(projectDir, name)
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp`
  // ponytail: no fsync; an OS crash just after a save can leave an unflushed asset (opens as flash-missing/corrupt, reset stays explicit). Add open+sync if that is ever seen
  await writeFile(tmp, Buffer.from(bytes))
  await rename(tmp, file)
}

/** The asset bytes, or null when the file does not exist. */
export async function readFm1Flash(projectDir, name) {
  const { file } = fm1FlashPath(projectDir, name)
  try {
    return new Uint8Array(await readFile(file))
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}
