import { describe, expect, it } from 'vitest'
import { encodePcmWav, importSf2 } from '../src/shared/sf2-import.js'
import { validatePackManifest } from '../src/renderer/js/instruments/pack-registry.js'
import { parseSf2Message } from '../src/renderer/js/workers/sf2-worker.js'

const fourCC = (value) => [...value].map(c => c.charCodeAt(0))
const u16 = value => [value & 255, value >>> 8]
const u32 = value => [value & 255, value >>> 8, value >>> 16, value >>> 24]
const str = (value, length) => [...value.slice(0, length), ...'\0'.repeat(length)].slice(0, length).map(c => c.charCodeAt(0))
const chunk = (id, data) => {
  const flat = data.flat(Infinity)
  return [...fourCC(id), ...u32(flat.length), ...flat, ...(flat.length & 1 ? [0] : [])]
}
const list = (type, children) => chunk('LIST', [...fourCC(type), ...children.flat(Infinity)])
const record = (name, ...data) => [...str(name, 20), ...data.flat()]

function fixture({ envelope = false, sampleType = 1, raw = null } = {}) {
  const info = list('INFO', [chunk('ifil', [...u16(2), ...u16(1)]), chunk('INAM', str('Tiny Piano', 11))])
  const pcm = new Int16Array([100, -200, 300, -400])
  const sampleBytes = raw || [...new Uint8Array(pcm.buffer)]
  const end = raw ? raw.length : 4
  const sdta = list('sdta', [chunk('smpl', sampleBytes)])
  const phdr = chunk('phdr', [record('Piano', u16(0), u16(0), u16(0), u32(0), u32(0), u32(0)), record('EOP', u16(0), u16(0), u16(1), u32(0), u32(0), u32(0))])
  const pbag = chunk('pbag', [...u16(0), ...u16(0), ...u16(1), ...u16(0)])
  const pgen = chunk('pgen', [...u16(41), ...u16(0)])
  const inst = chunk('inst', [record('Piano Inst', u16(0)), record('EOI', u16(1))])
  const generatorRows = [...u16(43), 60, 72, ...u16(44), 10, 120, ...(envelope ? [...u16(34), ...u16(0), ...u16(37), ...u16(600)] : []), ...u16(53), ...u16(0)]
  const ibag = chunk('ibag', [...u16(0), ...u16(0), ...u16(envelope ? 5 : 3), ...u16(0)])
  const igen = chunk('igen', generatorRows)
  const shdr = chunk('shdr', [record('Piano C4', u32(0), u32(end), u32(1), u32(3), u32(44100), 60, 0, u16(0), u16(sampleType)), record('EOS', u32(end), u32(end), u32(end), u32(end), u32(0), 0, 0, u16(0), u16(1))])
  const pdta = list('pdta', [phdr, pbag, pgen, inst, ibag, igen, shdr])
  const body = [...fourCC('sfbk'), ...info, ...sdta, ...pdta]
  return new Uint8Array([...fourCC('RIFF'), ...u32(body.length), ...body])
}

