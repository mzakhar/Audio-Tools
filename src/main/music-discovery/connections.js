import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const FILE = 'music-discovery-connections.json'

function connection(value, decrypt) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.baseUrl !== 'string' || typeof value.model !== 'string') return null
  let url
  try { url = new URL(value.baseUrl) } catch { return null }
  if (url.protocol !== 'https:') return null
  const auth = typeof value.auth === 'string' ? decrypt(value.auth) : null
  return auth ? { id: value.id, name: value.name || value.id, baseUrl: url.href.replace(/\/$/, ''), model: value.model, auth, capabilities: value.capabilities || {} } : null
}

export async function loadConnections(userData, safeStorage) {
  try {
    const saved = JSON.parse(await readFile(join(userData, FILE), 'utf8'))
    return (saved.connections || []).map(item => connection(item, encrypted => {
      if (!safeStorage?.isEncryptionAvailable?.()) return null
      try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')) } catch { return null }
    })).filter(Boolean)
  } catch { return [] }
}

// Settings UI can call this later; this file never exposes decrypted secrets.
export async function saveConnections(userData, connections, safeStorage) {
  if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('Secure credential storage is unavailable')
  const safe = connections.map(item => {
    const url = new URL(item.baseUrl)
    if (url.protocol !== 'https:' || !item.id || !item.model || !item.auth) throw new Error('Invalid discovery connection')
    return { id: item.id, name: item.name || item.id, baseUrl: url.href.replace(/\/$/, ''), model: item.model, capabilities: item.capabilities || {}, auth: safeStorage.encryptString(item.auth).toString('base64') }
  })
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, FILE), JSON.stringify({ version: 1, connections: safe }), 'utf8')
}
