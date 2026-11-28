import { describe, it, expect, vi } from 'vitest'
import { createFm1Sessions } from '../src/renderer/js/fm1/session-manager.js'
import { createAuditioner } from '../src/renderer/js/instruments/auditioner.js'

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) }

function env() {
  const node = () => ({ connect() {}, disconnect() {} })
  const ctx = { currentTime: 1, sampleRate: 48000, createGain: node }
  const workers = []
  const sessions = createFm1Sessions({
    ctx,
    getModule: async () => ({}),
    readFirmware: async () => new ArrayBuffer(8),
    createWorker: () => {
      const w = { sent: [], postMessage(m) { this.sent.push(m) }, terminate() { this.terminated = true } }
      workers.push(w)
      return w
    },
  })
  return { ctx, sessions, workers }
}

describe('FM-1 audition keys', () => {
  it('a fast double play: the first play ending late cannot release the second one\'s device', async () => {
    const { ctx, sessions, workers } = env()
    // the first ensureAudio settles after the second (it is the one that starts the context)
    let first = true
    const ensureAudio = () => {
      if (!first) return Promise.resolve()
      first = false
      return new Promise(r => setTimeout(r, 5))
    }
    const auditioner = createAuditioner({ ensureAudio, buildDeps: () => ({ ctx, output: {}, fm1Sessions: sessions }), holdMs: 10000 })
    const fm1 = { type: 'fm1', firmwareHash: 'sha256:a' }
    const a = auditioner.play(fm1)
    const b = auditioner.play(fm1)
    await flush()
    for (const w of workers) if (!w.terminated) w.onmessage({ data: { type: 'ready' } })
    expect(await a).toBe(false)
    expect(await b).toBe(true)
    const live = workers.filter(w => !w.terminated)
    expect(live).toHaveLength(1)
    expect(live[0].sent.some(m => m.type === 'midi' && m.bytes[0] === 0x90)).toBe(true)
    auditioner.stop()
    expect(workers.every(w => w.terminated)).toBe(true)
  })
})
