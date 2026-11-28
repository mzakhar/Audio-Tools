// Pure pieces of the FM-1 host: time -> emulator frame, the timed event queue, minimum key holds,
// the 44.1 kHz -> context-rate resampler, LCD pixel conversion and the MIDI bytes the session
// sends. public/worklets/fm1-worklet.js carries inline copies of the queue, key hold and
// resampler (it cannot import); keep the two in step.

export const FM1_RATE = 44100

// AudioContext seconds -> emulator frame, from an anchor { time, frame } (a frame played at time).
export function framesAt(time, anchor, rate = FM1_RATE) {
  return anchor.frame + Math.round((time - anchor.time) * rate)
}

// Timed events in frame order; equal frames keep push order. Bounded: a full queue refuses the
// push (returns false) so a stalled emulator cannot grow memory without limit. An event may carry
// a source tag (`src`); with a `notes` gate (createNoteCounts) tagged events pass through it as
// they are taken, so note holders are counted in audible (frame) order, not call order.
export function createEventQueue(limit = 4096, notes = null) {
  const items = []
  return {
    push(ev) {
      if (items.length >= limit) return false
      let i = items.length
      while (i > 0 && items[i - 1].frame > ev.frame) i--
      items.splice(i, 0, ev)
      return true
    },
    takeUpTo(frame) {
      let n = 0
      while (n < items.length && items[n].frame <= frame) n++
      const out = []
      for (const e of items.splice(0, n)) {
        const bytes = notes && e.src ? notes.filter(e.bytes, e.src) : e.bytes
        if (bytes) out.push(bytes)
      }
      return out
    },
    // Transport stop without panic: drop what was queued for `frame` on, except note-offs, so
    // sounding notes still end and nothing new starts.
    dropFrom(frame) {
      for (let i = items.length - 1; i >= 0 && items[i].frame >= frame; i--) if (!isNoteOff(items[i].bytes)) items.splice(i, 1)
    },
    clear() { items.length = 0 },
    get size() { return items.length },
  }
}

const isNoteOff = (b) => b.length === 3 && ((b[0] & 0xF0) === 0x80 || ((b[0] & 0xF0) === 0x90 && b[2] === 0))

// The firmware polls its key matrix: a press shorter than ~100 ms of emulated time can be missed.
// up() returns the frame the release may be applied at; due(frame) hands back ids to release.
export function createKeyHold(minFrames = 4410) {
  const downAt = new Map()
  const releases = new Map()
  return {
    down(id, frame) {
      // ponytail: a re-press while a release is pending just keeps the key held; queue it if a
      // firmware needs fast double presses
      releases.delete(id)
      downAt.set(id, frame)
    },
    up(id, frame) {
      const at = Math.max(frame, (downAt.get(id) ?? frame) + minFrames)
      downAt.delete(id)
      releases.set(id, at)
      return at
    },
    due(frame) {
      const ids = []
      for (const [id, at] of releases) if (at <= frame) { ids.push(id); releases.delete(id) }
      return ids
    },
  }
}

// Stateful linear resampler, stereo. Feed exactly need(n) input frames to get n output frames
// (the worklet's quantum); process() also works with any input length and returns how many
// output frames it wrote, provided the output arrays are large enough.
export function createResampler(inRate, outRate) {
  const step = inRate / outRate
  let t = 0              // next output position, in input frames; index -1 = last sample kept
  let prevL = 0, prevR = 0
  return {
    need(nOut) {
      if (nOut <= 0) return 0
      let p = t
      for (let k = 1; k < nOut; k++) p += step
      return Math.max(0, Math.floor(p) + 2)
    },
    process(inL, inR, outL, outR) {
      const m = inL.length
      let o = 0
      while (o < outL.length) {
        const i = Math.floor(t)
        if (i + 1 > m - 1) break
        const f = t - i
        const l0 = i < 0 ? prevL : inL[i], r0 = i < 0 ? prevR : inR[i]
        outL[o] = l0 + (inL[i + 1] - l0) * f
        outR[o] = r0 + (inR[i + 1] - r0) * f
        o++
        t += step
      }
      if (m > 0) { prevL = inL[m - 1]; prevR = inR[m - 1]; t -= m }
      return o
    },
  }
}

