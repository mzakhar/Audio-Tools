import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const FILE = 'music-discovery-freesound.json'

export async function loadFreesound(userData, safeStorage) {
  try {
    const saved = JSON.parse(await readFile(join(userData, FILE), 'utf8'))
    if (!safeStorage?.isEncryptionAvailable?.() || typeof saved.token !== 'string') return null
    const token = safeStorage.decryptString(Buffer.from(saved.token, 'base64'))
    return token ? { token } : null
  } catch { return null }
}

export async function saveFreesound(userData, token, safeStorage) {
  if (typeof token !== 'string' || token.trim().length < 16) throw new Error('Invalid Freesound API key')
  if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('Secure credential storage is unavailable')
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, FILE), JSON.stringify({ version: 1, token: safeStorage.encryptString(token.trim()).toString('base64') }), 'utf8')
}
