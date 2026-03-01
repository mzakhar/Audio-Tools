/**
 * audio-engine.js
 * Single shared AudioContext, master chain, reverb send.
 */
const AudioEngine = (() => {
  let ctx = null;
  let masterGain = null;
  let dryGain = null;
  let reverbSend = null;
  let convolver = null;
  let premaster = null;
  let compressor = null;

  function buildImpulseResponse(duration = 2.5, decay = 2.0) {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const buf = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buf;
  }

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }

    ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Master chain:
    // masterGain → dryGain ─┐
    //              reverbSend → convolver ─┤→ premaster → compressor → destination
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.85;

    dryGain = ctx.createGain();
    dryGain.gain.value = 1.0;

    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.25;

    convolver = ctx.createConvolver();
    convolver.buffer = buildImpulseResponse(2.5, 2);

    premaster = ctx.createGain();
    premaster.gain.value = 0.8;

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    masterGain.connect(dryGain);
    masterGain.connect(reverbSend);
    reverbSend.connect(convolver);
    dryGain.connect(premaster);
    convolver.connect(premaster);
    premaster.connect(compressor);
    compressor.connect(ctx.destination);
  }

  function getContext() { return ctx; }
  function getMasterInput() { return masterGain; }
  function getCompressor() { return compressor; }

  function setMasterVolume(v) {
    if (!masterGain) return;
    masterGain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), ctx.currentTime, 0.02);
  }

  function setReverb(amount) {
    if (!reverbSend) return;
    const a = Math.max(0, Math.min(1, amount));
    reverbSend.gain.setTargetAtTime(a * 0.8, ctx.currentTime, 0.05);
    dryGain.gain.setTargetAtTime(1 - a * 0.3, ctx.currentTime, 0.05);
  }

  return { init, getContext, getMasterInput, getCompressor, setMasterVolume, setReverb };
})();
