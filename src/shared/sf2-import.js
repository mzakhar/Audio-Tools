// Small, deliberately conservative SF2 reader for the import path. It reads
// 16-bit SoundFont 2 files and SF3 files (Ogg Vorbis sample data) and converts
// their playable zones to Synth's manifest + ordinary audio samples; it is not
// a SoundFont runtime.
//
// A zone the reader cannot honour is dropped, not fatal: one ROM reference or
// one malformed sample must never cost a bank its other five hundred presets.

import { chunks, fail, name, text } from './riff.js'
import { bankTitle, packIdForBank, parseInfo } from './sf2-index.js'

// sfSampleType: 1 mono, 2 right, 4 left, 8 linked. 0x10 marks SF3 Ogg Vorbis
// data; 0x8000 marks a sample that lives in E-mu ROM and not in this file.
const RIGHT_SAMPLE = 2, LEFT_SAMPLE = 4, OGG_SAMPLE = 0x10, ROM_SAMPLE = 0x8000
// The SF2 spec's own recommended floor. Real banks ship samples near 3 kHz, and
// a rate outside this range costs that one sample, never the import.
const MIN_RATE = 400, MAX_RATE = 192000
const usableRate = rate => Number.isInteger(rate) && rate >= MIN_RATE && rate <= MAX_RATE

const idFor = (value, fallback) => (value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback
const signed16 = value => value > 0x7fff ? value - 0x10000 : value
const timecentsToSeconds = value => {
  const seconds = Math.pow(2, signed16(value) / 1200)
  return Number.isFinite(seconds) ? Math.min(20, seconds) : 0
}

function volumeEnvelope(g) {
  if (![33, 34, 35, 36, 37, 38].some(op => g.has(op))) return null
  return {
    delay: timecentsToSeconds(g.get(33) ?? 0xd120),
    attack: timecentsToSeconds(g.get(34) ?? 0xd120),
    hold: timecentsToSeconds(g.get(35) ?? 0xd120),
    decay: timecentsToSeconds(g.get(36) ?? 0xd120),
    sustain: Math.pow(10, -Math.max(0, g.get(37) ?? 0) / 200),
    release: timecentsToSeconds(g.get(38) ?? 0xd120)
  }
}

function records(view, chunk, size, label) {
  if (!chunk || chunk.size % size) fail(`missing or malformed ${label}`)
  return Array.from({ length: chunk.size / size }, (_, i) => chunk.data + i * size)
}

function generators(view, list, start, end) {
  const out = new Map()
  for (let i = start; i < end; i++) {
    const at = list[i]
    if (at === undefined) fail('generator index out of range')
    const op = view.getUint16(at, true)
    if (!out.has(op)) out.set(op, view.getUint16(at + 2, true))
  }
  return out
}

function range(value) { return value === undefined ? [0, 127] : [value & 255, value >>> 8] }
function mergeRanges(a, b) { return [Math.max(a[0], b[0]), Math.min(a[1], b[1])] }

export function encodePcmWav(samples, sampleRate, channels = 1) {
  if (!(samples instanceof Int16Array) || !usableRate(sampleRate)) fail('invalid PCM sample')
  if (channels !== 1 && channels !== 2) fail('invalid channel count')
  const wav = new ArrayBuffer(44 + samples.byteLength), view = new DataView(wav)
  const write = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)) }
  write(0, 'RIFF'); view.setUint32(4, 36 + samples.byteLength, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2 * channels, true); view.setUint16(32, 2 * channels, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.byteLength, true)
  new Int16Array(wav, 44).set(samples)
  return wav
}

