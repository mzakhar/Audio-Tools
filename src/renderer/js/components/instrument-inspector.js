import Palettes from '../palettes.js'
import { SetTrackInstrument, SetTrackMidiChannel } from '../store/ProjectStore.js'

const internalKeys = ['classic', 'fm', 'pad', 'drum']
const catalog = value => (typeof value === 'function' ? value() : value) || []
const manifestOf = pack => pack.manifest || pack
const bankKey = address => `${address.bankMsb}:${address.bankLsb}`

function packFor(packs, id, version) {
  return packs.find(pack => pack.id === id && pack.version === version) || null
}

function patchFor(pack, id) {
  return manifestOf(pack)?.patches?.find(patch => patch.id === id) || null
}

function option(select, value, label) {
  const item = document.createElement('option')
  item.value = value
  item.textContent = label
  select.appendChild(item)
}

export function trackInstrumentLabel(instrument, packs) {
  if (!instrument || instrument.type === 'palette') return Palettes[instrument?.paletteKey || 'classic']?.name || 'Internal Synth'
  if (instrument.type === 'rack') return `Rack: ${instrument.rackId}`
  const patch = patchFor(packFor(catalog(packs), instrument.packId, instrument.packVersion), instrument.patchId)
  return patch ? `${patch.name} · ${instrument.packId}` : `Missing: ${instrument.packId}`
}

export class InstrumentInspector {
  constructor(container, { store, packCatalog, audition, auditionPack, auditionRawPack, selectPreview, preloadPack }) {
    this.container = container
    this.store = store
    this.packCatalog = packCatalog
    this.audition = audition
    this.auditionPack = auditionPack
    this.auditionRawPack = auditionRawPack
    this.selectPreview = selectPreview
    this.preloadPack = preloadPack
    this.trackId = null
    this.diagnostic = ''
    this.preview = null
    document.addEventListener('track-selected', event => {
      this.trackId = event.detail.trackId
      this.render()
    })
    document.addEventListener('instrument-sample-status', event => {
      if (event.detail.trackId !== this.trackId) return
      const status = event.detail.status
      this.diagnostic = status.state === 'error'
        ? `Pack error: ${status.error}`
        : status.state === 'track-signal'
          ? `Track signal peak: ${status.peak.toFixed(3)}`
        : `Pack ${status.state}: ${status.sampleId}${status.duration ? ` (${status.duration.toFixed(2)}s)` : ''}`
      this.render()
    })
    store.subscribe(() => this.render())
    this.render()
  }

  render() {
    const state = this.store.getState()
    const track = state.tracks.find(item => item.id === this.trackId)
    this.container.innerHTML = ''
    if (!track || track.type !== 'midi') {
      this.renderBrowser(catalog(this.packCatalog))
      return
    }

    const instrument = track.instrument || { type: 'palette', paletteKey: 'classic' }
    const packs = catalog(this.packCatalog)
    const title = document.createElement('h2')
    title.textContent = `Instrument · ${track.name || 'MIDI'}`
    const source = document.createElement('select')
    source.setAttribute('aria-label', 'Instrument source')
    option(source, 'palette', 'Internal Synth')
    option(source, 'pack', 'Instrument Pack')
    option(source, 'rack', 'Rack')
    source.value = instrument.type || 'palette'
    source.onchange = () => {
      if (source.value === 'palette') this.store.dispatch(SetTrackInstrument(track.id, { type: 'palette', paletteKey: 'classic' }))
      if (source.value === 'pack') {
        const pack = packs[0], patch = manifestOf(pack)?.patches?.[0]
        if (pack && patch) this.store.dispatch(SetTrackInstrument(track.id, { type: 'pack', packId: pack.id, packVersion: pack.version, patchId: patch.id, programFollow: 'midi' }))
      }
      if (source.value === 'rack') {
        const rack = Object.values(state.racks || {})[0]
        if (rack) this.store.dispatch(SetTrackInstrument(track.id, { type: 'rack', rackId: rack.id }))
      }
    }
    this.container.append(title, field('Source', source))

    const channel = document.createElement('select')
    option(channel, '', 'Omni')
    for (let value = 0; value < 16; value++) option(channel, String(value), `Channel ${value + 1}${value === 9 ? ' · Drums' : ''}`)
    channel.value = track.midiChannel ?? ''
    channel.onchange = () => this.store.dispatch(SetTrackMidiChannel(track.id, channel.value === '' ? null : Number(channel.value)))
    this.container.append(field('MIDI input', channel))

    if (instrument.type === 'palette') this.renderInternal(track, instrument)
    else if (instrument.type === 'pack') this.renderPack(track, instrument, packs)
    else this.renderRack(track, instrument, state)
    if (instrument.type === 'pack' && this.diagnostic) this.container.append(text(this.diagnostic))

    const audition = document.createElement('button')
    audition.className = 'instrument-audition'
    audition.textContent = '▶ AUDITION C4'
    audition.onclick = async () => {
      audition.disabled = true
      try { await this.audition?.(this.store.getState().tracks.find(item => item.id === track.id)) }
      catch (error) { alert(`Could not audition instrument: ${error.message}`) }
      finally { audition.disabled = false }
    }
    this.container.append(audition)
  }

