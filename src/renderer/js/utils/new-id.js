// A unique id. crypto.randomUUID exists only in secure contexts, and the LAN http route is not
// one, so fall back to time + randomness there (ids only need to be unique within a project).
export const newId = (c = globalThis.crypto) =>
  c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