/** One instrument, two zones over the same range: a linked left/right pair. */
function stereoFixture({ link = [1, 0], rates = [44100, 44100], lengths = [4, 4] } = {}) {
  const info = list('INFO', [chunk('ifil', [...u16(2), ...u16(1)]), chunk('INAM', str('Tiny Stereo', 11))])
  const frames = new Int16Array([100, 200, 300, 400, -100, -200, -300, -400])
  const sdta = list('sdta', [chunk('smpl', [...new Uint8Array(frames.buffer)])])
  const phdr = chunk('phdr', [record('Pad', u16(0), u16(0), u16(0), u32(0), u32(0), u32(0)), record('EOP', u16(0), u16(0), u16(1), u32(0), u32(0), u32(0))])
  const pbag = chunk('pbag', [...u16(0), ...u16(0), ...u16(1), ...u16(0)])
  const pgen = chunk('pgen', [...u16(41), ...u16(0)])
  const inst = chunk('inst', [record('Pad Inst', u16(0)), record('EOI', u16(2))])
  const zone = index => [...u16(43), 60, 72, ...u16(53), ...u16(index)]
  const igen = chunk('igen', [...zone(0), ...zone(1)])
  const ibag = chunk('ibag', [...u16(0), ...u16(0), ...u16(2), ...u16(0), ...u16(4), ...u16(0)])
  const shdr = chunk('shdr', [
    record('PadL', u32(0), u32(lengths[0]), u32(0), u32(0), u32(rates[0]), 60, 0, u16(link[0]), u16(4)),
    record('PadR', u32(4), u32(4 + lengths[1]), u32(0), u32(0), u32(rates[1]), 60, 0, u16(link[1]), u16(2)),
    record('EOS', u32(8), u32(8), u32(8), u32(8), u32(0), 0, 0, u16(0), u16(1))
  ])
  const body = [...fourCC('sfbk'), ...info, ...sdta, ...list('pdta', [phdr, pbag, pgen, inst, ibag, igen, shdr])]
  return new Uint8Array([...fourCC('RIFF'), ...u32(body.length), ...body])
}

