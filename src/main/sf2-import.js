// Small, deliberately conservative SF2 reader for the import path. It reads
// uncompressed 16-bit SoundFont 2 files and converts their playable zones to
// Synth's manifest + ordinary WAV samples; it is not a SoundFont runtime.

const text = (view, off, len) => {
  let value = ''
  for (let i = 0; i < len; i++) value += String.fromCharCode(view.getUint8(off + i))
  return value
}
const name = (view, off, len) => text(view, off, len).replace(/\0.*$/, '').trim()
const fail = message => { throw new Error(`Invalid SF2: ${message}`) }
const idFor = (value, fallback) => (value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback

function chunks(view, start, end) {
  const found = []
  for (let at = start; at < end;) {
    if (at + 8 > end) fail('truncated chunk header')
    const id = text(view, at, 4), size = view.getUint32(at + 4, true), data = at + 8, next = data + size + (size & 1)
    if (next > end) fail(`truncated ${id} chunk`)
    found.push({ id, data, size })
    at = next
  }
  return found
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

export function encodePcmWav(samples, sampleRate) {
  if (!(samples instanceof Int16Array) || !Number.isInteger(sampleRate) || sampleRate < 4000 || sampleRate > 192000) fail('invalid PCM sample')
  const wav = new ArrayBuffer(44 + samples.byteLength), view = new DataView(wav)
  const write = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)) }
  write(0, 'RIFF'); view.setUint32(4, 36 + samples.byteLength, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.byteLength, true)
  new Int16Array(wav, 44).set(samples)
  return wav
}

/** Parse only standard PCM SF2 data. Throws before returning partial output. */
export function importSf2(input, { id, version = '1.0.0', license = { spdx: 'LicenseRef-Imported', noticeFile: 'NOTICE.txt' } } = {}) {
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
  const infoChunks = byId(info), dataChunks = byId(sdta), tables = byId(pdta)
  const smpl = dataChunks.smpl
  if (!smpl || smpl.size % 2) fail('missing or malformed smpl')
  const phdr = records(view, tables.phdr, 38, 'phdr'), pbag = records(view, tables.pbag, 4, 'pbag'), pgen = records(view, tables.pgen, 4, 'pgen')
  const inst = records(view, tables.inst, 22, 'inst'), ibag = records(view, tables.ibag, 4, 'ibag'), igen = records(view, tables.igen, 4, 'igen'), shdr = records(view, tables.shdr, 46, 'shdr')
  if (phdr.length < 2 || inst.length < 2 || shdr.length < 2 || !pbag.length || !ibag.length) fail('missing terminal records')
  const presetBags = pbag.map(at => ({ gen: view.getUint16(at, true) })), instrumentBags = ibag.map(at => ({ gen: view.getUint16(at, true) }))
  if (presetBags.some(b => b.gen > pgen.length) || instrumentBags.some(b => b.gen > igen.length)) fail('bag generator index out of range')
  const samples = shdr.slice(0, -1).map(at => ({
    name: name(view, at, 20), start: view.getUint32(at + 20, true), end: view.getUint32(at + 24, true), loopStart: view.getUint32(at + 28, true), loopEnd: view.getUint32(at + 32, true), rate: view.getUint32(at + 36, true), rootKey: view.getUint8(at + 40), pitchCorrection: view.getInt8(at + 41), type: view.getUint16(at + 44, true)
  }))
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset + smpl.data, smpl.size / 2)
  const emitted = new Map()
  const sampleFor = index => {
    const sample = samples[index]
    if (!sample) fail('sample index out of range')
    if (sample.type !== 1) fail(`unsupported non-mono sample ${sample.name || index}`)
    if (!sample.rate || sample.start >= sample.end || sample.end > pcm.length || sample.loopStart < sample.start || sample.loopEnd > sample.end || sample.loopStart > sample.loopEnd) fail(`invalid sample bounds ${sample.name || index}`)
    if (!emitted.has(index)) {
      const sampleId = `${idFor(sample.name, `sample-${index}`)}-${index}`
      emitted.set(index, { id: sampleId, wav: encodePcmWav(pcm.slice(sample.start, sample.end), sample.rate), sample })
    }
    return emitted.get(index)
  }
  const patches = []
  for (let p = 0; p < phdr.length - 1; p++) {
    const at = phdr[p], first = view.getUint16(at + 24, true), last = view.getUint16(phdr[p + 1] + 24, true)
    if (first > last || last > presetBags.length) fail('preset bag index out of range')
    const zones = []
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
        const found = sampleFor(sampleIndex), sample = found.sample
        const rootKey = g.get(58) ?? sample.rootKey
        if (rootKey > 127) fail('invalid root key')
        const loop = (g.get(54) ?? 0) & 1
        const attenuation = g.get(48) ?? 0 // SoundFont centibels.
        zones.push({ keyLo: key[0], keyHi: key[1], velocityLo: velocity[0], velocityHi: velocity[1], rootKey, sampleId: found.id, tune: (g.get(51) ?? 0) * 100 + (g.get(52) ?? 0) + sample.pitchCorrection, gain: Math.pow(10, -attenuation / 200), ...(loop ? { loopStart: sample.loopStart - sample.start, loopEnd: sample.loopEnd - sample.start } : {}) })
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
  if (!patches.length) fail('no playable PCM preset zones')
  const sourceName = infoChunks.INAM ? name(view, infoChunks.INAM.data, infoChunks.INAM.size) : 'Imported SoundFont'
  const packId = idFor(id || sourceName, 'imported-sf2')
  return { manifest: { schemaVersion: 1, id: packId, version, name: sourceName, license, source: { format: 'sf2', name: sourceName }, patches }, samples: [...emitted.values()].map(({ id: sampleId, wav }) => ({ id: sampleId, wav })) }
}
