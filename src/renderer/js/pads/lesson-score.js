// Pure lesson scoring. Units: beats (quarter = 1), ms for timing errors, velocity 0..127.
export const WINDOWS = { perfect: 25, good: 50, ok: 90 }

export const beatsToMs = (beats, bpm) => (beats * 60000) / bpm

export function markOf(errorMs, windows = WINDOWS) {
  const e = Math.abs(errorMs)
  return e <= windows.perfect ? 'perfect' : e <= windows.good ? 'good' : e <= windows.ok ? 'ok' : 'miss'
}

/** Every target repeated per loop, k >= 0, beat < toBeat, sorted by beat. */
export function targetOccurrences(targets, { loopBeats, toBeat, fromBeat = 0 }) {
  const out = []
  const k0 = loopBeats > 0 ? Math.max(0, Math.floor(fromBeat / loopBeats)) : 0
  targets.forEach((t, idx) => {
    for (let k = k0; k * loopBeats + t.beat < toBeat; k++) {
      out.push({ idx, k, pad: t.pad, beat: k * loopBeats + t.beat, vel: t.vel })
    }
  })
  return out.sort((a, b) => a.beat - b.beat || a.idx - b.idx)
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const round1 = (x) => Math.round(x * 10) / 10

export function scoreHits(hits, targets, { loopBeats, bpm, toBeat, fromBeat = 0, offsetMs = 0, windows = WINDOWS, velBand = 16 }) {
  const occ = targetOccurrences(targets, { loopBeats, toBeat, fromBeat })
  const valid = hits.filter((h) => h.beat >= 0 && h.beat >= fromBeat - 1)
  const pairs = []
  occ.forEach((o, oi) =>
    valid.forEach((h, hi) => {
      if (h.pad !== o.pad) return
      const errorMs = beatsToMs(h.beat - o.beat, bpm) - offsetMs
      if (Math.abs(errorMs) <= windows.ok) pairs.push({ oi, hi, errorMs })
    })
  )
  pairs.sort((a, b) => Math.abs(a.errorMs) - Math.abs(b.errorMs))
  const matchOf = new Map()
  const usedHits = new Set()
  for (const p of pairs) {
    if (matchOf.has(p.oi) || usedHits.has(p.hi)) continue
    matchOf.set(p.oi, p)
    usedHits.add(p.hi)
  }

  // an unmatched occurrence is over once its latest possible hit time has passed
  const overBeat = toBeat - ((windows.ok + Math.max(0, offsetMs)) * bpm) / 60000
  const marks = []
  let pending = 0
  occ.forEach((o, oi) => {
    const m = matchOf.get(oi)
    if (m) {
      const h = valid[m.hi]
      const velOk = o.vel == null ? null : Math.abs(h.velocity - o.vel) <= velBand
      marks.push({ idx: o.idx, k: o.k, pad: o.pad, beat: o.beat, mark: markOf(m.errorMs, windows), errorMs: m.errorMs, velocity: h.velocity, velOk })
    } else if (o.beat < overBeat) {
      marks.push({ idx: o.idx, k: o.k, pad: o.pad, beat: o.beat, mark: 'miss', errorMs: null, velocity: null, velOk: o.vel == null ? null : false })
    } else pending++
  })

  const counts = { perfect: 0, good: 0, ok: 0, miss: 0 }
  marks.forEach((m) => counts[m.mark]++)
  const total = marks.length
  const matched = marks.filter((m) => m.errorMs != null)
  const velMarks = marks.filter((m) => m.velOk != null)
  const perLap = new Map()
  marks.forEach((m) => perLap.set(m.k, (perLap.get(m.k) || 0) + 1))
  const fullLaps = [...perLap.values()].filter((n) => n >= targets.length).length
  return {
    marks,
    pending,
    fullLaps,   // laps in the window with every target occurrence resolved
    extras: valid.filter((_, hi) => !usedHits.has(hi)),
    biasMs: matched.length ? matched.reduce((s, m) => s + m.errorMs, 0) / matched.length : null,
    counts,
    total,
    goodPct: total ? (counts.perfect + counts.good) / total : 0,
    hitPct: total ? (total - counts.miss) / total : 0,
    velPct: velMarks.length ? velMarks.filter((m) => m.velOk).length / velMarks.length : null,
  }
}

/** Signed ms from each tap to its nearest integer beat (+ = late). */
export const tapErrors = (tapBeats, bpm) => tapBeats.map((b) => beatsToMs(b - Math.round(b), bpm))

export function calibrate(errorsMs, { min = 8 } = {}) {
  if (errorsMs.length < min) return { ok: false, reason: 'too-few' }
  const med = median(errorsMs)
  return { ok: true, offsetMs: round1(med), spreadMs: median(errorsMs.map((e) => Math.abs(e - med))) }
}

export function hintsFor({ hits, score, offsetMs = 0 }) {
  const out = []
  const maxVel = hits.reduce((m, h) => Math.max(m, h.velocity), 0)
  if (hits.length >= 8 && hits.every((h) => h.velocity === 127)) {
    out.push({ id: 'all-127', text: 'Every hit is 127 — Full is on, or the curve is too hard.' })
  }
  const matched = score ? score.total - score.counts.miss : 0
  if (score && score.biasMs != null && matched >= 6) {
    const n = Math.round(Math.abs(score.biasMs))
    if (score.biasMs > 30) out.push({ id: 'late', text: `You are ${n} ms late on average — recalibrate?` })
    else if (score.biasMs < -30) out.push({ id: 'early', text: `You are ${n} ms early on average — wait for the click.` })
  }
  if (hits.length >= 8 && maxVel < 90) {
    out.push({ id: 'soft', text: `Hits never pass ${maxVel} — hold SHIFT + Pad 9 for the soft curve.` })
  }
  if (score && score.total >= 4 && score.extras.length > score.total) {
    out.push({ id: 'extras', text: 'Lots of extra hits — follow the lit pad.' })
  }
  return out
}
