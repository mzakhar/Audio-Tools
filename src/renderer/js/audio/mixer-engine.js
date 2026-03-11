/**
 * mixer-engine.js
 * Manages per-track GainNode + StereoPannerNode chains.
 * Each track's sources connect to MixerEngine.getOutput(channelId),
 * which feeds into AudioEngine.getMasterInput().
 */
import AudioEngine from '../audio-engine.js'

const _channels = new Map()  // channelId → { gain: GainNode, pan: StereoPannerNode }

const MixerEngine = {
  ensureChannel(channelId) {
    if (_channels.has(channelId)) return _channels.get(channelId)
    const ctx = AudioEngine.getContext()
    if (!ctx) throw new Error('AudioContext not initialized')

    const gain = ctx.createGain()
    const pan  = ctx.createStereoPanner()
    gain.connect(pan)
    pan.connect(AudioEngine.getMasterInput())

    const ch = { gain, pan }
    _channels.set(channelId, ch)
    return ch
  },

  setVolume(channelId, value) {
    const ch = _channels.get(channelId)
    if (!ch) return
    ch.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, value)), AudioEngine.getContext().currentTime, 0.01)
  },

  setPan(channelId, value) {
    const ch = _channels.get(channelId)
    if (!ch) return
    ch.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, value)), AudioEngine.getContext().currentTime, 0.01)
  },

  setMute(channelId, muted) {
    const ch = _channels.get(channelId)
    if (!ch) return
    const ctx = AudioEngine.getContext()
    ch.gain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.01)
  },

  setSolo(channelId, soloed, allChannelIds) {
    const anyOtherSoloed = soloed // if this one is being soloed, mute everything else
    allChannelIds.forEach(id => {
      const ch = _channels.get(id)
      if (!ch) return
      const ctx = AudioEngine.getContext()
      if (id === channelId) {
        ch.gain.gain.setTargetAtTime(1, ctx.currentTime, 0.01)
      } else {
        ch.gain.gain.setTargetAtTime(soloed ? 0 : 1, ctx.currentTime, 0.01)
      }
    })
  },

  getOutput(channelId) {
    const ch = this.ensureChannel(channelId)
    return ch.gain
  },

  destroyChannel(channelId) {
    const ch = _channels.get(channelId)
    if (!ch) return
    ch.gain.disconnect()
    ch.pan.disconnect()
    _channels.delete(channelId)
  },

  destroy() {
    _channels.forEach((_, id) => this.destroyChannel(id))
  }
}

export default MixerEngine
