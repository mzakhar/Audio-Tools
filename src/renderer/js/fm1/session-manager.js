// One FM-1 session per key (a track id, or 'audition:<n>'), shared by live play, timeline
// playback and the device panel. Lives outside the live-instrument cache so rebuilding an adapter
// or a panic never reboots a device. Audition keys ('audition…') are unique per play, so one
// audition ending can never release the next one's device; their owner releases them.
import { createFm1Session } from './session.js'

const defaultWorker = () => new Worker(new URL('../workers/fm1-worker.js', import.meta.url), { type: 'module' })
const defaultWorkletNode = (ctx) => new AudioWorkletNode(ctx, 'fm1', { numberOfInputs: 0, outputChannelCount: [2] })

const normalize = (d) => ({ type: 'fm1', firmwareHash: d.firmwareHash, deviceChannel: d.deviceChannel ?? 0, mhz: d.mhz ?? 120 })
const same = (a, b) => a.firmwareHash === b.firmwareHash && a.deviceChannel === b.deviceChannel && a.mhz === b.mhz

// getWasmBytes (optional, () => Promise<ArrayBuffer>): the worklet path posts bytes, since a
// compiled Module does not cross into a worklet scope everywhere. Without it the worklet is sent
// the Module and falls back to the Worker path where that fails.
export function createFm1Sessions({
  ctx, getModule, getWasmBytes, readFirmware, preferWorklet = () => false, workletUrl, now,
  createWorker = defaultWorker, createWorkletNode = defaultWorkletNode, leadMs,
}) {
  const sessions = new Map()
  let workletLoad = null
  const loadWorklet = () => {
    workletLoad ||= ctx.audioWorklet.addModule(workletUrl).catch((e) => { workletLoad = null; throw e })
    return workletLoad
  }

  function release(key) {
    sessions.get(key)?.dispose()
    sessions.delete(key)
  }

  const api = {
    // Same key and descriptor -> the existing session (re-pointed at output). A different
    // descriptor, or a session that failed or was disposed, is replaced by a fresh boot.
    acquire(key, descriptor, output) {
      const d = normalize(descriptor)
      const s = sessions.get(key)
      if (s) {
        const { state } = s.status()
        if (state !== 'failed' && state !== 'disposed' && same(s.descriptor, d)) {
          if (output && output !== s.output) s.connect(output)
          return s
        }
        s.dispose()
      }
      // ONE device per worklet: every AudioWorkletNode renders on the context's single audio
      // thread, and one device at 120 MHz already takes ~75% of it (rtf ~1.3); a second one
      // overloads the thread, the context clock slows and every device goes silent. Further
      // devices run on the Worker path, a thread each.
      // ponytail: a fixed limit of one; budget by mhz/measured rtf if light firmware needs two.
      const workletBusy = [...sessions.values()].some(other => other.path === 'worklet' && !['failed', 'disposed'].includes(other.status().state))
      const session = createFm1Session({
        ctx, key, descriptor: d, output, getModule, getWasmBytes, readFirmware, now, leadMs,
        useWorklet: !!(preferWorklet() && ctx.audioWorklet && workletUrl && !workletBusy),
        loadWorklet, createWorker, createWorkletNode,
      })
      sessions.set(key, session)
      return session
    },
    // Per-call resolution for adapters (every note, panel input): the current session for key,
    // booting one only when there is none or it was disposed. Unlike acquire it keeps a failed
    // session with an equal descriptor, so notes into a broken device do not reboot it per note;
    // retries go through acquire (prewarm, play, a firmware import).
    use(key, descriptor, output) {
      const s = sessions.get(key)
      if (s && s.status().state === 'failed' && same(s.descriptor, normalize(descriptor))) return s
      return api.acquire(key, descriptor, output)
    },
    get: (key) => sessions.get(key) ?? null,
    release,
    disposeAll() { for (const key of [...sessions.keys()]) release(key) },
    panicAll() { for (const s of sessions.values()) s.panic() },
  }
  return api
}
