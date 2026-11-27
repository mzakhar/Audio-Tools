// PURE geometry for the lesson overlay on the loop strip (same beat->x and row math as PadsView.drawStrip).
const rowRect = (pad, beat, { loopBeats, w, h, ruler }) => {
  const rowH = (h - ruler) / 16
  const b = ((beat % loopBeats) + loopBeats) % loopBeats
  return { x: (b / loopBeats) * w, y: h - (pad + 1) * rowH + 1, h: Math.max(2, rowH - 2) }
}

/** Outline boxes for lesson targets (bank A: pad p = row p). */
export function ghostRects(targets, { loopBeats, w, h, ruler = 16, width = 3 }) {
  return (targets ?? []).filter(t => t.pad >= 0 && t.pad <= 15)
    .map(t => ({ ...rowRect(t.pad, t.beat, { loopBeats, w, h, ruler }), w: width, pad: t.pad }))
}

/** Result marks at absolute beat mod loop; centred on the beat. */
export function markRects(marks, { loopBeats, w, h, ruler = 16 }) {
  return (marks ?? []).filter(m => m.pad >= 0 && m.pad <= 15).map(m => {
    const r = rowRect(m.pad, m.beat, { loopBeats, w, h, ruler })
    return { ...r, x: r.x - 2, w: 5, mark: m.mark }
  })
}

/** Needle position 0..1 over -range..+range ms; 0.5 = on time. */
export const biasPos = (ms, range = 90) => Math.min(1, Math.max(0, 0.5 + ms / (2 * range)))

export function biasText(ms) {
  const r = Math.round(ms)
  if (Math.abs(ms) < 3) return 'on time'
  return r > 0 ? `+${r} ms late` : `${r} ms early`
}
