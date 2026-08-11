// TURING — looping shift register (Music Thing Turing Machine). Random that
// repeats: the LOCK knob decides how much of the loop survives each pass.
//
// The PULSE event carries the new CV as `cv`, so TURING → QUANT quantizes the
// actual note instead of whatever the CV jack happened to be sitting at.

import { turingStep, bitsToCv, REGISTER_BITS } from '../turing.js'

export default {
  type: 'turing',
  name: 'TURING',
  group: 'mod',
  hp: 8,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'clk', dir: 'in', kind: 'gate', label: 'CLK' },
    { id: 'lock', dir: 'in', kind: 'cv', label: 'LOCK', atten: true },
    { id: 'write', dir: 'in', kind: 'gate', label: 'WRITE' },
    { id: 'cv', dir: 'out', kind: 'cv', label: 'CV' },
    { id: 'cv2', dir: 'out', kind: 'cv', label: 'CV2' },
    { id: 'pulse', dir: 'out', kind: 'gate', label: 'PULSE' }
  ],
  params: [
    { key: 'length', label: 'LENGTH', min: 2, max: 16, step: 1, def: 8, fmt: '' },
    { key: 'lock', label: 'LOCK', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'range', label: 'RANGE', min: 0, max: 1, step: 0.01, def: 1, fmt: '' },
    { key: 'bipolar', label: 'BIPOLAR', options: ['off', 'on'], def: 'off' }
  ],

  create(ctx, { params = {}, poll = null, emitEvent = () => {}, random = Math.random } = {}) {
    params = { length: 8, lock: 0.5, range: 1, bipolar: 'off', ...params }
    const clk = ctx.createGain()
    const write = ctx.createGain()
    const lockIn = ctx.createGain()
    const cvSrc = ctx.createConstantSource()
    const cv2Src = ctx.createConstantSource()
    const cv = ctx.createGain()
    const cv2 = ctx.createGain()
    const pulse = ctx.createGain()

    // ponytail: the LOCK jack is sampled at the shared 30 Hz poll through an
    // AnalyserNode. Audio-rate lock modulation would need a worklet, and the
    // knob it offsets is a "how random" control nobody sweeps at audio rate.
    const analyser = ctx.createAnalyser?.() || null
    const scan = analyser ? new Float32Array(analyser.fftSize) : null
    let lockCv = 0
    if (analyser) lockIn.connect(analyser)
    const removePoll = analyser
      ? poll?.add(() => { analyser.getFloatTimeDomainData?.(scan); lockCv = scan[scan.length - 1] || 0 })
      : null

    let bits = Array.from({ length: REGISTER_BITS }, () => (random() < 0.5 ? 1 : 0))
    let writePending = false

    cvSrc.offset.value = bitsToCv(bits, params.range, params.bipolar === 'on')
    cv2Src.offset.value = bitsToCv(bits, params.range, params.bipolar === 'on', 2)
    cvSrc.connect(cv)
    cv2Src.connect(cv2)
    cvSrc.start()
    cv2Src.start()

    return {
      inputs: { clk: [clk], lock: [lockIn], write: [write] },
      outputs: { cv: [cv], cv2: [cv2], pulse: [pulse] },
      setParam(key, value) { params[key] = value },
      // Register contents for the LED panel. Read-only, safe from a UI poll.
      uiBits() { return bits.slice() },
      onEvent(portId, event) {
        // WRITE forces one coin-flip bit past a locked knob — the hardware's
        // "punch new data into the loop" move.
        if (portId === 'write' && event.type !== 'gate-off') { writePending = true; return }
        if (portId !== 'clk' || event.type === 'gate-off') return
        const lock = writePending ? 0.5 : Math.min(1, Math.max(0, params.lock + lockCv))
        writePending = false
        bits = turingStep(bits, params.length, lock, random)
        const bipolar = params.bipolar === 'on'
        const value = bitsToCv(bits, params.range, bipolar)
        const time = event.time ?? ctx.currentTime
        cvSrc.offset.setValueAtTime(value, time)
        cv2Src.offset.setValueAtTime(bitsToCv(bits, params.range, bipolar, 2), time)
        if (bits[0]) emitEvent('pulse', { type: 'trig', time, channel: 0, cv: value })
      },
      dispose() {
        removePoll?.()
        cvSrc.stop()
        cv2Src.stop()
        for (const node of [clk, write, lockIn, cvSrc, cv2Src, cv, cv2, pulse]) node.disconnect()
        analyser?.disconnect()
      }
    }
  },

  // Sixteen LEDs, the register head on the left. Without this the module is
  // just four knobs and you cannot see the loop you are locking.
  panel(module, { getInstance, addPoll }) {
    const wrapper = document.createElement('div')
    wrapper.className = 'turing-leds'
    for (let i = 0; i < REGISTER_BITS; i++) {
      const led = document.createElement('span')
      led.className = 'turing-led'
      wrapper.append(led)
    }
    let last = ''
    const removePoll = addPoll(() => {
      if (!wrapper.isConnected) { removePoll(); return }
      const bits = getInstance()?.uiBits?.() || []
      const key = bits.join('')
      if (key === last) return
      last = key
      for (let i = 0; i < wrapper.children.length; i++) {
        wrapper.children[i].classList.toggle('on', !!bits[i])
      }
    })
    return wrapper
  }
}
