// Pure core for ARP — turns a held-note stack into the sequence the clock
// walks. Notes in and out are pitch CVs (0.1 = one octave), never MIDI: the
// module converts once, at the note event.

export const ARP_MODES = ['up', 'down', 'updown', 'random', 'as-played']

export function arpOrder(notes, mode = 'up', octaves = 1) {
  const held = (notes || []).filter(Number.isFinite)
  if (!held.length) return []
  const octs = Math.max(1, Math.min(4, Math.round(octaves) || 1))

  // `random` and `as-played` both keep the stack order — random picks its index
  // at clock time, so the order it picks from must stay stable.
  const base = mode === 'down' ? [...held].sort((a, b) => b - a)
    : mode === 'random' || mode === 'as-played' ? held
    : [...held].sort((a, b) => a - b)

  const seq = []
  for (let o = 0; o < octs; o++) for (const note of base) seq.push(note + o * 0.1)
  // Turnaround without repeating either endpoint, the way every hardware arp
  // does it — otherwise the top and bottom notes land twice as often.
  return mode === 'updown' ? seq.concat(seq.slice(1, -1).reverse()) : seq
}
