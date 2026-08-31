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

const part = (value, label) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

const handoff = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid imported preset')
  return {
    packId: part(value.packId, 'pack id'),
    packVersion: part(value.packVersion, 'pack version'),
    patchId: part(value.patchId, 'patch id'),
  }
}

const candidateForLead = value => validateCandidate(value, {
  // Local rows are metadata only.  This never imports a path or grants file access.
  kind: value?.kind === 'local-preset' ? 'local-preset' : 'remote',
})

export async function listLeads(userData) {
  return readLeads(userData)
}

export async function saveLead(userData, { brief: rawBrief, candidate: rawCandidate }) {
  const brief = normalizeBrief(rawBrief)
  const candidate = candidateForLead(rawCandidate)
  if (!brief.ok) throw new Error(brief.errors.join('; '))
  if (!candidate.ok) throw new Error(candidate.errors.join('; '))
  const lead = { id: crypto.randomUUID(), brief: brief.value, candidate: candidate.value, reviewedAt: new Date().toISOString(), disposition: 'saved' }
  const leads = await readLeads(userData)
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, FILE), JSON.stringify({ version: 2, leads: [...leads, lead] }), 'utf8')
  return lead
}

/** Attach an imported-pack identity to a saved local lead; importing stays elsewhere. */
export async function linkLead(userData, leadId, importedPreset) {
  if (typeof leadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leadId)) throw new Error('Invalid lead id')
  const leads = await readLeads(userData)
  const index = leads.findIndex(lead => lead?.id === leadId)
  if (index < 0) throw new Error('Saved lead not found')
  if (leads[index]?.candidate?.kind !== 'local-preset') throw new Error('Only local leads can be linked')
  const next = { ...leads[index], handoff: handoff(importedPreset) }
  leads[index] = next
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, FILE), JSON.stringify({ version: 2, leads }), 'utf8')
  return next
}