/** Parse SF2 (16-bit PCM) or SF3 (Ogg Vorbis) sample data into one pack. */
export function importSf2(input, { id, version = '1.0.0', presets = null, license = { spdx: 'LicenseRef-Imported', noticeFile: 'NOTICE.txt' } } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < 12) fail('file is too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (text(view, 0, 4) !== 'RIFF' || text(view, 8, 4) !== 'sfbk') fail('not a RIFF sfbk file')
  const riffEnd = view.getUint32(4, true) + 8
  if (riffEnd !== bytes.byteLength) fail('RIFF size mismatch')
  const lists = chunks(view, 12, riffEnd).filter(c => c.id === 'LIST').map(c => ({ ...c, type: text(view, c.data, 4), children: chunks(view, c.data + 4, c.data + c.size) }))
  const info = lists.find(l => l.type === 'INFO'), sdta = lists.find(l => l.type === 'sdta'), pdta = lists.find(l => l.type === 'pdta')
  if (!info || !sdta || !pdta) fail('missing INFO, sdta, or pdta list')
  const byId = list => Object.fromEntries(list.children.map(c => [c.id, c]))
  const dataChunks = byId(sdta), tables = byId(pdta)
  const smpl = dataChunks.smpl
  if (!smpl) fail('missing smpl')
  const phdr = records(view, tables.phdr, 38, 'phdr'), pbag = records(view, tables.pbag, 4, 'pbag'), pgen = records(view, tables.pgen, 4, 'pgen')
  const inst = records(view, tables.inst, 22, 'inst'), ibag = records(view, tables.ibag, 4, 'ibag'), igen = records(view, tables.igen, 4, 'igen'), shdr = records(view, tables.shdr, 46, 'shdr')
  if (phdr.length < 2 || inst.length < 2 || shdr.length < 2 || !pbag.length || !ibag.length) fail('missing terminal records')
  const presetBags = pbag.map(at => ({ gen: view.getUint16(at, true) })), instrumentBags = ibag.map(at => ({ gen: view.getUint16(at, true) }))
  if (presetBags.some(b => b.gen > pgen.length) || instrumentBags.some(b => b.gen > igen.length)) fail('bag generator index out of range')
  const samples = shdr.slice(0, -1).map(at => ({
    name: name(view, at, 20), start: view.getUint32(at + 20, true), end: view.getUint32(at + 24, true), loopStart: view.getUint32(at + 28, true), loopEnd: view.getUint32(at + 32, true), rate: view.getUint32(at + 36, true), rootKey: view.getUint8(at + 40), pitchCorrection: view.getInt8(at + 41), link: view.getUint16(at + 42, true), type: view.getUint16(at + 44, true)
  }))
  // smpl carries 16-bit frames in SF2 and whole Ogg streams in SF3, so it is a
  // frame array only when its byte length actually divides into frames.
  const pcm = smpl.size % 2 ? null : new Int16Array(bytes.buffer, bytes.byteOffset + smpl.data, smpl.size / 2)
  const kindOf = sample => sample.type & ~(ROM_SAMPLE | OGG_SAMPLE)
  /** The sample record when its bytes are actually in this file, else null. */
  const playable = index => {
    const sample = samples[index]
    if (!sample || !usableRate(sample.rate) || (sample.type & ROM_SAMPLE)) return null
    // SF3 start/end are byte offsets of an Ogg stream inside smpl, and its loop
    // points are frames relative to the sample rather than absolute.
    if (sample.type & OGG_SAMPLE) return sample.start < sample.end && sample.end <= smpl.size ? sample : null
    return pcm && sample.start < sample.end && sample.end <= pcm.length ? sample : null
  }
  // Junk loop points are common and cost the sample only its loop, not its zone.
  const hasLoop = sample => sample.loopEnd > sample.loopStart &&
    ((sample.type & OGG_SAMPLE) || (sample.loopStart >= sample.start && sample.loopEnd <= sample.end))
  /** Index of the uncompressed other half of a stereo pair, else -1. */
  const stereoPartner = index => {
    const sample = samples[index], kind = kindOf(sample)
    if ((kind !== LEFT_SAMPLE && kind !== RIGHT_SAMPLE) || (sample.type & OGG_SAMPLE) || sample.link === index) return -1
    const other = playable(sample.link)
    if (!other || kindOf(other) !== (kind === LEFT_SAMPLE ? RIGHT_SAMPLE : LEFT_SAMPLE)) return -1
    // A mismatched rate is a broken link, not a pair; play that side as mono.
    return other.rate === sample.rate ? sample.link : -1
  }
  const interleave = (sample, partner) => {
    const mine = pcm.slice(sample.start, sample.end)
    if (!partner) return mine
    const theirs = pcm.slice(partner.start, partner.end)
    const left = kindOf(sample) === LEFT_SAMPLE ? mine : theirs, right = left === mine ? theirs : mine
    // Real pairs are sometimes a few frames apart; the short side pads with silence.
    const frames = Math.max(left.length, right.length)
    const out = new Int16Array(frames * 2)
    for (let i = 0; i < frames; i++) { out[i * 2] = left[i] || 0; out[i * 2 + 1] = right[i] || 0 }
    return out
  }
  const emitted = new Map()
  const sampleFor = index => {
    const sample = playable(index)
    if (!sample) return null
    // A stereo pair is stored as two mono runs, and zoneFor() plays only the
    // first matching zone — interleaving here is what makes both sides audible.
    const partner = stereoPartner(index)
    const key = partner < 0 ? index : Math.min(index, partner)
    if (!emitted.has(key)) {
      const sampleId = `${idFor(sample.name, `sample-${key}`)}-${key}`
      const compressed = sample.type & OGG_SAMPLE
      const wav = compressed
        ? bytes.slice(smpl.data + sample.start, smpl.data + sample.end).buffer
        : encodePcmWav(interleave(sample, partner < 0 ? null : samples[partner]), sample.rate, partner < 0 ? 1 : 2)
      emitted.set(key, { id: sampleId, wav, ext: compressed ? 'ogg' : 'wav', sample })
    }
    return emitted.get(key)
  }
  const loopSeconds = (sample, frame) => ((sample.type & OGG_SAMPLE) ? frame : frame - sample.start) / sample.rate
  // Per-preset import is just a skip: sample emission keys off the zones that
  // were kept, so the emitted sample set shrinks with the preset list.
  const wanted = Array.isArray(presets) ? new Set(presets) : null
  const patches = []
  for (let p = 0; p < phdr.length - 1; p++) {
    if (wanted && !wanted.has(p)) continue
    const at = phdr[p], first = view.getUint16(at + 24, true), last = view.getUint16(phdr[p + 1] + 24, true)
    if (first > last || last > presetBags.length) fail('preset bag index out of range')
    const zones = [], seen = new Set()
    let presetGlobal = new Map()
    for (let b = first; b < last; b++) {
      const next = b + 1 < presetBags.length ? presetBags[b + 1].gen : pgen.length
      const pg = generators(view, pgen, presetBags[b].gen, next), instrument = pg.get(41)
      if (instrument === undefined) { presetGlobal = new Map([...presetGlobal, ...pg]); continue }
      if (instrument >= inst.length - 1) fail('instrument index out of range')
      const ia = inst[instrument], ifirst = view.getUint16(ia + 20, true), ilast = view.getUint16(inst[instrument + 1] + 20, true)
      if (ifirst > ilast || ilast > instrumentBags.length) fail('instrument bag index out of range')
      let instrumentGlobal = new Map()
      for (let ib = ifirst; ib < ilast; ib++) {
        const inext = ib + 1 < instrumentBags.length ? instrumentBags[ib + 1].gen : igen.length
        const ig = generators(view, igen, instrumentBags[ib].gen, inext), sampleIndex = ig.get(53)
        if (sampleIndex === undefined) { instrumentGlobal = new Map([...instrumentGlobal, ...ig]); continue }
        const g = new Map([...presetGlobal, ...pg, ...instrumentGlobal, ...ig])
        const key = mergeRanges(range(pg.get(43)), range(ig.get(43))), velocity = mergeRanges(range(pg.get(44)), range(ig.get(44)))
        if (key[0] > key[1] || velocity[0] > velocity[1]) continue
        const found = sampleFor(sampleIndex)
        if (!found) continue
        const sample = found.sample
        const rootKey = g.get(58) ?? sample.rootKey
        if (rootKey > 127) continue
        // Merging a stereo pair leaves its second zone pointing at the same
        // interleaved sample over the same range, where it can never be picked.
        const identity = `${found.id}:${key[0]}:${key[1]}:${velocity[0]}:${velocity[1]}`
        if (seen.has(identity)) continue
        seen.add(identity)
        const loop = ((g.get(54) ?? 0) & 1) && hasLoop(sample)
        const attenuation = g.get(48) ?? 0 // SoundFont centibels.
        const envelope = volumeEnvelope(g)
        zones.push({ keyLo: key[0], keyHi: key[1], velocityLo: velocity[0], velocityHi: velocity[1], rootKey, sampleId: found.id, tune: signed16(g.get(51) ?? 0) * 100 + signed16(g.get(52) ?? 0) + sample.pitchCorrection, gain: Math.pow(10, -attenuation / 200), ...(envelope ? { volumeEnvelope: envelope } : {}), ...(loop ? { loopStart: loopSeconds(sample, sample.loopStart), loopEnd: loopSeconds(sample, sample.loopEnd) } : {}) })
      }
    }
    if (zones.length) {
      const bank = view.getUint16(at + 22, true)
      patches.push({
        id: `sf2-${p}`,
        address: { bankMsb: 0, bankLsb: bank === 128 ? 0 : bank, program: view.getUint16(at + 20, true) },
        ...(bank === 128 ? { channelProfile: 'gm-percussion' } : {}),
        name: name(view, at, 20) || `Preset ${p}`,
        kind: 'sample', zones
      })
    }
  }
  if (!patches.length) fail('no playable preset zones')
  const bankInfo = parseInfo(view, info)
  const sourceName = bankInfo.name || 'Imported SoundFont'
  // INAM collides across 101 of 500 real banks, so identity stays the filename.
  const packId = packIdForBank(id || sourceName)
  const title = bankTitle(bankInfo, id) || sourceName
  // Fallbacks for a program change that names an address this bank does not
  // have: without them an unmapped program resolves to nothing and plays
  // silence. Prefer GM program 0, else simply the first patch of each kind.
  const melodic = patches.filter(patch => patch.channelProfile !== 'gm-percussion')
  const percussion = patches.filter(patch => patch.channelProfile === 'gm-percussion')
  const defaultPatchId = (melodic.find(patch => patch.address.program === 0 && patch.address.bankLsb === 0) || melodic[0] || patches[0]).id
  const defaultDrumPatchId = percussion[0]?.id
  return { manifest: { schemaVersion: 1, id: packId, version, name: title, license, source: { format: 'sf2', name: sourceName, info: bankInfo }, defaultPatchId, ...(defaultDrumPatchId ? { defaultDrumPatchId } : {}), patches }, samples: [...emitted.values()].map(({ id: sampleId, wav, ext }) => ({ id: sampleId, wav, ext })) }
}
