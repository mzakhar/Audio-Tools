// Pure sample slicer math: onset detection -> N contiguous regions. Units: sample indexes unless noted.

/** Average channels into one Float32Array (always a copy). */
export function mono(channels) {
  const n = channels[0].length
  const out = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i]
  if (channels.length > 1) for (let i = 0; i < n; i++) out[i] /= channels.length
  return out
}

/**
 * Onset envelope: env[i] = half-wave rectified log ratio of the energy in the frame after i*hop
 * over the frame before it, so a peak sits at the onset itself. O(n) via prefix sums.
 */
export function onsetEnvelope(samples, sampleRate, { frameMs = 10, hopMs = 5 } = {}) {
  const frame = Math.max(1, Math.round(sampleRate * frameMs / 1000))
  const hop = Math.max(1, Math.round(sampleRate * hopMs / 1000))
  const n = samples.length
  const cum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + samples[i] * samples[i]
  const mean = (a, b) => (cum[Math.min(n, b)] - cum[Math.max(0, a)]) / frame + 1e-8
  const env = new Float32Array(Math.ceil(n / hop))
  for (let i = 1; i < env.length; i++) {
    const t = i * hop
    env[i] = Math.max(0, Math.log(mean(t, t + frame)) - Math.log(mean(t - frame, t)))
  }
  return { env, hop }
}

/** Peak-pick the envelope: adaptive local mean (~200 ms) + a global term shrinking with sensitivity. */
export function pickOnsets(env, hop, sampleRate, { sensitivity = 0.5, minGapMs = 60 } = {}) {
  const n = env.length
  const cum = new Float64Array(n + 1)
  let max = 0
  for (let i = 0; i < n; i++) { cum[i + 1] = cum[i] + env[i]; if (env[i] > max) max = env[i] }
  const half = Math.max(1, Math.round(sampleRate * 0.1 / hop))
  const global = (1 - Math.min(1, Math.max(0, sensitivity))) * 0.6 * max
  const cand = []
  for (let i = 1; i < n; i++) {
    const v = env[i]
    if (v <= 0 || v <= env[i - 1] || (i + 1 < n && v < env[i + 1])) continue
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1)
    if (v > (cum[b] - cum[a]) / (b - a) + global) cand.push({ at: i * hop, strength: v })
  }
  const gap = sampleRate * minGapMs / 1000
  const kept = []
  for (const c of cand.sort((x, y) => y.strength - x.strength)) {
    if (kept.every((k) => Math.abs(k.at - c.at) >= gap)) kept.push(c)
  }
  return kept.sort((x, y) => x.at - y.at)
}

/** Nearest index <= index (within maxLook) at a sign change / zero; else the smallest |s|. Never < 0. */
export function snapToZero(samples, index, maxLook = 256) {
  const top = Math.max(0, Math.min(samples.length - 1, Math.floor(index)))
  const lo = Math.max(0, top - maxLook)
  let best = top
  for (let j = top; j >= lo; j--) {
    if (samples[j] === 0 || (j > 0 && samples[j - 1] * samples[j] < 0)) return j
    if (Math.abs(samples[j]) < Math.abs(samples[best])) best = j
  }
  return best
}

/** Index after the last sample whose magnitude exceeds floor (>= 1). */
export function trimEnd(samples, { floor = 0.001 } = {}) {
  for (let i = samples.length - 1; i >= 0; i--) if (Math.abs(samples[i]) > floor) return i + 1
  return 1
}

/** Exactly `count` contiguous { start, end } regions covering [0, trimEnd). */
export function sliceRegions(samples, sampleRate, onsets, { count = 16, minSliceMs = 30 } = {}) {
  const end = trimEnd(samples)
  const minLen = sampleRate * minSliceMs / 1000
  let cuts = onsets
    .filter((o) => o.at > 0 && o.at < end)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, count - 1)
    .map((o) => snapToZero(samples, o.at))
    .sort((a, b) => a - b)
  cuts = cuts.filter((c, i) => c > 0 && (i === 0 || c > cuts[i - 1]))
  // merge: drop the right-hand cut of any region shorter than minSlice (left cut for the last region)
  for (;;) {
    const b = [0, ...cuts, end]
    const i = b.findIndex((x, k) => k > 0 && x - b[k - 1] < minLen)
    if (i < 0 || !cuts.length) break
    cuts.splice(i - 1 < cuts.length ? i - 1 : i - 2, 1)
  }
  // split the longest region at its (snapped) midpoint until count
  // (stops early when the longest region is 1 sample: never emits a zero-length region)
  while (cuts.length < count - 1) {
    const b = [0, ...cuts, end]
    let li = 0
    for (let k = 1; k < b.length - 1; k++) if (b[k + 1] - b[k] > b[li + 1] - b[li]) li = k
    if (b[li + 1] - b[li] < 2) break
    const mid = Math.floor((b[li] + b[li + 1]) / 2)
    const z = snapToZero(samples, mid)
    cuts.splice(li, 0, z > b[li] && z < b[li + 1] ? z : mid)
  }
  const b = [0, ...cuts, end]
  return b.slice(1).map((e, i) => ({ start: b[i], end: e }))
}

/** Loop-length guess: bars in 1/2/4/8 whose bpm lies in [min,max], closest to 120 (ties: fewer bars). */
export function estimateBars(lengthSec, { beatsPerBar = 4, min = 70, max = 180 } = {}) {
  let best = null
  for (const bars of [1, 2, 4, 8]) {
    const bpm = bars * beatsPerBar * 60 / lengthSec
    if (bpm >= min && bpm <= max && (!best || Math.abs(bpm - 120) < Math.abs(best.bpm - 120))) best = { bars, bpm }
  }
  return best && { bars: best.bars, bpm: Math.round(best.bpm * 10) / 10 }
}

/** One note per region on pad i at its start, in beats. */
export function slicePattern(regions, sampleRate, bpm) {
  return regions.map((r, pad) => ({ pad, beat: r.start / sampleRate * bpm / 60 }))
}
