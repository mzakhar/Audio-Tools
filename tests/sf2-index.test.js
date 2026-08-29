import { describe, expect, it } from 'vitest'
import { bankTitle, parseInfo, readBankIndex, withDisplayTitles } from '../src/shared/sf2-index.js'
import { chunk, fourCC, list, multiPresetFixture, str, u16, u32 } from './helpers/sf2-bytes.js'

/** A read() that answers from a buffer and records every range it was asked for. */
function reader(bytes) {
  const calls = []
  const read = async (offset, length) => {
    calls.push({ offset, length })
    return bytes.subarray(offset, Math.min(offset + length, bytes.byteLength))
  }
  return { read, calls, options: { fileName: 'two-presets.sf2', byteLength: bytes.byteLength } }
}

/** Byte range of a chunk's body, found by its fourCC. */
function bodyRange(bytes, id) {
  const needle = fourCC(id)
  for (let at = 0; at + 8 <= bytes.byteLength; at++) {
    if (needle.every((byte, i) => bytes[at + i] === byte)) {
      const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24)
      return { start: at + 8, end: at + 8 + size }
    }
  }
  throw new Error(`no ${id} chunk`)
}

const infoView = fields => {
  const bytes = new Uint8Array(list('INFO', Object.entries(fields).map(([id, value]) => chunk(id, str(value, value.length + 1)))))
  // A LIST chunk: header at 0, body (starting with the 'INFO' fourCC) at 8.
  return { view: new DataView(bytes.buffer), chunk: { data: 8, size: bytes.byteLength - 8 } }
}

describe('bankTitle', () => {
  it('keeps a real INAM', () => {
    expect(bankTitle({ name: 'Chorium Rev B' }, 'ChoriumRevB.sf2')).toBe('Chorium Rev B')
  })

  it('falls back to the filename when the name is blank or generic', () => {
    for (const name of ['', '   ', 'untitled', 'New SoundFont', 'soundfont', 'GM', 'default', 'Bank', 'User Bank']) {
      expect(bankTitle({ name }, 'ChoriumRevB.sf2')).toBe('ChoriumRevB')
    }
  })

  it('falls back to the filename when the name is really a file instruction', () => {
    // 62 real banks name themselves like this; the filename is the better title.
    expect(bankTitle({ name: 'sc-55.sf2' }, 'SC-55 v1.sf2')).toBe('SC-55 v1')
    expect(bankTitle({ name: '8mbgmgs.sf2, please use this filename.' }, '8MBGMGS.SF3')).toBe('8MBGMGS')
  })

  it('keeps the name when there is no filename to fall back to', () => {
    expect(bankTitle({ name: 'User Bank' }, '')).toBe('User Bank')
    expect(bankTitle(null, 'Nice Bank.sf2')).toBe('Nice Bank')
    expect(bankTitle({}, '')).toBe('')
  })
})

describe('parseInfo', () => {
  it('reads every field it knows and blanks the rest', () => {
    const { view, chunk: infoChunk } = infoView({ INAM: 'Two Presets', IENG: 'Someone', ICMT: 'A comment' })
    expect(parseInfo(view, infoChunk)).toEqual({ name: 'Two Presets', author: 'Someone', date: '', product: '', copyright: '', comment: 'A comment', software: '' })
  })

  it('trims and cuts each field at the first NUL', () => {
    const bytes = new Uint8Array(list('INFO', [chunk('INAM', [...str('Pad  ', 5), 0, ...str('junk', 4)])]))
    const info = parseInfo(new DataView(bytes.buffer), { data: 8, size: bytes.byteLength - 8 })
    expect(info.name).toBe('Pad')
  })

  it('throws on a missing INFO list', () => {
    expect(() => parseInfo(null, null)).toThrow('Invalid SF2')
  })
})

