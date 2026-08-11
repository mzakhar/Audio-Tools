// Pure core for DRIFT — slow correlated randomness.
//
// Both generators are one step of a map: the module owns time, these own only
// the arithmetic, so a 10 000-step boundedness check costs no AudioContext.

// Random walk on [-1, 1], reflecting at the rails rather than clamping — a
// clamped walk parks on the rail and stops being interesting.
export function walkStep(value, depth, random = Math.random) {
  const next = (Number.isFinite(value) ? value : 0) + (random() * 2 - 1) * depth
  if (next > 1) return 2 - next
  if (next < -1) return -2 - next
  return next
}

// Forward Euler on the Lorenz system. dt stays small (the module uses 0.01);
// large dt diverges, which is exactly what the bounded-trajectory test guards.
export function lorenzStep(state, dt = 0.01, sigma = 10, rho = 28, beta = 8 / 3) {
  const { x = 0.1, y = 0, z = 20 } = state || {}
  return {
    x: x + dt * sigma * (y - x),
    y: y + dt * (x * (rho - z) - y),
    z: z + dt * (x * y - beta * z)
  }
}

// Attractor bounds, used to map the raw state into CV range. Not tight — the
// module clamps — just close enough that the output uses most of its range.
export const LORENZ_SCALE = { x: 20, y: 26, z: 25 }
export const LORENZ_SEED = { x: 0.1, y: 0, z: 20 }
