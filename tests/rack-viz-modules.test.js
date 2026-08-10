import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import scope from '../src/renderer/js/rack/modules/scope.js'
import meter from '../src/renderer/js/rack/modules/meter.js'
import { paramDefaults } from '../src/renderer/js/rack/modules/index.js'
import { RackPoll } from '../src/renderer/js/rack/rack-poll.js'
import { renderPanel } from '../src/renderer/js/components/rack-panel.js'

// ---------------------------------------------------------------------------
// Minimal BaseAudioContext fake. `read` is what every analyser hands back; pass
// nothing and the analysers have no read methods at all — which is exactly the
// shape of the fake in rack-modules.test.js and the crash that guard prevents.
// ---------------------------------------------------------------------------
function makeCtx(read = null) {
  const created = []
  const node = (kind, extra = {}) => {
    const n = {
      kind, targets: [], disconnected: 0,
      connect: vi.fn(dst => { n.targets.push(dst); return dst }),
      disconnect: vi.fn(() => { n.disconnected++ }),
      ...extra
    }
    created.push(n)
    return n
  }
  return {
    currentTime: 0, sampleRate: 44100, created,
    createGain: () => node('gain', { gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() } }),
    createAnalyser: () => {
      const n = node('analyser', { fftSize: 2048 })
      if (read) {
        n.getFloatTimeDomainData = buf => { for (let i = 0; i < buf.length; i++) buf[i] = read(i, buf.length) }
        n.getByteFrequencyData = buf => buf.fill(200)
      }
      return n
    }
  }
}

const reaches = (from, to) => !!from?.targets?.some(n => n === to || reaches(n, to))
const build = (def, ctx, poll = null, params = {}) =>
  def.create(ctx, { params: { ...paramDefaults(def.type), ...params }, poll })

// jsdom ships no 2D context, so the paint path would never run. A recording fake
// runs it for real and fails on any method the modules assume but a canvas lacks.
function fake2d() {
  const g = { calls: [] }
  for (const fn of ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'fillRect', 'fillText', 'setTransform', 'save', 'restore']) {
    g[fn] = vi.fn((...args) => g.calls.push([fn, ...args]))
  }
  return g
}