describe('readBankIndex', () => {
  it('returns the title, INFO fields and preset list', async () => {
    const bytes = multiPresetFixture({ info: { INAM: 'Two Presets', IENG: 'Someone', ICRD: '2026-08-29' } })
    const { read, options } = reader(bytes)
    const index = await readBankIndex(read, options)
    expect(index.title).toBe('Two Presets')
    expect(index.info).toMatchObject({ author: 'Someone', date: '2026-08-29', product: '' })
    // The terminal EOP record is not a preset.
    expect(index.presets).toEqual([
      { bank: 0, program: 0, name: 'Piano' },
      { bank: 128, program: 5, name: 'Kit' }
    ])
  })

  it('never reads the sample data', async () => {
    const bytes = multiPresetFixture()
    const { read, calls, options } = reader(bytes)
    await readBankIndex(read, options)
    const smpl = bodyRange(bytes, 'smpl')
    const overlapping = calls.filter(call => call.offset < smpl.end && call.offset + call.length > smpl.start)
    expect(overlapping).toEqual([])
    // Headers plus the two small LISTs: the cost does not track sample size.
    const total = calls.reduce((sum, call) => sum + call.length, 0)
    expect(total).toBeLessThanOrEqual(bytes.byteLength - (smpl.end - smpl.start))
  })

  it('titles a generic bank from its filename', async () => {
    const bytes = multiPresetFixture({ info: { INAM: 'User Bank' } })
    const { read } = reader(bytes)
    expect((await readBankIndex(read, { fileName: 'ChoriumRevB.sf2', byteLength: bytes.byteLength })).title).toBe('ChoriumRevB')
  })

  it('throws on a file that is not a SoundFont, so the scan can skip it', async () => {
    const junk = new Uint8Array([...fourCC('RIFF'), ...u32(4), ...fourCC('WAVE')])
    await expect(readBankIndex(reader(junk).read, { byteLength: junk.byteLength })).rejects.toThrow('not a RIFF sfbk')
    await expect(readBankIndex(reader(new Uint8Array(4)).read, { byteLength: 4 })).rejects.toThrow('Invalid SF2')
  })

  it('throws when pdta carries no phdr', async () => {
    const body = [...fourCC('sfbk'), ...list('INFO', [chunk('INAM', str('X', 2))]), ...list('sdta', [chunk('smpl', [0, 0])]), ...list('pdta', [chunk('pbag', [...u16(0), ...u16(0)])])]
    const bytes = new Uint8Array([...fourCC('RIFF'), ...u32(body.length), ...body])
    await expect(readBankIndex(reader(bytes).read, { byteLength: bytes.byteLength })).rejects.toThrow('malformed phdr')
  })
})

describe('display titles across a folder', () => {
  const bank = (title, author, fileName) => ({ title, fileName, info: { author } })

  it('leaves a title alone unless it actually collides', () => {
    const rows = withDisplayTitles([bank('Chorium', 'openwrld', 'a.sf2'), bank('Merlin', 'Tim', 'b.sf2')])
    expect(rows.map(row => row.title)).toEqual(['Chorium', 'Merlin'])
  })

  it('disambiguates a collision with the author', () => {
    const rows = withDisplayTitles([bank('User Bank', 'Ann', 'a.sf2'), bank('User Bank', 'Bob', 'b.sf2')])
    expect(rows.map(row => row.title)).toEqual(['User Bank — Ann', 'User Bank — Bob'])
  })

  it('falls back to the filename when the author collides too', () => {
    // Real case: two banks in the collection share a title AND an author, so
    // suffixing the author leaves two rows a person cannot tell apart.
    const rows = withDisplayTitles([bank('General Midi', 'Yanick', 'x.sf2'), bank('General Midi', 'Yanick', 'y.sf2')])
    expect(rows.map(row => row.title)).toEqual(['General Midi — x.sf2', 'General Midi — y.sf2'])
    expect(new Set(rows.map(row => row.title)).size).toBe(2)
  })

  it('uses the filename for a colliding bank that has no author', () => {
    const rows = withDisplayTitles([bank('GM', '', 'a.sf2'), bank('GM', 'Bob', 'b.sf2')])
    expect(rows.map(row => row.title)).toEqual(['GM — a.sf2', 'GM — Bob'])
  })
})

describe('names that cannot be decoded', () => {
  const high = codes => codes.map(code => String.fromCharCode(code)).join('')

  it('prefers the filename over a name that is mojibake', () => {
    // A GBK bank name read as Latin-1: a run of high bytes, no way to recover it
    // without an encoding table. 13 of 500 real banks look like this.
    const garbled = high([0xb6, 0xcc, 0xb8, 0xe8]) + ' Grand GM'
    expect(bankTitle({ name: garbled }, 'DGX 62M GM.sf2')).toBe('DGX 62M GM')
  })

  it('keeps an accented European name', () => {
    // One or two high characters are a real name, not a decoding failure.
    expect(bankTitle({ name: 'Bj' + high([0xf6]) + 'rn Piano' }, 'x.sf2')).toBe('Bj' + high([0xf6]) + 'rn Piano')
  })
})
