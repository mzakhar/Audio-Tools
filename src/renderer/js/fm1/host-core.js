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
// push (returns false) so a stalled emulator cannot grow memory without limit.
export function createEventQueue(limit = 4096) {
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
      return items.splice(0, n).map(e => e.bytes)
    },
    clear() { items.length = 0 },
    get size() { return items.length },
  }
}

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
