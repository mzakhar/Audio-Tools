// PURE lesson data, evaluator and progress helpers. No DOM, no Date, no storage.
// Pads are 0..15 (pad 1 = 0). Default 909 kit: 0 bd, 2 sd, 6 ch, 8 ch-short, 10 oh, 11 mt2.

const L = (n, o) => ({ id: `l${n}`, n, kitId: 'default-909', targets: [], hints: [], ...o })

const alt = (pads, beats, vels) => beats.map((beat, i) => ({ pad: pads[i % pads.length], beat, vel: vels[i % vels.length] }))

export const LESSONS = [
  L(0, {
    title: 'Meet your pads', concept: 'Test every pad and measure your latency.',
    bpm: 90, groove: 0.5, bars: 2,
    pass: { type: 'calibration' },
    steps: [
      'Hit each pad once. Every one should light and sound.',
      'If hits sound too hard or too soft, hold SHIFT + Pad 9 for the soft curve.',
      'Tap any pad on each of the 16 clicks. Stay relaxed.',
    ],
    hints: ['Calibration is saved on this computer. Redo it if you change audio output.'],
  }),
  L(1, {
    title: 'Soft and hard', concept: 'Velocity: hit as hard as each target asks.',
    bpm: 80, groove: 0.5, bars: 2,
    targets: alt([0], [0, 1, 2, 3, 4, 5, 6, 7], [40, 100]),
    pass: { type: 'velocity', pct: 0.8 },
    steps: ['Hit the lit pad on every click.', 'Soft targets are quiet taps, hard targets are firm hits.', 'Keep Full (H) off.'],
    hints: ['Everything sounds loud? Hold SHIFT + Pad 9 for the soft curve.', 'Full (H) forces 127 and ignores your touch.'],
  }),
  L(2, {
    title: 'Kick and snare', concept: 'Place hits against the click.',
    bpm: 80, groove: 0.5, bars: 2,
    targets: [{ pad: 0, beat: 0 }, { pad: 2, beat: 1 }, { pad: 0, beat: 2 }, { pad: 2, beat: 3 }],
    pass: { type: 'score', goodPct: 0.8, loops: 1 },
    steps: ['Kick (Pad 1) on beats 1 and 3.', 'Snare (Pad 3) on beats 2 and 4.', 'Watch the marks and the bias needle.'],
    hints: ['Listen to the click, not the screen.', 'Consistently late or early? Redo lesson 0.'],
  }),
  L(3, {
    title: 'First groove', concept: 'Kick, snare and eighth-note hats together.',
    bpm: 85, groove: 0.5, bars: 1,
    targets: [
      { pad: 0, beat: 0 }, { pad: 0, beat: 2.5 }, { pad: 2, beat: 1 }, { pad: 2, beat: 3 },
      ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(beat => ({ pad: 6, beat })),
    ],
    pass: { type: 'score', goodPct: 0.8, loops: 2 },
    steps: ['Kick on 1 and on the "and" of 3.', 'Snare on 2 and 4.', 'Closed hat on every eighth note.', 'Hold it for 2 loops.'],
    hints: ['Hats first, then add kick and snare.', 'Too many extra hits? Follow the lit pad.'],
  }),
  L(4, {
    title: 'Hats with Repeat', concept: 'Hold Repeat for rolls; open hats get cut by closed.',
    bpm: 90, groove: 0.5, bars: 2,
    pass: { type: 'repeat', beats: 8 },
    setup: { full: false, ladder: null, repeatRate: '1/16' },
    steps: [
      'Hold G (or the REPEAT button) and hold Pad 7 for a roll.',
      'Turn RATE to change the speed.',
      'Hold the roll for 2 bars (8 beats) without a gap.',
      'Then hit Pad 11 (open hat) and cut it with Pad 7 or Pad 9 (closed).',
    ],
    hints: ['Repeat velocity is the velocity of the hit that started it.', 'Full (H) makes every repeat 127.'],
  }),
  L(5, {
    title: 'Layer it', concept: 'Record, overdub, undo, never stop.',
    bpm: 90, groove: 0.5, bars: 2,
    pass: { type: 'pads-in-loop', count: 3 },
    steps: ['Start the loop and record a kick.', 'Turn on Layer and add a snare, then hats.', 'Made a mistake? Press Undo. The loop keeps running.', 'Finish with 3 different pads in the loop.'],
    hints: ['Layer adds to the loop. Without it a new pass replaces the old one.'],
  }),
  L(6, {
    title: 'Wipe', concept: 'Remove one pad from the loop while it plays.',
    bpm: 90, groove: 0.5, bars: 2,
    pass: { type: 'pad-empty', pad: 0 },
    steps: ['Record a kick (Pad 1) and a snare (Pad 3) in the loop.', 'Hold Wipe + Pad 1 while the loop plays.', 'The kick goes, the snare stays.'],
    hints: ['Undo brings a wiped pad back.'],
  }),
  L(7, {
    title: 'Groove', concept: 'Swing: hear 50, 54, 62 and 66, then pick one.',
    bpm: 90, groove: 0.5, bars: 2,
    pass: { type: 'groove-ab', values: [0.5, 0.54, 0.62, 0.66] },
    steps: ['Record a hat pattern in the loop.', 'Set Groove to 50 and listen for one loop.', 'Do the same at 54, 62 and 66.', 'Leave it on the one you like.'],
    hints: ['50 is straight. Around 66 is a hard triplet swing.'],
  }),
  L(8, {
    title: 'Snap', concept: 'Tighten a loose recording: 50 % against 100 %.',
    bpm: 90, groove: 0.5, bars: 2,
    pass: { type: 'snap-compare', values: [0.5, 1] },
    steps: ['Record a loose pattern, a little off the grid on purpose.', 'Apply Snap at 50 % and listen for one loop.', 'Undo, then apply Snap at 100 % and listen again.'],
    hints: ['50 % keeps some feel. 100 % locks every hit to the grid.'],
  }),
  L(9, {
    title: 'Ladder', concept: 'Play a melody from one sound across 16 pads.',
    bpm: 85, groove: 0.5, bars: 2,
    setup: { ladder: 'tune' },
    targets: [0, 2, 4, 5, 7, 5, 4, 2].map((pad, i) => ({ pad, beat: i })),
    pass: { type: 'phrase', goodPct: 0.7 },
    steps: ['Ladder is on (L cycles it). Each pad plays the same sound at a different pitch.', 'Follow the lit pads in order, one per beat.', 'Match 70 % of the phrase.'],
    hints: ['Pads further right are higher.', 'Press L to cycle Ladder off or to another parameter.'],
  }),
  L(10, {
    title: 'Mute performance', concept: 'Build and drop with mute and solo.',
    bpm: 95, groove: 0.5, bars: 2,
    pass: { type: 'mutes', count: 4 },
    steps: ['Loop a full pattern: kick, snare, hats.', 'Hold O for the bank overlay.', 'Mute and unmute pads right on the bar line.', 'Land 4 mutes within 90 ms of a bar line.'],
    hints: ['Drop the hats for a bar, then bring everything back.'],
  }),
  L(11, {
    title: 'Slice', concept: 'Chop a drum loop onto 16 pads and play it back in a new order.',
    bpm: 90, groove: 0.5, bars: 2,
    pass: { type: 'sample-pads', count: 4 },
    steps: ['Drop a drum loop on the pad grid (or press SLICE…).', 'Pick Slice to 16 and press Apply: the 16 pads now play the loop in order.', 'Turn Layer on and play the slices in a new order.', 'Record 4 different sample pads into the loop.'],
    hints: ['Lower sensitivity gives fewer, bigger cuts; the rest are split evenly.', 'Click a region in the dialog to hear it first.'],
  }),
]

