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

// Every GM percussion note across both banks (plus 35/40/44) routed onto the
// palette's 4 voices (0 kick, 1 snare, 2 hihat, 3 clap), grouped by family —
// the drum palette has no real toms/cymbals yet, so the closest voice stands
// in for the whole family.
// ponytail: only four voices exist, map by family; revisit when the drum
// palette grows real toms.
export const PALETTE_DRUM_NOTES = {
  35: 0, 36: 0,                   // kick
  37: 1, 38: 1, 40: 1,            // snare
  39: 3,                          // clap
  41: 0,                          // kick (toms)
  42: 2,                          // hihat
  43: 0,                          // kick (toms)
  44: 2,                          // hihat
  45: 0,                          // kick (toms)
  46: 2,                          // hihat (open)
  47: 0,                          // kick (toms)
  48: 0,                          // kick (toms)
  49: 3,                          // clap
  50: 0,                          // kick (toms)
  51: 2,                          // hihat
  52: 3,                          // clap
  53: 2,                          // hihat
  54: 2,                          // hihat
  55: 3,                          // clap
  56: 2,                          // hihat
  57: 3,                          // clap
  58: 2,                          // hihat
  59: 2,                          // hihat
}

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
