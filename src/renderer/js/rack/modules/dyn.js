// DYN — compressor. A thin wrapper over DynamicsCompressorNode, which has been
// in Web Audio since the first spec; the rack simply never exposed it. (`comp`
// is a comparator and stays what it is.)
//
// Attack/release are knobbed in ms and stored in ms; the node wants seconds.
// Its own ranges are attack 0–1 s and release 0–1 s, which the param maxima
// respect, so nothing here can throw on a legal knob value.

const GR_FLOOR = -24  // dB, full-scale of the gain-reduction readout

export default {
  // panelInline: the gain-reduction bar is a full-width strip, not a display
  // that needs its own column — five knobs wrap above it.
  type: 'dyn', name: 'DYN', group: 'fx', hp: 12, tier: 'native', poly: false, panelInline: true,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [
    { key: 'threshold', label: 'THRESH', min: -60, max: 0, step: 1, def: -24, fmt: 'dB' },
    { key: 'knee', label: 'KNEE', min: 0, max: 40, step: 1, def: 12, fmt: 'dB' },
    { key: 'ratio', label: 'RATIO', min: 1, max: 20, step: 0.1, def: 4, fmt: '' },
    { key: 'attack', label: 'ATTACK', min: 0, max: 100, step: 1, def: 3, fmt: 'ms' },
    { key: 'release', label: 'RELEASE', min: 10, max: 1000, step: 1, def: 250, fmt: 'ms' }
  ],

  create(ctx, { params = {}, poll = null } = {}) {
    const input = ctx.createGain()
    const comp = ctx.createDynamicsCompressor()
    const out = ctx.createGain()
    comp.threshold.value = params.threshold
    comp.knee.value = params.knee
    comp.ratio.value = params.ratio
    comp.attack.value = params.attack / 1000
    comp.release.value = params.release / 1000
    input.connect(comp); comp.connect(out)

    // .reduction is a plain number on the node, so the readout is a poll away.
    let reduction = 0
    const removePoll = poll?.add(() => { reduction = comp.reduction ?? 0 })

    return {
      inputs: { in: [input] },
      outputs: { out: [out] },
      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        const target = key === 'attack' || key === 'release' ? value / 1000 : value
        comp[key]?.setTargetAtTime(target, atTime, 0.01)
      },
      uiReduction() { return reduction },
      dispose() { removePoll?.(); input.disconnect(); comp.disconnect(); out.disconnect() }
    }
  },

  // One bar of gain reduction. A compressor you cannot see working is a
  // compressor you set by guesswork.
  panel(module, { getInstance, addPoll }) {
    const wrapper = document.createElement('div')
    wrapper.className = 'dyn-gr'
    const fill = document.createElement('span')
    fill.className = 'dyn-gr-fill'
    wrapper.append(fill)
    let last = -1
    const removePoll = addPoll(() => {
      if (!wrapper.isConnected) { removePoll(); return }
      const gr = Math.min(1, Math.abs(getInstance()?.uiReduction?.() || 0) / Math.abs(GR_FLOOR))
      if (Math.abs(gr - last) < 0.01) return
      last = gr
      fill.style.width = `${(gr * 100).toFixed(0)}%`
    })
    return wrapper
  }
}