// RGB565 framebuffer -> RGBA bytes (out: Uint8ClampedArray of 4 * u16.length).
export function rgb565ToRgba(u16, out) {
  for (let i = 0, j = 0; i < u16.length; i++, j += 4) {
    const v = u16[i]
    out[j] = ((v >> 11) & 31) * 255 / 31
    out[j + 1] = ((v >> 5) & 63) * 255 / 63
    out[j + 2] = (v & 31) * 255 / 31
    out[j + 3] = 255
  }
  return out
}

const byte7 = v => Math.max(0, Math.min(127, Math.round(v)))

export const noteOnBytes = (ch, pitch, vel) => [0x90 | (ch & 15), byte7(pitch), Math.max(1, byte7(vel))]
export const noteOffBytes = (ch, pitch) => [0x80 | (ch & 15), byte7(pitch), 0]
export function allNotesOffBytes() {
  const out = []
  for (let ch = 0; ch < 16; ch++) out.push(0xB0 | ch, 123, 0)
  return out
}

// True when the device fell behind since the previous status: the firmware left audio blocks
// unfilled or the Worker path's buffer queue ran dry. Late events are a scheduling matter
// (live play is always "late" on the Worker path) so they do not count as overload.
export function overload({ starved = 0, underruns = 0 } = {}, prev = {}) {
  return starved > (prev.starved ?? 0) || underruns > (prev.underruns ?? 0)
}

// Worker path: resample 44.1 kHz chunks to the context rate and cut the result into blocks of
// `size` output frames. push() returns the blocks completed by that chunk; each owns its arrays
// (safe to transfer) and carries its start frame in output frames, contiguous from 0.
export function createBlockWriter(inRate, outRate, size = 1024) {
  const rs = createResampler(inRate, outRate)
  let l = new Float32Array(size), r = new Float32Array(size), fill = 0, frame = 0
  let sl = new Float32Array(0), sr = new Float32Array(0)
  return {
    push(inL, inR) {
      const cap = Math.ceil(inL.length * outRate / inRate) + 2
      if (sl.length < cap) { sl = new Float32Array(cap); sr = new Float32Array(cap) }
      const n = rs.process(inL, inR, sl, sr)
      const blocks = []
      for (let i = 0; i < n;) {
        const k = Math.min(n - i, size - fill)
        l.set(sl.subarray(i, i + k), fill)
        r.set(sr.subarray(i, i + k), fill)
        fill += k
        i += k
        if (fill === size) {
          blocks.push({ l, r, frame })
          frame += size
          l = new Float32Array(size); r = new Float32Array(size); fill = 0
        }
      }
      return blocks
    },
  }
}

// Boot is over once the firmware is up AND taking input. Measured on Felucca, Sloop, FM-1 015 and
// Dock (node, 120 MHz): audio starts (first render with have > 0) at ~320 ms emulated, but MIDI
// sent then is lost and panel keys are ignored until the UI comes up, which redraws the LCD again
// (~540-1410 ms). So: ready at the first LCD revision change at least settleMs after audio
// started. After timeoutMs of emulated time it is ready anyway ('timeout', which the status
// reports). Both hosts use this rule; the worklet carries an inline copy.
export function createBootWatch({ timeoutMs = 8000, settleMs = 100 } = {}) {
  let audioAt = -1, rev = null
  return function step({ have = 0, lcdRev, ms = 0 }) {
    if (audioAt < 0 && have > 0) { audioAt = ms; rev = lcdRev }
    else if (audioAt >= 0 && lcdRev !== rev) {
      rev = lcdRev
      if (ms - audioAt >= settleMs) return 'up'
    }
    return ms >= timeoutMs ? 'timeout' : null
  }
}

