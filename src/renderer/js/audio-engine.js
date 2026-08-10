/**
 * audio-engine.js
 * Single shared AudioContext, master chain, reverb send.
 */
import recorderProcessorUrl from './worklets/recorder-processor.js?url'
import { buildImpulseResponse } from './utils/impulse.js'

const AudioEngine = {
  _ctx: null,
  _masterGain: null,
  _dryGain: null,
  _reverbSend: null,
  _convolver: null,
  _premaster: null,
  _compressor: null,
  _workletReady: false,

  async init() {
    if (this._ctx) {
      if (this._ctx.state === 'suspended') this._ctx.resume()
      return
    }

    const ctx = new (window.AudioContext || window.webkitAudioContext)()

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
    this._convolver.buffer = buildImpulseResponse(ctx, 2.5, 2)

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

    this._ctx = ctx

    // Recorder's worklet. `ctx.audioWorklet` is undefined outside a secure
    // context (plain-http deploys), so this must not be fatal — synth audio
    // works fine without it, only recording is lost.
    try {
      await ctx.audioWorklet.addModule(recorderProcessorUrl)
      this._workletReady = true
    } catch (e) {
      console.warn('AudioWorklet unavailable, recording disabled:', e.message)
    }
  },

  getContext() { return this._ctx },
  hasRecorder() { return this._workletReady },
  // Capability, not readiness: worklet-tier rack modules need `addModule`,
  // which does not exist outside a secure context (the plain-http LAN deploy).
  hasWorklet() { return typeof this._ctx?.audioWorklet?.addModule === 'function' },
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