describe('SCOPE and METER — inline visualization modules', () => {
  let g2d, originalGetContext

  beforeEach(() => {
    g2d = fake2d()
    originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => g2d
  })
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    vi.restoreAllMocks()
  })

  it('exposes every declared port, one channel each, inputs and outputs', () => {
    for (const def of [scope, meter]) {
      const inst = build(def, makeCtx())
      expect(def.ports.some(p => p.dir === 'out'), `${def.type} must be patchable onward`).toBe(true)
      for (const port of def.ports) {
        const bag = port.dir === 'in' ? inst.inputs : inst.outputs
        expect(bag[port.id], `${def.type}.${port.id} missing`).toBeTruthy()
        expect(bag[port.id].length, `${def.type}.${port.id} is mono`).toBe(1)
      }
      inst.dispose()
    }
  })

  // Chrome only renders a subgraph that reaches the destination. An AnalyserNode
  // is exempt via automatic-pull, but ONLY while it has no outgoing connections.
  // Wiring it inline (in -> analyser -> out) forfeits that exemption, and the
  // module reads silence whenever its OUT jack is unpatched — which is how a
  // scope or meter is used most of the time. So: tap in parallel, never inline.
  it('taps with a leaf analyser and passes through in parallel', () => {
    const isLeaf = node => node.kind === 'analyser' && node.targets.length === 0

    const s = build(scope, makeCtx())
    for (const port of ['a', 'b']) {
      const kinds = s.inputs[port][0].targets.map(n => n.kind).sort()
      expect(kinds, `scope.${port} fans out to tap + pass-through`).toEqual(['analyser', 'gain'])
      expect(s.inputs[port][0].targets.filter(isLeaf).length, `scope.${port} analyser is a leaf`).toBe(1)
    }
    expect(reaches(s.inputs.a[0], s.outputs.outa[0])).toBe(true)
    expect(reaches(s.inputs.b[0], s.outputs.outb[0])).toBe(true)
    // A and B stay separate traces, not a summed one.
    expect(reaches(s.inputs.a[0], s.outputs.outb[0])).toBe(false)
    // TRIG is a tap only — no pass-through jack, so a lone leaf analyser.
    expect(s.inputs.trig[0].targets.every(isLeaf)).toBe(true)
    s.dispose()

    const m = build(meter, makeCtx())
    for (let i = 1; i <= 4; i++) {
      const kinds = m.inputs[`in${i}`][0].targets.map(n => n.kind).sort()
      expect(kinds, `meter ch${i} fans out to tap + pass-through`).toEqual(['analyser', 'gain'])
      expect(m.inputs[`in${i}`][0].targets.filter(isLeaf).length, `meter ch${i} analyser is a leaf`).toBe(1)
      expect(reaches(m.inputs[`in${i}`][0], m.outputs[`out${i}`][0]), `meter ch${i} pass-through`).toBe(true)
    }
    expect(reaches(m.inputs.in1[0], m.outputs.out2[0])).toBe(false)
    m.dispose()
  })

  it('METER meters four channels on four separate analysers', () => {
    const ctx = makeCtx()
    const m = build(meter, ctx)
    expect(m.analysers).toHaveLength(4)
    expect(new Set(m.analysers).size).toBe(4)
    m.dispose()
  })

  it('dispose() removes its poll job and disconnects everything it built', () => {
    for (const def of [scope, meter]) {
      const ctx = makeCtx(), poll = new RackPoll()
      const inst = build(def, ctx, poll)
      expect(poll.jobs.size, `${def.type} registers one poll job`).toBe(1)
      inst.dispose()
      expect(poll.jobs.size, `${def.type} leaves no poll job`).toBe(0)
      expect(ctx.created.filter(n => !n.disconnected).map(n => n.kind)).toEqual([])
    }
  })

  it('panel() renders a canvas and adds exactly one more poll job', () => {
    for (const def of [scope, meter]) {
      const poll = new RackPoll()
      const inst = build(def, makeCtx(() => 0.5), poll)
      const el = renderPanel({ id: `${def.type}-1`, type: def.type, params: {} }, {
        getInstance: () => inst,
        addPoll: job => poll.add(job)
      })
      expect(el.querySelector('canvas'), `${def.type} panel canvas`).toBeTruthy()
      expect(poll.jobs.size, `${def.type}: capture job + paint job`).toBe(2)

      // Off the DOM the paint job unregisters itself — RackView rebuilds panels
      // wholesale and never tears them down.
      poll.jobs.forEach(job => job())
      expect(poll.jobs.size).toBe(1)
      inst.dispose()
    }
  })

  it('paints once the panel is on the DOM, at devicePixelRatio', () => {
    const poll = new RackPoll()
    const inst = build(scope, makeCtx((i) => Math.sin(i / 64 * 2 * Math.PI)), poll)
    const el = renderPanel({ id: 's1', type: 'scope', params: {} }, { getInstance: () => inst, addPoll: job => poll.add(job) })
    document.body.append(el)
    poll.jobs.forEach(job => job())
    expect(poll.jobs.size).toBe(2)
    expect(g2d.setTransform).toHaveBeenCalled()
    expect(g2d.stroke).toHaveBeenCalled()
    el.remove()
    inst.dispose()
  })

  it('survives a tick against an analyser with no read methods at all', () => {
    const poll = new RackPoll()
    const panels = []
    for (const def of [scope, meter]) {
      const inst = build(def, makeCtx(), poll)
      const el = renderPanel({ id: `${def.type}-1`, type: def.type, params: {} }, { getInstance: () => inst, addPoll: job => poll.add(job) })
      document.body.append(el)
      panels.push(el)
    }
    expect(poll.jobs.size).toBe(4)
    expect(() => poll.jobs.forEach(job => job())).not.toThrow()
    expect(poll.jobs.size).toBe(4)
    panels.forEach(el => el.remove())
  })

  it('every SCOPE mode paints without a mode-specific crash', () => {
    for (const mode of ['wave', 'xy', 'spectrum']) {
      const poll = new RackPoll()
      const inst = build(scope, makeCtx(i => Math.sin(i / 64 * 2 * Math.PI)), poll, { mode })
      const el = renderPanel({ id: 's1', type: 'scope', params: { mode } }, { getInstance: () => inst, addPoll: job => poll.add(job) })
      document.body.append(el)
      expect(() => poll.jobs.forEach(job => job())).not.toThrow()
      expect(inst.uiFrame().mode).toBe(mode)
      el.remove()
      inst.dispose()
    }
  })

  it('SCOPE triggers on a waveform and flags UNTRIG on a flat line', () => {
    const poll = new RackPoll()
    const wave = build(scope, makeCtx(i => Math.sin(i / 64 * 2 * Math.PI)), poll, { time: 1 })
    poll.jobs.forEach(job => job())
    expect(wave.uiFrame().triggered).toBe(true)
    expect(wave.uiFrame().count).toBeGreaterThan(1)
    wave.dispose()

    const quiet = new RackPoll()
    const flat = build(scope, makeCtx(() => 0), quiet)
    quiet.jobs.forEach(job => job())
    expect(flat.uiFrame().triggered).toBe(false)
    expect(flat.uiFrame().start).toBe(0)
    flat.dispose()
  })

  it('SCOPE triggers on TRIG when something is patched there, not on A', () => {
    const poll = new RackPoll()
    const inst = build(scope, makeCtx(() => 0), poll, { time: 1 })
    poll.jobs.forEach(job => job())
    expect(inst.uiFrame().triggered).toBe(false)

    // A is still flat; only TRIG carries an edge. A decorative TRIG jack would
    // leave this free-running.
    inst.analysers.trig.getFloatTimeDomainData = buf => { buf.fill(-0.5); buf.fill(1, 20) }
    poll.jobs.forEach(job => job())
    const frame = inst.uiFrame()
    expect(frame.triggered).toBe(true)
    expect(frame.start).toBeGreaterThan(0)
    expect(frame.start).toBeLessThanOrEqual(21)
    inst.dispose()
  })

  it('METER latches clip and holds the peak cap above the falling bar', () => {
    const level = { v: 1 }
    const clock = { t: 0 }
    vi.spyOn(performance, 'now').mockImplementation(() => clock.t * 1000)
    const poll = new RackPoll()
    const inst = build(meter, makeCtx(() => level.v), poll)
    const run = seconds => {
      for (let i = 0; i < Math.round(seconds * 30); i++) { clock.t += 1 / 30; poll.jobs.forEach(job => job()) }
    }

    run(0.5)
    expect(inst.uiMeters()[0].clip).toBe(true)
    expect(inst.uiMeters()[0].db).toBeGreaterThan(-1)

    level.v = 0
    run(0.5)
    const falling = inst.uiMeters()[0]
    expect(falling.clip, 'clip stays latched for ~1.5 s').toBe(true)
    expect(falling.hold, 'peak cap sits above the released bar').toBeGreaterThan(falling.db)
    expect(falling.db).toBeLessThan(-3)

    run(1.5)
    const settled = inst.uiMeters()[0]
    expect(settled.clip).toBe(false)
    expect(settled.db).toBeLessThan(-40)
    inst.dispose()
  })

  it('METER cv mode shows a signed voltage instead of dB, with no clip latch', () => {
    const clock = { t: 0 }
    vi.spyOn(performance, 'now').mockImplementation(() => clock.t * 1000)
    const poll = new RackPoll()
    // -0.25 CV is a valid note 2.5 octaves below C4 — dB metering would read it
    // as a loud positive signal.
    const inst = build(meter, makeCtx(() => -0.25), poll, { mode: 'cv' })
    for (let i = 0; i < 15; i++) { clock.t += 1 / 30; poll.jobs.forEach(job => job()) }
    const m = inst.uiMeters()[0]
    expect(m.cv).toBeCloseTo(-0.25, 2)
    expect(m.clip).toBe(false)
    inst.dispose()
  })
})