  renderBrowser(packs) {
    const title = document.createElement('h2')
    title.textContent = 'Instrument Browser'
    this.container.append(title)
    if (!packs.length) {
      this.container.append(text('Import a SoundFont with + PACK to audition instruments.'))
      return
    }
    const packSelect = document.createElement('select')
    for (const pack of packs) option(packSelect, `${pack.id}@${pack.version}`, `${manifestOf(pack).name} · ${pack.version}`)
    const initial = this.preview && packFor(packs, this.preview.packId, this.preview.packVersion)
      ? this.preview : { packId: packs[0].id, packVersion: packs[0].version, patchId: manifestOf(packs[0]).patches[0].id }
    packSelect.value = `${initial.packId}@${initial.packVersion}`
    const program = document.createElement('select')
    const fill = () => {
      const [id, version] = packSelect.value.split('@')
      const pack = packFor(packs, id, version), manifest = manifestOf(pack)
      program.innerHTML = ''
      for (const patch of manifest.patches) option(program, patch.id, `${String(patch.address.program).padStart(3, '0')} · ${patch.name}`)
      if (this.preview?.packId === id && this.preview?.packVersion === version) program.value = this.preview.patchId
      if (program.selectedIndex < 0) program.selectedIndex = 0
    }
    fill()
    const selection = () => {
      const [packId, packVersion] = packSelect.value.split('@')
      const pack = packFor(packs, packId, packVersion), patch = patchFor(pack, program.value)
      this.preview = { packId, packVersion, patchId: patch.id }
      this.selectPreview?.(this.preview)
      return { pack, patch }
    }
    packSelect.onchange = () => { fill(); selection() }
    program.onchange = selection
    const audition = document.createElement('button')
    audition.className = 'instrument-audition'
    audition.textContent = '▶ AUDITION C4'
    audition.onclick = async () => {
      audition.disabled = true
      try { const { pack, patch } = selection(); await this.auditionPack?.(pack, patch) }
      catch (error) { alert(`Could not audition pack: ${error.message}`) }
      finally { audition.disabled = false }
    }
    const raw = document.createElement('button')
    raw.className = 'instrument-audition'
    raw.textContent = 'RAW WAV TEST'
    raw.onclick = async () => {
      raw.disabled = true
      try { const { pack, patch } = selection(); await this.auditionRawPack?.(pack, patch) }
      catch (error) { alert(`Could not run raw WAV test: ${error.message}`) }
      finally { raw.disabled = false }
    }
    this.container.append(field('Pack', packSelect), field('Program', program), text('Audition uses master output. Add a MIDI track to arrange this selection.'), audition, raw)
  }

  renderInternal(track, instrument) {
    const select = document.createElement('select')
    for (const key of internalKeys) option(select, key, Palettes[key].name)
    select.value = instrument.paletteKey || 'classic'
    select.onchange = () => this.store.dispatch(SetTrackInstrument(track.id, { type: 'palette', paletteKey: select.value }))
    this.container.append(field('Engine', select))
  }

