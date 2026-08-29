// RIFF primitives shared by the SoundFont reader and indexer. They live here so
// those two can both use them without importing each other: a cycle works only
// while every cross-use stays inside a function body, and nothing should have
// to remember that.

export const text = (view, off, len) => {
  let value = ''
  for (let i = 0; i < len; i++) value += String.fromCharCode(view.getUint8(off + i))
  return value
}
export const name = (view, off, len) => text(view, off, len).replace(/\0.*$/, '').trim()
export const fail = message => { throw new Error(`Invalid SF2: ${message}`) }

export function chunks(view, start, end) {
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
