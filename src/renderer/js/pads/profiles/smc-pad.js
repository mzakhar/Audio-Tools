// M-Vave SMC-PAD controller map. Facts captured in specs/pads-view.md (Hardware mapping).
export const SMC_PAD = {
  id: 'smc-pad',
  match: (name) => /SMC-PAD/i.test(name || ''),
  pads: { channel: 9, firstNote: 36, banks: 4 }, // 0-indexed ch10
  // Knobs 1..8 as turned send CC 36,37,34,35,32,33,30,31.
  encoders: { channel: 0, ccs: [36, 37, 34, 35, 32, 33, 30, 31], mode: 'absolute' },
  // Labels unconfirmed; roles are defaults, learn can remap.
  buttons: { channel: 0, map: { 25: 'play', 26: 'layer', 27: 'repeat', 28: 'wipe', 29: 'full' } },
  aftertouch: 'channel',
}