describe('SF2 importer', () => {
  it('converts a valid PCM preset into a Synth manifest and WAV', () => {
    const result = importSf2(fixture(), { id: 'tiny-piano' })
    expect(result.manifest).toMatchObject({ id: 'tiny-piano', name: 'Tiny Piano', patches: [{ address: { bankMsb: 0, bankLsb: 0, program: 0 }, zones: [{ keyLo: 60, keyHi: 72, velocityLo: 10, velocityHi: 120, rootKey: 60 }] }] })
    const wav = new DataView(result.samples[0].wav)
    expect(String.fromCharCode(...new Uint8Array(result.samples[0].wav, 0, 4))).toBe('RIFF')
    expect(wav.getUint32(40, true)).toBe(8)
    expect(new Int16Array(result.samples[0].wav, 44)).toEqual(new Int16Array([100, -200, 300, -400]))
    expect(validatePackManifest(result.manifest)).toEqual({ ok: true, errors: [] })
  })

  it('rejects truncated and structurally invalid files', () => {
    expect(() => importSf2(new Uint8Array([1, 2, 3]))).toThrow('Invalid SF2')
    const bad = fixture(); bad[0] = 0
    expect(() => importSf2(bad)).toThrow('not a RIFF')
  })

  it('writes a standard mono PCM WAV', () => {
    const wav = encodePcmWav(new Int16Array([1, -2]), 44100)
    expect(new DataView(wav).getUint32(40, true)).toBe(4)
    expect(new DataView(wav).getUint16(22, true)).toBe(1)
  })

  it('writes stereo WAV headers when given two channels', () => {
    const view = new DataView(encodePcmWav(new Int16Array([1, -2]), 44100, 2))
    expect(view.getUint16(22, true)).toBe(2)     // channels
    expect(view.getUint16(32, true)).toBe(4)     // block align
    expect(view.getUint32(28, true)).toBe(44100 * 4) // byte rate
    expect(() => encodePcmWav(new Int16Array([1]), 44100, 3)).toThrow('invalid channel count')
  })

  it('merges a linked stereo pair into one interleaved zone', () => {
    const result = importSf2(stereoFixture(), { id: 'tiny-stereo' })
    expect(result.samples).toHaveLength(1)
    expect(result.manifest.patches[0].zones).toHaveLength(1)
    const wav = new DataView(result.samples[0].wav)
    expect(wav.getUint16(22, true)).toBe(2)
    expect([...new Int16Array(result.samples[0].wav, 44)]).toEqual([100, -100, 200, -200, 300, -300, 400, -400])
    expect(validatePackManifest(result.manifest)).toEqual({ ok: true, errors: [] })
  })

  it('plays each side as mono when the stereo link is broken', () => {
    // Mismatched rates are a malformed link, not a stereo pair.
    const result = importSf2(stereoFixture({ rates: [44100, 22050] }), { id: 'broken-link' })
    expect(result.samples).toHaveLength(2)
    expect(result.manifest.patches[0].zones).toHaveLength(2)
    expect(new DataView(result.samples[0].wav).getUint16(22, true)).toBe(1)
  })

  it('pads the short side of an uneven stereo pair', () => {
    const result = importSf2(stereoFixture({ lengths: [4, 2] }), { id: 'uneven' })
    expect(result.samples).toHaveLength(1)
    expect([...new Int16Array(result.samples[0].wav, 44)]).toEqual([100, -100, 200, -200, 300, 0, 400, 0])
  })

  it('accepts the low sample rates real banks ship', () => {
    // Banks in the wild carry a stray ~3 kHz sample; it cost the whole import.
    expect(() => encodePcmWav(new Int16Array([1, -2]), 3608)).not.toThrow()
    expect(() => encodePcmWav(new Int16Array([1, -2]), 200)).toThrow('invalid PCM sample')
  })

  it('skips ROM samples rather than failing the whole bank', () => {
    // 0x8001 is romMonoSample: the audio lives in E-mu hardware, not the file.
    expect(() => importSf2(fixture({ sampleType: 0x8001 }))).toThrow('no playable preset zones')
  })

  it('passes SF3 Ogg Vorbis sample data through untouched', () => {
    const ogg = [...fourCC('OggS'), 0, 2, 0, 0, 0, 0, 0, 0]
    const result = importSf2(fixture({ sampleType: 1 | 0x10, raw: ogg }), { id: 'tiny-sf3' })
    expect(result.samples[0].ext).toBe('ogg')
    expect([...new Uint8Array(result.samples[0].wav)]).toEqual(ogg)
    expect(validatePackManifest(result.manifest)).toEqual({ ok: true, errors: [] })
  })

  it('preserves SF2 volume envelope generators for sampled playback', () => {
    const zone = importSf2(fixture({ envelope: true }), { id: 'tiny-piano' }).manifest.patches[0].zones[0]
    expect(zone.volumeEnvelope).toMatchObject({ attack: 1, sustain: 10 ** -3 })
  })

  it('posts back the message shape the browser importer expects', () => {
    const bytes = fixture().buffer
    const result = parseSf2Message({ id: 7, bytes, name: 'tiny-piano' })
    expect(result.type).toBe('done')
    expect(result.id).toBe(7)
    expect(result.manifest.id).toBe('tiny-piano')
    expect(result.samples.every(sample => typeof sample.id === 'string' && sample.wav instanceof ArrayBuffer)).toBe(true)
    // The importer transfers result.samples[].wav, so they must be real buffers.
    expect(validatePackManifest(result.manifest).ok).toBe(true)
  })

  it('reports a parse failure as an error message, never a throw', () => {
    expect(parseSf2Message({ id: 1, bytes: new Uint8Array([1, 2, 3]).buffer })).toMatchObject({ type: 'error', id: 1 })
  })
})

describe('imported packs carry GM fallbacks', () => {
  it('names a default melodic patch and a default drum patch', () => {
    const pack = importSf2(fixture(), { id: 'fallbacks' })
    expect(pack.manifest.defaultPatchId).toBeTruthy()
    expect(pack.manifest.patches.some(patch => patch.id === pack.manifest.defaultPatchId)).toBe(true)
    // A bank with no percussion preset must not claim a drum default it lacks.
    const percussion = pack.manifest.patches.filter(patch => patch.channelProfile === 'gm-percussion')
    if (percussion.length) expect(pack.manifest.defaultDrumPatchId).toBe(percussion[0].id)
    else expect(pack.manifest.defaultDrumPatchId).toBeUndefined()
  })
})
