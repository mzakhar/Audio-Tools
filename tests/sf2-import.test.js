import { describe, expect, it } from 'vitest'
import { encodePcmWav, importSf2 } from '../src/main/sf2-import.js'

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

function fixture() {
  const info = list('INFO', [chunk('ifil', [...u16(2), ...u16(1)]), chunk('INAM', str('Tiny Piano', 11))])
  const pcm = new Int16Array([100, -200, 300, -400])
  const sampleBytes = [...new Uint8Array(pcm.buffer)]
  const sdta = list('sdta', [chunk('smpl', sampleBytes)])
  const phdr = chunk('phdr', [record('Piano', u16(0), u16(0), u16(0), u32(0), u32(0), u32(0)), record('EOP', u16(0), u16(0), u16(1), u32(0), u32(0), u32(0))])
  const pbag = chunk('pbag', [...u16(0), ...u16(0), ...u16(1), ...u16(0)])
  const pgen = chunk('pgen', [...u16(41), ...u16(0)])
  const inst = chunk('inst', [record('Piano Inst', u16(0)), record('EOI', u16(1))])
  const ibag = chunk('ibag', [...u16(0), ...u16(0), ...u16(3), ...u16(0)])
  const igen = chunk('igen', [...u16(43), 60, 72, ...u16(44), 10, 120, ...u16(53), ...u16(0)])
  const shdr = chunk('shdr', [record('Piano C4', u32(0), u32(4), u32(1), u32(3), u32(44100), 60, 0, u16(0), u16(1)), record('EOS', u32(4), u32(4), u32(4), u32(4), u32(0), 0, 0, u16(0), u16(1))])
  const pdta = list('pdta', [phdr, pbag, pgen, inst, ibag, igen, shdr])
  const body = [...fourCC('sfbk'), ...info, ...sdta, ...pdta]
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
  })

  it('rejects truncated and structurally invalid files', () => {
    expect(() => importSf2(new Uint8Array([1, 2, 3]))).toThrow('Invalid SF2')
    const bad = fixture(); bad[0] = 0
    expect(() => importSf2(bad)).toThrow('not a RIFF')
  })

  it('writes a standard mono PCM WAV', () => {
    const wav = encodePcmWav(new Int16Array([1, -2]), 44100)
    expect(new DataView(wav).getUint32(40, true)).toBe(4)
  })
})
