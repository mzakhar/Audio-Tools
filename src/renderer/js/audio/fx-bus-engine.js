/**
 * fx-bus-engine.js
 * Parallel FX bus (send/return) system.
 *
 * Signal flow per bus:
 *   channelOutputNode → trackSendGain[busId] → bus.inputGain → bus.effect → bus.returnGain → masterInput
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateReverb(ctx, decaySec) {
  const rate = ctx.sampleRate
  const length = Math.ceil(rate * decaySec)
  const buf = ctx.createBuffer(2, length, rate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2)
    }
  }
  return buf
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

// busId → { id, name, inputGain, effect, returnGain, params }
const _buses = new Map()

// channelId → busId → GainNode (the per-channel send gain for each bus)
const _sends = new Map()

// channelId → AudioNode (the channel's output node, for wiring sends)
const _channelOutputs = new Map()

let _ctx = null
let _masterInput = null

// ---------------------------------------------------------------------------
// Bus builders
// ---------------------------------------------------------------------------

function _buildReverbBus(ctx, masterInput, decaySec = 1.5) {
  const inputGain = ctx.createGain()
  inputGain.gain.value = 1.0

  const convolver = ctx.createConvolver()
  convolver.buffer = generateReverb(ctx, decaySec)

  const returnGain = ctx.createGain()
  returnGain.gain.value = 0.8

  inputGain.connect(convolver)
  convolver.connect(returnGain)
  returnGain.connect(masterInput)

  return {
    id: 'reverb',
    name: 'Reverb',
    inputGain,
    effect: convolver,
    returnGain,
    params: { decay: decaySec },
  }
}

function _buildDelayBus(ctx, masterInput, time = 0.375, feedback = 0.4) {
  const inputGain = ctx.createGain()
  inputGain.gain.value = 1.0

  const delay = ctx.createDelay(2)
  delay.delayTime.value = time

  const feedbackGain = ctx.createGain()
  feedbackGain.gain.value = feedback

  const returnGain = ctx.createGain()
  returnGain.gain.value = 0.6

  // Feedback loop: delay → feedbackGain → delay
  delay.connect(feedbackGain)
  feedbackGain.connect(delay)

  inputGain.connect(delay)
  delay.connect(returnGain)
  returnGain.connect(masterInput)

  return {
    id: 'delay',
    name: 'Delay',
    inputGain,
    effect: delay,
    feedbackGain,
    returnGain,
    params: { time, feedback },
  }
}

// ---------------------------------------------------------------------------
// FxBusEngine
// ---------------------------------------------------------------------------

const FxBusEngine = {
  /**
   * Must be called after AudioEngine.init().
   * @param {AudioContext} ctx
   * @param {AudioNode}    masterInput  — e.g. AudioEngine.getMasterInput()
   */
  init(ctx, masterInput) {
    _ctx = ctx
    _masterInput = masterInput

    _buses.clear()
    _sends.clear()
    _channelOutputs.clear()

    const reverb = _buildReverbBus(ctx, masterInput)
    const delay  = _buildDelayBus(ctx, masterInput)
    _buses.set('reverb', reverb)
    _buses.set('delay', delay)
  },

  /**
   * Returns list of buses: [{ id, name }]
   */
  getBuses() {
    return Array.from(_buses.values()).map(({ id, name }) => ({ id, name }))
  },

  /**
   * Set send level from a channel to a bus (0..1).
   * Creates the send GainNode + wiring on first call for this pair.
   */
  setSendLevel(channelId, busId, level) {
    const bus = _buses.get(busId)
    if (!bus) return

    if (!_sends.has(channelId)) {
      _sends.set(channelId, new Map())
    }
    const channelSends = _sends.get(channelId)

    if (!channelSends.has(busId)) {
      // Create and wire the send gain node
      const sendGain = _ctx.createGain()
      sendGain.gain.value = 0
      const outputNode = _channelOutputs.get(channelId)
      if (outputNode) {
        outputNode.connect(sendGain)
      }
      sendGain.connect(bus.inputGain)
      channelSends.set(busId, sendGain)
    }

    const sendGain = channelSends.get(busId)
    sendGain.gain.value = Math.max(0, Math.min(1, level))
  },

  /**
   * Get current send level for a channel/bus pair.
   */
  getSendLevel(channelId, busId) {
    const channelSends = _sends.get(channelId)
    if (!channelSends) return 0
    const sendGain = channelSends.get(busId)
    if (!sendGain) return 0
    return sendGain.gain.value
  },

  /**
   * Set bus return level (wet mix, 0..1).
   */
  setBusReturn(busId, level) {
    const bus = _buses.get(busId)
    if (!bus) return
    bus.returnGain.gain.value = Math.max(0, Math.min(1, level))
  },

  /**
   * Set a bus effect parameter.
   * delay: 'time' (0..2s), 'feedback' (0..0.95)
   * reverb: 'decay' (0.1..5s) — regenerates impulse
   */
  setBusParam(busId, param, value) {
    const bus = _buses.get(busId)
    if (!bus) return

    if (busId === 'reverb' && param === 'decay') {
      bus.params.decay = value
      bus.effect.buffer = generateReverb(_ctx, value)
    } else if (busId === 'delay') {
      if (param === 'time') {
        bus.params.time = value
        bus.effect.delayTime.value = Math.max(0, Math.min(2, value))
      } else if (param === 'feedback') {
        bus.params.feedback = value
        bus.feedbackGain.gain.value = Math.max(0, Math.min(0.95, value))
      }
    }
  },

  /**
   * Wire a channel's output into the send network.
   * Call this when a channel is created in MixerEngine.
   * @param {string}    channelId
   * @param {AudioNode} channelOutputNode — the node whose output feeds the bus sends
   */
  registerChannel(channelId, channelOutputNode) {
    _channelOutputs.set(channelId, channelOutputNode)

    // If sends already exist for this channel (e.g. set before register), wire them now
    const channelSends = _sends.get(channelId)
    if (channelSends) {
      channelSends.forEach((sendGain) => {
        channelOutputNode.connect(sendGain)
      })
    }
  },

  /**
   * Remove a channel from the send network.
   */
  unregisterChannel(channelId) {
    const outputNode = _channelOutputs.get(channelId)
    const channelSends = _sends.get(channelId)

    if (channelSends) {
      channelSends.forEach((sendGain) => {
        if (outputNode) {
          try { outputNode.disconnect(sendGain) } catch (_) {}
        }
        try { sendGain.disconnect() } catch (_) {}
      })
      _sends.delete(channelId)
    }

    _channelOutputs.delete(channelId)
  },

  /**
   * Clear all send state (does not destroy buses).
   */
  reset() {
    _sends.forEach((channelSends, channelId) => {
      this.unregisterChannel(channelId)
    })
    _sends.clear()
    _channelOutputs.clear()
  },
}

export default FxBusEngine