  renderPack(track, instrument, packs) {
    const packSelect = document.createElement('select')
    for (const pack of packs) option(packSelect, `${pack.id}@${pack.version}`, `${manifestOf(pack).name} · ${pack.version}`)
    packSelect.value = `${instrument.packId}@${instrument.packVersion}`
    const choose = (chosenPack, patch) => {
      this.store.dispatch(SetTrackInstrument(track.id, {
      type: 'pack', packId: chosenPack.id, packVersion: chosenPack.version, patchId: patch.id,
      programFollow: follow.checked ? 'midi' : 'pinned',
      received: { bankMsb: patch.address.bankMsb, bankLsb: patch.address.bankLsb, program: patch.address.program }
      }))
      this.preloadPack?.(chosenPack, patch)
    }
    const pack = packFor(packs, instrument.packId, instrument.packVersion)
    const manifest = manifestOf(pack)
    if (!manifest) {
      this.container.append(field('Pack', packSelect), text('Missing pack. Import it again to restore audio.'))
      return
    }
    const bank = document.createElement('select')
    const banks = [...new Map(manifest.patches.map(patch => [bankKey(patch.address), patch.address])).values()]
    for (const address of banks) option(bank, bankKey(address), address.bankMsb === 0 && address.bankLsb === 0 ? 'GM Main · 0:0' : `Bank ${address.bankMsb}:${address.bankLsb}`)
    const current = patchFor(pack, instrument.patchId) || manifest.patches[0]
    bank.value = bankKey(current.address)
    const program = document.createElement('select')
    const search = document.createElement('input')
    search.type = 'search'; search.placeholder = 'Find program'; search.setAttribute('aria-label', 'Find pack program')
    const fillPrograms = () => {
      program.innerHTML = ''
      const needle = search.value.trim().toLowerCase()
      for (const patch of manifest.patches.filter(item => bankKey(item.address) === bank.value && item.name.toLowerCase().includes(needle))) {
        option(program, patch.id, `${String(patch.address.program).padStart(3, '0')} · ${patch.name}`)
      }
      program.value = current.id
      if (program.selectedIndex < 0) program.selectedIndex = 0
    }
    fillPrograms()
    packSelect.onchange = () => {
      const [id, version] = packSelect.value.split('@')
      const next = packFor(packs, id, version)
      if (next) choose(next, manifestOf(next).patches[0])
    }
    bank.onchange = () => { fillPrograms(); choose(pack, manifest.patches.find(item => item.id === program.value)) }
    search.oninput = fillPrograms
    program.onchange = () => choose(pack, manifest.patches.find(item => item.id === program.value))
    const follow = document.createElement('input')
    follow.type = 'checkbox'; follow.checked = instrument.programFollow !== 'pinned'
    follow.onchange = () => choose(pack, manifest.patches.find(item => item.id === program.value) || current)
    this.container.append(field('Pack', packSelect), field('Bank', bank), field('Program', program), field('Search', search), check('Follow keyboard program changes', follow))
  }

  renderRack(track, instrument, state) {
    const select = document.createElement('select')
    for (const rack of Object.values(state.racks || {})) option(select, rack.id, rack.name || rack.id)
    select.value = instrument.rackId
    select.onchange = () => this.store.dispatch(SetTrackInstrument(track.id, { type: 'rack', rackId: select.value }))
    this.container.append(field('Rack', select))
  }
}

function field(label, control) {
  const row = document.createElement('label')
  row.className = 'instrument-field'
  const text = document.createElement('span')
  text.textContent = label
  row.append(text, control)
  return row
}

function check(label, control) {
  const row = document.createElement('label')
  row.className = 'instrument-check'
  row.append(control, document.createTextNode(label))
  return row
}

function text(value) {
  const item = document.createElement('p')
  item.className = 'instrument-empty'
  item.textContent = value
  return item
}
