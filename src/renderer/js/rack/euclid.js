// Euclidean rhythm: evenly distribute fills across steps.
// Rotate moves hits right, matching the panel's clockwise convention.
export function euclid(steps, fills, rotate = 0) {
  steps = Math.max(1, Math.floor(steps))
  fills = Math.max(0, Math.min(steps, Math.floor(fills)))
  const sparse = count => Array.from({ length: steps }, (_, i) => (i * count) % steps < count)
  // Distribute the sparse side, then invert it for dense rhythms. The phase
  // keeps the conventional E(3,8) and E(5,8) patterns both on beat one.
  const canonical = fills <= steps / 2
    ? sparse(fills)
    : Array.from({ length: steps }, (_, i) => !sparse(steps - fills)[(i - 1 + steps) % steps])
  const shift = ((Math.floor(rotate) % steps) + steps) % steps
  return canonical.map((_, i) => canonical[(i - shift + steps) % steps])
}

export default euclid
