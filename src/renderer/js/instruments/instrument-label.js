// instrument-label.js — one human-readable line for an instrument descriptor.
// Pure; `packs` may be the catalog array or a function returning it.

import Palettes from '../palettes.js'

const catalog = value => (typeof value === 'function' ? value() : value) || []
const manifestOf = pack => pack?.manifest || pack

export function trackInstrumentLabel(instrument, packs) {
  if (!instrument || instrument.type === 'palette') return Palettes[instrument?.paletteKey || 'classic']?.name || 'Internal Synth'
  if (instrument.type === 'rack') return `Rack: ${instrument.rackId}`
  const pack = catalog(packs).find(item => item.id === instrument.packId && item.version === instrument.packVersion)
  const patch = manifestOf(pack)?.patches?.find(item => item.id === instrument.patchId)
  return patch ? `${patch.name} · ${instrument.packId}` : `Missing: ${instrument.packId}`
}
