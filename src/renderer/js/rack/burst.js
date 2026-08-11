// Ratchet timing. `count` triggers starting at t0, spanning (count-1)*spacing
// seconds whatever the curve does — curve only redistributes the hits inside
// that span, so turning it never changes when the burst ends.
//
// curve > 0 accelerates (gaps shrink), curve < 0 decelerates, 0 is even.
export function burstTimes(t0, count, spacing, curve = 0) {
  const n = Math.max(1, Math.floor(count) || 1)
  if (n === 1) return [t0]
  const span = Math.max(0, spacing) * (n - 1)
  // p^e is monotone for any e > 0 and pins both ends: p=0 → 0, p=1 → 1.
  const exponent = Math.pow(4, -Math.max(-1, Math.min(1, curve)))
  return Array.from({ length: n }, (_, i) => t0 + span * Math.pow(i / (n - 1), exponent))
}

export default burstTimes
