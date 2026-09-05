/**
 * audio-engine.js
 * Single shared AudioContext, master chain, reverb send.
 */
// The worklet is a public asset, copied verbatim, not a bundled module: `?url`
// built to a bare string with no emitted file and `new URL(...)` inlined it as
// a data: URI, and a module script cannot load from data: — both killed
// recording in every browser build. Resolving against document.baseURI keeps
// the sub-path deploy (http://themachine/synth/) working too.
const recorderProcessorUrl = new URL('worklets/recorder-processor.js', document.baseURI).href
import { buildImpulseResponse } from './utils/impulse.js'

const AudioEngine = {
  _ctx: null,
  _masterGain: null,
  _dryGain: null,
  _reverbSend: null,
  _convolver: null,
  _premaster: null,
  _compressor: null,
  _makeup: null,
  _workletReady: false,
  _workletTried: false,

  /**
   * Build the context and master chain. Synchronous on purpose: a MIDI note has
   * to be able to reach the graph inside the callback that delivered it, and an
   * awaited init() put every note at least a microtask behind its own message.
   * Only resume() and the worklet load below are genuinely async.
   */
  ensureContext() {
    if (this._ctx) return this._ctx

    const ctx = new (window.AudioContext || window.webkitAudioContext)()

    // Master chain:
    // masterGain → dryGain ─┐
    //              reverbSend → convolver ─┤→ premaster → compressor → makeup → destination
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

    // Tuned for percussive playing, not for loudness. A 3 ms attack clamped the
    // very peak that makes a drum hit read as immediate, and a 250 ms release
    // meant each hit in a roll ducked the next — both together made pads feel
    // late and forced hard hitting. 12 ms lets the transient through and catches
    // the body behind it; the shorter release recovers inside a roll.
    this._compressor = ctx.createDynamicsCompressor()
    this._compressor.threshold.value = -6
    this._compressor.knee.value = 10
    this._compressor.ratio.value = 3
    this._compressor.attack.value = 0.012
    this._compressor.release.value = 0.12

    this._masterGain.connect(this._dryGain)
    this._masterGain.connect(this._reverbSend)
    this._reverbSend.connect(this._convolver)
    this._dryGain.connect(this._premaster)
    this._convolver.connect(this._premaster)
    // A DynamicsCompressor has no makeup gain of its own, so everything the
    // limiter pulled down stayed down and the app played well under every other
    // tab. Put it back after the limiter, where it cannot drive it harder.
    this._makeup = ctx.createGain()
    // Trimmed with the limiter above: it now pulls down less, so the same 1.8
    // would clip the transients the new attack time deliberately lets past.
    this._makeup.gain.value = 1.4

    this._premaster.connect(this._compressor)
    this._compressor.connect(this._makeup)
    this._makeup.connect(ctx.destination)

    this._ctx = ctx
    return ctx
  },

  async init() {
    const ctx = this.ensureContext()

    // Creation is usually inside a user gesture, but awaiting the worklet below
    // loses that activation. Resume the context before any asynchronous setup.
    if (ctx.state === 'suspended') await ctx.resume()

    // Recorder's worklet. `ctx.audioWorklet` is undefined outside a secure
    // context (plain-http deploys), so this must not be fatal — synth audio
    // works fine without it, only recording is lost. Tried once: init() is now
    // called on every gesture that might need audio, and a failed addModule
    // must not be retried on each one.
    if (this._workletTried) return
    this._workletTried = true
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
  // Last node before the destination — what Recorder splices itself into, so a
  // recording matches what was heard. Not the compressor: makeup sits after it.
  getRecordTap() { return this._makeup },

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
