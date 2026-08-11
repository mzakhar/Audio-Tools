// Pure core for TURING — the Music Thing Turing Machine shift register.
//
// The register is always 16 bits wide; `length` only decides which bit wraps
// back to the head, so shortening the loop and lengthening it again recovers
// the old pattern exactly the way the hardware does.

export const REGISTER_BITS = 16

// One clock. `lock` is read as a *flip probability* (1 - lock), which is what
// gives the hardware its three useful knob positions for free:
//   lock 1   → never flips → the loop is locked and repeats
//   lock .5  → flips half the time → a fresh random bit every clock
//   lock 0   → always flips → locked, but inverted each pass (two-length loop)
export function turingStep(bits, length, lock, random = Math.random) {
  const register = Array.from({ length: REGISTER_BITS }, (_, i) => (bits?.[i] ? 1 : 0))
  const len = Math.max(2, Math.min(REGISTER_BITS, Math.round(length) || 2))
  const wrapped = register[len - 1]
  const flip = random() < 1 - Math.min(1, Math.max(0, lock))
  return [flip ? 1 - wrapped : wrapped, ...register.slice(0, REGISTER_BITS - 1)]
}

// The DAC tap: the top `taps` bits weighted MSB-first, normalised to 0..1 then
// scaled. `taps` is 8 for the main CV out and 2 for the coarse second tap.
export function bitsToCv(bits, range = 1, bipolar = false, taps = 8) {
  let word = 0
  for (let i = 0; i < taps; i++) word = word * 2 + (bits?.[i] ? 1 : 0)
  const unit = word / (Math.pow(2, taps) - 1)
  return (bipolar ? unit * 2 - 1 : unit) * range
}
