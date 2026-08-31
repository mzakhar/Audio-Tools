import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { normalizeBrief, validateCandidate } from '../../shared/music-discovery/contracts.js'

const FILE = 'music-discovery-leads.json'

async function readLeads(userData) {
  try {
    const saved = JSON.parse(await readFile(join(userData, FILE), 'utf8'))
    return Array.isArray(saved.leads) ? saved.leads : []
  } catch { return [] }
}

export async function listLeads(userData) {
  return readLeads(userData)
}

export async function saveLead(userData, { brief: rawBrief, candidate: rawCandidate }) {
  const brief = normalizeBrief(rawBrief)
  const candidate = validateCandidate(rawCandidate)
  if (!brief.ok) throw new Error(brief.errors.join('; '))
  if (!candidate.ok) throw new Error(candidate.errors.join('; '))
  const lead = { id: crypto.randomUUID(), brief: brief.value, candidate: candidate.value, reviewedAt: new Date().toISOString(), disposition: 'saved' }
  const leads = await readLeads(userData)
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, FILE), JSON.stringify({ version: 1, leads: [...leads, lead] }), 'utf8')
  return lead
}
