// instrument-settings.js — everything dense and occasional about one track's
// instrument, in one <dialog>. The browser is for finding a sound; this is for
// pinning down "program 89 of bank 0:0", which a fuzzy search cannot say.

import Palettes from '../palettes.js'
import { kitFor, DEFAULT_KIT_ID } from '../pads/kit.js'
import { openDialog } from '../ui/dialog.js'
import { SetTrackInstrument, SetTrackMidiChannel } from '../store/ProjectStore.js'
import { fm1Descriptor, fm1InstrumentFor, FM1_MHZ_CHOICES, slowWarning } from '../fm1/descriptor.js'

export const SETTINGS_DIALOG_ID = 'instrument-settings-dialog'

const TABS = ['Patch', 'MIDI', 'Expression', 'Output']
const INTERNAL_KEYS = ['classic', 'fm', 'pad', 'drum']
const MOD_DESTS = [['default', 'Engine default'], ['off', 'Off']]
const manifestOf = pack => pack?.manifest || pack
const bankKey = address => `${address.bankMsb}:${address.bankLsb}`

function option(select, value, label) {
  const item = document.createElement('option')
  item.value = value
  item.textContent = label
  select.appendChild(item)
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

function note(value) {
  const item = document.createElement('p')
  item.className = 'instrument-empty'
  item.textContent = value
  return item
}

/** Unique sample ids across a patch — the honest "how heavy is this" number. */
function sampleWeight(manifest) {
  const ids = new Set()
  for (const patch of manifest?.patches || []) for (const zone of patch.zones || []) ids.add(zone.sampleId)
  return ids.size
}

export class InstrumentSettings {
  /** deps: { store, packCatalog(), warmPack(pack, patch), fm1Installed(), fm1Compat(hash), openFm1Device(trackId), refreshFm1() }
   *  fm1Installed/fm1Compat read a cache; refreshFm1() reloads it, resolving true when it changed. */
  constructor(deps) {
    this.deps = deps
    this.trackId = null
    this.tab = 'Patch'
    this.el = document.getElementById(SETTINGS_DIALOG_ID)
    if (!this.el) return
    this.tabsEl = this.el.querySelector('#is-tabs')
    this.bodyEl = this.el.querySelector('#is-body')
    this.titleEl = this.el.querySelector('#is-title')
    for (const name of TABS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'is-tab'
      button.textContent = name.toUpperCase()
      button.setAttribute('role', 'tab')
      button.onclick = () => { this.tab = name; this.render() }
      this.tabsEl.appendChild(button)
    }
    // A live re-render would rebuild the Output sliders mid-drag, so that tab opts out.
    deps.store.subscribe(() => { if (this.el?.open && this.tab !== 'Output') this.render() })
  }

  open(trackId) {
    if (!this.el || this.el.open) return // showModal throws on an open dialog
    this.trackId = trackId
    this.tab = 'Patch'
    if (!openDialog(SETTINGS_DIALOG_ID)) return
    this.render()
    Promise.resolve(this.deps.refreshFm1?.()).then(changed => { if (changed && this.el.open) this.render() }, () => {})
    this.bodyEl.querySelector('select, input, button')?.focus()
  }

  track() {
    return this.deps.store.getState().tracks.find(item => item.id === this.trackId) || null
  }

  set(instrument) {
    this.deps.store.dispatch(SetTrackInstrument(this.trackId, instrument))
  }

  render() {
    const track = this.track()
    this.tabsEl.querySelectorAll('.is-tab').forEach((button, i) => {
      button.classList.toggle('active', TABS[i] === this.tab)
      button.setAttribute('aria-selected', String(TABS[i] === this.tab))
    })
    this.bodyEl.innerHTML = ''
    if (!track || track.type !== 'midi') {
      this.bodyEl.append(note('Select a MIDI track to edit its instrument.'))
      return
    }
    this.titleEl.textContent = `INSTRUMENT · ${track.name || 'MIDI'}`
    const instrument = track.instrument || { type: 'palette', paletteKey: 'classic' }
    if (this.tab === 'Patch') this.renderPatch(track, instrument)
    else if (this.tab === 'MIDI') this.renderMidi(track)
    else if (this.tab === 'Expression') this.renderExpression(instrument)
    else this.renderOutput(track)
  }

  // ── Patch ────────────────────────────────────────────────────────────────
  renderPatch(track, instrument) {
    const packs = this.deps.packCatalog?.() || []
    const racks = Object.values(this.deps.store.getState().racks || {})
    const source = document.createElement('select')
    source.setAttribute('aria-label', 'Instrument source')
    option(source, 'palette', 'Internal Synth')
    option(source, 'pack', 'Instrument Pack')
    option(source, 'rack', 'Rack')
    option(source, 'kit', 'Drum Kit')
    option(source, 'fm1', 'FM-1 Device')
    source.value = instrument.type || 'palette'
    source.onchange = () => {
      const keep = { ...(instrument.bendRange != null ? { bendRange: instrument.bendRange } : {}), ...(instrument.modDest ? { modDest: instrument.modDest } : {}) }
      if (source.value === 'palette') this.set({ type: 'palette', paletteKey: 'classic', ...keep })
      if (source.value === 'pack') {
        const pack = packs[0], patch = manifestOf(pack)?.patches?.[0]
        if (pack && patch) this.choosePatch(pack, patch, 'pinned', keep)
        else this.render()
      }
      if (source.value === 'kit') this.set({ type: 'kit', kitId: DEFAULT_KIT_ID, ...keep })
      if (source.value === 'rack' && racks[0]) this.set({ type: 'rack', rackId: racks[0].id, ...keep })
      if (source.value === 'fm1') {
        const record = this.deps.fm1Installed?.()[0]
        if (record) this.set(fm1InstrumentFor(record, keep))
        else { this.fm1Missing = true; this.render() }   // nothing to switch to: say why, once
      }
    }
    this.bodyEl.append(field('Source', source))
    if (this.fm1Missing) {
      this.fm1Missing = false
      this.bodyEl.append(note('No FM-1 firmware installed. Open FM-1 firmware… to import one.'))
    }

    if (instrument.type === 'pack') this.renderPack(instrument, packs)
    else if (instrument.type === 'rack') this.renderRack(instrument, racks)
    else if (instrument.type === 'kit') this.renderKit(instrument)
    else if (instrument.type === 'fm1') this.renderFm1(track, instrument)
    else this.renderInternal(instrument)
  }

  renderFm1(track, instrument) {
    const installed = this.deps.fm1Installed?.() || []
    const descriptor = fm1Descriptor(instrument)
    const firmware = document.createElement('select')
    firmware.setAttribute('aria-label', 'Firmware')
    if (!installed.some(record => record.id === descriptor.firmwareHash)) option(firmware, descriptor.firmwareHash || '', 'Missing firmware')
    for (const record of installed) option(firmware, record.id, record.name)
    firmware.value = descriptor.firmwareHash || ''
    firmware.onchange = () => this.set({ ...instrument, firmwareHash: firmware.value })

    const channel = document.createElement('select')
    channel.setAttribute('aria-label', 'Device channel')
    for (let value = 0; value < 16; value++) option(channel, String(value), `Channel ${value + 1}`)
    channel.value = String(descriptor.deviceChannel)
    channel.onchange = () => this.set({ ...instrument, deviceChannel: Number(channel.value) })

    const mhz = document.createElement('select')
    mhz.setAttribute('aria-label', 'Emulated clock')
    const choices = FM1_MHZ_CHOICES.includes(descriptor.mhz) ? FM1_MHZ_CHOICES : [...FM1_MHZ_CHOICES, descriptor.mhz].sort((a, b) => a - b)
    for (const value of choices) option(mhz, String(value), `${value} MHz`)
    mhz.value = String(descriptor.mhz)
    mhz.onchange = () => this.set({ ...instrument, mhz: Number(mhz.value) })

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'btn midi-btn'
    open.textContent = 'Open device…'
    open.onclick = () => this.deps.openFm1Device?.(track.id)

    this.bodyEl.append(field('Firmware', firmware), field('Device channel', channel), field('Clock', mhz))
    if (!installed.length) this.bodyEl.append(note('No firmware installed. Use FM-1 firmware… in the ⋯ menu.'))
    const warning = slowWarning(descriptor.mhz, this.deps.fm1Compat?.(descriptor.firmwareHash))
    if (warning) this.bodyEl.append(note(warning))
    this.bodyEl.append(open, note('Saves on the device are not kept yet.'))
  }

  renderInternal(instrument) {
    const select = document.createElement('select')
    for (const key of INTERNAL_KEYS) option(select, key, Palettes[key]?.name || key)
    select.value = instrument.paletteKey || 'classic'
    select.onchange = () => this.set({ ...instrument, paletteKey: select.value })
    this.bodyEl.append(field('Engine', select))
  }

  renderKit(instrument) {
    const select = document.createElement('select')
    option(select, DEFAULT_KIT_ID, kitFor(DEFAULT_KIT_ID).name)
    select.value = kitFor(instrument.kitId) ? instrument.kitId : DEFAULT_KIT_ID
    select.onchange = () => this.set({ ...instrument, kitId: select.value })
    this.bodyEl.append(field('Kit', select))
  }

  renderRack(instrument, racks) {
    const select = document.createElement('select')
    for (const rack of racks) option(select, rack.id, rack.name || rack.id)
    select.value = instrument.rackId
    select.onchange = () => this.set({ ...instrument, rackId: select.value })
    this.bodyEl.append(field('Rack', select))
    if (!racks.some(rack => rack.id === instrument.rackId)) {
      this.bodyEl.append(note(`Missing rack ${instrument.rackId}. Pick another rack to restore audio.`))
    }
  }

  choosePatch(pack, patch, programFollow, extra = {}) {
    this.set({
      type: 'pack',
      packId: pack.id ?? manifestOf(pack).id,
      packVersion: pack.version ?? manifestOf(pack).version,
      patchId: patch.id,
      programFollow,
      received: { bankMsb: patch.address.bankMsb, bankLsb: patch.address.bankLsb, program: patch.address.program },
      ...extra,
    })
    this.deps.warmPack?.(pack, patch)
  }

  renderPack(instrument, packs) {
    const packSelect = document.createElement('select')
    for (const pack of packs) option(packSelect, `${pack.id}@${pack.version}`, `${manifestOf(pack).name} · ${pack.version}`)
    packSelect.value = `${instrument.packId}@${instrument.packVersion}`
    const pack = packs.find(item => item.id === instrument.packId && item.version === instrument.packVersion)
    const manifest = manifestOf(pack)
    const keep = { ...(instrument.bendRange != null ? { bendRange: instrument.bendRange } : {}), ...(instrument.modDest ? { modDest: instrument.modDest } : {}) }
    packSelect.onchange = () => {
      const [id, version] = packSelect.value.split('@')
      const next = packs.find(item => item.id === id && item.version === version)
      const patch = manifestOf(next)?.patches?.[0]
      if (next && patch) this.choosePatch(next, patch, instrument.programFollow || 'pinned', keep)
    }
    if (!manifest) {
      this.bodyEl.append(field('Pack', packSelect), note(`Missing pack ${instrument.packId}@${instrument.packVersion}. Import it again to restore audio.`))
      return
    }

    const current = manifest.patches.find(item => item.id === instrument.patchId) || manifest.patches[0]
    const bank = document.createElement('select')
    for (const address of new Map(manifest.patches.map(patch => [bankKey(patch.address), patch.address])).values()) {
      option(bank, bankKey(address), address.bankMsb === 0 && address.bankLsb === 0 ? 'GM Main · 0:0' : `Bank ${address.bankMsb}:${address.bankLsb}`)
    }
    bank.value = bankKey(current.address)

    const program = document.createElement('select')
    const fillPrograms = () => {
      program.innerHTML = ''
      for (const patch of manifest.patches.filter(item => bankKey(item.address) === bank.value)) {
        option(program, patch.id, `${String(patch.address.program).padStart(3, '0')} · ${patch.name}`)
      }
      program.value = current.id
      if (program.selectedIndex < 0) program.selectedIndex = 0
    }
    fillPrograms()
    const chosen = () => manifest.patches.find(item => item.id === program.value) || current
    bank.onchange = () => { fillPrograms(); this.choosePatch(pack, chosen(), instrument.programFollow || 'pinned', keep) }
    program.onchange = () => this.choosePatch(pack, chosen(), instrument.programFollow || 'pinned', keep)

    const follow = document.createElement('input')
    follow.type = 'checkbox'
    follow.checked = instrument.programFollow !== 'pinned'
    follow.onchange = () => this.choosePatch(pack, chosen(), follow.checked ? 'midi' : 'pinned', keep)

    this.bodyEl.append(
      field('Pack', packSelect), field('Bank', bank), field('Program', program),
      check('Follow incoming program changes', follow),
      note(`Licence: ${manifest.license?.spdx || 'unknown'} · ${manifest.license?.noticeFile || 'no notice file'}`),
      note(`${manifest.patches.length} patches · ${sampleWeight(manifest)} samples`),
    )
    if (instrument.received) {
      this.bodyEl.append(note(`Last received: bank ${instrument.received.bankMsb}:${instrument.received.bankLsb} program ${instrument.received.program}`))
    }
  }

  // ── MIDI ─────────────────────────────────────────────────────────────────
  renderMidi(track) {
    const channel = document.createElement('select')
    option(channel, '', 'Omni')
    for (let value = 0; value < 16; value++) option(channel, String(value), `Channel ${value + 1}${value === 9 ? ' · Drums' : ''}`)
    channel.value = track.midiChannel ?? ''
    channel.onchange = () => this.deps.store.dispatch(SetTrackMidiChannel(track.id, channel.value === '' ? null : Number(channel.value)))
    this.bodyEl.append(field('Input', channel), note('Omni plays every channel unless another track claims one.'))
  }

  // ── Expression ───────────────────────────────────────────────────────────
  renderExpression(instrument) {
    const bend = document.createElement('input')
    bend.type = 'number'
    bend.min = '0'; bend.max = '24'; bend.step = '1'
    bend.value = String(instrument.bendRange ?? 2)
    bend.onchange = () => this.set({ ...instrument, bendRange: Math.min(24, Math.max(0, Number(bend.value) || 0)) })

    const mod = document.createElement('select')
    for (const [value, label] of MOD_DESTS) option(mod, value, label)
    mod.value = instrument.modDest || 'default'
    mod.onchange = () => this.set({ ...instrument, modDest: mod.value })

    this.bodyEl.append(
      field('Bend ±', bend), field('Mod wheel', mod),
      note('Engine default is vibrato on packs, filter or FM depth on internal engines.'),
    )
  }

  // ── Output ───────────────────────────────────────────────────────────────
  renderOutput(track) {
    const state = this.deps.store.getState()
    const channel = state.mixer.channels.find(item => item.id === track.mixerChannelId)
    if (!channel) { this.bodyEl.append(note('This track has no mixer channel.')); return }
    const send = (param, value) => document.dispatchEvent(new CustomEvent('mixer-param', { detail: { channelId: channel.id, param, value } }))

    const volume = document.createElement('input')
    volume.type = 'range'; volume.min = '0'; volume.max = '1.5'; volume.step = '0.01'
    volume.value = String(channel.volume ?? 1)
    volume.oninput = () => send('volume', Number(volume.value))

    const pan = document.createElement('input')
    pan.type = 'range'; pan.min = '-1'; pan.max = '1'; pan.step = '0.01'
    pan.value = String(channel.pan ?? 0)
    pan.oninput = () => send('pan', Number(pan.value))

    this.bodyEl.append(note(`Mixer channel: ${channel.id}`), field('Level', volume), field('Pan', pan))
  }
}
