// Reads what a SoundFont bank *is* without reading what it sounds like: title,
// INFO fields and the preset list, from a few kilobytes of a file that may be
// 1.9 GB. Everything here is metadata; sdta is never touched.
//
// readBankIndex() takes a positional read function rather than a buffer so the
// Electron side can seek past sdta instead of loading it.

import { chunks, fail, name, text } from './riff.js'

const INFO_FIELDS = { INAM: 'name', IENG: 'author', ICRD: 'date', IPRD: 'product', ICOP: 'copyright', ICMT: 'comment', ISFT: 'software' }
const EMPTY_INFO = { name: '', author: '', date: '', product: '', copyright: '', comment: '', software: '' }
// 101 of 500 real banks share an INAM, and 62 carry a filename instruction in
// it ("8mbgmgs.sf2, please use this filename."). Both are better off as the
// filename; repairing such a string is not worth attempting.
const GENERIC_NAME = /^(untitled|new soundfont|soundfont|gm|default|bank|user bank)$/i
const FILE_IN_NAME = /\.sf[23]/i

/** INFO LIST chunk (the one holding the 'INFO' fourCC) to its text fields. */
export function parseInfo(view, infoChunk) {
  if (!infoChunk) fail('missing INFO list')
  const info = { ...EMPTY_INFO }
  for (const chunk of chunks(view, infoChunk.data + 4, infoChunk.data + infoChunk.size)) {
    const field = INFO_FIELDS[chunk.id]
    if (field) info[field] = name(view, chunk.data, chunk.size)
  }
  return info
}

/** Display title only. Collision handling (appending IENG) belongs to the caller. */
export function bankTitle(info, fileName = '') {
  const named = (info?.name || '').trim()
  const base = String(fileName || '').replace(/\.sf[23]$/i, '').trim()
  const usable = named && !GENERIC_NAME.test(named) && !FILE_IN_NAME.test(named)
  return usable ? named : (base || named)
}

/**
 * Bank metadata from positional reads.
 * @param {(offset: number, length: number) => Promise<Uint8Array>} read
 */
export async function readBankIndex(read, { fileName = '', byteLength = Infinity } = {}) {
  const at = async (offset, length) => {
    const bytes = await read(offset, length)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < length) fail('unexpected end of file')
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  const header = await at(0, 12)
  if (text(header, 0, 4) !== 'RIFF' || text(header, 8, 4) !== 'sfbk') fail('not a RIFF sfbk file')
  const riffEnd = Math.min(header.getUint32(4, true) + 8, byteLength)
  let info = null, pdta = null
  for (let pos = 12; pos + 8 <= riffEnd && !(info && pdta);) {
    // Chunk headers only: sdta is walked past on its declared size, never read.
    const head = await at(pos, Math.min(12, riffEnd - pos))
    const id = text(head, 0, 4), size = head.getUint32(4, true), data = pos + 8
    const next = data + size + (size & 1)
    if (next > riffEnd) fail(`truncated ${id} chunk`)
    const type = id === 'LIST' && head.byteLength >= 12 ? text(head, 8, 4) : ''
    if (type === 'INFO' || type === 'pdta') {
      const found = { view: await at(data, size), chunk: { id, data: 0, size } }
      if (type === 'INFO') info = found; else pdta = found
    }
    pos = next
  }
  if (!info || !pdta) fail('missing INFO or pdta list')
  const phdr = chunks(pdta.view, 4, pdta.chunk.size).find(chunk => chunk.id === 'phdr')
  if (!phdr || phdr.size % 38 || phdr.size < 76) fail('missing or malformed phdr')
  const fields = parseInfo(info.view, info.chunk)
  // The last phdr record is the EOP terminator, not a preset.
  const presets = Array.from({ length: phdr.size / 38 - 1 }, (_, i) => {
    const record = phdr.data + i * 38
    return { bank: pdta.view.getUint16(record + 22, true), program: pdta.view.getUint16(record + 20, true), name: name(pdta.view, record, 20) }
  })
  return { title: bankTitle(fields, fileName), info: fields, presets }
}
