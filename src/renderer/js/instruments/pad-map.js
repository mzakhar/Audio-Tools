// Pure GM percussion pad map: two banks of 8 pads over the standard channel-10 map.
// No DOM, no globals — see specs/instrument-browser.md phase 4.

export const GM_PERCUSSION = {
  35: 'Acoustic Bass Drum',
  36: 'Bass Drum 1',
  37: 'Side Stick',
  38: 'Acoustic Snare',
  39: 'Hand Clap',
  40: 'Electric Snare',
  41: 'Low Floor Tom',
  42: 'Closed Hi Hat',
  43: 'High Floor Tom',
  44: 'Pedal Hi-Hat',
  45: 'Low Tom',
  46: 'Open Hi-Hat',
  47: 'Low-Mid Tom',
  48: 'Hi-Mid Tom',
  49: 'Crash Cymbal 1',
  50: 'High Tom',
  51: 'Ride Cymbal 1',
  52: 'Chinese Cymbal',
  53: 'Ride Bell',
  54: 'Tambourine',
  55: 'Splash Cymbal',
  56: 'Cowbell',
  57: 'Crash Cymbal 2',
  58: 'Vibraslap',
  59: 'Ride Cymbal 2',
}

const BANKS = {
  A: [36, 38, 37, 39, 42, 46, 43, 49],
  B: [41, 45, 48, 50, 51, 54, 56, 58],
}

export const PALETTE_DRUM_NOTES = { 36: 0, 38: 1, 42: 2, 46: 3 }

function bankRows(bank) {
  const notes = BANKS[bank]
  if (!notes) return null
  return notes.map((note, i) => ({
    slot: i + 1,
    note,
    label: GM_PERCUSSION[note] || `Note ${note}`,
    key: String(i + 1),
  }))
}

export function padBank(bank) {
  return bankRows(bank) || []
}

export function padToNote(bank, slot) {
  const rows = bankRows(bank)
  if (!rows) return null
  const row = rows.find(r => r.slot === slot)
  return row ? row.note : null
}

export function noteToPad(note) {
  for (const bank of Object.keys(BANKS)) {
    const index = BANKS[bank].indexOf(note)
    if (index !== -1) return { bank, slot: index + 1 }
  }
  return null
}
