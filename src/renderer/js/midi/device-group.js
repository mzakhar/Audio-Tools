// device-group.js — PURE. One physical controller can show up as several MIDI
// input ports (Windows adds "MIDIIN2 (SMC-PAD)" mirrors). Opening more than one
// would double every hit, so the app opens exactly one id per group.

const MIRROR = /^MIDIIN\d+\s*\((.*)\)\s*$/i

const trimmed = name => (name || '').trim()
const keyOf = name => (MIRROR.exec(trimmed(name))?.[1] ?? trimmed(name)).trim().toLowerCase()

/** [{id,name}] -> [{key, name, ids[], primaryId}]. Primary is the plain-named port, else the first. */
export function groupInputs(inputs) {
  const groups = new Map()
  for (const { id, name } of inputs) {
    const key = keyOf(name)
    let group = groups.get(key)
    if (!group) groups.set(key, group = { key, name: trimmed(name), ids: [], primaryId: id })
    group.ids.push(id)
    if (!MIRROR.test(trimmed(name)) && MIRROR.test(group.name)) { group.primaryId = id; group.name = trimmed(name) }
  }
  return [...groups.values()]
}
