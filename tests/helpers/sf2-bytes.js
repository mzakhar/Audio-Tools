// RIFF byte builders shared by the SF2 import and index tests. Plain arrays of
// byte values; every builder returns one so they nest by spreading.

export const fourCC = (value) => [...value].map(c => c.charCodeAt(0))
export const u16 = value => [value & 255, value >>> 8]
export const u32 = value => [value & 255, value >>> 8, value >>> 16, value >>> 24]
export const str = (value, length) => [...value.slice(0, length), ...'\0'.repeat(length)].slice(0, length).map(c => c.charCodeAt(0))
export const chunk = (id, data) => {
  const flat = data.flat(Infinity)
  return [...fourCC(id), ...u32(flat.length), ...flat, ...(flat.length & 1 ? [0] : [])]
}
export const list = (type, children) => chunk('LIST', [...fourCC(type), ...children.flat(Infinity)])
export const record = (name, ...data) => [...str(name, 20), ...data.flat()]

/**
 * Two presets, one instrument and one sample each, so a per-preset import has
 * something to leave behind. `info` overrides the INFO fields.
 */
export function multiPresetFixture({ info = { INAM: 'Two Presets' } } = {}) {
  const infoList = list('INFO', [chunk('ifil', [...u16(2), ...u16(1)]), ...Object.entries(info).map(([id, value]) => chunk(id, str(value, value.length + 1)))])
  const frames = new Int16Array([100, 200, 300, 400, -100, -200, -300, -400])
  const sdta = list('sdta', [chunk('smpl', [...new Uint8Array(frames.buffer)])])
  const phdr = chunk('phdr', [
    record('Piano', u16(0), u16(0), u16(0), u32(0), u32(0), u32(0)),
    record('Kit', u16(5), u16(128), u16(1), u32(0), u32(0), u32(0)),
    record('EOP', u16(0), u16(0), u16(2), u32(0), u32(0), u32(0))
  ])
  const pbag = chunk('pbag', [...u16(0), ...u16(0), ...u16(1), ...u16(0), ...u16(2), ...u16(0)])
  const pgen = chunk('pgen', [...u16(41), ...u16(0), ...u16(41), ...u16(1)])
  const inst = chunk('inst', [record('Piano Inst', u16(0)), record('Kit Inst', u16(1)), record('EOI', u16(2))])
  const zone = (lo, hi, sample) => [...u16(43), lo, hi, ...u16(53), ...u16(sample)]
  const igen = chunk('igen', [...zone(60, 72, 0), ...zone(36, 47, 1)])
  const ibag = chunk('ibag', [...u16(0), ...u16(0), ...u16(2), ...u16(0), ...u16(4), ...u16(0)])
  const shdr = chunk('shdr', [
    record('Piano C4', u32(0), u32(4), u32(0), u32(0), u32(44100), 60, 0, u16(0), u16(1)),
    record('Kick', u32(4), u32(8), u32(0), u32(0), u32(44100), 36, 0, u16(0), u16(1)),
    record('EOS', u32(8), u32(8), u32(8), u32(8), u32(0), 0, 0, u16(0), u16(1))
  ])
  const body = [...fourCC('sfbk'), ...infoList, ...sdta, ...list('pdta', [phdr, pbag, pgen, inst, ibag, igen, shdr])]
  return new Uint8Array([...fourCC('RIFF'), ...u32(body.length), ...body])
}