export function lessonById(id) { return LESSONS.find(l => l.id === id) || null }

export function nextLesson(id, progress) {
  const done = progress?.done || {}
  const i = LESSONS.findIndex(l => l.id === id)
  const order = [...LESSONS.slice(i + 1), ...LESSONS.slice(0, Math.max(i, 0) + (i < 0 ? 0 : 1))]
  return order.find(l => !done[l.id]) || null
}

const clamp01 = x => Math.max(0, Math.min(1, x))
const frac = (v, need, unit) => ({ done: v >= need, progress: clamp01(v / need), label: `${Math.min(v, need)}/${need} ${unit}` })
const pct = (v, need, what) => ({ done: v >= need, progress: clamp01(v / need), label: `${Math.round(v * 100)}% ${what}` })
const heardAll = (heard, values) => {
  const got = (heard || []).filter(h => values.some(v => Math.abs(v - h) < 1e-6))
  const n = values.filter(v => got.some(h => Math.abs(v - h) < 1e-6)).length
  return frac(n, values.length, 'heard')
}

export function evaluate(lesson, ctx = {}) {
  const p = lesson.pass
  const score = ctx.score
  switch (p.type) {
    case 'calibration': {
      const ok = !!ctx.calibration?.ok
      return { done: ok, progress: ok ? 1 : 0, label: ok ? 'calibrated' : 'tap 16 clicks' }
    }
    case 'velocity': {
      const v = score?.velPct ?? 0
      const r = pct(v, p.pct, 'in band')
      return { ...r, done: r.done && (score?.fullLaps ?? 0) > 0 }
    }
    case 'score': case 'phrase': {
      if (p.type === 'phrase' && !ctx.pads?.ladder) return { done: false, progress: 0, label: 'turn Ladder on (L)' }
      const g = score?.goodPct ?? 0
      const loops = p.type === 'score' ? p.loops : 1
      const l = p.type === 'score' ? ctx.loops || 0 : 1
      const gp = clamp01(g / p.goodPct)
      const done = !!score && (score.fullLaps ?? 0) > 0 && g >= p.goodPct && l >= loops
      const label = `${Math.round(g * 100)}% good` + (loops > 1 ? `, ${Math.min(l, loops)}/${loops} loops` : '')
      return { done, progress: loops > 1 ? (gp + clamp01(l / loops)) / 2 : gp, label }
    }
    case 'repeat': {
      const b = ctx.repeatBeats || 0
      return { done: b >= p.beats, progress: clamp01(b / p.beats), label: `${Math.min(Math.floor(b), p.beats)}/${p.beats} beats` }
    }
    case 'pads-in-loop': return frac([...(ctx.clipPads || [])].filter(x => !ctx.startPads?.has(x)).length, p.count, 'pads')
    case 'sample-pads': return frac([...(ctx.clipPads || [])].filter(x => ctx.samplePads?.has(x) && !ctx.startPads?.has(x)).length, p.count, 'sample pads')
    case 'pad-empty': {
      const was = !!(ctx.seenPads?.has(p.pad) || ctx.startPads?.has(p.pad))
      const gone = was && !ctx.clipPads?.has(p.pad)
      return { done: gone, progress: gone ? 1 : 0, label: gone ? 'wiped' : was ? 'wipe the pad' : 'record the pad first' }
    }
    case 'groove-ab': return heardAll(ctx.grooveHeard, p.values)
    case 'snap-compare': return heardAll(ctx.snapHeard, p.values)
    case 'mutes': return frac(ctx.mutesInTime || 0, p.count, 'mutes')
    default: return { done: false, progress: 0, label: '' }
  }
}

export const emptyProgress = () => ({ v: 1, done: {}, calibration: null })

export function parseProgress(text) {
  try {
    const o = JSON.parse(text)
    if (!o || typeof o !== 'object' || o.v !== 1 || !o.done || typeof o.done !== 'object') return emptyProgress()
    const c = o.calibration
    const cal = c && Number.isFinite(c.offsetMs) && Number.isFinite(c.spreadMs) ? { offsetMs: c.offsetMs, spreadMs: c.spreadMs, at: c.at } : null
    return { v: 1, done: { ...o.done }, calibration: cal }
  } catch { return emptyProgress() }
}

export const markDone = (progress, id, atIso) => ({ ...progress, done: { ...progress.done, [id]: atIso } })

export const setCalibration = (progress, cal, atIso) => ({ ...progress, calibration: { offsetMs: cal.offsetMs, spreadMs: cal.spreadMs, at: atIso } })