// One FM-1 device hears the same note from live play and the timeline. The hosts run each tagged
// event through filter() when it is due, in frame order: a note-on always passes (the firmware
// retriggers) and counts one more hold for its source (live holds at most one, so one live off
// releases it as on a keyboard; timeline overlaps count); a note-off releases one hold of its
// source and is sent only when no hold is left on that note from ANY source (overlapping notes
// of one pitch from one source, or two tracks on one device channel, end with the last off).
// Untagged and non-note bytes pass; an off nobody holds passes (it releases anything stray). Panic calls reset().
// The worklet carries an inline copy.
export function createNoteCounts() {
  const holders = new Map()   // ch * 128 + pitch -> Map(source -> notes on it holds)
  return {
    filter(bytes, src) {
      const kind = bytes[0] & 0xF0
      if (bytes.length !== 3 || (kind !== 0x80 && kind !== 0x90)) return bytes
      const key = (bytes[0] & 15) * 128 + (bytes[1] & 127)
      let counts = holders.get(key)
      if (kind === 0x90 && bytes[2] > 0) {
        if (!counts) holders.set(key, counts = new Map())
        counts.set(src, src === 'live' ? 1 : (counts.get(src) ?? 0) + 1)   // live: one off releases, like a keyboard
        return bytes
      }
      const n = counts?.get(src) ?? 0
      if (n > 1) counts.set(src, n - 1)
      else counts?.delete(src)
      if (counts && !counts.size) holders.delete(key)
      return counts?.size ? null : bytes
    },
    reset() { holders.clear() },
  }
}

// A capture take: stereo blocks placed by their audible time. Sample index of time t is
// round((t - startTime) * rate); gaps (underruns) stay silent, samples before startTime are
// dropped, past maxFrames are ignored and set `full`.
export function createTake({ rate, startTime, maxFrames }) {
  let L = new Float32Array(0), R = new Float32Array(0), hi = 0, peak = 0, recent = 0, full = false
  function grow(n) {
    if (n <= L.length) return
    const cap = Math.min(maxFrames, Math.max(n, L.length * 2, rate))
    const nl = new Float32Array(cap), nr = new Float32Array(cap)
    nl.set(L.subarray(0, hi)); nr.set(R.subarray(0, hi))
    L = nl; R = nr
  }
  // Views when the buffers already hold n frames (past hi they are still zero), else a
  // zero-extended copy.
  const exact = (n) => {
    if (n <= L.length) return { L: L.subarray(0, n), R: R.subarray(0, n), rate, frames: n }
    const l = new Float32Array(n), r = new Float32Array(n)
    l.set(L.subarray(0, hi)); r.set(R.subarray(0, hi))
    return { L: l, R: r, rate, frames: n }
  }
  return {
    add(l, r, atTime) {
      const i0 = Math.round((atTime - startTime) * rate)
      let from = Math.max(0, -i0), to = l.length
      if (i0 + to > maxFrames) { full = true; to = Math.max(from, maxFrames - i0) }
      if (to <= from) return
      grow(i0 + to)
      for (let k = from; k < to; k++) {
        const a = l[k], b = r[k]
        L[i0 + k] = a; R[i0 + k] = b
        const m = Math.max(Math.abs(a), Math.abs(b))
        if (m > recent) recent = m
      }
      if (recent > peak) peak = recent
      hi = Math.max(hi, i0 + to)
    },
    frames: () => hi,
    get full() { return full },
    get peak() { return peak },
    // peak since the previous call: a level meter's window
    takeRecentPeak() { const p = recent; recent = 0; return p },
    finish(endTime) {
      const n = endTime == null ? hi : Math.max(0, Math.min(maxFrames, Math.round((endTime - startTime) * rate)))
      return exact(n)
    },
  }
}

// Worker-side flash snapshot timing. A snapshot is taken only while no SPI flash command is in
// flight and the revision has not moved for quietMs, so a half-written firmware save is never
// stored; a request still waiting after timeoutMs is answered as a timeout (keep the last save).
// observe() every pump; request() on a snapshot message; take() -> requests to answer now.
export function createFlashGate({ revision, quietMs = 250, timeoutMs = 1500 }) {
  let rev = revision, changedAt = -Infinity
  let waiting = []
  return {
    get revision() { return rev },
    observe(revision, ms) { if (revision !== rev) { rev = revision; changedAt = ms } },
    request(req, ms) { waiting.push({ ...req, at: ms }) },
    // -> [{ ...req, ok: true } | { ...req, ok: false }]
    take(busy, ms) {
      if (!waiting.length) return []
      if (!busy && ms - changedAt >= quietMs) {
        const out = waiting.map(({ at, ...req }) => ({ ...req, ok: true }))
        waiting = []
        return out
      }
      const out = waiting.filter(w => ms - w.at >= timeoutMs).map(({ at, ...req }) => ({ ...req, ok: false }))
      waiting = waiting.filter(w => ms - w.at < timeoutMs)
      return out
    },
  }
}
