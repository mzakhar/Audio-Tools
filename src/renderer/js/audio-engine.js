/**
 * audio-engine.js
 * Single shared AudioContext, master chain, reverb send.
 */
import recorderProcessorUrl from './worklets/recorder-processor.js?url'

const AudioEngine = {
  _ctx: null,
  _masterGain: null,
  _dryGain: null,
  _reverbSend: null,
  _convolver: null,
  _premaster: null,
  _compressor: null,

  _buildImpulseResponse(duration = 2.5, decay = 2.0) {
    const ctx = this._ctx
    const rate = ctx.sampleRate
    const length = Math.floor(rate * duration)
    const buf = ctx.createBuffer(2, length, rate)
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < length; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay)
      }
    }
    return buf
  },

  async init() {
    if (this._ctx) {
      if (this._ctx.state === 'suspended') this._ctx.resume()
      return
    }

    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    this._ctx = ctx

    // Load AudioWorklet module so Recorder can use it immediately
    await ctx.audioWorklet.addModule(recorderProcessorUrl)

    // Master chain:
    // masterGain → dryGain ─┐
    //              reverbSend → convolver ─┤→ premaster → compressor → destination
    this._masterGain = ctx.createGain()
    this._masterGain.gain.value = 0.85

    this._dryGain = ctx.createGain()
    this._dryGain.gain.value = 1.0

    this._reverbSend = ctx.createGain()
    this._reverbSend.gain.value = 0.25

    this._convolver = ctx.createConvolver()
    this._convolver.buffer = this._buildImpulseResponse(2.5, 2)

    this._premaster = ctx.createGain()
    this._premaster.gain.value = 0.8

    this._compressor = ctx.createDynamicsCompressor()
    this._compressor.threshold.value = -14
    this._compressor.knee.value = 6
    this._compressor.ratio.value = 4
    this._compressor.attack.value = 0.003
    this._compressor.release.value = 0.25

    this._masterGain.connect(this._dryGain)
    this._masterGain.connect(this._reverbSend)
    this._reverbSend.connect(this._convolver)
    this._dryGain.connect(this._premaster)
    this._convolver.connect(this._premaster)
    this._premaster.connect(this._compressor)
    this._compressor.connect(ctx.destination)
  },

  getContext() { return this._ctx },
  getMasterInput() { return this._masterGain },
  getCompressor() { return this._compressor },

  setMasterVolume(v) {
    if (!this._masterGain) return
    this._masterGain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this._ctx.currentTime, 0.02)
  },

  setReverb(amount) {
    if (!this._reverbSend) return
    const a = Math.max(0, Math.min(1, amount))
    this._reverbSend.gain.setTargetAtTime(a * 0.8, this._ctx.currentTime, 0.05)
    this._dryGain.gain.setTargetAtTime(1 - a * 0.3, this._ctx.currentTime, 0.05)
  },
}

export default AudioEngine
